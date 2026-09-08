import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(app, /id="historyPreviewDialog"/u);
assert.match(app, /const openHistoryPreview = /u);
assert.match(app, /data-preview-version=/u);
assert.match(app, /data-preview-document=/u);
assert.match(app, /renderHistoryDiff/u);
assert.match(styles, /history-preview-dialog/u);
assert.match(styles, /history-preview-body/u);

console.log(JSON.stringify({
  ok: true,
  contract: "passed",
  manualScreenshot: "pending",
  message: "历史版本预览结构与样式契约通过；仍需在桌面界面逐项点击并人工确认截图。",
}));
