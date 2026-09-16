import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  compileManagedMaterialMutation,
  materialUpdateExecutionInstruction,
  materialUpdateSourceRevisionConflicts,
  materialUpdateSourceRevisions,
  parseMaterialUpdatePlan,
  unintendedMaterialDocumentChanges,
} from "../src/material-update-plan.js";
import { applyDocumentPatchPlan } from "../src/document-patch-engine.js";

const documents = {
  "chapter-8": { title: "第八章", html: "<p>天衡印第一次在他掌心亮起。</p>" },
  "canon-items": { title: "物品与道具", markdown: "## 旧剑\n\n### 功能\n破甲。" },
  "canon-world": { title: "世界观与基础规则", markdown: "## 灵力\n\n### 当前规则\n不可逆。" },
  "library-memo": { title: "备忘录", markdown: "## 已知线索\n\n旧线索。" },
};

const sourceRevisions = materialUpdateSourceRevisions({ documents, sourceDocumentIds: ["chapter-8"] });
assert.equal(materialUpdateSourceRevisionConflicts({ documents, sourceRevisions }).length, 0);
assert.deepEqual(materialUpdateSourceRevisionConflicts({
  documents: { ...documents, "chapter-8": { ...documents["chapter-8"], html: "<p>正文已经变化。</p>" } },
  sourceRevisions,
}), ["chapter-8"], "来源正文变化后旧资料计划必须失效");

const plan = parseMaterialUpdatePlan(JSON.stringify({
  schema: "shensi.material-update-plan.v1",
  changes: [{
    targetDocumentId: "canon-items",
    changeType: "insert",
    entityHeadings: ["天衡印"],
    evidence: [{ sourceDocumentId: "chapter-8", quote: "天衡印第一次在他掌心亮起。" }],
  }, {
    targetDocumentId: "canon-glossary",
    changeType: "patch",
    evidence: [{ sourceDocumentId: "chapter-8", quote: "灵契反噬会灼伤御兽师识海。" }],
  }, {
    targetDocumentId: "canon-world",
    changeType: "patch",
    evidence: [],
  }],
}), { documents, sourceDocumentIds: ["chapter-8"], sourceRevisions });

assert.equal(plan.changes.length, 2, "没有正文证据的变化必须被丢弃");
assert.equal(plan.sourceRevisions["chapter-8"], sourceRevisions["chapter-8"], "资料计划必须绑定来源正文版本");
assert.equal(plan.changes[1].changeType, "create", "缺失资料文档必须转为首次创建");
assert.match(materialUpdateExecutionInstruction(plan), /insert：只返回需要新增的二级标题记录/u);

const scopedPlan = parseMaterialUpdatePlan(JSON.stringify({
  changes: [{
    targetDocumentId: "memory-release",
    changeType: "patch",
    evidence: [{ sourceDocumentId: "chapter-8", quote: "天衡印第一次在他掌心亮起。" }],
  }, {
    targetDocumentId: "library-memo",
    changeType: "append",
    evidence: [{ sourceDocumentId: "chapter-8", quote: "天衡印第一次在他掌心亮起。" }],
  }],
}), {
  documents,
  sourceDocumentIds: ["chapter-8"],
  sourceRevisions,
  allowedTargetDocumentIds: ["memory-release", "library-memo"],
});
assert.equal(scopedPlan.changes[0].changeType, "snapshot", "结构化记忆必须由可信记忆仓更新");
assert.equal(scopedPlan.changes[1].changeType, "append", "作品备忘录可以按证据追加");

const current = [
  "# 物品与道具",
  "",
  "## 旧剑",
  "",
  "### 功能",
  "破甲。",
  "",
  "## 铜铃",
  "",
  "### 功能",
  "示警。",
].join("\n");
const insertion = compileManagedMaterialMutation({
  currentContent: current,
  candidateContent: "## 天衡印\n\n### 功能\n镇压灵兽血脉。",
  changeType: "insert",
  insertBeforeHeading: "铜铃",
});
const inserted = applyDocumentPatchPlan(current, insertion.patches, { expectedRevision: insertion.beforeRevision }).content;
assert.match(inserted, /旧剑[\s\S]*天衡印[\s\S]*铜铃/u, "新增设定必须能插入指定中间位置");
assert.match(inserted, /破甲。/u, "新增设定不得重写旧记录");

const htmlInsertion = compileManagedMaterialMutation({
  currentContent: "<h1>物品与道具</h1><h2>旧剑</h2><h3>功能</h3><p>破甲。</p><h2>铜铃</h2><p>示警。</p>",
  candidateContent: "<h2>天衡印</h2><h3>功能</h3><p>镇压灵兽血脉。</p>",
  changeType: "insert",
  insertBeforeHeading: "铜铃",
});
const insertedHtml = applyDocumentPatchPlan("<h1>物品与道具</h1><h2>旧剑</h2><h3>功能</h3><p>破甲。</p><h2>铜铃</h2><p>示警。</p>", htmlInsertion.patches, { expectedRevision: htmlInsertion.beforeRevision }).content;
assert.match(insertedHtml, /旧剑[\s\S]*天衡印[\s\S]*铜铃/u, "HTML 正式文档也必须按记录中间插入");

const patch = compileManagedMaterialMutation({
  currentContent: inserted,
  candidateContent: "## 旧剑\n\n### 功能\n破甲并斩断灵契。",
  changeType: "patch",
});
const patched = applyDocumentPatchPlan(inserted, patch.patches, { expectedRevision: patch.beforeRevision }).content;
assert.match(patched, /破甲并斩断灵契/u);
assert.match(patched, /天衡印[\s\S]*镇压灵兽血脉/u, "局部修改不得删除其他设定");

const noChange = compileManagedMaterialMutation({ currentContent: patched, candidateContent: "## 旧剑\n\n### 功能\n破甲并斩断灵契。", changeType: "patch" });
assert.equal(noChange.changed, false, "无差异资料不得产生写入");

const replacement = compileManagedMaterialMutation({ currentContent: patched, candidateContent: "# 新世界规则\n\n全部推翻重建。", changeType: "replace" });
assert.equal(replacement.operation, "replace");
assert.equal(replacement.content, "# 新世界规则\n\n全部推翻重建。");

assert.throws(() => compileManagedMaterialMutation({ currentContent: "无结构旧文", candidateContent: "新增一条", changeType: "patch" }), /阻止全文覆盖/u);
assert.deepEqual(unintendedMaterialDocumentChanges({ before: { a: "1", b: "2" }, after: { a: "1", b: "3" }, targetDocumentIds: ["a"] }), ["b"]);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const extractor = await readFile(new URL("../src/formal-artifact-extractor.js", import.meta.url), "utf8");
const mutationPlan = await readFile(new URL("../src/creative-mutation-plan.js", import.meta.url), "utf8");
assert.match(app, /const workspaceState = pending\.workspaceState \|\| state/u, "确认后必须绑定发起任务的工作区");
assert.match(app, /sendMessage\(instruction,[\s\S]{0,520}workspaceState,[\s\S]{0,120}taskContextSnapshot/u, "资料检查 Agent 必须继承发起任务的工作区与快照");
assert.match(app, /materialMutationPlans\.set\(document\.documentId, mutation\)/u, "正式资料写入必须绑定可信增量计划");
assert.match(app, /unintendedMaterialDocumentChanges/u, "批量写入必须检查计划外资料守恒");
assert.match(app, /nextHash === integrity\.currentHash/u, "没有变化的状态投影不得重复改写");
assert.match(extractor, /insertBeforeHeading/u, "模型提供的中间插入锚点必须保留到落盘事务");
assert.match(mutationPlan, /materialUpdateOutputContract/u, "资料更新必须使用专门的增量输出合同");

console.log("Shensi v5.2 material update delta contracts passed");
