import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRuntimeManifest, verifyRuntimeManifest, writeRuntimeManifest } from "../src/server/runtime-manifest.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-runtime-manifest-"));
try {
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "packaging", "windows", "desktop-app"), { recursive: true });
  await mkdir(join(root, "packaging", "bundled"), { recursive: true });
  await writeFile(join(root, "server.mjs"), "export const ok = true;\n");
  await writeFile(join(root, "index.html"), "<!doctype html>\n");
  await writeFile(join(root, "update-config.json"), "{}\n");
  await writeFile(join(root, "src", "worker.mjs"), "export const worker = true;\n");
  await writeFile(join(root, "packaging", "windows", "desktop-app", "main.mjs"), "export const main = true;\n");
  await writeFile(join(root, "packaging", "bundled", "skill.md"), "skill\n");
  await writeFile(join(root, "packaging", "bundled", "shensi-bundle-manifest.json"), JSON.stringify({ files: [] }));
  const manifest = await writeRuntimeManifest({ root, version: "9.2.4", buildId: "20261005123456789" });
  const verified = await verifyRuntimeManifest({ root, expectedVersion: "9.2.4", expectedBuildId: "20261005123456789", expectedSourceHash: manifest.sourceHash, requireManifest: true });
  assert.equal(verified.ok, true);
  assert.equal(manifest.entries.some((entry) => entry.path === "packaging/bundled/shensi-bundle-manifest.json"), false);
  await writeFile(join(root, "src", "worker.mjs"), "export const worker = false;\n");
  await assert.rejects(() => verifyRuntimeManifest({ root, requireManifest: true }), /发布运行文件校验失败/u);
  await writeFile(join(root, "src", "worker.mjs"), "export const worker = true;\n");
  await writeFile(join(root, "src", "unlisted.mjs"), "export const unlisted = true;\n");
  await assert.rejects(() => verifyRuntimeManifest({ root, requireManifest: true }), /文件集合不一致/u);
  const rebuilt = await buildRuntimeManifest({ root, version: "9.2.4", buildId: "20261005123456789" });
  assert.notEqual(rebuilt.sourceHash, manifest.sourceHash);
  console.log("Runtime manifest detects packaged-source drift and excludes generated bundle manifest");
} finally {
  await rm(root, { recursive: true, force: true });
}

