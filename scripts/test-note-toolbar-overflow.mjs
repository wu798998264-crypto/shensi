import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  noteToolbarControlFullyVisible,
  noteToolbarControlKey,
  noteToolbarDuplicateAssignment,
  rectFullyVisibleWithin,
} from "../src/note-toolbar-overflow.js";

const rect = (left, right, top = 0, bottom = 30) => ({
  left,
  right,
  top,
  bottom,
  width: right - left,
  height: bottom - top,
});

const primaryRect = rect(0, 100);
assert.equal(rectFullyVisibleWithin(rect(10, 40), [primaryRect]), true, "完整容纳的按钮应留在主工具栏");
assert.equal(rectFullyVisibleWithin(rect(80, 110), [primaryRect]), false, "被 overflow:hidden 裁切的按钮不得算作可见");
assert.equal(rectFullyVisibleWithin(rect(-5, 25), [primaryRect]), false, "左侧被裁切的按钮不得算作可见");
assert.equal(rectFullyVisibleWithin(rect(20, 50, -4, 26), [primaryRect]), false, "垂直裁切也必须被识别");

const primary = { getBoundingClientRect: () => primaryRect };
const fakeControl = (box) => ({
  dataset: { noteAction: "media" },
  hidden: false,
  parentElement: primary,
  getBoundingClientRect: () => box,
  getClientRects: () => [box],
});
const visibleControl = fakeControl(rect(60, 90));
const clippedControl = fakeControl(rect(80, 110));
const visibleStyle = () => ({ display: "inline-flex", visibility: "visible", overflowX: "visible", overflowY: "visible" });
assert.equal(noteToolbarControlFullyVisible(visibleControl, primary, { getStyle: visibleStyle }), true);
assert.equal(noteToolbarControlFullyVisible(clippedControl, primary, { getStyle: visibleStyle }), false);
assert.equal(noteToolbarControlKey(visibleControl), "action:media", "媒体操作必须有稳定键");
assert.equal(noteToolbarControlKey({ dataset: { noteCommand: "bold" } }), "command:bold");
assert.equal(noteToolbarControlKey({ dataset: { noteBlock: "h1" } }), "block:h1");

for (const [label, fits] of [
  ["窄窗口", false],
  ["普通窗口", true],
  ["宽屏", true],
  ["全屏", true],
]) {
  const assignment = noteToolbarDuplicateAssignment({ hasPrimary: true, primaryFullyVisible: fits });
  assert.equal(Number(!assignment.primaryHidden) + Number(!assignment.moreHidden), 1, `${label}只能保留一个媒体入口`);
}

for (let index = 0; index < 8; index += 1) {
  const assignment = noteToolbarDuplicateAssignment({ hasPrimary: true, primaryFullyVisible: index % 2 === 0 });
  assert.notEqual(assignment.primaryHidden, assignment.moreHidden, "重复展开、折叠和缩放后仍必须互斥显示");
}

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /primaryControlList\.forEach[\s\S]{0,260}control\.hidden = false/u, "重算前必须恢复主栏副本以支持窗口变宽");
assert.match(app, /document\.fonts\?\.ready\?\.then\(scheduleNoteToolbarLayout\)/u, "字体布局完成后必须重算工具栏");
assert.match(app, /new ResizeObserver\(scheduleNoteToolbarLayout\)/u, "工具栏尺寸变化必须触发重算");
assert.match(app, /window\.addEventListener\("resize", scheduleNoteToolbarLayout\)/u, "窗口缩放必须触发重算");
assert.equal((app.match(/elements\.editorMediaInput\.click\(\)/gu) ?? []).length, 1, "媒体按钮只能打开一次文件选择器");

console.log("note toolbar overflow and duplicate assignment tests passed");
