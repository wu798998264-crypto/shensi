import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { saveWorkspaceAttachmentFromPath } from "../src/server/workspace.mjs";

const workerSource = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
const videoCliSource = await readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8");
assert.match(workerSource, /forceRedownload/u, "视频重试必须显式要求跳过即梦缓存");
assert.match(workerSource, /不会重新生成或重复扣费/u, "完整性重试必须保留原任务并禁止重复收费");
assert.match(videoCliSource, /forceRedownload[\s\S]{0,180}rm\(downloadDirectory/u, "即梦视频强制重试必须清理下载缓存");

const root = await mkdtemp(join(tmpdir(), "shensi-video-integrity-"));
const appRoot = join(root, "app");
const workspaceRoot = join(appRoot, "runtime", "video-integrity");
const sourceRoot = join(root, "source");
await Promise.all([
  mkdir(workspaceRoot, { recursive: true }),
  mkdir(sourceRoot, { recursive: true }),
]);

const renderClip = (output) => {
  const result = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=navy:s=320x180:d=2:r=24",
    "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", output,
  ], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "FFmpeg test clip generation failed");
};

try {
  const completePath = join(sourceRoot, "complete.mp4");
  const truncatedPath = join(sourceRoot, "truncated.mp4");
  renderClip(completePath);
  const completeBytes = await readFile(completePath);
  assert.ok(completeBytes.length > 1_000, "测试视频应有足够字节用于截断夹具");
  await writeFile(truncatedPath, completeBytes.subarray(0, Math.floor(completeBytes.length * 0.62)));

  await assert.rejects(
    saveWorkspaceAttachmentFromPath({
      appRoot,
      requestedPath: workspaceRoot,
      sourcePath: truncatedPath,
      name: "damaged.mp4",
      mimeType: "video/mp4",
      expectedDurationMs: 2_000,
      requirePlayableMedia: true,
      stableName: true,
    }),
    (error) => ["MEDIA_VALIDATION_FAILED", "MEDIA_DURATION_INCOMPLETE", "FFPROBE_MEDIA_ERROR", "FFPROBE_EXIT_NONZERO"].includes(error.code),
    "截断视频必须在落盘前被拒绝",
  );
  assert.equal(existsSync(join(workspaceRoot, "附件", "damaged.mp4")), false, "损坏视频不得出现在附件目录");

  const saved = await saveWorkspaceAttachmentFromPath({
    appRoot,
    requestedPath: workspaceRoot,
    sourcePath: completePath,
    name: "complete.mp4",
    mimeType: "video/mp4",
    expectedDurationMs: 2_000,
    requirePlayableMedia: true,
    stableName: true,
  });
  const savedPath = join(workspaceRoot, saved.relativePath);
  assert.equal((await stat(savedPath)).size, completeBytes.length, "完整视频应按原始字节数写入");
  assert.ok(saved.videoFrameCount > 0, "完整视频应有可读取帧数");
  assert.equal(saved.videoFrameCountRead, saved.videoFrameCountDeclared, "完整视频声明帧数与实际读取帧数必须一致");

  console.log("视频完整性校验：截断文件拒绝落盘，完整文件通过帧数与时长验收");
} finally {
  await rm(root, { recursive: true, force: true });
}
