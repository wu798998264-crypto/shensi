import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  renderHistoryDiff,
  replayHistoryChangeSet,
  resolveHistoryDiffInput,
  validateHistoryChangeSet,
} from "../src/history-diff.js";

const initial = "# 标题\n\n初始文本。\n\n删除对象：保留。\n修改对象：旧句。";
const added = `${initial}\n新增文字：检查背景。`;
const modified = added.replace("修改对象：旧句。", "修改对象：新句。 ");
const deleted = modified.replace("删除对象：保留。\n", "");

const firstVersion = resolveHistoryDiffInput({
  snapshotAfter: initial,
  hasParent: false,
});
assert.equal(firstVersion.hasDiff, false, "首个手动快照应显示完整版本");

for (const [label, before, after, expectedClass] of [
  ["新增", initial, added, "history-diff-added"],
  ["修改", added, modified, "history-diff-removed"],
  ["删除", modified, deleted, "history-diff-removed"],
]) {
  const input = resolveHistoryDiffInput({ parentBefore: before, snapshotAfter: after, hasParent: true });
  assert.equal(input.hasDiff, true, `${label}手动快照应按父版本生成差异`);
  assert.equal(input.source, "parent-snapshot");
  const html = renderHistoryDiff(input);
  assert.match(html, new RegExp(expectedClass, "u"), `${label}差异应包含对应样式标记`);
}

const explicit = resolveHistoryDiffInput({
  changeSet: [{ editId: "patch", start: 0, end: 2, before: "旧句", after: "新句" }],
  explicitBefore: "旧句正文",
  explicitAfter: "新句正文",
  parentBefore: "不应使用",
  snapshotAfter: "旧句正文",
  hasParent: true,
});
assert.equal(explicit.source, "stored-change-set", "正式补丁历史必须优先使用已保存的精确差异");
assert.equal(explicit.before, "旧句正文");
assert.equal(explicit.after, "新句正文");

const exactChanges = [
  { editId: "added", start: 2, end: 2, before: "", after: "新增" },
  { editId: "modified", start: 4, end: 6, before: "乙乙", after: "修改" },
  { editId: "deleted", start: 8, end: 10, before: "丙丙", after: "" },
];
const exactBefore = "甲甲前前乙乙后后丙丙尾尾";
const exactAfter = "甲甲新增前前修改后后尾尾";
const exactValidation = validateHistoryChangeSet(exactChanges, exactBefore, exactAfter);
assert.equal(exactValidation.valid, true, "合法的新增、修改、删除差异必须通过完整回放校验");
assert.equal(replayHistoryChangeSet(exactBefore, exactValidation.changes), exactAfter);
const exactHtml = renderHistoryDiff({ before: exactBefore, after: exactAfter, changeSet: exactChanges });
assert.match(exactHtml, /data-history-change-type="added"/u);
assert.match(exactHtml, /data-history-change-type="deleted"/u);
assert.match(exactHtml, /data-history-change-type="modified"/u);

for (const [label, invalidChanges, invalidBefore, invalidAfter, reason] of [
  ["越界", [{ start: 0, end: 99, before: "全文", after: "短文" }], "全文", "短文", "overlap-or-out-of-range"],
  ["重叠", [{ start: 0, end: 3, before: "甲乙丙", after: "一" }, { start: 2, end: 4, before: "丙丁", after: "二" }], "甲乙丙丁", "一二", "overlap-or-out-of-range"],
  ["原文不符", [{ start: 0, end: 2, before: "错误", after: "正确" }], "原文内容", "正确内容", "before-mismatch"],
  ["回放不符", [{ start: 0, end: 2, before: "原文", after: "新文" }], "原文内容", "另一个结果", "replay-mismatch"],
]) {
  const validation = validateHistoryChangeSet(invalidChanges, invalidBefore, invalidAfter);
  assert.equal(validation.valid, false, `${label}差异必须拒绝`);
  assert.equal(validation.reason, reason, `${label}差异必须报告准确原因`);
}

const longPrefix = `# 长标题\n\n${"完整前文。".repeat(240)}`;
const longSuffix = `${"完整后文。".repeat(240)}\n\n特殊符号：<>&\"'。`;
const legacyParent = `${longPrefix}\n旧段落。\n${longSuffix}`;
const completeSnapshot = `${longPrefix}\n新段落。\n${longSuffix}`;
const completeNextContent = `${longPrefix}\n下一轮段落。\n${longSuffix}`;
const rebuiltLegacy = resolveHistoryDiffInput({
  changeSet: [{ editId: "broken-legacy", start: 4, end: 999999, before: "残缺片段", after: "错误片段" }],
  explicitBefore: completeSnapshot,
  explicitAfter: completeNextContent,
  hasExplicitAfter: true,
  parentBefore: legacyParent,
  snapshotAfter: completeSnapshot,
  hasParent: true,
});
assert.equal(rebuiltLegacy.source, "rebuilt-from-complete-content", "损坏的旧差异必须优先从完整版本与下一轮正文重建");
assert.equal(rebuiltLegacy.rejectedChangeSetReason, "overlap-or-out-of-range");
const rebuiltHtml = renderHistoryDiff(rebuiltLegacy);
assert.match(rebuiltHtml, /# 长标题/u, "重建预览必须保留标题");
assert.match(rebuiltHtml, /完整前文。完整前文。/u, "重建预览必须保留长前文");
assert.match(rebuiltHtml, /完整后文。完整后文。/u, "重建预览必须保留长后文");
assert.match(rebuiltHtml, /特殊符号：&lt;&gt;&amp;&quot;&#39;。/u, "重建预览必须安全保留特殊符号");
const decodePreviewText = (html) => html
  .replace(/<[^>]+>/gu, "")
  .replaceAll("&lt;", "<")
  .replaceAll("&gt;", ">")
  .replaceAll("&amp;", "&")
  .replaceAll("&quot;", '"')
  .replaceAll("&#39;", "'");
const reconstructedNextContent = decodePreviewText(rebuiltHtml.replace(/<span class="history-diff-removed"[^>]*>[\s\S]*?<\/span>/gu, ""));
assert.equal(reconstructedNextContent, completeNextContent, "忽略删除标注后必须逐字还原完整下一轮正文");
const reconstructedSnapshot = decodePreviewText(rebuiltHtml.replace(/<span class="history-diff-added"[^>]*>[\s\S]*?<\/span>/gu, ""));
assert.equal(reconstructedSnapshot, completeSnapshot, "忽略新增标注后必须逐字还原完整历史快照");

const safeFullSnapshot = resolveHistoryDiffInput({
  changeSet: [{ start: -1, end: 3, before: "坏数据", after: "" }],
  explicitBefore: completeSnapshot,
  explicitAfter: "",
  snapshotAfter: completeSnapshot,
  hasParent: false,
});
assert.equal(safeFullSnapshot.hasDiff, false, "无法重建差异时必须回退完整快照而不是显示残缺内容");
assert.equal(safeFullSnapshot.before, completeSnapshot);
assert.equal(safeFullSnapshot.after, completeSnapshot);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(appSource, /const historyDiffTextFromHtml = \(html = ""\) =>/u);
assert.match(appSource, /const historyVersionDiffText = \(version = \{\}\) =>/u);
assert.match(appSource, /version\.document\?\.markdown \|\| version\.markdown/u, "纯 Markdown 历史版本必须回退读取完整 Markdown 正文");
assert.match(appSource, /const completeSnapshotText = historyVersionDiffText\(version\)/u, "单篇预览必须以完整版本快照作为差异基线");
assert.match(appSource, /explicitBefore: completeSnapshotText/u);
assert.match(appSource, /hasExplicitAfter: Object\.prototype\.hasOwnProperty\.call\(version, "afterContent"\)/u);
assert.match(appSource, /parentBefore: historyVersionDiffText/u);
assert.match(appSource, /snapshotAfter: completeSnapshotText/u);
assert.match(appSource, /snapshotDocument\(documentId, "用户点击版本保存", \{ force: true/u, "手动保存相同内容也必须强制创建版本");
assert.match(appSource, /const applyWorkspaceHistoryUpdates = \(workspaceState, updates\) =>/u, "后台工作区必须合并服务端生成的历史回执");
assert.match(appSource, /single-history-preview\$\{diffInput\.hasDiff \? " has-history-diff" : ""\}/u, "单篇历史预览必须按是否存在差异标题栏选择布局");
assert.match(appSource, /完整版本与修改标注/u);
assert.match(appSource, /<i class="added">新增<\/i><i class="deleted">删除<\/i><i class="modified">修改<\/i>/u);
assert.match(styles, /\.single-history-preview\s*\{[\s\S]{0,160}grid-template-rows:\s*minmax\(0, 1fr\)/u, "首个完整快照必须占满历史预览高度");
assert.match(styles, /\.single-history-preview\.has-history-diff\s*\{[\s\S]{0,120}grid-template-rows:\s*48px minmax\(0, 1fr\)/u, "后续差异版本必须保留标题栏和完整正文滚动区");
assert.match(styles, /\.history-diff-added\s*\{[\s\S]{0,120}color:\s*var\(--success/u, "历史新增内容必须使用绿色文字");

console.log("v3.1.1 manual history snapshot diff tests passed");
