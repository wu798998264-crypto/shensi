import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  analyzeRegisteredFullTextImport,
  fullTextImportGateStatus,
  materializeRegisteredFullTextImport,
  registerFullTextAttachment,
} from "../src/server/full-text-import-gate.mjs";

const text = "书名：苍鳞御主\n\n第1章 退婚\n\n婚书落地。\n\n第2章 觉醒\n\n灵兽睁眼。";
const sourceSha256 = createHash("sha256").update(text, "utf8").digest("hex");
const workspacePath = "C:/tests/full-text-gate";
const attachment = {
  id: "attachment-source",
  name: "苍鳞御主全文.txt",
  relativePath: ".shensi/attachments/source.txt",
  mimeType: "text/plain",
  size: Buffer.byteLength(text),
  sha256: sourceSha256,
};

await assert.rejects(
  analyzeRegisteredFullTextImport({
    workspacePath,
    attachment,
    loadAttachmentText: async () => ({ text, sourceSha256 }),
  }),
  /没有有效登记/u,
);

const registration = registerFullTextAttachment({ workspacePath, attachment });
const registeredAttachment = { ...attachment, ...registration };
let loads = 0;
const loadAttachmentText = async () => {
  loads += 1;
  await new Promise((resolve) => setTimeout(resolve, 10));
  return { text, name: attachment.name, size: attachment.size, sourceSha256 };
};
const [firstPreview, duplicatePreview] = await Promise.all([
  analyzeRegisteredFullTextImport({ workspacePath, attachment: registeredAttachment, loadAttachmentText }),
  analyzeRegisteredFullTextImport({ workspacePath, attachment: registeredAttachment, loadAttachmentText }),
]);
assert.equal(loads, 1, "相同登记附件的并发预览必须合并为一次读取和解析");
assert.equal(firstPreview.previewToken, duplicatePreview.previewToken);
assert.equal(firstPreview.candidates[0].chapterCount, 2);
assert.equal("chapters" in firstPreview, false, "确认前的预览接口不得返回完整正文");

const materialized = materializeRegisteredFullTextImport({
  workspacePath,
  previewToken: firstPreview.previewToken,
  candidateId: "zh-chapter",
  bookTitle: "苍鳞御主",
});
const repeated = materializeRegisteredFullTextImport({
  workspacePath,
  previewToken: firstPreview.previewToken,
  candidateId: "zh-chapter",
  bookTitle: "苍鳞御主",
});
assert.match(materialized.batchId, /^fulltext-[a-f0-9]{32}$/u);
assert.equal(materialized.batchId, repeated.batchId, "同一源哈希、方案和书名必须生成稳定批次号");
assert.equal(materialized.chapters.length, 2);
assert.ok(materialized.chapters.every((chapter) => !chapter.content.includes("苍鳞御主")));
assert.throws(() => materializeRegisteredFullTextImport({
  workspacePath,
  previewToken: firstPreview.previewToken,
  candidateId: "zh-chapter",
  bookTitle: "",
}), /确认书名/u);

const changedRegistration = registerFullTextAttachment({
  workspacePath,
  attachment: { ...attachment, relativePath: ".shensi/attachments/changed.txt" },
});
await assert.rejects(
  analyzeRegisteredFullTextImport({
    workspacePath,
    attachment: { ...attachment, relativePath: ".shensi/attachments/changed.txt", ...changedRegistration },
    loadAttachmentText: async () => ({ text: `${text}\n变化`, sourceSha256: "f".repeat(64) }),
  }),
  /内容已变化/u,
);

const status = fullTextImportGateStatus();
assert.equal(status.activePreviews, 0);
assert.equal(status.waitingPreviews, 0);

console.log("full-text attachment registration, deduplication, confirmation materialization and hash gate tests passed");
