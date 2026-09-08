import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { creativeContractDocumentPatch } from "../src/creative-contract.js";
import { compileCreativeMutationPlan, creativeMutationOutputContract } from "../src/creative-mutation-plan.js";
import {
  managedDocumentFormatInstruction,
  managedDocumentFormatMetadata,
  managedDocumentSchemaFor,
  validateManagedDocumentFormat,
} from "../src/managed-document-format.js";

assert.equal(managedDocumentSchemaFor({ documentId: "canon-characters" }).id, "shensi.canon.characters.v1");
assert.equal(managedDocumentSchemaFor({ documentId: "memory-snapshot" }).systemManaged, true);
assert.equal(managedDocumentSchemaFor({ documentId: "index-pending" }).id, "shensi.index.pending-decisions.v1");
assert.equal(managedDocumentSchemaFor({ documentId: "chapter-1", moduleId: "manuscript" }), null);

assert.equal(validateManagedDocumentFormat({
  documentId: "canon-characters",
  moduleId: "canon",
  content: "## 林渊\n### 身份与定位\n御兽宗外门弟子。\n### 核心目标\n证明自身御兽天赋。",
}).valid, true);
assert.equal(validateManagedDocumentFormat({
  documentId: "canon-world",
  moduleId: "canon",
  content: "# 第1章 退婚\n这里误混入了正文。",
}).reason, "foreign_document_type_content");
assert.equal(validateManagedDocumentFormat({
  documentId: "memory-snapshot",
  moduleId: "memory",
  content: "模型直接写入的状态",
}).reason, "system_managed_document");
assert.equal(validateManagedDocumentFormat({
  documentId: "chapter-1",
  moduleId: "manuscript",
  content: "小说正文保持原有自由格式。",
}).valid, true);

const settingPlan = compileCreativeMutationPlan({
  instruction: "将人物设定写入人物设定文档并落盘",
  inventory: [{ id: "canon-characters", title: "人物设定", moduleId: "canon", characters: 100 }],
  formalWriteIntent: true,
  productionIntent: true,
  explicitTargets: [{ documentId: "canon-characters", title: "人物设定", moduleId: "canon" }],
});
assert.match(creativeMutationOutputContract(settingPlan), /设定文档格式合同/u);
assert.match(creativeMutationOutputContract(settingPlan), /核心目标/u);

const prosePlan = compileCreativeMutationPlan({
  instruction: "写第一章正文并落盘",
  inventory: [],
  productionIntent: true,
  explicitTargets: [{ documentId: "chapter-1", title: "第一章", moduleId: "manuscript" }],
});
assert.equal(creativeMutationOutputContract(prosePlan), "", "正文写作不得被设定模板污染");

const contract = creativeContractDocumentPatch({}, { bannedTerms: "禁止词", specialNotes: "保持人物能动性" });
assert.equal(contract.managedFormat.schemaId, "shensi.index.creative-contract.v1");
assert.match(contract.markdown, /项目禁用词[\s\S]*特别注意事项/u);

assert.equal(managedDocumentFormatMetadata({ documentId: "canon-world", moduleId: "canon" }).schemaVersion, 1);
assert.match(managedDocumentFormatInstruction([{ documentId: "canon-world", moduleId: "canon" }]), /限制与代价/u);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /validateManagedDocumentFormat\(\{/u, "聊天落盘事务必须执行格式校验");
assert.match(app, /trusted-memory-projector/u, "记忆展示文档必须记录可信投影格式来源");
assert.match(app, /structuredLogEntries/u, "更新日志必须保留结构化记录而不只是 HTML");
assert.match(app, /structuredNotices/u, "待确认索引的运行通知必须有结构化记录");

console.log("v3.1.6 记忆、设定、索引结构化写入格式约束测试通过");
