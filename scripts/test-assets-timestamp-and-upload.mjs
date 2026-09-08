import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { buildWorkspaceAssetCatalog } from "../src/server/global-asset-catalog.mjs";
import { saveWorkspaceAttachmentFromStream } from "../src/server/workspace.mjs";

const [app, catalogSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/global-asset-catalog.mjs", import.meta.url), "utf8"),
]);

assert.match(app, /Promise\.all\(Array\.from\(\{ length: Math\.min\(standaloneAssetUploadWorkerCount\(accepted\), accepted\.length\) \}/u, "独立资产上传必须使用按文件体量动态限制的有限并发");
assert.match(app, /attachment\.uploadedAt \|\| new Date\(\)\.toISOString\(\)/u, "上传资产必须绑定服务端接收时间");
assert.match(app, /elements\.uploadStandaloneAsset\.disabled = true/u, "上传过程中按钮必须锁定，避免重复上传触发");
assert.match(catalogSource, /sourceEventAt = canonicalAssetEventIso\(asset\)/u, "全局目录必须使用统一的持久化事件时间恢复规则");
assert.match(catalogSource, /!item\.sourceEventAt/u, "只有没有持久化事件时间的附件才允许回退文件时间");
const workspaceSource = await readFile(new URL("../src/server/workspace.mjs", import.meta.url), "utf8");
assert.match(workspaceSource, /const storedAt = new Date\(\)\.toISOString\(\);/u, "服务端成功保存附件后必须固化存储时间");
assert.match(workspaceSource, /createdAt: storedAt,[\s\S]{0,100}uploadedAt: storedAt,[\s\S]{0,100}sourceEventAt: storedAt/u, "附件响应必须携带稳定的创建、上传和事件时间");

const eventAt = "2026-08-19T08:15:00.000Z";
const [record] = buildWorkspaceAssetCatalog({
  workspace: { workspacePath: "C:/workspace", name: "测试作品", savedAt: "2026-08-20T08:00:00.000Z" },
  workspaceKind: "project",
  state: {
    savedAt: "2026-08-20T08:00:00.000Z",
    workspaceAssets: [{
      id: "asset-upload-time",
      kind: "image",
      origin: "upload",
      source: "asset-library",
      createdAt: eventAt,
      uploadedAt: eventAt,
      sourceEventAt: eventAt,
      attachment: { relativePath: "assets/upload.png", name: "upload.png", mimeType: "image/png" },
    }],
    documents: {},
  },
});
assert.equal(record.createdAt, eventAt, "资产目录必须保留真实上传事件时间");
assert.equal(record.sourceEventAt, eventAt, "资产目录必须保留事件时间字段用于后续扫描");

const [recoveredLegacyRecord] = buildWorkspaceAssetCatalog({
  workspace: { workspacePath: "C:/workspace", name: "测试作品", savedAt: "2026-08-26T15:38:03.389Z" },
  workspaceKind: "project",
  state: {
    savedAt: "2026-08-26T15:38:03.389Z",
    workspaceAssets: [{
      id: "conversation-asset-conversation-1784993311389-typm1-pending-image-1785003180160-q4pju-image-1",
      kind: "image",
      origin: "generated",
      createdAt: "2026-08-26T15:38:03.389Z",
      attachment: { relativePath: "assets/result.png", name: "result.png", mimeType: "image/png" },
    }],
    documents: {},
  },
});
assert.equal(recoveredLegacyRecord.createdAt, "2026-07-25T18:13:00.160Z", "全局目录必须从旧资产稳定 ID 恢复原始事件时间");
assert.equal(recoveredLegacyRecord.sourceEventAt, recoveredLegacyRecord.createdAt, "恢复时间必须成为稳定目录事件时间");

const uploadRoot = await mkdtemp(join(tmpdir(), "shensi-large-asset-"));
try {
  const expectedBytes = 16 * 1024 * 1024;
  const chunk = Buffer.alloc(256 * 1024, 0x5a);
  const stream = Readable.from((function* largeAssetChunks() {
    for (let offset = 0; offset < expectedBytes; offset += chunk.length) yield chunk;
  })());
  const startedAt = performance.now();
  const attachment = await saveWorkspaceAttachmentFromStream({
    appRoot: uploadRoot,
    requestedPath: join(uploadRoot, "runtime", "large-asset-test"),
    name: "large-reference.bin",
    mimeType: "application/octet-stream",
    stream,
    expectedBytes,
  });
  const saved = await stat(join(uploadRoot, "runtime", "large-asset-test", attachment.relativePath));
  assert.equal(saved.size, expectedBytes, "16MB 资产必须流式完整落盘");
  assert.match(attachment.sha256 || attachment.objectHash || "", /^[a-f0-9]{64}$/u, "大资产必须产生内容哈希");
  assert.ok(Number.isFinite(Date.parse(attachment.createdAt)), "附件响应必须包含可解析的创建时间");
  assert.equal(attachment.createdAt, attachment.uploadedAt, "附件创建时间和上传时间必须在成功保存时固定");
  assert.equal(attachment.createdAt, attachment.sourceEventAt, "附件事件时间必须与保存时间一起固定");
  assert.ok(performance.now() - startedAt < 15_000, "本机 16MB 流式上传不应长期阻塞");
} finally {
  await rm(uploadRoot, { recursive: true, force: true });
}

console.log("asset upload concurrency and stable timestamp tests passed");
