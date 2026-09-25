import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const app = await readFile(resolve(root, "src/app.js"), "utf8");

// The visible contenteditable is rebuilt when references or a failed provider
// update changes the generation form.  A native Range can be transiently
// detached during that replacement, so the renderer must fall back to the
// last logical offsets saved by the editor.
assert.match(app, /preservedSelection = preservedFocus\s*\n\s*\? whiteboardRichPromptSelectionOffsets\(tray\) \|\| form\._whiteboardRichPromptSelectionOffsets \|\| null/u,
  "强制重绘时必须使用最近一次稳定的逻辑选区作为光标回退");
assert.match(app, /requestAnimationFrame\(\(\) => \{[\s\S]{0,700}safeToRestore[\s\S]{0,220}placeWhiteboardRichPromptSelectionAtOffsets\(form, preservedSelection, \{ focus: true \}\)/u,
  "原生 dialog 重置焦点后必须在下一帧恢复光标");
assert.match(app, /const safeToRestore = dialog\?\.open[\s\S]{0,180}active === dialog \|\| !active/u,
  "光标恢复不得抢走用户已经点击的按钮或菜单焦点");
assert.match(app, /editor\?\.addEventListener\("input", \(event\) => \{[\s\S]{0,240}syncWhiteboardRichPromptValue\(form\)/u,
  "恢复后的输入必须继续同步到隐藏提交字段");
assert.match(app, /editor\?\.addEventListener\("click", \(event\) => \{[\s\S]{0,520}placeWhiteboardGenerationReferenceDropCaret\(editor, event\.clientX, event\.clientY\)/u,
  "点击重绘后的提示词文字时必须按实际点击坐标恢复光标，而不是固定跳到末尾");
assert.match(app, /(?:let|const) hasLiveSelection =[\s\S]{0,320}editor\.focus\(\{ preventScroll: true \}\);[\s\S]{0,800}if \(hasLiveSelection\) rememberWhiteboardRichPromptSelection/u,
  "捕获 pointerdown 时不得抢先把用户光标强行放到末尾");

console.log("whiteboard generation caret recovery contract passed");
