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
const historyActions = styles.slice(styles.indexOf(".history-actions {"), styles.indexOf(".history-actions > button:hover"));
assert.match(historyActions, /flex-wrap:\s*nowrap/u, "历史版本动作区必须保持横排");
assert.match(historyActions, /min-width:\s*max-content/u, "历史版本动作区不得被压缩成逐字竖排");
assert.match(historyActions, /white-space:\s*nowrap/u, "设为当前按钮文字必须保持横向单行");
assert.match(historyActions, /writing-mode:\s*horizontal-tb/u, "历史版本文字方向必须固定为横向");

console.log(JSON.stringify({
  ok: true,
  contract: "passed",
  manualScreenshot: "pending",
  message: "历史版本预览结构与样式契约通过；仍需在桌面界面逐项点击并人工确认截图。",
}));
