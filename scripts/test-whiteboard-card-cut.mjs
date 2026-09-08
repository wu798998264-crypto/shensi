import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(appSource, /data-whiteboard-action="cut"[\s\S]{0,160}<span>剪切<\/span>/u, "白板卡片右键菜单必须提供剪切");
assert.match(appSource, /const cutWhiteboardCards = \(nodeIds = \[\]\) =>[\s\S]{0,1200}mode: "cut"/u, "单卡片和批量卡片必须进入统一剪切剪贴板");
assert.match(appSource, /const batchActions = new Set\(\[[\s\S]{0,300}"copy", "cut"/u, "白板批量选择必须显示剪切动作");
assert.match(appSource, /key === "x"[\s\S]{0,500}cutWhiteboardCards\(selectedIds\)/u, "Ctrl+X 必须剪切当前白板选中卡片");
assert.match(appSource, /const cutClipboard = clipboard\.mode === "cut"[\s\S]{0,2400}removeCanvasNodeWithRecord/u, "剪切粘贴成功后必须移除源卡片");
assert.match(appSource, /sourceChanged = true/u, "源卡片变化时必须标记为已变化而不静默覆盖");
assert.match(appSource, /ui\.whiteboardClipboard = null/u, "剪切粘贴完成后必须清理内部剪贴板");
assert.match(appSource, /pushWhiteboardHistory\(sourceBeforeCanvas, \{ documentId: sourceDocumentId/u, "跨白板剪切必须将源白板历史记录写入源文档");
assert.match(appSource, /writeWhiteboardCardsToSystemClipboard\(normalizedRecords, \{ mode \}\)/u, "系统剪贴板写入必须保留剪切模式提示");

console.log("Whiteboard card cut, batch cut, cross-board paste and Ctrl+X contracts passed");
