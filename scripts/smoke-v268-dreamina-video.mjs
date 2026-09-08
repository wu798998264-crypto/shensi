import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DreaminaVideoDriver } from "../src/server/media-provider-drivers.mjs";
import { probeVideoValidationRuntime } from "../src/server/workspace.mjs";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const profileId = String(process.argv[2] || "chenan");
const outputRoot = resolve(process.argv[3] || join(process.cwd(), "release", "qa", "v268-dreamina-video"));
const model = String(process.argv[4] || "seedance2.0_vip");
const resolution = String(process.argv[5] || "720p");
const idempotencyKey = String(process.argv[6] || `v218-${profileId}-${model.replace(/[^a-z0-9]+/gi, "-")}-${resolution}-4s-${Date.now()}`);
const cardId = String(process.argv[7] || "");
const workRoot = join(outputRoot, "work", idempotencyKey.replace(/[^a-z0-9_-]+/gi, "-"));
const outputPath = join(outputRoot, `${idempotencyKey}.mp4`);
await mkdir(workRoot, { recursive: true });

const settings = {
  id: `video-dreamina-${profileId}`,
  connectionId: `video-dreamina-${profileId}`,
  provider: "即梦",
  adapter: "cli",
  model,
  dreaminaCliProfile: profileId,
  timeoutMs: "1800000",
};
const job = {
  id: idempotencyKey,
  idempotencyKey,
  cardId,
  providerTaskId: "",
  pollCount: 0,
  request: {
    prompt: "电影感雨夜街道，一盏暖色路灯照亮细雨，镜头缓慢向前推进，画面稳定、自然，无文字无水印。",
    executionPrompt: "电影感雨夜街道，一盏暖色路灯照亮细雨，镜头缓慢向前推进，画面稳定、自然，无文字无水印。",
    aspectRatio: "16:9",
    duration: 4,
    resolution,
    generationMode: "smart_params",
    settings,
    referenceMedia: [],
  },
};

const driver = new DreaminaVideoDriver();
const capability = await driver.probeCapabilities({ settings, paid: false });
if (capability.available !== true) throw new Error(`陈安配置免费能力检测失败：${capability.raw?.message || capability.reason || "unknown"}`);
let result = await driver.submit({ job, settings, references: [], workRoot });
if (!result.providerTaskId) throw new Error("即梦提交未返回 providerTaskId");
job.providerTaskId = result.providerTaskId;
const submittedAt = new Date().toISOString();
for (let poll = 0; !["completed", "failed", "cancelled"].includes(result.providerStatus) && poll < 180; poll += 1) {
  await sleep(poll < 10 ? 3_000 : 5_000);
  job.pollCount = poll + 1;
  result = await driver.getStatus({ job, settings, workRoot });
}
if (result.providerStatus !== "completed") throw new Error(`即梦视频未完成：${result.providerStatus} ${result.error || result.rawStatus || ""}`);
const downloaded = await driver.download({ job, settings, workRoot, outputPath });
// `downloadedPath` points at the provider cache inside workRoot, while `path`
// is the durable copy requested by --output. Verify and report the durable
// artifact because workRoot is removed after the smoke succeeds.
const actualPath = resolve(downloaded.path || outputPath);
const file = await stat(actualPath);
if (file.size < 100_000) throw new Error(`下载视频过小：${file.size} bytes`);

const runtime = await probeVideoValidationRuntime({ appRoot: process.cwd() });
if (!runtime.available) throw new Error(runtime.message || "FFprobe 不可用");
const ffprobe = await new Promise((resolveProbe, rejectProbe) => {
  const child = spawn(runtime.executable, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", actualPath], { windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", rejectProbe);
  child.on("close", (code) => code === 0 ? resolveProbe(JSON.parse(stdout || "{}")) : rejectProbe(new Error(stderr || `ffprobe exit ${code}`)));
});
const durationSeconds = Number(ffprobe.format?.duration || 0);
if (!(durationSeconds >= 3.5 && durationSeconds <= 5.5)) throw new Error(`视频时长不符合 4 秒测试：${durationSeconds}`);
const evidence = {
  ok: true,
  profileId,
  model,
  resolution,
  durationRequested: 4,
  durationSeconds,
  providerTaskId: job.providerTaskId,
  idempotencyKey,
  cardId,
  submittedAt,
  completedAt: new Date().toISOString(),
  outputPath: actualPath,
  bytes: file.size,
  streams: ffprobe.streams || [],
};
await writeFile(join(outputRoot, `${idempotencyKey}.json`), JSON.stringify(evidence, null, 2), "utf8");
await rm(workRoot, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
