import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  historyDiffIsFullReplacement,
  renderHistoryDiff,
  replayHistoryChangeSet,
  resolveHistoryDiffInput,
  validateHistoryChangeSet,
} from "../src/history-diff.js";
import { matchingDocumentHistoryIndex, sameDocumentHistoryContent } from "../src/history-scope.js";

const initial = "# 标题\n\n初始文本。\n\n删除对象：保留。\n修改对象：旧句。";
const added = `${initial}\n新增文字：检查背景。`;
const modified = added.replace("修改对象：旧句。", "修改对象：新句。 ");
const deleted = modified.replace("删除对象：保留。\n", "");

const completeDocument = { title: "第一章", html: "<p>一句话。</p>", markdown: "一句话。", continuityDelta: null };
assert.equal(sameDocumentHistoryContent(completeDocument, structuredClone(completeDocument)), true, "完整文档完全相同时不得重复保存");
assert.equal(sameDocumentHistoryContent(completeDocument, { ...completeDocument, title: "第一章（修订）" }), false, "标题变化必须创建版本");
assert.equal(sameDocumentHistoryContent(completeDocument, { ...completeDocument, html: "<p>一句话！</p>", markdown: "一句话！" }), false, "标点变化必须创建版本");
assert.equal(sameDocumentHistoryContent(completeDocument, { ...completeDocument, html: "<p><strong>一句话。</strong></p>" }), false, "格式变化必须创建版本");
assert.equal(sameDocumentHistoryContent({ title: "版本说明", document: completeDocument }, { title: "另一条版本说明", document: structuredClone(completeDocument) }), true, "版本说明不应被误当成文档标题变化");
assert.equal(matchingDocumentHistoryIndex([
  { document: { ...completeDocument, title: "第二章" } },
  { document: structuredClone(completeDocument) },
], { document: structuredClone(completeDocument) }), 1, "完整内容与任意旧版本一致时必须定位旧版本而不只比较第一条");

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
  parentBefore: "旧句正文",
  snapshotAfter: "新句正文",
  hasParent: true,
});
assert.equal(explicit.source, "stored-change-set", "正式补丁历史必须优先使用已保存的精确差异");
assert.equal(explicit.before, "旧句正文");
assert.equal(explicit.after, "新句正文");

assert.equal(historyDiffIsFullReplacement({
  operationType: "replace",
  before: "旧全文",
  after: "新全文",
  hasDiff: false,
}), true, "明确的全文替换历史必须使用全文覆盖预览");
assert.equal(historyDiffIsFullReplacement({
  operationType: "partial-replace",
  before: "旧句正文",
  after: "新句正文",
  changeSet: explicit.changeSet,
  hasDiff: true,
}), false, "局部替换历史必须继续显示精确差异");
assert.equal(historyDiffIsFullReplacement({
  operationType: "patch",
  before: "旧全文",
  after: "新全文",
  changeSet: [{ start: 0, end: 3, before: "旧全文", after: "新全文" }],
  hasDiff: true,
}), true, "旧历史中精确覆盖全文的单一 changeSet 也必须识别为全文覆盖");

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
  parentBefore: completeSnapshot,
  snapshotAfter: completeNextContent,
  hasParent: true,
});
assert.equal(rebuiltLegacy.source, "rebuilt-from-snapshots", "损坏的旧差异必须只从相邻完整快照重建");
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

const localPartialBefore = `${longPrefix}\n这是一句需要局部修改的原文。\n${longSuffix}`;
const localPartialAfter = `${longPrefix}\n这是一句已经完成局部修改的新文！\n${longSuffix}`;
const localPartialStart = localPartialBefore.indexOf("这是一句需要局部修改的原文。");
const localPartialInput = resolveHistoryDiffInput({
  changeSet: [{
    editId: "local-partial-edit",
    start: localPartialStart,
    end: localPartialStart + "这是一句需要局部修改的原文。".length,
    before: "这是一句需要局部修改的原文。",
    after: "这是一句已经完成局部修改的新文！",
  }],
  explicitBefore: localPartialBefore,
  hasExplicitBefore: true,
  snapshotAfter: localPartialAfter,
  hasParent: false,
});
assert.equal(localPartialInput.source, "stored-change-set", "首个局部修改版本也必须使用完整修改前正文生成精确标注");
const localPartialHtml = renderHistoryDiff(localPartialInput);
assert.match(localPartialHtml, /# 长标题/u, "局部修改预览必须显示完整标题和前文");
assert.match(localPartialHtml, /完整后文。完整后文。/u, "局部修改预览必须显示完整后文");
assert.match(localPartialHtml, /history-diff-removed/u, "局部修改必须标出被删除的原文");
assert.match(localPartialHtml, /history-diff-added/u, "局部修改必须标出新增的正文");
assert.equal(
  decodePreviewText(localPartialHtml.replace(/<span class="history-diff-removed"[^>]*>[\s\S]*?<\/span>/gu, "")),
  localPartialAfter,
  "隐藏删除标注后必须逐字还原局部修改后的完整文档",
);
assert.equal(
  decodePreviewText(localPartialHtml.replace(/<span class="history-diff-added"[^>]*>[\s\S]*?<\/span>/gu, "")),
  localPartialBefore,
  "隐藏新增标注后必须逐字还原局部修改前的完整文档",
);
const reconstructedNextContent = decodePreviewText(rebuiltHtml.replace(/<span class="history-diff-removed"[^>]*>[\s\S]*?<\/span>/gu, ""));
assert.equal(reconstructedNextContent, completeNextContent, "忽略删除标注后必须逐字还原完整选中快照");
const reconstructedSnapshot = decodePreviewText(rebuiltHtml.replace(/<span class="history-diff-added"[^>]*>[\s\S]*?<\/span>/gu, ""));
assert.equal(reconstructedSnapshot, completeSnapshot, "忽略新增标注后必须逐字还原完整历史快照");

const safeFullSnapshot = resolveHistoryDiffInput({
  changeSet: [{ start: -1, end: 3, before: "坏数据", after: "" }],
  snapshotAfter: completeSnapshot,
  hasParent: false,
});
assert.equal(safeFullSnapshot.hasDiff, false, "无法重建差异时必须回退完整快照而不是显示残缺内容");
assert.equal(safeFullSnapshot.before, completeSnapshot);
assert.equal(safeFullSnapshot.after, completeSnapshot);

const missingSnapshot = resolveHistoryDiffInput({
  changeSet: [{ start: 0, end: 1, before: "旧", after: "片段" }],
  parentBefore: completeSnapshot,
  snapshotAfter: "",
  hasParent: true,
  hasSnapshot: false,
});
assert.equal(missingSnapshot.source, "missing-complete-snapshot");
assert.match(missingSnapshot.integrityError, /快照不完整/u);
assert.equal(missingSnapshot.after, "", "快照缺失时不得回退显示 afterContent 片段");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(appSource, /const historyDiffTextFromHtml = \(html = ""\) =>/u);
assert.match(appSource, /const historyVersionDiffText = \(version = \{\}\) =>/u);
assert.match(appSource, /version\.document\?\.markdown[\s\S]{0,160}version\.markdown/u, "纯 Markdown 历史版本必须回退读取完整 Markdown 正文");
assert.match(appSource, /version\.document\?\.content[\s\S]{0,80}version\.content/u, "隔离历史顶层 content 必须作为完整正文快照读取");
assert.match(appSource, /content: versionDocument\.content \?\? version\.content \?\? ""/u, "历史预览必须把顶层 content 平移到文档快照");
assert.match(appSource, /history-preview-plain-content/u, "纯文本历史正文必须完整渲染而不是显示为空");
assert.match(appSource, /const completeSnapshotText = historyVersionDiffText\(version\)/u, "单篇预览必须以完整版本快照作为差异基线");
assert.match(appSource, /parentBefore: historyVersionDiffText/u);
assert.match(appSource, /snapshotAfter: completeSnapshotText/u);
assert.match(appSource, /explicitBefore: version\.beforeContent/u, "局部修改历史缺少相邻父版本时必须使用保存的完整修改前正文");
assert.match(appSource, /beforeContent: documentTextFromHtml\(beforeHtml\)/u, "鼠标选区局部修改必须保存完整修改前正文");
assert.match(appSource, /beforeContent: previousDocumentText/u, "Agent 局部修改必须保存完整修改前正文");
assert.doesNotMatch(appSource, /explicitAfter: version\.afterContent/u, "afterContent 不得再充当历史预览正文");
assert.match(appSource, /const matchingIndex = matchingDocumentHistoryIndex\(historyEntries, entry\)/u, "保存时必须检查全部历史版本");
assert.match(appSource, /historyEntries\.splice\(matchingIndex, 1\)[\s\S]{0,260}historyEntries\.unshift\(matchingEntry\)/u, "命中旧版本时必须将原版本移动到最上方");
assert.match(appSource, /matchingEntry\.lastActivatedAt = entry\.createdAt/u, "提升旧版本时必须记录最新排序时间");
assert.match(appSource, /const comparisonVersionId = version\.latestComparisonVersionId \|\| version\.parentVersionId/u, "提升后的版本预览必须以本次切回前的版本作为差异基线");
assert.match(appSource, /snapshotDocument\(documentId, "用户点击版本保存", \{ operations:/u, "手动保存应按完整差异创建版本");
assert.doesNotMatch(appSource, /snapshotDocument\(documentId, "用户点击版本保存", \{ force: true/u, "手动保存完全相同内容时不得强制创建重复版本");
assert.match(appSource, /当前完整内容与最新历史版本完全相同，无需重复保存/u);
assert.match(appSource, /const applyWorkspaceHistoryUpdates = \(workspaceState, updates\) =>/u, "后台工作区必须合并服务端生成的历史回执");
assert.match(appSource, /const showInlineHistoryDiff = diffInput\.hasDiff && !fullReplacement/u, "全文覆盖必须与局部差异预览分流");
assert.match(appSource, /single-history-preview\$\{showInlineHistoryDiff \? " has-history-diff" : fullReplacement \? " has-history-status" : ""\}/u, "单篇历史预览必须按局部差异或全文覆盖状态选择布局");
assert.match(appSource, /history-full-replacement-badge">全文覆盖</u, "全文覆盖历史必须显示黄色状态标签");
assert.match(appSource, /showInlineHistoryDiff[\s\S]{0,520}renderHistoryDiff\(diffInput\)[\s\S]{0,120}previewDocumentHtml\(selectedDocument\)/u, "全文覆盖不得渲染整篇删除新增差异，必须显示完整历史快照");
assert.match(appSource, /完整版本与修改标注/u);
assert.match(appSource, /<i class="added">新增<\/i><i class="deleted">删除<\/i>/u);
assert.doesNotMatch(appSource, /<i class="modified">修改<\/i>/u, "修改即删除后新增，不再重复展示修改图例");
assert.doesNotMatch(styles, /\.history-diff-legend \.modified/u, "不再保留修改颜色示例样式");
assert.match(styles, /\.history-preview-body\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);[^}]*overflow:\s*hidden;/u,
  "历史预览主体必须约束子内容高度，避免完整正文被裁掉");
assert.match(styles, /\.history-preview-content\s*\{[^}]*height:\s*100%;[^}]*overflow:\s*hidden;/u,
  "历史预览内容区必须占满可用高度，并把滚动交给正文区域");
assert.match(styles, /\.single-history-preview\s*\{[\s\S]{0,160}grid-template-rows:\s*minmax\(0, 1fr\)/u, "首个完整快照必须占满历史预览高度");
assert.match(styles, /\.single-history-preview\.has-history-diff,\s*\n\.single-history-preview\.has-history-status\s*\{[\s\S]{0,120}grid-template-rows:\s*48px minmax\(0, 1fr\)/u, "差异和全文覆盖版本必须保留标题栏和完整正文滚动区");
assert.match(styles, /\.history-diff-added\s*\{[\s\S]{0,120}color:\s*var\(--success/u, "历史新增内容必须使用绿色文字");
assert.match(styles, /\.history-full-replacement-badge\s*\{[\s\S]{0,260}#f5c542/u, "全文覆盖标签必须使用黄色状态样式");
assert.match(styles, /\.history-preview-document\.full-replacement,[\s\S]{0,160}color:\s*var\(--text\)\s*!important/u, "全文覆盖正文必须保持正常文字颜色");

console.log("v3.1.1 manual history snapshot diff tests passed");
