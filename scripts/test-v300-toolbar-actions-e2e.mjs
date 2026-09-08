import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const commands = [
  "undo", "redo", "removeFormat", "bold", "italic", "strikeThrough", "underline",
  "insertUnorderedList", "insertOrderedList", "justifyLeft", "justifyCenter", "justifyRight", "insertHorizontalRule",
];
const blocks = ["p", "h1", "h2", "h3", "blockquote", "pre"];
const actions = ["format-painter", "checklist", "link", "table", "media"];

for (const command of commands) {
  assert.match(app, new RegExp(`data-note-command="${command}"`, "u"), `工具栏缺少 ${command}`);
}
for (const block of blocks) {
  assert.match(app, new RegExp(`data-note-block="${block}"`, "u"), `工具栏缺少 ${block}`);
}
for (const action of actions) {
  assert.match(app, new RegExp(`data-note-action="${action}"`, "u"), `工具栏缺少 ${action}`);
}
assert.match(app, /if \(\["undo", "redo"\]\.includes\(command\)\) runDocumentEditorHistoryCommand\(command\)/u, "撤销与重做必须走真实编辑历史");
assert.match(app, /else runNoteEditorCommand\(command\)/u, "文本样式命令必须走真实编辑器命令");
assert.match(app, /runNoteEditorCommand\("formatBlock", blockButton\.dataset\.noteBlock\)/u, "段落块必须走真实格式命令");
assert.match(app, /captureNoteFormat\(\)/u, "格式刷必须有处理器");
assert.match(app, /applyNoteChecklist\(\)/u, "核对清单必须有处理器");
assert.match(app, /openNoteLinkDialog\(\)/u, "插入链接必须打开输入框");
assert.match(app, /openNoteTableSizePicker\(actionButton\)/u, "插入表格必须打开尺寸选择器");
assert.match(app, /insertNoteTable\(\{ rows, columns \}\)/u, "表格尺寸选择必须写入表格");
assert.match(app, /elements\.editorMediaInput\.click\(\)/u, "媒体按钮必须只触发同一个文件选择器");
assert.match(app, /elements\.editorMediaInput\.addEventListener\("change", async \(\) =>/u, "媒体选择后必须有真实处理器");
assert.match(app, /insertLocalMediaFilesAtEditor\(files\)/u, "媒体文件必须插入当前编辑位置");
assert.match(app, /const command = colorPreset\.dataset\.notePresetColor;[\s\S]{0,160}chooseNoteEditorColor\(command, colorPreset\.dataset\.noteColorValue/u, "预设文字颜色必须实际应用");
assert.match(app, /const command = event\.target\.dataset\.noteColor;[\s\S]{0,120}chooseNoteEditorColor\(command, event\.target\.value\)/u, "自定义颜色必须实际应用");

console.log("v3.0 富文本工具栏真实处理器覆盖测试通过；隔离 Electron UI 回读由 test-main-ui-menu-image-editor.mjs 执行");
