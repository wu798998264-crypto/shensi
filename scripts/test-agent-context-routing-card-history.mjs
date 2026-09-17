import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_ENGINE_IDS,
  agentEngineDescriptor,
  agentModelsForEngine,
  agentProfileBelongsToEngine,
  selectedAgentRuntimeProfile,
} from "../src/agent-engine-registry.js";
import {
  associatedDocumentId,
  conversationAssociationDisplayDocumentId,
  createTurnContextSnapshot,
  resolveTurnAssociationChange,
} from "../src/automatic-landing-policy.js";
import {
  notebookDocumentWorkIdentity,
  notebookSameWorkDocumentIds,
} from "../src/notebook-work-scope.js";
import {
  normalizePastedDocumentTitle,
  sequencedDocumentLabel,
} from "../src/document-title-policy.js";
import { landingDocumentTitle } from "../src/document-landing-title.js";
import {
  beginCardGenerationOwnership,
  cardGenerationResultDisposition,
} from "../src/card-generation-ownership.js";
import {
  cardHistoryViewModel,
  canDeleteCardHistoryVersion,
} from "../src/whiteboard-card-history.js";
import {
  replaceCanvasNodeWithGenerationAsset,
} from "../src/whiteboard.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(AGENT_ENGINE_IDS, ["codex", "codex_api", "deepseek_opencode", "opencode", "claude_code", "trae_work", "workbuddy", "custom"]);
assert.equal(agentEngineDescriptor("codex").label, "Codex");
assert.equal(agentEngineDescriptor("deepseek_opencode").label, "OpenCode+DeepSeek");
assert.equal(agentEngineDescriptor("opencode").label, "OpenCode");
assert.equal(agentEngineDescriptor("claude_code").label, "Claude Code");
assert.equal(agentProfileBelongsToEngine({ provider: "Claude", adapter: "cli", agentEngine: "claude_code" }, "claude_code"), true);
assert.equal(agentProfileBelongsToEngine({ provider: "OpenAI", adapter: "cli", agentEngine: "codex" }, "codex"), true);
assert.equal(agentProfileBelongsToEngine({ provider: "DeepSeek", adapter: "cli", agentEngine: "deepseek_opencode" }, "codex"), false);
assert.equal(agentProfileBelongsToEngine({ provider: "自定义兼容接口", adapter: "cli", agentEngine: "opencode" }, "opencode"), true);
const selectedOpenCodeRuntime = selectedAgentRuntimeProfile({
  activeTextAgentConnectionId: "opencode-deepseek",
  textConnections: [
    { id: "codex", provider: "OpenAI", adapter: "cli", agentEngine: "codex" },
    { id: "opencode-deepseek", provider: "DeepSeek", adapter: "cli", agentEngine: "opencode" },
  ],
}, "codex");
assert.equal(selectedOpenCodeRuntime.engine, "opencode", "当前配置必须覆盖全局旧 Agent 引擎");
assert.equal(selectedOpenCodeRuntime.profile.id, "opencode-deepseek");
assert.deepEqual(
  agentModelsForEngine("codex", {
    codexModels: [{ slug: "gpt-5.6-sol" }],
    openCodeModels: [{ slug: "deepseek-v3.2" }],
    effectiveModel: "deepseek-v3.2",
  }).map((item) => item.slug),
  ["gpt-5.6-sol"],
  "Codex 引擎不得注入 DeepSeek/OpenCode 的 effective model",
);
assert.deepEqual(
  agentModelsForEngine("deepseek_opencode", {
    codexModels: [{ slug: "gpt-5.6-sol" }],
    openCodeModels: [{ slug: "deepseek-v3.2" }],
    effectiveModel: "gpt-5.6-sol",
  }).map((item) => item.slug),
  ["deepseek-v3.2"],
  "OpenCode+DeepSeek 引擎不得注入 Codex effective model",
);

const pausedConversation = {
  id: "conversation-a",
  autoAssociateActiveDocument: false,
  boundDocumentId: "chapter-2",
  associationRevision: 3,
};
assert.equal(associatedDocumentId(pausedConversation, "chapter-3"), null, "暂停关联后不得暗中读取当前文档");
assert.equal(conversationAssociationDisplayDocumentId(pausedConversation, "chapter-3"), "chapter-3", "暂停关联后标签仍可跟随当前文档");
const snapshot = createTurnContextSnapshot({
  conversation: pausedConversation,
  workspaceKind: "project",
  workspacePath: "E:/Shensi/作品/大主宰",
  workspaceName: "大主宰",
  activeDocumentId: "chapter-3",
  documents: { "chapter-3": { title: "第三章 北苍界", revision: "editor-r4" } },
  editorContentRevision: "editor-r5",
});
assert.equal(snapshot.schemaVersion, 2);
assert.equal(snapshot.conversationId, "conversation-a");
assert.equal(snapshot.associationEnabled, false);
assert.equal(snapshot.boundDocumentId, "");
assert.equal(snapshot.editorContentRevision, "editor-r5");

assert.equal(resolveTurnAssociationChange({
  snapshot: { associationEnabled: true, boundDocumentId: "chapter-2", workspacePath: "E:/work/a" },
  current: { associationEnabled: true, boundDocumentId: "chapter-3", workspacePath: "E:/work/a" },
  explicitRetarget: false,
  sameWorkspace: true,
}).action, "keep_original_target", "同作品浏览切换不得静默重定向正在运行的任务");
assert.equal(resolveTurnAssociationChange({
  snapshot: { associationEnabled: true, boundDocumentId: "chapter-2", workspacePath: "E:/work/a" },
  current: { associationEnabled: true, boundDocumentId: "chapter-1", workspacePath: "E:/work/b" },
  explicitRetarget: false,
  sameWorkspace: false,
}).action, "confirm_target", "跨作品切换必须确认任务归属");

const notebookDocuments = {
  "north-1": { title: "《北灵台》第一章", moduleId: "manuscript", workName: "北灵台" },
  "north-2": { title: "《北灵台》第二章", moduleId: "manuscript", workName: "北灵台" },
  "huanjin-1": { title: "《幻烬》第一章", moduleId: "manuscript", workName: "幻烬" },
  history: { title: "北灵台旧稿", moduleId: "manuscript", workName: "北灵台", contextStatus: "history" },
};
assert.equal(notebookDocumentWorkIdentity({ documentId: "north-1", document: notebookDocuments["north-1"] }), "work:北灵台");
assert.deepEqual(notebookSameWorkDocumentIds({
  currentDocumentId: "north-2",
  documents: notebookDocuments,
  moduleItems: { manuscript: Object.entries(notebookDocuments).map(([id, document]) => [id, document.title, { moduleId: "manuscript", workName: document.workName }]) },
}), ["north-2", "north-1"], "同一笔记本只能补入同作品当前版本");

assert.equal(normalizePastedDocumentTitle("  第三章\n北苍界  "), "第三章 北苍界");
assert.equal(sequencedDocumentLabel({ documentId: "chapter-3", title: "北苍界" }), "第3章　北苍界");
assert.equal(landingDocumentTitle({
  target: { requestedDocumentTitle: "第三章 北苍界" },
  content: "# 第三章 北苍界\n正文",
}), "第三章 北苍界");

const firstJob = beginCardGenerationOwnership({}, {
  cardId: "card-a", generationJobId: "job-1", generationType: "image", connectionId: "gpt-image", model: "gpt-image-2",
});
const secondJob = beginCardGenerationOwnership(firstJob, {
  cardId: "card-a", generationJobId: "job-2", generationType: "video", connectionId: "dreamina-chenan", model: "seedance2.5",
});
assert.equal(cardGenerationResultDisposition(secondJob, { cardId: "card-a", generationJobId: "job-1" }).action, "quarantine");
assert.equal(cardGenerationResultDisposition(secondJob, { cardId: "card-a", generationJobId: "job-2" }).action, "commit");
assert.equal(cardGenerationResultDisposition(secondJob, { cardId: "card-b", generationJobId: "job-2" }).action, "reject_wrong_card");

const history = cardHistoryViewModel({
  current: { id: "v2", version: 2, kind: "image" },
  versions: [{ id: "v1", version: 1, kind: "image" }, { id: "v2", version: 2, kind: "image" }],
});
assert.deepEqual(history.map((item) => [item.id, item.current, item.actionLabel]), [
  ["v2", true, "当前版本"],
  ["v1", false, "设为当前"],
]);
assert.equal(canDeleteCardHistoryVersion({ versionId: "v2", currentVersionId: "v2", versionCount: 2 }), false);
assert.equal(canDeleteCardHistoryVersion({ versionId: "v1", currentVersionId: "v2", versionCount: 2 }), true);
assert.equal(canDeleteCardHistoryVersion({ versionId: "v1", currentVersionId: "v2", versionCount: 1 }), false);

const historyCanvas = {
  nodes: [{ id: "card-a", type: "text", kind: "generated", text: "当前稿", x: 120, y: 80, width: 260, height: 160 }],
  edges: [],
  assets: [
    { id: "asset-v1", kind: "text", origin: "generated", text: "旧稿", sourceNodeId: "card-a", createdAt: "2026-08-24T00:00:00.000Z" },
    { id: "asset-v2", kind: "text", origin: "generated", text: "当前稿", sourceNodeId: "card-a", createdAt: "2026-08-25T00:00:00.000Z" },
  ],
};
const swappedCanvas = replaceCanvasNodeWithGenerationAsset(historyCanvas, "card-a", historyCanvas.assets[0]);
assert.equal(swappedCanvas.nodes[0].text, "旧稿", "设为当前必须立即把历史正文换入卡片位置");
assert.equal(swappedCanvas.nodes[0].x, 120, "设为当前不得改变卡片位置");
assert.equal(swappedCanvas.assets.length, historyCanvas.assets.length, "设为当前不得重复追加被选历史资产");
assert.deepEqual(
  cardHistoryViewModel({
    current: swappedCanvas.assets[0],
    versions: swappedCanvas.assets,
  }).map((item) => [item.id, item.actionLabel]),
  [["asset-v1", "当前版本"], ["asset-v2", "设为当前"]],
  "设为当前后历史列表必须立即交换当前标签和排序位置",
);

const appSource = await readFile(resolve(root, "src", "app.js"), "utf8");
const styles = await readFile(resolve(root, "src", "styles.css"), "utf8");
assert.doesNotMatch(appSource, /skill-history-active[^\n]{0,80}最近生成/u, "卡片历史不应显示‘最近生成’");
assert.doesNotMatch(appSource, /恢复历史结果会生成一个新的当前版本/u, "卡片历史顶部不再显示重复说明");
assert.match(appSource, /data-whiteboard-card-history-delete/u, "卡片历史必须提供删除入口");
assert.match(appSource, /whiteboard-card-history-delete[^\n]{0,240}icon\("\\uE74D"/u, "卡片历史删除必须使用和文档历史一致的垃圾桶图标");
assert.match(appSource, /const restoreWhiteboardCardHistoryVersion\s*=/u, "设置当前版本必须先执行内存级切换");
assert.match(appSource, /renderWhiteboardCardHistory\(\);\s*renderWhiteboard\(documentState\);/u, "设置当前版本后必须先立即重排并刷新当前状态");
assert.match(appSource, /void persistRestoredWhiteboardCardHistoryVersion/u, "设置当前版本的工作区保存不得阻塞界面点击");
assert.match(appSource, /data-whiteboard-action="save-history"/u, "文字卡片右键必须提供手动保存历史版本");
assert.match(styles, /whiteboard-card-history-state[\s\S]{0,180}min-width:\s*76px/u, "当前版本按钮边框必须完整容纳文字");
assert.match(styles, /#whiteboardVideoDialog[^\n]*whiteboard-media-model-option/u, "视频模型宽度调整必须限制在视频生成栏");

console.log("Agent engine, conversation scope, landing title and whiteboard card history tests passed");
