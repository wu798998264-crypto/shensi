import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, styles] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

assert.doesNotMatch(app, /id="document(?:HistoryControls|Undo|Redo|ClearFormat)"/u, "正文历史重复按钮必须从编辑头部移除");
assert.doesNotMatch(app, /id="editorMediaButton"/u, "编辑头部重复媒体按钮必须移除");
assert.match(app, /id="editorMediaInput"[^>]+hidden/u, "底部媒体工具仍需保留共享文件选择器");
assert.match(app, /const syncDocumentEditorHistoryControls = \(\) => \{/u, "历史状态同步钩子必须保留以兼容旧编辑路径");

const toolbarStart = app.indexOf('<nav class="note-rich-toolbar"');
const toolbarEnd = app.indexOf("</nav>", toolbarStart);
assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart, "富文本工具栏标记必须存在");
const toolbar = app.slice(toolbarStart, toolbarEnd);
for (const marker of [
  'data-note-command="undo"',
  'data-note-command="redo"',
  'data-note-command="removeFormat"',
  'data-note-command="bold"',
  'data-note-command="italic"',
  'data-note-command="strikeThrough"',
  'data-note-command="underline"',
  'data-note-command="insertUnorderedList"',
  'data-note-command="insertOrderedList"',
  'data-note-command="justifyLeft"',
  'data-note-command="justifyCenter"',
  'data-note-command="justifyRight"',
  'data-note-command="insertHorizontalRule"',
  'data-note-action="format-painter"',
  'data-note-action="checklist"',
  'data-note-action="link"',
  'data-note-action="table"',
  'data-note-action="media"',
  'data-note-block="p"',
  'data-note-block="h1"',
  'data-note-block="h2"',
  'data-note-block="h3"',
  'data-note-block="blockquote"',
  'data-note-block="pre"',
]) assert.match(toolbar, new RegExp(marker.replace(/["']/g, "\\$&")), `${marker} 必须出现在工具栏`);

for (const handler of [
  /runDocumentEditorHistoryCommand\(command\)/u,
  /runNoteEditorCommand\(command\)/u,
  /runNoteEditorCommand\("formatBlock", blockButton\.dataset\.noteBlock\)/u,
  /action === "format-painter"[\s\S]{0,80}captureNoteFormat\(\)/u,
  /action === "checklist"[\s\S]{0,80}applyNoteChecklist\(\)/u,
  /action === "link"[\s\S]{0,100}openNoteLinkDialog\(\)/u,
  /action === "table"[\s\S]{0,220}openNoteTableSizePicker\(actionButton\)/u,
  /action === "media"[\s\S]{0,180}elements\.editorMediaInput\.click\(\)/u,
]) assert.match(app, handler, `工具栏控制必须有实际处理逻辑：${handler}`);

assert.match(toolbar, /noteColorPickerMarkup\("foreColor"/u, "文字颜色控件必须出现在工具栏");
assert.match(toolbar, /noteColorPickerMarkup\("hiliteColor"/u, "高亮颜色控件必须出现在工具栏");
assert.match(app, /chooseNoteEditorColor\(command, colorPreset\.dataset\.noteColorValue/u, "文字与高亮颜色必须执行真实编辑命令");
assert.match(app, /return command === "foreColor" \? "#000000" : ""/u, "文字颜色默认值必须为纯黑，高亮默认值必须为空");
assert.match(app, /noteColorDisplayValue = \(command\) => noteColorPreferences\[command\] \|\| \(command === "hiliteColor" \? "无" : "#000000"\)/u, "工具栏状态必须显示纯黑和高亮无的默认值");
assert.match(app, /Missing preferences use the current defaults/u, "升级时缺失颜色偏好必须使用当前默认值并保留显式选择");
assert.match(app, /const applyNoteChecklist = \(\) => \{[\s\S]{0,180}document\.execCommand\("insertUnorderedList"/u, "任务列表必须执行真实列表命令");
assert.match(app, /const applyCapturedNoteFormat = \(\) => \{[\s\S]{0,1200}ui\.noteFormatPainter = null/u, "格式刷必须能应用并结束一次复制状态");
assert.match(app, /insertNoteTable\(\{ rows, columns \}\)/u, "表格尺寸选择必须真正插入表格");
assert.match(app, /noteToolbarControlKey/u, "主工具栏与更多菜单必须共享稳定操作键");
assert.match(app, /noteToolbarControlFullyVisible/u, "工具栏必须按实际裁切状态分配重复操作");
assert.equal((app.match(/elements\.editorMediaInput\.click\(\)/gu) ?? []).length, 1, "媒体操作只能调用一次共享文件选择器");

assert.match(styles, /\.note-color-presets\s*\{[\s\S]{0,180}grid-auto-rows:\s*28px/u, "颜色网格必须锁定正方形行高");
assert.match(styles, /\.note-color-swatch\s*\{[\s\S]{0,260}width:\s*28px\s*!important[\s\S]{0,160}min-height:\s*28px\s*!important[\s\S]{0,80}max-height:\s*28px\s*!important/u, "颜色卡必须覆盖全局按钮最小高度并保持正方形");
assert.doesNotMatch(app, /note-color-trigger-indicator/u, "颜色状态不得再使用独立色条或色点节点");
assert.match(app, /note-color-icon[^>]+data-note-color-glyph="\$\{iconCode\}"/u, "颜色图标必须携带自身字形用于局部着色");
assert.match(styles, /\.note-color-trigger\[data-note-color-toggle="foreColor"\] \.note-color-icon::before[\s\S]{0,260}background:\s*var\(--note-control-color/u, "文字颜色必须由 A 图标下方的内部色块显示");
assert.match(styles, /\.note-color-trigger\[data-note-color-toggle="foreColor"\] \.note-color-icon::after[\s\S]{0,140}clip-path:\s*inset\(100%/u, "文字颜色不得覆盖 A 图标或其外轮廓");
assert.match(styles, /\.note-color-trigger\[data-note-color-toggle="hiliteColor"\] \.note-color-icon::after[\s\S]{0,140}clip-path:\s*inset\(100%/u, "高亮颜色不得覆盖荧光笔外轮廓");
assert.match(styles, /\.note-color-trigger\[data-note-color-toggle="hiliteColor"\] \.note-color-icon::before[\s\S]{0,120}inset:\s*0[\s\S]{0,120}background:\s*var\(--note-control-color/u, "高亮颜色必须使用图标内部填充层");
assert.match(styles, /\.note-color-trigger\[data-note-color-toggle="hiliteColor"\] \.note-color-icon::before[\s\S]{0,180}z-index:\s*-1[\s\S]{0,220}clip-path:\s*polygon\([\s\S]{0,260}90\.625%/u, "高亮颜色必须位于原色轮廓下方并只填充笔尖内部区域");
assert.match(app, /cached\?\.prepared === true[\s\S]{0,260}resumePointerUnchanged/u, "工作区切换必须复用未变化的已准备缓存");

console.log("v2.19.8 editor toolbar, color swatches, and workspace switch regression tests passed");
