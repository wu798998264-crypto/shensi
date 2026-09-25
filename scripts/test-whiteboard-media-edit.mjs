import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractWorkspaceVideoFrame, separateWorkspaceVideoAudio, trimWorkspaceAudio } from "../src/server/workspace.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runtimeRoot = join(root, "runtime");
await mkdir(runtimeRoot, { recursive: true });
const workspacePath = await mkdtemp(join(runtimeRoot, "test-whiteboard-media-edit-"));
const mediaDirectory = join(workspacePath, "素材");
const sourcePath = join(mediaDirectory, "source.mp4");
const executable = process.platform === "win32"
  ? join(root, "node_modules", "@ffmpeg-installer", "win32-x64", "ffmpeg.exe")
  : "ffmpeg";
const probeExecutable = process.platform === "win32"
  ? join(root, "node_modules", "@ffprobe-installer", "win32-x64", "ffprobe.exe")
  : "ffprobe";

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `command failed: ${command}`);
  return result.stdout;
};

const probe = (path) => JSON.parse(run(probeExecutable, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]));

try {
  await mkdir(mediaDirectory, { recursive: true });
  run(executable, [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=0x4f7cac:s=320x180:d=2",
    "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=44100:duration=2",
    "-shortest", "-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y", sourcePath,
  ]);

  const separated = await separateWorkspaceVideoAudio({
    appRoot: root,
    requestedPath: workspacePath,
    relativePath: "素材/source.mp4",
    whiteboardDocumentId: "whiteboard-test",
  });
  assert.ok(separated.silentVideo.relativePath);
  assert.ok(separated.audio.relativePath);
  const silentProbe = probe(join(workspacePath, ...separated.silentVideo.relativePath.split("/")));
  const audioProbe = probe(join(workspacePath, ...separated.audio.relativePath.split("/")));
  assert.equal(silentProbe.streams.filter((stream) => stream.codec_type === "video").length, 1);
  assert.equal(silentProbe.streams.filter((stream) => stream.codec_type === "audio").length, 0);
  assert.equal(audioProbe.streams.filter((stream) => stream.codec_type === "video").length, 0);
  assert.equal(audioProbe.streams.filter((stream) => stream.codec_type === "audio").length, 1);

  const trimmed = await trimWorkspaceAudio({
    appRoot: root,
    requestedPath: workspacePath,
    relativePath: separated.audio.relativePath,
    startMs: 250,
    endMs: 1_250,
    whiteboardDocumentId: "whiteboard-test",
  });
  const trimmedProbe = probe(join(workspacePath, ...trimmed.attachment.relativePath.split("/")));
  const durationMs = Number(trimmedProbe.format.duration) * 1_000;
  assert.ok(durationMs >= 850 && durationMs <= 1_200, `unexpected trim duration: ${durationMs}`);

  const firstFrame = await extractWorkspaceVideoFrame({
    appRoot: root,
    requestedPath: workspacePath,
    relativePath: "素材/source.mp4",
    position: "first",
    currentTimeMs: 0,
  });
  const currentFrame = await extractWorkspaceVideoFrame({
    appRoot: root,
    requestedPath: workspacePath,
    relativePath: "素材/source.mp4",
    position: "current",
    currentTimeMs: 1_500,
  });
  assert.equal(firstFrame.frameTimeMs, 0);
  assert.ok(currentFrame.frameTimeMs >= 1_000, `current frame fell back to first frame: ${currentFrame.frameTimeMs}`);

  const appSource = await readFile(join(root, "src", "app.js"), "utf8");
  const styles = await readFile(join(root, "src", "styles.css"), "utf8");
  assert.match(appSource, /id="whiteboardCardToolbar"/);
  assert.match(appSource, /data-whiteboard-card-tool="\$\{escapeHtml\(button\.tool\)\}"/);
  assert.match(appSource, /tool: "edit-text"/);
  assert.match(appSource, /const textCard = Boolean\(node && \["text", "generated"\]/);
  assert.match(appSource, /tool: "extract-frame", label: "截取关键帧", glyph: "\\uE722",[\s\S]{0,100}compact: true/);
  assert.match(appSource, /currentTimeMs: Math\.max\(0, Math\.round\(\(Number\(sourceVideo\?\.currentTime\)/);
  assert.match(appSource, /Number\(context\.currentTimeMs\)/);
  assert.match(appSource, /target\?\.closest\?\.\("\.whiteboard-card-toolbar"\)/);
  assert.match(appSource, /preview\.dataset\.attachmentFullscreen = "true"/);
  assert.match(appSource, /data-whiteboard-card-tool="separate-av"|tool: "separate-av"/);
  assert.match(appSource, /tool: "trim-audio"/);
  assert.match(appSource, /if \(node\?\.kind === "audio"\) \{\s*openWhiteboardAudioTrimDialog\(node\.id\);\s*return;\s*\}/u);
  assert.match(appSource, /id="whiteboardAudioTrimStart"/);
  assert.match(appSource, /id="whiteboardAudioTrimEnd"/);
  assert.doesNotMatch(appSource, /class="whiteboard-image-edit-button"/);
  assert.doesNotMatch(appSource, /class="whiteboard-video-frame-trigger"/);
  assert.match(styles, /\.whiteboard-card-toolbar\s*\{/);
  assert.match(styles, /\.whiteboard-audio-trim-track\s*\{/);
  console.log("whiteboard media edit: ok");
} finally {
  const resolvedWorkspace = resolve(workspacePath);
  assert.ok(resolvedWorkspace.startsWith(resolve(runtimeRoot) + "\\") || resolvedWorkspace.startsWith(resolve(runtimeRoot) + "/"));
  await rm(resolvedWorkspace, { recursive: true, force: true });
}
