import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const source = join(root, "public", "assets", "shensi-app-icon.png");
const destination = join(root, "public", "assets", "shensi-app-icon.ico");
const ffmpeg = spawnSync("ffmpeg", [
  "-hide_banner", "-loglevel", "error", "-y",
  "-i", source,
  "-vf", "scale=256:256:flags=lanczos",
  "-frames:v", "1",
  destination,
], { encoding: "utf8" });
if (ffmpeg.status !== 0) {
  const existing = await readFile(destination).catch(() => null);
  if (!existing) throw new Error(`Unable to build Windows brand icon: ${ffmpeg.stderr || ffmpeg.stdout || "ffmpeg unavailable"}`);
}
const icon = await readFile(destination);
if (icon.length < 16_384 || icon[0] !== 0 || icon[1] !== 0 || icon[2] !== 1 || icon[3] !== 0) {
  throw new Error("Generated Windows icon is invalid");
}
console.log(JSON.stringify({ ok: true, source, destination, bytes: icon.length }));
