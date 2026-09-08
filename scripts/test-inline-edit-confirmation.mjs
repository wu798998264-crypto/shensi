import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildInlineSelectionPrompt,
  inlineEditAppliedText,
  inlineEditChangeSet,
  inlineEditModeLabel,
  inlineSelectionMutationMode,
} from "../src/selection-edit.js";
import {
  applyAnchoredTextEdit,
  createAnchoredTextEditContract,
  resolveAnchoredTextEdit,
} from "../src/anchored-text-edit.js";
import { renderHistoryDiff } from "../src/history-diff.js";

assert.equal(inlineSelectionMutationMode({ instruction: "润色这段", hasSelection: true }), "replace");
assert.equal(inlineSelectionMutationMode({ instruction: "在选区前补写一段", hasSelection: true }), "insert_before");
assert.equal(inlineSelectionMutationMode({ instruction: "在选区后补写一段", hasSelection: true }), "insert_after");
assert.equal(inlineSelectionMutationMode({ instruction: "补写一段过渡", hasSelection: true }), "insert_after", "选区补写未指定方向时必须默认保留选区并在后方新增");
assert.equal(inlineSelectionMutationMode({ instruction: "补写一段过渡", hasSelection: false }), "insert_at_caret");

const original = "原选区保持不变。";
const candidate = "新增的过渡描述。";
assert.equal(inlineEditAppliedText({ mode: "replace", originalText: original, candidate }), candidate);
assert.equal(inlineEditAppliedText({ mode: "insert_before", originalText: original, candidate }), `${candidate}${original}`);
assert.equal(inlineEditAppliedText({ mode: "insert_after", originalText: original, candidate }), `${original}${candidate}`);
assert.deepEqual(inlineEditChangeSet({ mode: "insert_after", originalText: original, candidate, startOffset: 10 })[0], {
  editId: "inline-insert-after",
  start: 10 + original.length,
  end: 10 + original.length,
  before: "",
  after: candidate,
});

const insertionPrompt = buildInlineSelectionPrompt({
  selectedText: original,
  instruction: "在选区后补写一段",
  mode: "insert_after",
  anchor: { prefix: "前文。", suffix: "后文。" },
  documentTitle: "第一章",
});
assert.match(insertionPrompt, /受保护的选中文字（必须逐字保持不变）/u);
assert.match(insertionPrompt, /同时承接两侧内容/u);
assert.match(insertionPrompt, /只返回新增片段本身/u);
assert.doesNotMatch(insertionPrompt, /直接替换选中文字/u);

const documentText = "前文完整。后文完整。";
const caretOffset = "前文完整。".length;
const caretContract = createAnchoredTextEditContract({
  transactionId: "caret-insert-1",
  documentId: "chapter-1",
  documentText,
  startOffset: caretOffset,
  endOffset: caretOffset,
});
assert.equal(caretContract.originalText, "");
assert.equal(resolveAnchoredTextEdit({ contract: caretContract, currentText: documentText }).status, "resolved");
const applied = applyAnchoredTextEdit({ contract: caretContract, currentText: documentText, replacementText: candidate });
assert.equal(applied.status, "applied");
assert.equal(applied.afterText, `前文完整。${candidate}后文完整。`);

const shiftedText = `新增章首。${documentText}`;
const relocated = resolveAnchoredTextEdit({ contract: caretContract, currentText: shiftedText });
assert.equal(relocated.status, "resolved");
assert.equal(relocated.strategy, "contextual_boundary");
assert.equal(relocated.startOffset, "新增章首。前文完整。".length);

const conflictContract = createAnchoredTextEditContract({
  transactionId: "conflict-replace-1",
  documentId: "chapter-1",
  documentText: "唯一原文。后文。",
  startOffset: 0,
  endOffset: "唯一原文。".length,
});
const conflict = applyAnchoredTextEdit({
  contract: conflictContract,
  currentText: "正文已经完全改成另一版本。",
  replacementText: "候选修改。",
});
assert.equal(conflict.status, "conflict", "无法重新定位时必须停止局部写入");
assert.equal(conflict.afterText, undefined, "锚点冲突不得产出可提交的正文");

const replacementDiff = renderHistoryDiff({
  before: original,
  after: candidate,
  changeSet: inlineEditChangeSet({ mode: "replace", originalText: original, candidate }),
});
assert.match(replacementDiff, /history-diff-removed/u);
assert.match(replacementDiff, /history-diff-added/u);
const insertionDiff = renderHistoryDiff({
  before: original,
  after: `${original}${candidate}`,
  changeSet: inlineEditChangeSet({ mode: "insert_after", originalText: original, candidate }),
});
assert.doesNotMatch(insertionDiff, /history-diff-removed/u, "局部补写不得把受保护选区标记为删除");
assert.match(insertionDiff, /history-diff-added/u);
assert.equal(inlineEditModeLabel("insert_at_caret"), "从此处补写");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(app, /data-text-edit-action="supplement"[\s\S]{0,180}data-text-edit-action="copy"/u, "从此处补写必须位于右键菜单第一项并处于复制之前");
assert.match(app, /确认前正文保持不变/u);
assert.match(app, /确认应用/u);
assert.doesNotMatch(app, /补写位置[：:]/u, "补写操作栏不得增加冗余的位置提示");
assert.match(app, /instruction: String\(instruction \|\| ""\)\.trim\(\)/u, "局部补写必须保留原始指令以便编译相关资料");
assert.match(app, /buildInlineEditProjectContext[\s\S]{0,1800}buildProjectContext\(\{ documentId: targetDocumentId \}[\s\S]{0,700}requiredContextDocumentIds: relevantIds/u, "局部补写必须复用正式上下文编译器读取目标章节和相关资料");
assert.match(app, /包含有关的设定、大纲、记忆、当前章节及必要承接内容/u);
assert.match(app, /const retainInlineEditConflict[\s\S]{0,900}status = "anchor_conflict"[\s\S]{0,900}persist\(\)/u, "定位失败时必须持久保留候选");
assert.match(app, /无法重新锁定原文位置，已停止写入/u);
assert.match(app, /id="inlineEditConflictDialog"/u, "定位失效必须弹出明确的处理选择框");
assert.match(app, /data-inline-edit-conflict-action="keep"/u, "定位失效时必须允许仅保留候选并关闭");
assert.match(app, /data-inline-edit-conflict-action="retarget"/u, "定位失效时必须允许用户重新选择位置");
assert.match(app, /data-inline-edit-conflict-action="retry"/u, "定位失效时必须允许重新检查唯一锚点");
assert.match(app, /const recheckInlineEditAnchor[\s\S]{0,1800}placePendingInlineEdit\(record\)/u, "重新检查必须复用唯一锚点解析，不能猜测位置");
assert.match(app, /const beginInlineEditRetarget[\s\S]{0,1000}ui\.inlineEditRetargetId = record\.id/u, "重新选择位置必须保留原候选并要求新的明确选区");
assert.match(app, /候选内容已保留，原文没有改动。只能在重新确认唯一位置后应用/u, "冲突提示必须明确禁止自动追加或全文覆盖");
assert.doesNotMatch(app, /data-inline-edit-conflict-action="force"/u, "定位失效不得提供强制覆盖入口");
assert.doesNotMatch(app, /placed\s*&&\s*landingDecision\.action\s*===\s*"land"[\s\S]{0,80}acceptInlineEdit/u, "局部候选不得自动接受");
assert.match(app, /status:\s*placed\s*\?\s*"candidate"/u);
assert.match(app, /const placeInlineEditSuggestion[\s\S]{0,260}original\.before\(suggestion\)[\s\S]{0,120}original\.after\(suggestion\)/u, "局部候选必须紧邻原文插入，不能移到整个段落之后");
assert.match(app, /const suggestion = document\.createElement\("span"\)[\s\S]{0,320}dataset\.inlineEditSuggestion/u, "局部候选必须使用可嵌入正文字符位置的节点");
assert.doesNotMatch(app, /message\.inlineEditResult\s*\?[^\n]*renderInlineEditResult\(message\)/u, "局部差异不得重复显示在右侧对话区");
assert.match(styles, /\.inline-edit-original\s*\{[\s\S]{0,240}#b42318[\s\S]{0,240}line-through/u);
assert.match(styles, /\.inline-edit-original\.protected\s*\{[\s\S]{0,160}text-decoration:\s*none/u);
assert.match(styles, /\.inline-edit-replacement\.history-diff-added\s*\{[\s\S]{0,180}color:\s*var\(--success/u, "新候选必须以绿色正文显示");
assert.match(styles, /\.inline-edit-conflict/u);
assert.match(styles, /\.inline-edit-conflict-dialog-actions/u, "定位失效选择框必须有独立操作区");
assert.match(styles, /\.selection-edit-form button\s*\{[\s\S]{0,420}width:\s*32px;[\s\S]{0,180}height:\s*32px;[\s\S]{0,220}border-radius:\s*999px;/u, "局部修改发送按钮必须保持等宽等高的正圆形");
assert.match(styles, /\.selection-edit-form button > \.icon\s*\{[\s\S]{0,260}display:\s*grid;[\s\S]{0,260}place-items:\s*center;/u, "局部修改发送图标必须在独立图标盒内水平和垂直居中");

console.log("Inline edit preview, confirmation, cancellation, and caret insertion contracts passed");
