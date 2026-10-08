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
assert.match(appSource, /const whiteboardClipboardNode = \(node, documentId = state\.activeDocument\) =>/u, "复制卡片必须读取尚未回写但已验证的媒体候选");
assert.match(appSource, /whiteboardClipboardNode\(record\.node\)/u, "单卡片和批量复制必须使用物化后的媒体节点");
assert.match(appSource, /const whiteboardClipboardMediaChannel = \(node\) =>/u, "复制前必须识别生成目标的媒体通道");
assert.match(appSource, /当前媒体卡片尚未完成落盘，暂时不能复制空卡片/u, "未落盘媒体卡片不得复制为空白卡片");
assert.match(appSource, /const clipboardHtmlImageFile = async \(clipboardData\) =>/u, "外部 HTML 图片剪贴板必须可转换为白板图片文件");
assert.match(appSource, /const externalMediaHint = files\.length[\s\S]{0,260}clipboardTypes\.some\(\(type\) => type\.startsWith\("image\/"\)\)/u, "外部图片存在时不得被内部白板剪贴板抢先消费");
assert.match(appSource, /const whiteboardClipboardFilesMatch = async \(files, clipboard\) =>/u, "菜单粘贴必须核对系统剪贴板是否仍是内部白板卡片");
assert.match(appSource, /matchesInternal[\s\S]{0,180}pasteWhiteboardCard\(point\)/u, "外部文件剪贴板不得被旧的内部卡片抢先消费");
assert.match(appSource, /const mimeType = String\(record\.mimeType \|\| attachmentMimeType\(\{ name, type: "" \}\)\)/u, "系统文件剪贴板读取必须恢复图片 MIME 类型");

console.log("Whiteboard card cut, batch cut, cross-board paste and Ctrl+X contracts passed");
