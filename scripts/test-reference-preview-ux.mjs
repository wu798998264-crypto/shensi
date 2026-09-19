import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { previewQuanbenChapter } from "../src/server/quanben-book-source.mjs";

const [appSource, styleSource, serverSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
]);

assert.match(appSource, /id="whiteboardFindButton"[\s\S]{0,180}Ctrl \+ F/u, "白板工具栏必须提供可见的查找入口");
assert.match(appSource, /id="whiteboardFindPrevious"[\s\S]{0,260}id="whiteboardFindNext"/u, "白板查找必须提供与正文一致的逐项导航");
assert.match(appSource, /id="whiteboardFindReplaceCurrent"[\s\S]{0,220}id="whiteboardFindReplaceAll"/u, "白板查找必须同时提供当前替换和全部替换");
assert.match(appSource, /const textPreviewOpen = Boolean[\s\S]{0,900}textPreviewOpen \|\| activeWhiteboardDocument\(\)/u, "文字卡片预览必须允许 Ctrl+F 进入白板查找");
assert.match(appSource, /const previewSurface =[\s\S]{0,700}kind: "preview"[\s\S]{0,500}attachmentTextPreviewState\.editing/u, "预览阅读态必须支持查找，只有预览编辑态才能替换");
assert.match(appSource, /key: `card:\$\{nodeId\}`[\s\S]{0,420}surface: element\?\.querySelector\("\[data-canvas-text\]"\)[\s\S]{0,300}editable:/u, "普通卡片编辑区必须成为可查找替换目标");
assert.match(appSource, /key: `prompt:\$\{config\.channel\}:\$\{nodeId\}`[\s\S]{0,360}surface[\s\S]{0,260}serializeWhiteboardRichPrompt/u, "生成操作栏必须按可见富文本提示词查找");
assert.match(appSource, /const renderWhiteboardFindTextareaHighlights[\s\S]{0,1700}whiteboard-find-text-active/u, "textarea 卡片与预览编辑器必须渲染逐字高亮层");
assert.match(appSource, /CSS\.highlights\.set\("shensi-whiteboard-find"[\s\S]{0,220}CSS\.highlights\.set\("shensi-whiteboard-find-active"/u, "富文本提示词与阅读预览必须区分普通命中和当前命中");
assert.match(appSource, /anchorRect\.top - panelRect\.height - 8/u, "白板查找面板必须定位在当前操作栏或编辑目标上方");
assert.match(appSource, /const applyWhiteboardFindSourceText[\s\S]{0,1000}scheduleAttachmentTextPreviewDraft\(\)/u, "预览替换必须先写入独立草稿而非绕过阅读按钮直接落盘");
assert.match(appSource, /const commitWhiteboardFindCardMutation[\s\S]{0,500}pushWhiteboardHistory[\s\S]{0,240}persist\(\{ documentIds: \[state\.activeDocument\] \}\)/u, "普通卡片替换必须保留白板历史并定向落盘");
assert.match(styleSource, /\.whiteboard-find-panel\s*\{[\s\S]{0,220}position:\s*fixed;[\s\S]{0,260}width:\s*min\(560px/u, "白板查找面板必须使用稳定的悬浮尺寸");
assert.match(styleSource, /textarea\.whiteboard-find-textarea-source[\s\S]{0,480}-webkit-text-fill-color:\s*transparent/u, "textarea 高亮层必须避免原文字与镜像文字重影");
assert.match(styleSource, /::highlight\(shensi-whiteboard-find\)[\s\S]{0,260}::highlight\(shensi-whiteboard-find-active\)/u, "白板普通命中和当前命中必须使用两种颜色");
assert.doesNotMatch(appSource, /data-whiteboard-text-(?:edit|cancel)(?:[\s=>])/u, "普通文字卡片不应重复渲染编辑或取消按钮");
assert.doesNotMatch(styleSource, /\.whiteboard-card-text-actions/u, "普通文字卡片不应保留废弃的悬浮编辑按钮样式");
assert.match(appSource, /addEventListener\("dblclick"[\s\S]{0,1600}else startWhiteboardEditing\(card\)/u, "文字卡片必须继续支持双击编辑");
assert.match(appSource, /data-whiteboard-action="edit-text"/u, "文字卡片右键菜单必须继续提供编辑入口");
assert.match(appSource, /if \(action === "edit-text" && context\.nodeId\) \{[\s\S]{0,260}startWhiteboardEditing\(card\)/u, "文字卡片右键编辑必须继续调用原编辑流程");
assert.match(appSource, /id="attachmentPreviewContent"[\s\S]{0,500}id="attachmentPreviewTextActions"[\s\S]{0,500}id="toggleAttachmentTextEdit"/u, "文字预览正文表面右上角必须提供编辑操作");
assert.match(appSource, /id="cancelAttachmentTextEdit"[\s\S]{0,160}icon\("\\uE72B"[\s\S]{0,260}id="toggleAttachmentTextEdit"[\s\S]{0,160}icon\("\\uE70F"/u, "预览必须沿用文档返回与编辑图标");
assert.match(appSource, /const openWhiteboardTextCardPreview[\s\S]{0,900}preview\.dataset\.whiteboardPreviewNodeId = nodeId[\s\S]{0,360}openAttachmentPreview\(preview\)/u, "当前卡片预览必须携带节点身份");
assert.match(appSource, /\["text", "generated", "skill", "reference"\]\.includes\(node\?\.kind\)/u, "文字、生成、Skill 与引用小说卡片必须共用内容预览入口");
assert.match(appSource, /if \(\["skill", "reference"\]\.includes\(node\?\.kind\)\)[\s\S]{0,120}openWhiteboardTextCardPreview/u, "Skill 与引用小说卡片必须支持双击只读预览");
assert.match(appSource, /data-whiteboard-editable-text[\s\S]{0,100}!\["text", "generated"\]\.includes\(contextNode\?\.kind\)/u, "Skill 与引用小说卡片不得误显示正文编辑入口");
assert.match(appSource, /const activeSourceEditable = Boolean\([\s\S]{0,700}!state\.readOnly[\s\S]{0,180}!whiteboardCandidateFor\(previewNodeId\)/u, "只读或生成中的当前文字卡片预览不得开放编辑入口");
assert.match(appSource, /snapshotCanvasNodeVersion\([\s\S]{0,260}source: "preview-edit"[\s\S]{0,260}updateCanvasTextNode\([\s\S]{0,320}persist\(\{ documentIds: \[previewState\.documentId\] \}\)/u, "预览保存必须先建立卡片历史版本，再更新并定向落盘");
assert.match(appSource, /const assetSourceNode = asset\.kind === "text"[\s\S]{0,1400}data-whiteboard-preview-node-id=/u, "全部资产的当前文字卡片必须把源节点身份交给预览编辑器");
assert.match(appSource, /const saveInactiveAttachmentTextEditing = async[\s\S]{0,2600}snapshotCanvasNodeVersion\([\s\S]{0,260}source: "asset-preview-edit"[\s\S]{0,260}updateCanvasTextNode/u, "跨作品的全部资产文字卡片保存也必须先建立历史版本");
assert.match(appSource, /if \(elements\.whiteboardAssetDialog\.open\) renderWhiteboardAssets\(\)/u, "资产预览保存后必须同步刷新全部资产中的文字内容");
assert.match(appSource, /const cancelAttachmentTextEditing = \(\) => \{[\s\S]{0,360}attachmentTextPreviewState\.editing = false[\s\S]{0,120}renderAttachmentTextPreview\(\)/u, "预览取消必须仅退出编辑并恢复只读内容");
assert.match(appSource, /toggleAttachmentTextEdit\.addEventListener\("click", \(event\) => \{[\s\S]{0,260}event\.stopPropagation\(\)/u, "预览编辑按钮必须阻止图标替换后的点击继续冒泡并关闭预览");
assert.match(appSource, /cancelAttachmentTextEdit\.addEventListener\("click", \(event\) => \{[\s\S]{0,180}event\.stopPropagation\(\)/u, "预览取消按钮必须阻止点击继续冒泡并关闭预览");
assert.match(appSource, /WHITEBOARD_TEXT_PREVIEW_DRAFT_KEY[\s\S]{0,2200}scheduleAttachmentTextPreviewDraft/u, "预览编辑必须提供独立于正式卡片内容的实时草稿保护");
assert.match(appSource, /previewState\.editorViewport = captureAttachmentTextPreviewViewport\(\)[\s\S]{0,260}previewState\.editing = true/u, "进入编辑前必须记录阅读态预览窗口的实际尺寸");
assert.match(appSource, /if \(editing && previewState\.editorViewport\)[\s\S]{0,420}editor\.style\.height = `\$\{previewState\.editorViewport\.height\}px`/u, "编辑器必须保持阅读态预览窗口的原始高度");
assert.doesNotMatch(styleSource, /\.attachment-preview-text-editor\s*\{[^}]*height:\s*min\(70vh,\s*680px\)/u, "编辑态不得再用固定高度缩放预览窗口");
assert.match(styleSource, /\.attachment-preview-content\[data-preview-kind="text"\][\s\S]{0,1800}\.attachment-preview-text-actions\s*\{[\s\S]{0,240}top:\s*8px;[\s\S]{0,120}right:\s*10px;/u, "预览编辑操作必须固定在白色正文表面右上角");
assert.match(styleSource, /#whiteboardAssetShowTrash\s*\{[\s\S]{0,260}height:\s*34px;[\s\S]{0,180}white-space:\s*nowrap/u, "资产回收站按钮必须与同排图标等高且禁止文字堆叠");
assert.match(appSource, /whiteboard-asset-batch-confirm[\s\S]{0,520}<span>确认<\/span>/u, "批量删除或恢复的最终按钮必须使用简洁的“确认”文案");

assert.match(appSource, /data-preview-skill-reference=/u, "Skill 引用行必须提供独立预览按钮");
assert.match(appSource, /const previewSkillId =[\s\S]{0,420}await openSkillDetail/u, "Skill 预览必须复用详情窗口且不直接加入引用");
assert.match(styleSource, /\.reference-tree-leaf-row[\s\S]{0,180}grid-template-columns/u, "Skill 预览按钮必须有稳定布局");

assert.match(serverSource, /pathname === "\/api\/books\/chapter-preview"[\s\S]{0,420}previewQuanbenChapter/u, "服务端必须提供只读章节预览接口");
assert.match(appSource, /data-preview-book-chapter=/u, "小说目录必须提供逐章正文预览入口");
assert.match(appSource, /const openBookChapterPreview = async[\s\S]{0,2400}\/api\/books\/chapter-preview/u, "章节预览入口必须调用只读预览接口");
assert.match(appSource, /预览只读取当前章节，不会加入引用、创建附件或写入作品/u, "预览窗口必须明确显示非落盘边界");
assert.match(styleSource, /\.book-chapter-preview-dialog[\s\S]{0,1200}white-space: pre-wrap/u, "章节正文必须以可滚动且保留中文段落的方式显示");

const chapterText = "这一章用于验证公开章节正文预览。".repeat(24);
const fetchImpl = async () => new Response(`<!doctype html><html><head><title>第一章 归来</title></head><body><article class="chapter-content"><p>${chapterText}</p></article></body></html>`, {
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
});
const lookupImpl = async () => [{ address: "203.0.113.10", family: 4 }];
const dispatcherFactory = () => ({ close: async () => {} });

const preview = await previewQuanbenChapter({
  bookUrl: "https://quanben-xiaoshuo.com/n/demo-book/",
  chapter: { id: "chapter-1", index: 1, title: "第一章 归来", url: "https://quanben-xiaoshuo.com/n/demo-book/chapter-1.html" },
  fetchImpl,
  lookupImpl,
  dispatcherFactory,
});
assert.equal(preview.id, "chapter-1");
assert.equal(preview.title, "第一章 归来");
assert.ok(preview.text.includes("公开章节正文预览"), "章节预览必须返回解析后的正文");
assert.match(preview.sha256, /^[0-9a-f]{64}$/u, "章节预览必须返回内容哈希");

await assert.rejects(
  previewQuanbenChapter({
    bookUrl: "https://quanben-xiaoshuo.com/n/demo-book/",
    chapter: { id: "chapter-2", title: "错误章节", url: "https://quanben-xiaoshuo.com/n/other-book/chapter-2.html" },
    fetchImpl,
    lookupImpl,
    dispatcherFactory,
  }),
  /章节不属于当前作品/u,
  "章节预览必须拒绝跨作品地址",
);

console.log("白板查找、文字预览编辑、Skill 预览与小说章节正文预览契约测试通过");
