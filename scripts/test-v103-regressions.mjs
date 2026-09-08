import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveCrossFormatContentRoute } from "../src/cross-format-content-router.js";
import {
  addCanvasEdge,
  addCanvasTextNode,
  canvasEdgeIdsInRect,
  removeCanvasEdge,
} from "../src/whiteboard.js";
import {
  ackConversationInstruction,
  dequeueReadyConversationInstruction,
  recoverConversationTaskQueue,
  requeueEditedConversationInstruction,
} from "../src/conversation-task-queue.js";
import {
  applyAnchoredTextEdit,
  createAnchoredTextEditContract,
} from "../src/anchored-text-edit.js";
import {
  createDocumentEditHistory,
  recordDocumentEditMutation,
  stepDocumentEditHistory,
} from "../src/document-edit-history.js";
import { defaultAppDataRoot } from "../src/server/app-data.mjs";
import { getDynamicAttachmentLimit } from "../src/conversation-attachment-intake.js";

const docs = [
  { id: "empty", title: "空白文档", contextDomain: "novel" },
  { id: "novel-1", title: "《幻烬》第一章小说", contextDomain: "novel", work: "幻烬" },
  { id: "novel-2", title: "《幻烬》第二章小说", contextDomain: "novel", work: "幻烬" },
  { id: "script-1", title: "《幻烬》第一集剧本", contextDomain: "script", work: "幻烬" },
  { id: "prompt-1", title: "《幻烬》第一集提示词", contextDomain: "prompt", work: "幻烬" },
];

const explicit = resolveCrossFormatContentRoute({
  instruction: "将《幻烬》第一章小说改编为剧本。",
  documents: docs.filter((document) => document.id !== "script-1"),
  associatedDocumentId: "empty",
});
assert.equal(explicit.sourceDocumentId, "novel-1");
assert.equal(explicit.targetContentType, "script");
assert.equal(explicit.targetDocumentId, "");
assert.notEqual(explicit.sourceDocumentId, "empty");

const linked = resolveCrossFormatContentRoute({ instruction: "将其改编为剧本。", documents: docs, associatedDocumentId: "novel-1" });
assert.equal(linked.sourceDocumentId, "novel-1");
assert.equal(linked.targetDocumentId, "script-1");
assert.equal(linked.source.contentType, "novel");

const novelPrompt = resolveCrossFormatContentRoute({ instruction: "根据这一章生成完整的 Seedance 视频提示词。", documents: docs, associatedDocumentId: "novel-1" });
assert.equal(novelPrompt.sourceDocumentId, "novel-1");
assert.equal(novelPrompt.targetContentType, "prompt");
assert.notEqual(novelPrompt.targetDocumentId, "novel-1");

const scriptPrompt = resolveCrossFormatContentRoute({ instruction: "根据当前剧本生成分镜视频提示词。", documents: docs, associatedDocumentId: "script-1" });
assert.equal(scriptPrompt.sourceDocumentId, "script-1");
assert.equal(scriptPrompt.targetDocumentId, "prompt-1");

const reverse = resolveCrossFormatContentRoute({ instruction: "把它改写为小说第一章的新版本。", documents: docs, associatedDocumentId: "script-1" });
assert.equal(reverse.sourceDocumentId, "script-1");
assert.equal(reverse.targetDocumentId, "novel-1");
assert.equal(reverse.operationType, "patch");

const mapped = resolveCrossFormatContentRoute({
  instruction: "将其改编为剧本。",
  documents: docs,
  associatedDocumentId: "novel-1",
  chapterEpisodeMappings: [{ sourceDocumentId: "novel-1", targetContentType: "script", targetDocumentId: "script-1" }],
});
assert.equal(mapped.targetDocumentId, "script-1");
assert.equal(mapped.mappingSource, "workspace_metadata");
assert.equal(resolveCrossFormatContentRoute({ instruction: "帮我润色当前剧本第二场对白。", documents: docs, associatedDocumentId: "script-1" }), null);
assert.equal(resolveCrossFormatContentRoute({ instruction: "第二场节奏太慢，把前半段压缩一点。", documents: docs, associatedDocumentId: "script-1" }), null);

const baseline = "第一场\n女主登场。\n第二场\n旧对白。\n第三场\n结尾。";
const startOffset = baseline.indexOf("旧对白。");
const contract = createAnchoredTextEditContract({ documentId: "script-1", documentText: baseline, startOffset, endOffset: startOffset + 4 });
const manuallyEdited = `用户补充。\n${baseline}`;
const applied = applyAnchoredTextEdit({ contract, currentText: manuallyEdited, replacementText: "精简后的对白。" });
assert.equal(applied.status, "applied");
assert.ok(applied.afterText.startsWith("用户补充。"));
assert.ok(applied.afterText.includes("精简后的对白。"));
assert.ok(!applied.afterText.includes("旧对白。"));

let history = createDocumentEditHistory("A");
history = recordDocumentEditMutation(history, { beforeHtml: "A", afterHtml: "B", inputType: "insertText", at: 1, forceBoundary: true });
const undone = stepDocumentEditHistory(history, "undo", { currentHtml: "B" });
assert.equal(undone.snapshot.html, "A");
const redone = stepDocumentEditHistory(undone.history, "redo", { currentHtml: "A" });
assert.equal(redone.snapshot.html, "B");

let canvas = {};
canvas = addCanvasTextNode(canvas, { id: "n1", x: 0, y: 0, width: 100, height: 100 });
canvas = addCanvasTextNode(canvas, { id: "n2", x: 300, y: 0, width: 100, height: 100 });
canvas = addCanvasTextNode(canvas, { id: "n3", x: 600, y: 0, width: 100, height: 100 });
canvas = addCanvasEdge(canvas, { id: "e1", fromNode: "n1", toNode: "n2" });
canvas = addCanvasEdge(canvas, { id: "e2", fromNode: "n2", toNode: "n3" });
assert.deepEqual(new Set(canvasEdgeIdsInRect(canvas, { left: 101, top: 45, right: 599, bottom: 55 })), new Set(["e1", "e2"]));
for (const edgeId of ["e1", "e2"]) canvas = removeCanvasEdge(canvas, edgeId);
assert.equal(canvas.edges.length, 0);

const conversation = { queue: [
  { id: "q-edit", state: "editing", content: "正在原位编辑" },
  { id: "q-next", state: "queued", content: "后续任务" },
] };
recoverConversationTaskQueue(conversation);
assert.equal(conversation.queue[0].state, "editing");
const editedQueue = { queue: [{ id: "q-edit", state: "editing", content: "旧指令", leaseId: "stale", claimedAt: 10, lastError: "old" }] };
const requeuedEdit = requeueEditedConversationInstruction({ conversation: editedQueue, itemId: "q-edit", content: "重新确认的指令" });
assert.equal(requeuedEdit.id, "q-edit");
assert.equal(requeuedEdit.state, "queued");
assert.equal(requeuedEdit.leaseId, "");
assert.equal(requeuedEdit.lastError, "");
const dispatchedEdit = dequeueReadyConversationInstruction({ conversation: editedQueue, leaseId: "lease-edit" });
assert.equal(dispatchedEdit.id, "q-edit");
assert.equal(dispatchedEdit.content, "重新确认的指令");
assert.equal(editedQueue.queue.length, 1, "编辑重发必须复用原 Queue ID，不能复制新任务");
assert.equal(ackConversationInstruction({ conversation: editedQueue, itemId: "q-edit", leaseId: "lease-edit" }), true);
assert.equal(dequeueReadyConversationInstruction({ conversation: editedQueue, leaseId: "lease-duplicate" }), null, "编辑重发完成后不得再次执行");
const dequeued = dequeueReadyConversationInstruction({ conversation, leaseId: "lease-v103" });
assert.equal(dequeued.id, "q-next");
assert.equal(dequeued.leaseId, "lease-v103");
assert.equal(conversation.queue[0].state, "editing");

assert.ok(getDynamicAttachmentLimit({ provider: "DeepSeek", model: "deepseek-v4-pro" }) > 6);
assert.equal(defaultAppDataRoot({ env: {}, platform: "win32", home: "C:\\Users\\Tester" }), "E:\\ShensiUserData");

const [app, html, css, packageText, desktopPackageText, installerCustomText] = await Promise.all([
  readFile("src/app.js", "utf8"),
  readFile("index.html", "utf8"),
  readFile("src/styles.css", "utf8"),
  readFile("package.json", "utf8"),
  readFile("packaging/windows/desktop-app/package.json", "utf8"),
  readFile("packaging/windows/desktop-app/installer-custom.nsh", "utf8"),
]);
const packageJson = JSON.parse(packageText);
const desktopPackage = JSON.parse(desktopPackageText);
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/u);
assert.equal(desktopPackage.version, packageJson.version);
if (packageJson.build) {
  assert.match(packageJson.build.artifactName, /\$\{version\}.*\$\{env\.SHENSI_BUILD_ID\}/u);
  assert.equal(packageJson.build.win.icon, "public/assets/shensi-app-icon.ico");
  assert.equal(packageJson.build.nsis.createDesktopShortcut, false);
  assert.equal(packageJson.build.nsis.oneClick, false);
} else {
  assert.match(process.cwd().replaceAll("\\", "/"), /\/resources\/app$/u);
}
assert.match(html, new RegExp(packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "u"));
assert.doesNotMatch(html, /data-settings-page=["']diagnostics["']/u);
assert.match(app, /queued-inline-editor/u);
assert.doesNotMatch(app, /scheduleQueuedConversationDispatch/u);
assert.match(app, /scheduleConversationQueueDrain\(conversation\.id\)/u);
assert.match(app, /hasReadyItem && \(dispatching \|\| landingBlocked \|\| running\)/u);
assert.match(app, /fallbackTimer = setTimeout\(dispatchOnce, 100\)[\s\S]{0,120}requestAnimationFrame\(\(\) => setTimeout\(dispatchOnce, 0\)\)/u);
assert.match(app, /const runBoundedExternalWorkspaceRefresh = async/u);
assert.match(app, /runBoundedExternalWorkspaceRefresh\(\{ silent: true \}\)/gu);
assert.match(app, /maxWaitMs = 15_000/u);
assert.match(app, /timedOut: true/u);
assert.doesNotMatch(app, /title:\s*["']修改排队指令["']/u);
assert.match(app, /event\.detail === 3/u);
assert.match(app, /syncGenerationAdapterFields/u);
assert.match(app, /\/api\/skills\/disabled/u);
assert.match(app, /chapterEpisodeMappings/u);
assert.equal((app.match(/id="whiteboardFullscreenButton"/gu) || []).length, 1);
assert.match(app, /elements\.whiteboardFullscreenButton\.hidden = false/u);
assert.match(app, /whiteboardFullscreenButton\?\.addEventListener\("click", async \(\) => \{\s+await toggleEditorFullscreen\(\)/u);
assert.doesNotMatch(css, /\.whiteboard-editor\.whiteboard-fullscreen-active/u);
assert.doesNotMatch(app, /id="editorFullscreenButton"/u);
assert.match(css, /\.editor-pane:fullscreen\s*\{[\s\S]{0,180}grid-template-rows:\s*58px auto auto minmax\(0, 1fr\) 44px/u);
assert.match(css, /\.app-shell\.editor-fullscreen-active \.editor-pane\s*\{[\s\S]{0,160}grid-template-rows:\s*58px auto auto minmax\(0, 1fr\) 44px/u);
assert.doesNotMatch(css, /editor-fullscreen-active \.editor-status\s*\{\s*display:\s*none/u);
const whiteboardPreviewStart = app.indexOf('if (action === "preview"');
const whiteboardPreviewHandler = app.slice(whiteboardPreviewStart, app.indexOf('if (action === "copy"', whiteboardPreviewStart));
assert.match(whiteboardPreviewHandler, /openWhiteboardTextCardPreview/u);
assert.match(css, /\.brand-mark[\s\S]{0,220}border-radius:\s*10px/u);
const sidebarToggleBlock = css.slice(css.indexOf(".left-sidebar-toggle {"), css.indexOf(".left-sidebar-toggle:hover"));
assert.match(sidebarToggleBlock, /right:\s*calc\(100% - 7px\)/u);
assert.match(sidebarToggleBlock, /background:\s*transparent/u);
assert.doesNotMatch(sidebarToggleBlock, /border:\s*1px/u);
assert.match(app, /activateWorkspaceKind\(kindOption\.dataset\.workspaceKind, \{ activatePreferred: false \}\)/u);
assert.match(app, /if \(!activatePreferred\)[\s\S]{0,180}ui\.panel = "projects"/u);
assert.match(installerCustomText, /Page custom ShensiShortcutPageCreate ShensiShortcutPageLeave/u);
assert.match(installerCustomText, /创建桌面快捷方式/u);
assert.match(installerCustomText, /\$ShensiCreateDesktopShortcut == \$\{BST_CHECKED\}[\s\S]{0,240}CreateShortCut/u);
const desktopMain = await readFile("packaging/windows/desktop-app/main.mjs", "utf8");
assert.match(desktopMain, /LOCALAPPDATA[\s\S]{0,180}ShensiCreativeEngine/u);
assert.doesNotMatch(desktopMain, /for \(const drive of \[[^\]]*D:/u);
assert.match(desktopMain, /const logDirs = \[machineLocalDataRoot\]/u);
const firstHydratedRender = app.indexOf("  renderAll();", app.indexOf("const bootstrap = async () =>"));
const firstInteractiveMark = app.indexOf('document.documentElement.dataset.bootReady = "true";', firstHydratedRender);
const firstOptionalStatusRefresh = app.indexOf("await refreshCodexAgentStatus(", firstHydratedRender);
assert.ok(firstHydratedRender >= 0 && firstInteractiveMark > firstHydratedRender, "启动完成工作区恢复后必须解除恢复遮罩");
assert.ok(firstInteractiveMark < firstOptionalStatusRefresh, "Agent 状态等非关键检查不得阻挡已恢复工作区进入可交互状态");

console.log(`Shensi v${packageJson.version} regression contracts passed`);
