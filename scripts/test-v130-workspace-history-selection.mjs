import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveHistoryTaskScope, workspaceWideHistoryIntent } from "../src/history-task-scope.js";
import { removeConversationAttachmentReference } from "../src/conversation-reference-policy.js";
import { generationRuntimeBindings, generationSettingsForChannel, normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { CodexAgentProvider } from "../src/server/codex-agent-provider.mjs";
import { landingDocumentTitle } from "../src/document-landing-title.js";

const [appSource, styles, indexHtml, workspaceServer, serverSource, packageText] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/server/workspace.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
]);
const packageVersion = JSON.parse(packageText).version;
const packageVersionPattern = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

assert.equal(workspaceWideHistoryIntent("优化整个作品"), true);
assert.equal(workspaceWideHistoryIntent("对整个笔记空间进行优化"), true);
assert.equal(workspaceWideHistoryIntent("润色当前文档"), false);
assert.deepEqual(resolveHistoryTaskScope([
  { documentId: "chapter-1", moduleId: "manuscript", viewId: "novel" },
  { documentId: "canon-world", moduleId: "canon", viewId: "novel" },
]), { type: "project", id: "project" });

assert.match(appSource, /已选 \$\{selected\.toLocaleString\("zh-CN"\)\} 字 \/ 全文/);
assert.match(appSource, /workspaceWideHistoryIntent\(reason\)/);
assert.match(appSource, /chapterEpisodeMappings: clone\(state\.chapterEpisodeMappings/);
assert.match(appSource, /workspaceAssets: clone\(state\.workspaceAssets/);
assert.match(appSource, /assetHistoryTombstones: clone\(state\.assetHistoryTombstones/);
assert.match(appSource, /data-project-action="create"/);
assert.match(appSource, /temporary: row\.dataset\.temporary === "true"/);
assert.match(appSource, /openWorkspaceCreateDialog\(target\.workspaceKind\)/);
assert.match(appSource, /querySelector\("\[data-project-action-label\]"\)/);
assert.match(appSource, /activeWorkspaceMenuTarget\(workspaceKind\)/);
assert.match(appSource, /ui\.historyAnchor = \{ x: event\.clientX, y: event\.clientY \}/);
assert.match(appSource, /temporaryNotebook[\s\S]*?\["create", "history", "share", "export", "delete"\]\.includes\(action\)/);
assert.match(appSource, /headerRoot[\s\S]*?\["create", "history", "share", "export", "rename"\]\.includes\(action\)/);
assert.match(appSource, /ui\.notebooks = temporary \? \[\.\.\.formal, temporary\] : formal/);
assert.match(appSource, /临时笔记只读，需要移动到正式目录中才可编辑/);
assert.match(appSource, /requestTemporaryNotebookPromotion\("rename", ui\.menuDocument\)/);
assert.match(appSource, /requestTemporaryNotebookPromotion\("attachment", state\.activeDocument\)/);
assert.match(appSource, /prefetchWorkspaceCollection\("notebook", 3\)/);
assert.match(appSource, /const pendingPrefetch = ui\.workspacePrefetches\.get\(key\);\s*if \(pendingPrefetch\) await pendingPrefetch;/s);
assert.match(appSource, /clearTimeout\(ui\.workspacePrefetchTimer\);\s*ui\.workspacePrefetchTimer = null;/s);
assert.match(appSource, /id="moveDocumentTree" role="tree"/);
assert.match(appSource, /documentTransferDirectories: new Map\(\)/);
assert.match(appSource, /const renderMoveDocumentDirectoryNodes = /);
assert.match(appSource, /workspaceRoot: true/);
assert.match(appSource, /data-move-document-kind=/);
assert.match(appSource, /data-move-document-target=/);
assert.match(appSource, /moveDocumentExpandedKeys: new Set\(\)/);
assert.match(styles, /\.move-document-tree-workspace/);
assert.match(styles, /\.move-document-kind-tabs/);
assert.match(styles, /\.move-document-tree-target\.selected/);
assert.match(styles, /\.move-document-dialog \{[\s\S]*?overflow: hidden/);
assert.match(styles, /\.move-document-tree \{[\s\S]*?overflow-y: auto/);
assert.ok(
  appSource.indexOf('data-project-action="create"') < appSource.indexOf('data-project-action="history"'),
  "作品/笔记本右键菜单必须把横向的新建按钮放在历史版本上方",
);
assert.match(appSource, /data-project-action="create"><svg class="icon context-menu-create-icon"/);
assert.match(appSource, /data-project-action="history">[\s\S]*?data-project-action-label>历史版本/);
assert.match(appSource, /activateWorkspaceKind\(kindOption\.dataset\.workspaceKind, \{ activatePreferred: false \}\)/);
assert.doesNotMatch(appSource, /data-project-action="create-temporary"|新建临时笔记本/);

const attachmentConversation = {
  references: ["chapter-1"],
  workspaceReferences: [],
  skillReferences: [],
  attachments: [{ id: "remove-me" }, { id: "keep-me" }],
  referenceContext: {
    schemaVersion: 1,
    references: ["chapter-1"],
    workspaceReferences: [],
    skillReferences: [],
    attachments: [{ id: "remove-me" }, { id: "keep-me" }],
    sourceMessageId: "message-1",
  },
  composerReferenceState: {
    schemaVersion: 1,
    pending: true,
    scope: {
      references: [],
      workspaceReferences: [],
      skillReferences: [],
      attachments: [{ id: "remove-me" }],
    },
  },
};
assert.equal(removeConversationAttachmentReference(attachmentConversation, "remove-me"), true);
assert.deepEqual(attachmentConversation.attachments.map((item) => item.id), ["keep-me"]);
assert.deepEqual(attachmentConversation.referenceContext.attachments.map((item) => item.id), ["keep-me"]);
assert.deepEqual(attachmentConversation.composerReferenceState.scope.attachments, []);
assert.equal(attachmentConversation.composerReferenceState.pending, false);
assert.equal(removeConversationAttachmentReference(attachmentConversation, "missing"), false);
assert.match(appSource, /removeConversationAttachmentReference\(conversation, attachment\)/);
assert.match(appSource, /attachmentButton[\s\S]*?preventDefault\(\)[\s\S]*?stopPropagation\(\)/);

const attachmentButtonRule = styles.match(/\.context-chip button\[data-remove-attachment\] \{[\s\S]*?\n\}/)?.[0] || "";
assert.match(attachmentButtonRule, /width: 20px/);
assert.match(attachmentButtonRule, /height: 20px/);
assert.match(attachmentButtonRule, /min-width: 20px/);
assert.match(attachmentButtonRule, /max-width: 20px/);
assert.match(attachmentButtonRule, /min-height: 20px !important/);
assert.match(attachmentButtonRule, /border-radius: 999px/);
assert.match(attachmentButtonRule, /clip-path: circle\(50% at 50% 50%\)/);
assert.match(attachmentButtonRule, /aspect-ratio: 1 \/ 1/);
assert.match(styles, /button\[data-remove-attachment\]::before \{[\s\S]*?inset: 0[\s\S]*?place-items: center[\s\S]*?transform: none/);
assert.match(styles, /\.context-chip\.visual-attachment-chip > button\[data-remove-attachment\] \{[\s\S]*?position: absolute[\s\S]*?top: 1px[\s\S]*?right: 1px[\s\S]*?pointer-events: auto/);
assert.match(styles, /\.context-menu button > \.icon \{[\s\S]*?min-width: 20px[\s\S]*?white-space: nowrap/);
assert.match(indexHtml, new RegExp(`styles\\.css\\?v=${packageVersionPattern}-[a-z0-9-]+`, "u"));
assert.match(indexHtml, new RegExp(`app\\.js\\?v=${packageVersionPattern}-[a-z0-9-]+`, "u"));
assert.match(appSource, new RegExp(`generation-profiles\\.js\\?v=${packageVersionPattern}-[a-z0-9-]+`, "u"));
assert.match(appSource, /data-whiteboard-action="paste"[\s\S]*?<span>粘贴<\/span>/);
assert.doesNotMatch(appSource, /<span>上传并覆盖<\/span>/);
assert.match(appSource, /data-folder-action="move"[\s\S]*?<span>移动到…<\/span>/);
assert.match(appSource, /data-folder-action="copy"[\s\S]*?<span>复制<\/span>/);
assert.match(appSource, /data-folder-action="cut"[\s\S]*?<span>剪切<\/span>/);
assert.doesNotMatch(appSource, /<span>复制文档<\/span>|<span>剪切文档<\/span>/);
assert.match(appSource, /pasteIntoWhiteboard/);
assert.match(appSource, /document\.elementsFromPoint\?\.\(event\.clientX, event\.clientY\)/);
assert.match(appSource, /canvasNodeIdAtPoint\([\s\S]*?excludedNodeIds: sourceIds/);
assert.match(appSource, /scheduleWhiteboardCardOpen\(card\.dataset\.canvasNode\)/);
assert.match(appSource, /setWhiteboardAutoOpenDisabled\(config\.form\.dataset\.nodeId, true\)/);
const restoredCliSettings = normalizeGenerationProfiles({
  videoConnections: [
    { id: "video-dreamina-cli", name: "默认即梦", adapter: "cli", provider: "即梦", model: "seedance2.0" },
    { id: "video-dreamina-cli-guobazai", name: "即梦视频 CLI · 锅巴仔", adapter: "cli", provider: "即梦", model: "sora-2" },
    { id: "video-dreamina-cli-xiaoyujie", name: "即梦视频 CLI · 小鱼姐", adapter: "cli", provider: "即梦", model: "sora-2" },
  ],
});
assert.deepEqual(restoredCliSettings.videoConnections
  .filter(({ adapter, provider }) => adapter === "cli" && provider === "即梦")
  .map(({ dreaminaCliProfile, remarkName }) => ({ dreaminaCliProfile, remarkName })), [
  { dreaminaCliProfile: "default", remarkName: "柏物语" },
  { dreaminaCliProfile: "guobazai", remarkName: "锅巴仔" },
  { dreaminaCliProfile: "xiaoyujie", remarkName: "小鱼姐" },
  { dreaminaCliProfile: "chenan", remarkName: "陈安" },
  { dreaminaCliProfile: "tashuo-juyougeng", remarkName: "她说剧有梗" },
  { dreaminaCliProfile: "duanju-zuiqianxian", remarkName: "短剧最前线" },
  { dreaminaCliProfile: "yinou-shijie", remarkName: "银鸥师姐" },
]);
const multipleAudioSettings = normalizeGenerationProfiles({
  audioConnections: [
    { id: "audio-voice-a", name: "声音配置 A", remarkName: "旁白 A", adapter: "cli", provider: "自定义音频", protocol: "audio", model: "voice-a", cliPath: "voice-a", reserved: false },
    { id: "audio-voice-b", name: "声音配置 B", remarkName: "旁白 B", adapter: "api", provider: "自定义音频", protocol: "audio", model: "voice-b", baseUrl: "https://audio.example.test/v1", apiKey: "test-only", reserved: false },
  ],
  activeAudioConnectionId: "audio-voice-a",
});
assert.equal(generationSettingsForChannel(multipleAudioSettings, "audio", "audio-voice-a")?.model, "voice-a");
assert.equal(generationSettingsForChannel(multipleAudioSettings, "audio", "audio-voice-b")?.model, "voice-b");
assert.deepEqual(generationRuntimeBindings(multipleAudioSettings).bindings
  .filter(({ channel }) => channel === "audio")
  .map(({ profileId }) => profileId), [
  "audio-voice-a",
  "audio-voice-b",
  "audio-libtv-jimeng",
  "audio-libtv-hailuo",
]);
assert.match(appSource, /chapter-title-text" contenteditable="\$\{editableDocumentTitle\}"/);
assert.doesNotMatch(appSource, /chapter-title-number" contenteditable="\$\{editableDocumentTitle\}"/);
assert.match(appSource, /data-full-sequence-title="\$\{sequenceKind \? "true" : "false"\}"/);
assert.match(appSource, /elements\.chapterTitle\.addEventListener\("focusout"/);
assert.match(appSource, /requestedDocumentTitle[\s\S]*?documentRenameTitle/);
assert.match(appSource, /const currentAudioGenerationSettings/);
assert.equal(landingDocumentTitle({ target: { requestedDocumentTitle: "新版编译报告" }, content: "旧正文" }), "新版编译报告");
assert.equal(landingDocumentTitle({ target: {}, content: "# 新版正文标题\n\n正文" }), "新版正文标题");
assert.equal(landingDocumentTitle({ target: {}, content: "普通说明文字\n正文" }), "");
assert.equal(landingDocumentTitle({ target: { requestedDocumentTitle: "不应覆盖章节名" }, content: "", chapterNumber: 2 }), "");
assert.match(workspaceServer, /externalizeHistoryDocuments/);
assert.match(workspaceServer, /historyObjectRelativePath\(hash\)/);
assert.match(workspaceServer, /pruneUnreferencedHistoryObjects/);

assert.match(appSource, /id="supplementButton"[^>]*>\$\{icon\("\\uE72B", "补充指令"\)\}<\/button>/);
assert.doesNotMatch(appSource, /id="supplementButton"[^>]*hidden/);
assert.match(appSource, /supplementButton\.hidden = false/);
assert.match(appSource, /\/api\/codex-agent\/supplement/);
assert.match(appSource, /runtimeSupplement: true/);
assert.match(appSource, /scheduleDeferredSupplementDelivery\(\)/);
assert.match(serverSource, /pathname === "\/api\/codex-agent\/supplement"/);

const steerCalls = [];
const steerEvents = [];
const codexRun = {
  id: "run-1",
  engine: "codex",
  threadId: "thread-1",
  turnId: "turn-1",
  activeAttemptTurnId: "turn-1",
  attemptTurnIds: new Set(["turn-1"]),
  status: "running",
  taskPacket: { requestId: "request-1" },
};
const providerHarness = {
  runs: new Map([[codexRun.id, codexRun], [codexRun.turnId, codexRun]]),
  request: async (method, params) => {
    steerCalls.push({ method, params });
    return { turnId: params.expectedTurnId };
  },
  publicRun: (run) => ({ id: run.id, turnId: run.turnId, status: run.status }),
  emit: (type, payload) => steerEvents.push({ type, payload }),
};
const steered = await CodexAgentProvider.prototype.supplement.call(providerHarness, "", {
  requestId: "request-1",
  content: "把第二场对白再压缩一些",
  clientUserMessageId: "message-supplement-1",
});
assert.equal(steered.accepted, true);
assert.equal(steered.deferred, false);
assert.equal(steerCalls[0].method, "turn/steer");
assert.equal(steerCalls[0].params.expectedTurnId, "turn-1");
assert.match(steerCalls[0].params.input[0].text, /不要取消、重启或另起任务/);
assert.equal(steerEvents[0].type, "run_supplemented");

const deepSeekRun = { ...codexRun, id: "run-deepseek", turnId: "deepseek-turn", activeAttemptTurnId: "deepseek-turn", engine: "deepseek_opencode" };
const deferred = await CodexAgentProvider.prototype.supplement.call({
  ...providerHarness,
  runs: new Map([[deepSeekRun.id, deepSeekRun], [deepSeekRun.turnId, deepSeekRun]]),
}, deepSeekRun.turnId, { content: "保留当前结果并补充结尾" });
assert.equal(deferred.accepted, false);
assert.equal(deferred.deferred, true);
assert.equal(deferred.reason, "provider_boundary_required");

console.log("v2.3.0 workspace history, clipboard, whiteboard, performance, and persistent supplement contracts passed");
