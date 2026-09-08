import { mkdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DreaminaImageDriver } from "../src/server/media-provider-drivers.mjs";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const profileId = String(process.argv[2] || "guobazai");
const outputRoot = resolve(process.argv[3] || join(process.cwd(), "release", "qa", "v218-dreamina-image"));
const model = String(process.argv[4] || "5.0");
const idempotencyKey = String(process.argv[5] || `v218-${profileId}-image-${model.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`);
const resolution = String(process.argv[6] || (model === "5.0Pro" ? "1.5k" : "2k"));
const imageCount = Math.max(1, Math.min(4, Number(process.argv[7]) || 1));
const cardId = String(process.argv[8] || "");
const workRoot = join(outputRoot, "work", idempotencyKey);
const outputPath = join(outputRoot, `${idempotencyKey}.png`);
await mkdir(workRoot, { recursive: true });

const settings = {
  id: `image-dreamina-${profileId}`,
  connectionId: `image-dreamina-${profileId}`,
  provider: "即梦",
  adapter: "cli",
  model,
  dreaminaCliProfile: profileId,
  timeoutMs: String(12 * 60_000),
};
const job = {
  id: idempotencyKey,
  idempotencyKey,
  cardId,
  providerTaskId: "",
  pollCount: 0,
  request: {
    prompt: "一只白色小兔坐在晨光草地上，电影级写实动画质感，细节清晰，无文字无水印。",
    executionPrompt: "一只白色小兔坐在晨光草地上，电影级写实动画质感，细节清晰，无文字无水印。",
    aspectRatio: "1:1",
    quality: resolution,
    imageCount,
    settings,
    referenceMedia: [],
  },
};

const driver = new DreaminaImageDriver();
const capability = await driver.probeCapabilities({ settings, paid: false });
if (capability.available !== true) throw new Error(`${profileId} 免费能力检测失败：${capability.raw?.message || capability.reason || "unknown"}`);
let result = await driver.submit({ job, settings, references: [], workRoot });
if (!result.providerTaskId) throw new Error("即梦提交未返回任务编号");
job.providerTaskId = result.providerTaskId;
const submittedAt = new Date().toISOString();
for (let poll = 0; !["completed", "failed", "cancelled"].includes(result.providerStatus) && poll < 180; poll += 1) {
  await sleep(poll < 10 ? 3_000 : 5_000);
  job.pollCount = poll + 1;
  result = await driver.getStatus({ job, settings, workRoot });
}
if (result.providerStatus !== "completed") throw new Error(`即梦图片未完成：${result.providerStatus} ${result.error || result.rawStatus || ""}`);
const downloaded = await driver.download({ job, settings, workRoot, outputPath });
const actualPaths = (Array.isArray(downloaded.paths) && downloaded.paths.length
  ? downloaded.paths
  : [downloaded.path || downloaded.downloadedPath || outputPath]
).map((value) => resolve(value));
const files = await Promise.all(actualPaths.map(async (path) => ({ path, size: (await stat(path)).size })));
if (files.some((file) => file.size < 10_000)) throw new Error(`下载图片过小：${JSON.stringify(files)}`);
if (files.length !== imageCount) throw new Error(`请求 ${imageCount} 张图片，实际下载 ${files.length} 张`);
const evidence = {
  ok: true,
  profileId,
  model,
  providerTaskId: job.providerTaskId,
  idempotencyKey,
  cardId,
  requestedImageCount: imageCount,
  returnedImageCount: files.length,
  submittedAt,
  completedAt: new Date().toISOString(),
  outputPath: files[0].path,
  outputPaths: files.map((file) => file.path),
  bytes: files[0].size,
  outputFiles: files,
  creditCount: Number(result.creditCount) || null,
  providerQueuePosition: result.providerQueuePosition ?? null,
  providerQueueLength: result.providerQueueLength ?? null,
};
await writeFile(join(outputRoot, `${idempotencyKey}.json`), JSON.stringify(evidence, null, 2), "utf8");
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
