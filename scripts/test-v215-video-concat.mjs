import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { concatWorkspaceVideos } from "../src/server/workspace.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const ffmpegExecutable = process.platform === "win32"
  ? join(appRoot, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
  : "ffmpeg";
if (process.platform === "win32") {
  process.env.SHENSI_FFMPEG_PATH = ffmpegExecutable;
  process.env.SHENSI_FFPROBE_PATH = join(appRoot, "node_modules", "@ffprobe-installer", "win32-x64", "ffprobe.exe");
}
const runtimeRoot = join(appRoot, "runtime");
await mkdir(runtimeRoot, { recursive: true });
const workspaceRoot = await mkdtemp(join(runtimeRoot, "qa-composite-video-"));
const attachmentRoot = join(workspaceRoot, "attachments", "qa");
await mkdir(attachmentRoot, { recursive: true });

const renderClip = (output, color) => {
  const result = spawnSync(ffmpegExecutable, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", `color=c=${color}:s=320x180:d=0.6:r=24`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", output,
  ], { windowsHide: true, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "FFmpeg test clip generation failed");
};

try {
  const first = join(attachmentRoot, "segment-1.mp4");
  const second = join(attachmentRoot, "segment-2.mp4");
  renderClip(first, "red");
  renderClip(second, "blue");
  const result = await concatWorkspaceVideos({
    appRoot,
    requestedPath: workspaceRoot,
    relativePaths: [relative(workspaceRoot, first), relative(workspaceRoot, second)],
    name: "qa-joined.mp4",
  });
  assert.equal(result.segmentCount, 2);
  const output = join(workspaceRoot, result.attachment.relativePath);
  assert.equal(existsSync(output), true);
  assert.ok((await stat(output)).size > 1_000);
  console.log("Composite long-video FFmpeg concat and playable workspace attachment verification passed");
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
