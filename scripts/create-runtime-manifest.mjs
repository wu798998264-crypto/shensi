import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRuntimeManifest, writeRuntimeManifest } from "../src/server/runtime-manifest.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const releaseBuildPath = join(root, "release-build.json");
const packageMetadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const releaseBuild = JSON.parse(await readFile(releaseBuildPath, "utf8"));
const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
if (status.status !== 0) throw new Error(`无法取得源码工作区状态：${status.stderr || status.stdout}`);
const statusText = String(status.stdout || "");
const dirtyEntries = statusText.split(/\r?\n/u).map((line) => line.trimEnd()).filter(Boolean);
const sourceDirtyEntries = dirtyEntries.filter((line) => {
  const path = line.slice(3).replaceAll("\\", "/");
  return !["release-build.json", "release-runtime-manifest.json"].includes(path);
});
// Formal packaging opts into this guard.  release-build.json and the
// generated runtime manifest are build metadata and are intentionally
// excluded because this script updates them below; all source and config
// edits must already be committed before an installer can be published.
if (process.env.SHENSI_REQUIRE_CLEAN_SOURCE === "1") {
  if (sourceDirtyEntries.length) {
    throw new Error(`正式发布要求源码工作区干净；发现未提交文件：${sourceDirtyEntries.slice(0, 12).join("、")}`);
  }
}
const sourceDirtyHash = createHash("sha256").update(sourceDirtyEntries.join("\n"), "utf8").digest("hex");
const manifest = await writeRuntimeManifest({
  root,
  version: packageMetadata.version,
  buildId: releaseBuild.buildId,
  sourceCommit: releaseBuild.commit,
  sourceDirty: sourceDirtyEntries.length > 0,
  sourceDirtyHash,
});
await writeFile(releaseBuildPath, `${JSON.stringify({
  ...releaseBuild,
  runtimeManifestHash: manifest.sourceHash,
  sourceDirty: manifest.sourceDirty,
  sourceDirtyHash: manifest.sourceDirtyHash,
}, null, 2)}\n`, "utf8");
// Re-read once so a failed write cannot be mistaken for a successful package input.
const persisted = JSON.parse(await readFile(releaseBuildPath, "utf8"));
if (persisted.runtimeManifestHash !== manifest.sourceHash) throw new Error("runtime 清单摘要没有成功写入 release-build.json");
console.log(JSON.stringify({ ok: true, version: manifest.version, buildId: manifest.buildId, sourceHash: manifest.sourceHash, sourceDirty: manifest.sourceDirty }));

