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

  const probe = await probeWorkspaceDepthExplorer({ appRoot: root });
  assert.equal(probe.available, true, probe.reasons?.join("；"));
  const result = await runWorkspaceDepthExplorer({
    appRoot: root,
    requestedPath: workspacePath,
    relativePaths: ["素材/depth-source.png"],
    settings: { quality: "fast", provider: "auto", pngBitDepth: 8 },
    whiteboardDocumentId: "whiteboard-depth-test",
  });
  assert.equal(result.outputs.length, 1);
  assert.equal(result.outputs[0].kind, "image");
  const outputPath = join(workspacePath, ...result.outputs[0].attachment.relativePath.split("/"));
  const output = await stat(outputPath);
  assert.ok(output.isFile() && output.size > 100, "depth output is missing or empty");
  console.log(`whiteboard depth explorer real: ok (${result.outputs[0].attachment.relativePath})`);
} finally {
  await rm(workspacePath, { recursive: true, force: true });
}
