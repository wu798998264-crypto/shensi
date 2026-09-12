import assert from "node:assert/strict";
import { agentDecision } from "./fixtures/agent-decision.mjs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { conversationMessagesForActiveAssociation, normalizeConversationMessages } from "../src/conversation-context.js";
import { notebookSameWorkDocumentIds } from "../src/notebook-work-scope.js";
import { buildLandingManifest } from "../src/landing-manifest.js";
import { verifyLandingDelivery } from "../src/landing-document-links.js";
import { contentRevision } from "../src/workspace-operations.js";
import { creativeDeliverableType, buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { reviewDeliveryPolicy } from "../src/review-delivery-policy.js";
import { CodexAgentProvider, workspaceFileMutationIntent } from "../src/server/codex-agent-provider.mjs";
import { selectAgentContracts } from "../src/server/agent-contract-selector.mjs";
import {
  enforceRequestedProseLength,
  requestedContentLengthContract,
} from "../src/server/shensi-orchestrator.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appSource = await readFile(join(root, "src", "app.js"), "utf8");
const serverSource = await readFile(join(root, "server.mjs"), "utf8");

assert.equal(creativeDeliverableType({ text: "把当前内容改为神思格式的剧本" }), "short_drama_script");
assert.equal(creativeDeliverableType({ text: "请写成一个完整脚本并直接落盘" }), "short_drama_script");

const managedRoute = buildAdaptiveTaskRoute({
  agentDecision: agentDecision({ operation: "create" }),
  text: "写一篇完整故事，命名为《雨夜灯塔》，新建文档并直接写入",
  authorizationInstruction: "写一篇完整故事，命名为《雨夜灯塔》，新建文档并直接写入",
  sourceMessageId: "user-managed-story",
  workspaceOperation: false,
  landing: true,
  targetDocumentId: "chapter-1",
  targetRevision: "chapter-1-rev",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "chapter-1-rev" },
  targetExists: false,
  targetModuleId: "manuscript",
  workspaceKind: "project",
}, { executionSurface: "agent" });
assert.equal(managedRoute.shensiLed, true);
assert.equal(managedRoute.candidatePreviewRequired, false, "直接写入不应被候选窗口前置阻断");
assert.equal(managedRoute.formalArtifactExpected, true, "不显示候选窗口也必须保持正式内容接收资格");
assert.equal(workspaceFileMutationIntent("写一篇完整故事，新建文档并直接写入", managedRoute), false);
const managedContract = selectAgentContracts({ route: managedRoute });
assert.match(managedContract.prompt, /deliverable itself/u);
assert.match(managedContract.prompt, /Never use Untitled, 未命名/u);
const creativeVerifier = Object.create(CodexAgentProvider.prototype);
const continuationRoute = buildAdaptiveTaskRoute({
  agentDecision: agentDecision({ operation: "append" }),
  text: "续写第三章",
  authorizationInstruction: "续写第三章",
  sourceMessageId: "user-continue-chapter-3",
  landing: true,
  targetDocumentId: "chapter-3",
  targetRevision: "chapter-3-rev",
  targetDocumentIds: ["chapter-3"],
  expectedRevisions: { "chapter-3": "chapter-3-rev" },
  targetExists: true,
  targetModuleId: "manuscript",
}, { executionSurface: "agent" });
const screenshotRefusal = [
  "我会延续当前玄幻学院线：完成北灵台决战的收束，并让玉简与北苍线索正式进入主线。先按创作构思流程校准承接点，再交付可自动落盘的第三章全文。抱歉，我不能续写《大主宰》角色与情节的后续正文。",
  "我可以立刻改写为原创第三章：保留学院擂台决战、少年突破、神秘玉简指向远方的高层设定，但使用全新人物、世界观与剧情。",
].join("\n");
const rejectedManagedOutput = creativeVerifier.verifyManagedCreativeOutput({
  taskRoute: continuationRoute,
  originalPrompt: "续写第三章",
  text: screenshotRefusal,
});
assert.equal(rejectedManagedOutput.ok, false, "operational prose/refusal must fail before the host landing transaction");
const acceptedManagedOutput = creativeVerifier.verifyManagedCreativeOutput({
  taskRoute: continuationRoute,
  originalPrompt: "续写第三章",
  text: `第三章 风从北灵台尽头涌来\n\n${"雨停以后，少年循着玉简的微光穿过石阶，远处钟声一层层压向山谷。".repeat(12)}`,
});
assert.equal(acceptedManagedOutput.ok, true);
assert.equal(reviewDeliveryPolicy({ text: "批量创作五篇完整故事，不能写提纲、说明、诊断或占位内容" }).active, false);
assert.equal(reviewDeliveryPolicy({ text: "不要自检，直接写完整正文" }).active, false);
assert.equal(reviewDeliveryPolicy({ text: "请审查当前小说正文" }).active, true);

const minimumLengthContract = requestedContentLengthContract("继续故事，正式正文至少300个汉字");
assert.deepEqual(minimumLengthContract, {
  min: 300,
  max: 99_999,
  bound: "minimum",
  scope: "document",
});
const shortMinimumEvaluation = enforceRequestedProseLength({
  evaluation: { pass: true, issues: [], findings: [], repairInstruction: "" },
  candidate: "这是一段仍需扩写的正文。",
  contract: minimumLengthContract,
  applicable: true,
});
assert.equal(shortMinimumEvaluation.pass, false);
assert.match(shortMinimumEvaluation.repairInstruction, /不少于 300 字/u);
const validMinimumEvaluation = enforceRequestedProseLength({
  evaluation: { pass: true, issues: [], findings: [], repairInstruction: "" },
  candidate: "正文".repeat(180),
  contract: minimumLengthContract,
  applicable: true,
});
assert.equal(validMinimumEvaluation.pass, true);

const associationScoped = normalizeConversationMessages(conversationMessagesForActiveAssociation([
  { id: "old-user", role: "user", content: "续写《幻烬》", turnContextSnapshot: { workspacePath: "E:/作品/幻烬", boundDocumentId: "chapter-2", associationRevision: 1 } },
  { id: "old-result", role: "assistant", candidate: "幻烬旧内容", content: "幻烬旧内容" },
  { id: "rolled-back", role: "assistant", candidate: "被退回内容", contextEligible: false },
  { id: "unselected", role: "assistant", candidate: "未选候选", candidateSelected: false },
  { id: "new-user", role: "user", content: "续写第三章", turnContextSnapshot: { workspacePath: "E:/笔记/北灵台", boundDocumentId: "chapter-2", associationRevision: 2 } },
]));
assert.deepEqual(associationScoped.map((message) => message.id), ["new-user"], "new association must not inherit another work or discarded candidates");

const notebookDocuments = {
  "chapter-2": { title: "第二章 北灵台", moduleId: "manuscript" },
  "canon-beilingtai": { title: "北灵台设定", moduleId: "canon" },
  "chapter-huanjin": { title: "幻烬旧章", moduleId: "manuscript" },
  "library-trash": { title: "回收站", moduleId: "library", contextStatus: "trash" },
};
const notebookModuleItems = {
  manuscript: [
    ["chapter-2", "第二章 北灵台", { folderId: "work-beilingtai" }],
    ["chapter-huanjin", "幻烬旧章", { folderId: "work-huanjin" }],
  ],
  canon: [["canon-beilingtai", "北灵台设定", { folderId: "work-beilingtai" }]],
  library: [["library-trash", "回收站", { folderId: "work-beilingtai" }]],
};
assert.deepEqual(notebookSameWorkDocumentIds({
  currentDocumentId: "chapter-2",
  referenceIds: ["chapter-huanjin"],
  documents: notebookDocuments,
  moduleItems: notebookModuleItems,
}), ["chapter-2", "canon-beilingtai"], "notebook context must stay inside the marked work and exclude trash");

const landedBody = "北灵台第三章正式正文。".repeat(40);
const landedHash = contentRevision(landedBody);
const landingManifest = buildLandingManifest({
  source: landedBody,
  workspaceKind: "notebook",
  workspacePath: "E:/笔记/北灵台",
  workspaceName: "北灵台",
  documents: [{ documentId: "chapter-3", title: "第三章 北灵台", content: landedBody, target: { moduleId: "manuscript" } }],
  batchLandingReceipt: {
    verified: true,
    failed: 0,
    results: [{ targetDocumentId: "chapter-3", requestedTitle: "第三章 北灵台", writtenHash: landedHash, verifiedHash: landedHash, verified: true }],
  },
});
const delivery = verifyLandingDelivery({
  manifest: landingManifest,
  documents: { "chapter-3": { title: "第三章 北灵台" } },
  expectedDocumentIds: ["chapter-3"],
});
assert.equal(delivery.ok, true);
assert.deepEqual(delivery.links, [{ documentId: "chapter-3", title: "第3章　北灵台", workspaceKind: "notebook", workspacePath: "E:/笔记/北灵台", workspaceName: "北灵台" }]);

assert.match(appSource, /agentGenerationAndLandingRequested[\s\S]{0,500}agentWorkspaceOperationRequested/u);
assert.match(appSource, /landing:\s*agentGenerationAndLandingRequested\s*\|\|\s*agentLandingOnlyRequested/u);
assert.doesNotMatch(appSource, /resolveCrossConversationTaskReference/u, "other conversations must never enter the active task context");
assert.match(appSource, /续写目标与落盘目标不一致/u);
assert.match(appSource, /对话交付回执不完整/u);
assert.match(serverSource, /landing:\s*body\.landing\s*===\s*true/u);
assert.match(appSource, /WHITEBOARD_PROMPT_CLIPBOARD_TYPE/u);
assert.match(appSource, /orderedWhiteboardPromptPasteSegments/u);
assert.match(appSource, /insertOrderedWhiteboardPromptSegments/u);
assert.match(appSource, /onImportedNode/u);
const orchestratorSource = await readFile(join(root, "src", "server", "shensi-orchestrator.mjs"), "utf8");
assert.match(orchestratorSource, /replace\(\/【\(\?:正式内容\|候选稿\)】\\s\*\/gu,\s*""\)/u);
assert.doesNotMatch(orchestratorSource, /候选保留为不可自动落盘/u);
assert.doesNotMatch(orchestratorSource, /已禁止自动落盘和记忆更新/u);

console.log("Shensi v2.6.0 core writing unblock and ordered prompt clipboard tests passed");
