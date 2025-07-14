// audioConverter.js
import fs from "fs";
import path from "path";
import crypto from "crypto";
import axios from "axios";
import os from "os";
import { temporaryFile } from "tempy";
import { execFile } from "child_process";
import pLimit from "p-limit";
import puppeteer from "puppeteer";
import sharp from "sharp";

// === Config ===
const inputDir = "./Music";
const outputDir = "./Converted";
const batchSize = 1;
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

const cleanFilename = (str) => {
  return str
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\[\(].*?[\]\)]/g, "")
    .replace(/[-_]/g, " ")
    .replace(/\b(?:ft|feat|featuring|vs|x|and|with|by)\b.*$/i, "")
    .replace(
      /\b(?:movie|film|official|lyrics?|video|music|hd|uhd|4k|1080p|720p|tamil|malayalam|telugu|hindi|punjabi|kannada|marathi|bengali|gujarati|odia|sinhala|karaoke|audio|remix|rework|reboot|revisit|bootleg|edit|extended|version|visualizer|teaser|trailer|status|dj|mix|song|songs|full|mv|original|feat|ft|starring|starrer|new|latest|exclusive|album|track|hit|hits|single|love|heart|emotional|sad|romantic|bgm|theme|intro|outro|ending|title|cover|performance|live|show|session|concert|reaction|behind|scenes|officially|release|leak|leaked|update|launch|dialogue|dance|choreography|practice|audio\s+only|with\s+lyrics|without\s+lyrics|lyric)\b/gi,
      ""
    )
    .replace(
      /\b(?:suriya|jyothika|yuvan\s+shankar\s+raja|yuvan|ar\s+rahman|anirudh|gv\s+prakash|vijay|ajith|dhanush|samantha|nayanthara|vikram\s+prabhu|lakshmi\s+menon|d\s+imman|arunraja\s+kamaraj|dhibu\s+ninan\s+thomas|sarathkumar|shankar|manojkumar|sivakarthikeyan|vikram|kamal\s+haasan|kamal|rajini|rajinikanth|trisha|shruti\s+haasan|sneha|keerthy\s+suresh|sai\s+pallavi|hiphop\s+tamizha|harris\s+jayaraj|santosh\s+narayanan|sam\s+cs|vidyasagar|chinmayi|shreya\s+ghoshal|sid\s+sriram|karthik|hariharan|shankar\s+mahadevan|tippu|karthi|arya|jayam\s+ravi|silambarasan|str|gautam\s+vasudev\s+menon|lokesh\s+kanagaraj|vetrimaaran|mari\s+selvaraj|selvaraghavan|mani\s+ratnam|balaji\s+sakthivel|bharath|bobby\s+simha|parthiban|vivek|vivega|na\s+muthukumar|thamarai|vignesh\s+shivan|kavingar\s+vaali|vairamuthu|bharathiraja|bhagyaraj|balachander|vishnuvardhan|ayngaran)\b/gi,
      ""
    )
    .replace(/[^ \p{L}\p{N}]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
};


function getAudioHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function hasEmbeddedCover(filePath) {
  return new Promise((resolve) => {
    const args = ["-v", "error", "-select_streams", "v", "-show_entries", "stream=codec_type", "-of", "default=noprint_wrappers=1:nokey=1", filePath];
    execFile("ffprobe", args, (err, stdout) => {
      if (err) return resolve(false);
      resolve(stdout.trim().split("\n").includes("video"));
    });
  });
}

async function fetchAlbumArt(title) {
  const query = `${title} song album art`;
  const searchUrl = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}`;
  console.log(`🔍 Searching Bing for: "${query}"`);

  const browser = await puppeteer.launch({ headless: "new" });
  const page = await browser.newPage();
  await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 0 });
  await page.waitForSelector("img.mimg", { timeout: 10000 });

  const imageUrls = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("img.mimg"))
      .map((img) => img.src || img.dataset?.src)
      .filter(Boolean);
  });
  await browser.close();

  for (const imageUrl of imageUrls) {
    try {
      if (/^data:image\/(jpeg|png);base64,/.test(imageUrl)) {
        const base64Data = imageUrl.split(",")[1];
        const ext = imageUrl.includes("jpeg") ? "jpg" : "png";
        const tempPath = temporaryFile({ extension: ext });
        fs.writeFileSync(tempPath, Buffer.from(base64Data, "base64"));
        return tempPath;
      }
      if (imageUrl.startsWith("https://")) {
        const res = await axios.get(imageUrl, { responseType: "arraybuffer" });
        const contentType = res.headers["content-type"];
        if (!contentType.startsWith("image/")) continue;
        const ext = contentType.split("/")[1].split(";")[0];
        const buffer = Buffer.from(res.data);
        const tempPath = temporaryFile({ extension: ext === "webp" ? "jpg" : ext });
        if (ext === "webp") {
          await sharp(buffer).jpeg().toFile(tempPath);
        } else {
          fs.writeFileSync(tempPath, buffer);
        }
        return tempPath;
      }
    } catch (e) {
      console.warn(`⚠️ Skipped image: ${imageUrl} — ${e.message}`);
    }
  }
  throw new Error("❌ No valid image found");
}


async function convertToM4A(input, output, title, coverPath, hasExistingCover) {
  return new Promise((resolve, reject) => {
const args = [
  "-i", input,
  ...(coverPath && !hasExistingCover
    ? [
        "-i", coverPath,
        "-map", "0:a:0",
        "-map", "1:v:0",
        "-c:v", "mjpeg",
        "-disposition:v", "attached_pic",
      ]
    : hasExistingCover
    ? [
        "-map", "0:a:0",
        "-map", "0:v:0",
        "-c:v", "copy",
        "-disposition:v", "attached_pic",
      ]
    : ["-map", "0:a:0"]
  ),
  "-af", "loudnorm=I=-14:TP=-1.5:LRA=11",
  "-c:a", "aac",
  "-b:a", "128k",
  "-metadata", `title=${title}`,
  "-metadata", `artist=${title}`,
  "-f", "ipod",
  output,
];


    console.log("🧪 ffmpeg " + args.join(" "));

    execFile("ffmpeg", args, (error) => {
      if (error) return reject(error);
      resolve();
    });
  });
}

async function processFile(filePath, seenHashes) {
  const fileName = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const baseName = path.basename(filePath, ext);
  const cleanName = cleanFilename(baseName);
  const outputPath = path.join(outputDir, `${cleanName}.m4a`);

  if (fs.existsSync(outputPath)) return `${fileName} → ⚠️ Skipped (already converted)`;

  const hash = await getAudioHash(filePath);
  if (seenHashes.has(hash)) return `${fileName} → ⚠️ Skipped (duplicate)`;
  seenHashes.add(hash);

  let coverPath = null;
  try {
    const hasCover = await hasEmbeddedCover(filePath);
    if (!hasCover) {
      coverPath = await fetchAlbumArt(cleanName);
    } else {
      console.log(`🖼️ Existing cover found in ${fileName}, skipping fetch`);
    }
    await convertToM4A(filePath, outputPath, cleanName, coverPath, hasCover);
    return `${fileName} → 🎵 Converted${hasCover ? " (kept cover)" : " (added cover)"}`;
  } finally {
    if (coverPath && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
  }
}

async function main() {
  const allFiles = fs
    .readdirSync(inputDir)
    .filter((f) => !fs.statSync(path.join(inputDir, f)).isDirectory())
    .map((f) => path.join(inputDir, f));

  const seenHashes = new Set();
  const batches = [];
  for (let i = 0; i < allFiles.length; i += batchSize)
    batches.push(allFiles.slice(i, i + batchSize));

  for (const batch of batches) {
    console.clear();
    console.log(`🎶 Processing ${batch.length} files...`);
    const limit = pLimit(os.cpus().length);
    const lines = Array(batch.length).fill("⏳ Starting...");
    lines.forEach((line) => console.log(line));

    const results = await Promise.all(
      batch.map((file, i) =>
        limit(async () => {
          const status = await processFile(file, seenHashes);
          process.stdout.write(`\x1b[${batch.length - i}F\x1b[2K${status}\n\x1b[${batch.length - i}E`);
          return status;
        })
      )
    );
    console.log("\n✅ Batch complete");
  }
  console.log("\n🎉 All files processed.");
}

main();
