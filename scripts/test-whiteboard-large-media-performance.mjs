import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [app, styles] = await Promise.all([
  readFile(resolve(root, "src", "app.js"), "utf8"),
  readFile(resolve(root, "src", "styles.css"), "utf8"),
]);

assert.match(app, /\["text", "generated", "web", "skill", "reference", "image", "video", "audio"\]\.includes\(visibleNode\.kind\)/u,
  "低缩放总览必须覆盖文字、图片、视频和音频卡片");
assert.match(app, /img\[data-whiteboard-deferred-src\][\s\S]{0,1800}WHITEBOARD_DEFERRED_IMAGE_BATCH/u,
  "总览图片必须通过受限批次延迟挂载");
assert.match(app, /visibleNode\.kind === "video"[\s\S]{0,1500}data-attachment-src=[\s\S]{0,900}whiteboard-card-overview-placeholder/u,
  "低缩放视频必须使用缩略图或静态占位而不是播放器");
assert.match(app, /WHITEBOARD_MEDIA_VIRTUALIZATION_THRESHOLD\s*=\s*8[\s\S]{0,4000}mediaNodeCount\s*<\s*WHITEBOARD_MEDIA_VIRTUALIZATION_THRESHOLD/u,
  "视频较多的中小型白板也必须启用视口虚拟化");
assert.match(app, /activeVideo[\s\S]{0,6500}whiteboard-card-media-shell dormant whiteboard-card-video-poster/u,
  "未播放的视频卡片必须只挂载静态封面");
assert.match(app, /whiteboardActiveVideoKeys\.add\(whiteboardActiveVideoKey\(nodeId\)\)[\s\S]{0,500}activateDormantWhiteboardVideo\(card\)[\s\S]{0,160}video\.play/u,
  "点击静态封面时必须按需创建并播放对应视频");
assert.match(app, /whiteboardActiveVideoKeys\.delete\(whiteboardActiveVideoKey\(nodeId\)\)[\s\S]{0,300}scheduleWhiteboardDormantVideoRefresh/u,
  "视频结束或点击卡片外部后必须恢复休眠封面");
assert.match(app, /<video class="whiteboard-card-video"[^>]+controls preload="none"/u,
  "被用户唤醒的完整视频卡片也不得预读媒体");
assert.match(app, /<audio class="whiteboard-card-audio"[^>]+controls preload="none"/u,
  "完整音频卡片不得在未播放时预读媒体");
assert.match(app, /whiteboard-asset-media-preview whiteboard-static-video-preview/u,
  "资产列表必须使用静态视频封面");
assert.match(app, /whiteboard-card-history-media whiteboard-static-video-preview/u,
  "卡片历史版本必须使用静态视频封面");
assert.match(app, /whiteboard-generation-reference-preview video whiteboard-static-video-preview/u,
  "生成操作栏里的视频参考必须使用静态封面");
assert.match(app, /const emptyPlainCard =[\s\S]{0,420}const overviewLabel = emptyPlainCard\s*\? ""/u,
  "空白普通卡片在总览中不得显示“文字卡片”占位");
assert.match(app, /\["文字卡片", "普通卡片"\]\.includes\(plainCardName\)/u,
  "旧版本遗留的普通卡片占位名也必须按空白表面显示");
assert.match(app, /<textarea data-canvas-text=[^>]+aria-label=[^>]+\$\{editing/u,
  "普通卡片必须继续保留可编辑 textarea");
assert.doesNotMatch(app, /<textarea data-canvas-text=[^>]+placeholder="\$\{escapeHtml\(uiText\(generating \? "" : "双击编辑…"\)\)\}"/u,
  "空白普通卡片表面不得显示编辑提示文字");
assert.match(app, /attachmentPreviewDialog\.close\(\);[\s\S]{0,700}removeAttribute\("src"\)[\s\S]{0,500}replaceChildren\(\)/u,
  "附件预览必须先退出模态状态再释放媒体资源");
assert.match(app, /cancelWhiteboardMediaHydration\(\);[\s\S]{0,700}whiteboardSurface\.replaceChildren\(\)[\s\S]{0,180}delete elements\.whiteboardSurface\.dataset\.renderIdentity/u,
  "离开白板后必须在空闲阶段释放休眠媒体 DOM");
assert.match(styles, /\.whiteboard-edge-flow \{[\s\S]{0,420}opacity: 0;[\s\S]{0,260}animation: none;/u,
  "静止连线不得永久运行流光动画");
assert.match(styles, /\.whiteboard-edge-group:is\(\.selected, :hover\) \.whiteboard-edge-flow \{[\s\S]{0,320}animation: whiteboard-edge-flow/u,
  "选中或悬停连线仍应提供方向动画反馈");

console.log("large whiteboard media performance contract passed");
