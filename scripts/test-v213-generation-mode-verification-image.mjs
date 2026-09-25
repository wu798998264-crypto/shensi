import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, styles, worker] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
]);

assert.match(app, /id="whiteboardVideoMode" hidden/);
assert.match(app, /id="whiteboardVideoModeTrigger"/);
assert.match(app, /id="whiteboardVideoModeMenu"[^>]*role="listbox"/);
const videoToolbar = app.slice(app.indexOf('<div class="whiteboard-generation-bottom-options whiteboard-video-options">'), app.indexOf('<footer class="whiteboard-generation-footer">', app.indexOf('<div class="whiteboard-generation-bottom-options whiteboard-video-options">')));
assert.doesNotMatch(videoToolbar, /whiteboard-media-connection-option[^\n]+whiteboard-media-option-leading[^>]*>[^<]*\$\{icon\(/);
assert.doesNotMatch(videoToolbar, /whiteboard-media-model-option[^\n]+whiteboard-media-option-leading[^>]*>[^<]*\$\{icon\(/);
assert.doesNotMatch(videoToolbar, /whiteboard-media-mode-option[^\n]+icon\("\\uE713"/);
assert.match(app, /id="whiteboardVideoModeMenu"[^>]*popover="manual"/, "mode list must use the browser top layer");
assert.match(app, /positionWhiteboardFloatingDropup/, "drop-up lists must be positioned outside clipped card containers");
assert.match(app, /trigger\.closest\("\.whiteboard-media-picker, \.whiteboard-media-mode-option"\)/, "ordinary drop-up lists must match the complete control width, including the leading label");
assert.match(app, /window\.innerHeight - controlRect\.top \+ gap/, "drop-up lists must anchor above their complete control");
assert.match(styles, /minmax\(126px, \.92fr\)/, "video mode slot must preserve the complete selected option and its disclosure icon");
assert.match(styles, /minmax\(140px, 1\.05fr\) minmax\(184px, 1\.40fr\) minmax\(126px, \.92fr\) minmax\(212px, 1\.45fr\)/, "only eight pixels may move from the video model slot to settings so the audio-state icon remains visible without changing connection or mode");
assert.match(app, /id="whiteboardImageConnectionTrigger"/);
assert.match(app, /id="whiteboardImageModelTrigger"/);
assert.match(app, /id="whiteboardVideoConnectionTrigger"/);
assert.match(app, /id="whiteboardVideoModelTrigger"/);
assert.match(app, /id="whiteboardFullscreenButton"/);
assert.doesNotMatch(app, /data-note-action="fullscreen"/u, "富文本工具栏不再重复提供全屏入口");
assert.match(app, /elements\.noteRichToolbar\.hidden = isWhiteboard \|\| previewMode/u, "作品正文必须复用笔记富文本工具栏");
assert.match(styles, /\.whiteboard-media-connection-option[\s\S]+::after \{[\s\S]+display: none/u, "媒体连接选择器只保留按钮内部的展开箭头");
assert.doesNotMatch(app, /当前\$\{workspaceKindLabel\(\)\}历史对话/u, "当前作品或笔记本对话入口不再显示‘历史’二字");
assert.match(app, /当前\$\{workspaceKindLabel\(\)\}对话/u);
assert.match(app, /data-new-conversation><span class="conversation-new-button-content">/u);
assert.match(styles, /\.conversation-new-button-content\s*\{[\s\S]{0,180}display:\s*inline-flex;[\s\S]{0,180}align-items:\s*center;[\s\S]{0,180}justify-content:\s*center;[\s\S]{0,180}white-space:\s*nowrap;/u);
assert.match(app, /id="whiteboardImageModelMenu"[^>]*popover="manual"/);
assert.match(app, /id="whiteboardVideoModelMenu"[^>]*popover="manual"/);
assert.match(styles, /\.whiteboard-media-picker-menu[\s\S]+position: fixed/);
assert.match(app, /const compactWhiteboardMediaModelLabel = \(model\) => \{[\s\S]{0,220}replace\(\/\\s\*\[（\(\]\(\?:即梦\|Dreamina\)\\s\+CLI\[）\)\]\\s\*\$\/iu, ""\)/u, "白板媒体型号应隐藏冗余的即梦 CLI 后缀");
assert.match(app, /title="\$\{escapeHtml\(model\.label \|\| model\.slug\)\}"[^>]*>\$\{escapeHtml\(compactWhiteboardMediaModelLabel\(model\)\)\}<\/option>/u, "白板媒体型号应保留完整悬停标题并显示精简名称");
assert.match(styles, /\.whiteboard-media-picker-menu button > span\s*\{[\s\S]{0,220}text-overflow:\s*ellipsis;[\s\S]{0,120}white-space:\s*nowrap;/u, "白板媒体型号菜单不得把单个型号拆成多行");
assert.match(app, /const opening = !whiteboardFloatingMenuIsOpen\(picker\.menu\)/u, "媒体模型菜单必须以 popover 实际状态作为唯一开关依据");
assert.match(app, /picker\.menu\?\.addEventListener\("toggle"[\s\S]{0,320}syncWhiteboardFloatingDropupState/u, "popover 状态变化必须同步 hidden 与 aria-expanded");
assert.match(app, /const exceptMenu = except\?\.menu \|\| except;[\s\S]{0,180}picker\.menu === exceptMenu/u, "关闭其他模型菜单时必须按稳定 DOM 身份排除当前菜单");
assert.match(app, /scheduleWhiteboardGenerateControlsRender/u, "文本模型切换必须合并同一帧内的重复重绘");
assert.match(styles, /\.dreamina-account-metrics > span\s*\{/);
assert.doesNotMatch(styles, /\.dreamina-account-metrics > span \+ span::before/);
assert.doesNotMatch(app, /data-dreamina-metric="expires"/);
assert.match(app, /"seedance2\.5",\s*"seedance2\.0_vip",\s*"seedance2\.0fast_vip",\s*"seedance2\.0mini",\s*"seedance2\.0",\s*"seedance2\.0fast",\s*"seedance1\.5pro",\s*"seedance1\.0fast",\s*"seedance1\.0"/);
assert.match(styles, /\.whiteboard-card-generation-type[\s\S]+top: 50%;[\s\S]+left: 50%;[\s\S]+background: transparent/);
assert.doesNotMatch(app, /<legend>生成音频\s*<small[^>]*>\?<\/small>/);

const transformMenuStart = app.indexOf('id="whiteboardTransformMenu"');
const transformMenu = app.slice(transformMenuStart, transformMenuStart + 1200);
assert.match(transformMenu, /data-whiteboard-action="upload-skill"[\s\S]*<span>转化为 Skill<\/span>/);
assert.doesNotMatch(transformMenu, /上传为 Skill/);

assert.match(app, /trigger\.textContent = "正在准备…"/);
assert.match(app, /await new Promise\(\(resolvePaint\) => requestAnimationFrame\(resolvePaint\)\)/);
assert.match(app, /void continueDreaminaProfileVerification/);
assert.match(app, /const dreaminaVerificationTasks = new Map\(\)/);

const imageStart = worker.indexOf("const processImageJob = async");
const providerDownloadStart = worker.indexOf("const downloadProviderResult = async");
assert.ok(imageStart >= 0 && providerDownloadStart > imageStart);
const imageCompletionPath = worker.slice(imageStart, providerDownloadStart);
assert.doesNotMatch(imageCompletionPath, /\bdriver\./, "OpenAI image completion must not reference a provider-driver variable");
assert.doesNotMatch(imageCompletionPath, /\bcurrent\.providerCreditCount\b/, "Dreamina credit calibration must not run in the OpenAI image path");

const providerCompletionPath = worker.slice(providerDownloadStart, worker.indexOf("const processProviderJob", providerDownloadStart));
assert.match(providerCompletionPath, /recordDreaminaProfileCreditEstimate/);
assert.match(providerCompletionPath, /\["dreamina-image-cli", "dreamina-video-cli"\]\.includes\(driver\.id\)/);

console.log("v2.13.0 generation mode, account verification response, and GPT image completion regression tests passed");
