import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { probeWorkspaceDepthExplorer, runWorkspaceDepthExplorer } from "../src/server/workspace.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = join(root, "runtime");
await mkdir(runtimeRoot, { recursive: true });
const workspacePath = await mkdtemp(join(runtimeRoot, "test-whiteboard-depth-explorer-"));
const mediaDirectory = join(workspacePath, "素材");
const sourcePath = join(mediaDirectory, "depth-source.png");
const videoPath = join(mediaDirectory, "depth-source.mp4");
const ffmpeg = process.platform === "win32"
  ? join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
  : "ffmpeg";

try {
  await mkdir(mediaDirectory, { recursive: true });
  const created = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "testsrc2=s=320x180:d=0.1",
    "-frames:v", "1", "-y", sourcePath,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(created.status, 0, created.stderr || "failed to create depth smoke image");
  const videoCreated = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=4:d=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", videoPath,
  ], { encoding: "utf8", windowsHide: true });
  assert.equal(videoCreated.status, 0, videoCreated.stderr || "failed to create depth smoke video");

  const probe = await probeWorkspaceDepthExplorer({ appRoot: root });
  assert.equal(probe.available, true, probe.reasons?.join("；"));
  const progress = [];
  const result = await runWorkspaceDepthExplorer({
    appRoot: root,
    requestedPath: workspacePath,
    relativePaths: ["素材/depth-source.png", "素材/depth-source.mp4"],
    settings: { quality: "fast", provider: "auto", pngBitDepth: 8 },
    whiteboardDocumentId: "whiteboard-depth-test",
    onProgress: (state) => progress.push({
      completed: Number(state?.completed) || 0,
      total: Number(state?.total) || 0,
      currentPercent: Number(state?.currentPercent) || 0,
      percent: Number(state?.percent) || 0,
    }),
  });
  assert.equal(result.outputs.length, 2);
  assert.equal(result.outputs[0].kind, "image");
  assert.equal(result.outputs[1].kind, "video");
  const outputPath = join(workspacePath, ...result.outputs[0].attachment.relativePath.split("/"));
  const output = await stat(outputPath);
  assert.ok(output.isFile() && output.size > 100, "depth output is missing or empty");
  assert.ok(progress.length >= 2, "depth progress did not emit start and completion states");
  assert.equal(progress[0].total, 2);
  assert.equal(progress.at(-1).completed, 2);
  assert.equal(progress.at(-1).percent, 100);
  for (let index = 1; index < progress.length; index += 1) {
    assert.ok(progress[index].percent >= progress[index - 1].percent, "overall depth progress moved backwards");
  }
  const intermediate = progress.filter((entry) => entry.currentPercent > 0 && entry.currentPercent < 100);
  assert.ok(intermediate.length > 0, "the real runtime must surface intermediate numerical progress, not just completion");
  console.log(`whiteboard depth explorer real: image + video passed; ${progress.length} progress updates, intermediate percentages: ${[...new Set(intermediate.map((entry) => entry.currentPercent))].join(", ")}; completed 2/2`);
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
