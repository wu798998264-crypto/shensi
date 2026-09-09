import assert from "node:assert/strict";

import {
  beginDocumentWriteTransaction,
  commitDocumentWriteTransaction,
  rollbackDocumentWriteTransaction,
} from "../src/document-write-transaction.js";
import { documentVersionHash, verifyDocumentVersionSnapshot } from "../src/version-integrity.js";
import { automaticLandingDecision } from "../src/automatic-landing-policy.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import {
  formalArtifactCommitEligibility,
  formalArtifactContentAssessment,
} from "../src/formal-artifact-extractor.js";
import { workspaceFileMutationIntent, workspaceFileReadIntent, workspaceSelfRepairIntent } from "../src/server/codex-agent-provider.mjs";
import { latestRecoverableCandidate } from "../src/candidate-chapters.js";

const original = {
  title: "第1章 北灵院",
  html: "<p>原文第一段。</p>",
  markdown: "原文第一段。",
  moduleId: "manuscript",
  workspaceView: "novel",
  attachments: [{ relativePath: "assets/reference.png" }],
  revision: "revision-1",
};

const appendInstruction = "续写当前章节";
const appendSourceMessageId = "user-append";
const appendRoute = buildAdaptiveTaskRoute({
  text: appendInstruction,
  sourceMessageId: appendSourceMessageId,
  target: { documentId: "chapter-1", revision: original.revision, title: original.title },
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": original.revision },
}, { executionSurface: "chat" });
const appendAuthorization = await bindFormalWriteCandidate(appendRoute.writeAuthorization, {
  candidate: "续写第二段。",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": original.revision },
});

const transaction = await beginDocumentWriteTransaction({
  transactionId: "tx-append",
  documentId: "chapter-1",
  documentState: original,
  operation: "continuation",
  candidateContent: "续写第二段。",
  writeAuthorization: appendAuthorization,
  sourceMessageId: appendSourceMessageId,
  sourceInstruction: appendInstruction,
  expectedDocumentHash: await documentVersionHash(original),
});
assert.equal((await verifyDocumentVersionSnapshot(transaction.snapshot)).ok, true);
assert.deepEqual(rollbackDocumentWriteTransaction(transaction), original);

const appended = { ...original, html: `${original.html}<p>续写第二段。</p>` };
const receipt = await commitDocumentWriteTransaction({ transaction, nextDocument: appended });
assert.equal(receipt.verified, true);
assert.notEqual(receipt.beforeHash, receipt.afterHash);

const createInstruction = "创建并写入设定文档《测试设定》";
const createCandidate = "这是正式设定内容。";
const createAuthorization = {
  ...await bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction: createInstruction,
    sourceMessageId: "user-create",
    targetDocumentIds: ["canon-test"],
    targetExists: false,
    taskContract: {
      contractId: "contract-create",
      revision: 1,
      deliverables: [{ id: "setting", required: true, kind: "setting", targetDocumentId: "canon-test", title: "测试设定" }],
    },
  }), {
    candidate: createCandidate,
    targetDocumentIds: ["canon-test"],
  }),
  allowTitleMutation: false,
};
const createTransaction = await beginDocumentWriteTransaction({
  transactionId: "tx-create",
  documentId: "canon-test",
  documentState: null,
  operation: "create",
  candidateContent: createCandidate,
  authorizationCandidate: createCandidate,
  writeAuthorization: createAuthorization,
  sourceMessageId: "user-create",
  sourceInstruction: createInstruction,
});
const createReceipt = await commitDocumentWriteTransaction({
  transaction: createTransaction,
  nextDocument: { title: "测试设定", html: `<p>${createCandidate}</p>`, moduleId: "canon" },
});
assert.equal(createReceipt.verified, true, "新建文档的初始标题不是对已有标题的未授权修改");

await assert.rejects(
  () => beginDocumentWriteTransaction({ documentId: "chapter-1", documentState: original, operation: "replace", candidateContent: "", writeAuthorization: appendAuthorization }),
  (error) => error.code === "DOCUMENT_TRANSACTION_EMPTY_CANDIDATE",
);
await assert.rejects(
  () => commitDocumentWriteTransaction({ transaction, nextDocument: { ...original, html: "<p>只剩续写内容。</p>" } }),
  (error) => error.code === "DOCUMENT_TRANSACTION_APPEND_VIOLATION",
);
const replaceInstruction = "直接重写当前章节";
const replaceRoute = buildAdaptiveTaskRoute({
  text: replaceInstruction,
  sourceMessageId: "user-replace",
  target: { documentId: "chapter-1", revision: original.revision, title: original.title },
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": original.revision },
}, { executionSurface: "agent" });
const replaceAuthorization = await bindFormalWriteCandidate(replaceRoute.writeAuthorization, {
  candidate: "新正文",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": original.revision },
});
await assert.rejects(
  () => beginDocumentWriteTransaction({ documentId: "chapter-1", documentState: original, operation: "replace", candidateContent: "新正文", expectedDocumentHash: "wrong", writeAuthorization: replaceAuthorization, sourceMessageId: "user-replace", sourceInstruction: replaceInstruction }),
  (error) => error.code === "DOCUMENT_TRANSACTION_BASELINE_CONFLICT",
);

const questionRoute = buildAdaptiveTaskRoute({
  text: "为什么续写会写入正文？",
  sourceMessageId: "question",
  target: { documentId: "chapter-1", revision: original.revision },
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": original.revision },
}, { executionSurface: "chat" });
const questionPolicy = questionRoute.taskPolicy;
assert.equal(questionPolicy.action, "analyze");
assert.equal(questionPolicy.commitOwner, "none");
assert.equal(questionPolicy.commitDisposition, "no_artifact");
assert.deepEqual(automaticLandingDecision({
  instruction: "为什么续写会写入正文？",
  result: { candidate: "这只是一段解释，不是正式正文。" },
  taskPolicy: questionPolicy,
  route: questionRoute,
}), { action: "none", reason: "formal_write_not_authorized" });
assert.equal(formalArtifactCommitEligibility({ route: questionRoute, runStatus: "completed" }).eligible, false);
assert.equal(formalArtifactCommitEligibility({ route: null, runStatus: "completed" }).eligible, false);
assert.equal(workspaceFileMutationIntent("检查普通问答为什么覆盖了标题并清空正文，需要修复原因", questionRoute), false);
assert.equal(workspaceFileMutationIntent("修改当前工作区里的 app.js", null), false);
assert.equal(formalArtifactContentAssessment({
  instruction: "请分析资料应该怎样采用",
  content: "我还不能确定以下资料应当怎样读取或采用。",
}).valid, false);
assert.equal(latestRecoverableCandidate({
  messages: [
    { id: "question", role: "user", content: "为什么标题被覆盖？" },
    {
      id: "answer",
      role: "assistant",
      candidate: "第6章 这只是普通问答，不是正式正文。",
      target: { documentId: "chapter-1" },
      execution: { sourceMessageId: "question", taskRoute: questionRoute },
    },
  ],
  fallbackTarget: { documentId: "chapter-1" },
}), null);

const writeCandidate = "正式续写正文。";
const writeBaseRoute = buildAdaptiveTaskRoute({
  text: "续写当前章节并落盘",
  sourceMessageId: "write-request",
  target: { documentId: "chapter-1", revision: original.revision, title: original.title },
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": original.revision },
}, { executionSurface: "chat" });
const writeAuthorization = await bindFormalWriteCandidate(writeBaseRoute.writeAuthorization, {
  candidate: writeCandidate,
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": original.revision },
});
const writeRoute = { ...writeBaseRoute, writeAuthorization };
const writePolicy = writeRoute.taskPolicy;
assert.equal(writePolicy.action, "generate");
assert.equal(writePolicy.commitOwner, "shensi_transaction");
assert.equal(formalArtifactCommitEligibility({ route: writeRoute, runStatus: "completed" }).eligible, true);
assert.equal(automaticLandingDecision({
  instruction: "续写当前章节并落盘",
  result: { candidate: writeCandidate },
  taskPolicy: writePolicy,
  route: writeRoute,
}).action, "land");

const workspaceRoute = {
  mode: "workspace_operation",
  candidatePreviewRequired: false,
  action: "operate",
  executionOwner: "workspace_agent",
  commitOwner: "workspace_agent",
  commitDisposition: "no_artifact",
};
assert.equal(workspaceFileMutationIntent("修改 src/app.js 并保存", workspaceRoute), true);
assert.equal(workspaceFileMutationIntent("继续执行刚才已经确认的方案", workspaceRoute), true,
  "源码写入权限必须来自结构化任务合同，不能依赖修改关键词");
assert.equal(workspaceSelfRepairIntent("继续", workspaceRoute), true,
  "已确认的自修复合同必须直接定位源码工作区，不能再次猜测目标关键词");
assert.equal(workspaceFileMutationIntent("修改 src/app.js 并保存", { ...workspaceRoute, action: "analyze", commitOwner: "none" }), false,
  "文字中的修改关键词不能越过只读任务合同");
const workspaceReadRoute = {
  mode: "general",
  action: "analyze",
  executionOwner: "workspace_agent",
  commitOwner: "none",
  workspaceReadRequired: true,
  workspaceReadTargets: ["src/app.js"],
};
assert.equal(workspaceFileReadIntent("继续核对", workspaceReadRoute), true,
  "文件读取要求必须来自结构化任务合同，不能依赖读取关键词");
assert.equal(workspaceFileReadIntent("读取 src/app.js", null), false,
  "裸关键词不得自行取得文件读取权限");

const [appSource, agentToolsSource] = await Promise.all([
  (await import("node:fs/promises")).readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  (await import("node:fs/promises")).readFile(new URL("../src/server/conversation-agent-tools.mjs", import.meta.url), "utf8"),
]);
assert.match(appSource, /const sendMessage = async[\s\S]{0,9000}executeConversationAgentMessage\(/u,
  "普通对话必须直接进入统一 Agent，不再由旧自动落盘关键词链决定");
assert.match(agentToolsSource, /state:\s*"commit",\s*action:\s*args\.operation[\s\S]{0,1800}type:\s*args\.operation/u,
  "Agent 工具选择的明确操作必须同时绑定授权与安全事务");
assert.doesNotMatch(agentToolsSource, /buildAdaptiveTaskRoute|createFormalWriteAuthorization/u,
  "Agent 文档工具不得再次用用户措辞做关键词任务分类");
assert.match(agentToolsSource, /import \{ executeDocumentTransaction \} from "\.\/native-document-transaction-service\.mjs"/u,
  "Agent 正式写入必须复用带完整历史保护的事务服务");
assert.match(agentToolsSource, /args\.operation !== "create"[\s\S]{0,120}expectedRevision/u,
  "覆盖、续写、追加、局部替换和重命名前必须先读取并绑定目标版本");
assert.match(agentToolsSource, /document\?\.documentKind === "whiteboard"[\s\S]{0,100}对话工具不修改白板/u,
  "统一对话 Agent 不得绕过原有白板执行面");

console.log("Shensi safe write transaction and unified Agent operation tests passed");
