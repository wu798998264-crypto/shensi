import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBlankProjectState } from "../src/data.js";
import { formalDocumentWriteRevision } from "../src/document-write-revision.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization, rebaseFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { liveWriteTargetDecision } from "../src/live-write-target-policy.js";
import { supplementRequestsLatestDocument } from "../src/supplement-policy.js";
import { resolveTurnAssociationChange } from "../src/automatic-landing-policy.js";
import { resolveWorkspaceLandingScope } from "../src/workspace-scope-policy.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const documentId = "chapter-8";
const item = [documentId, "第8章 未命名", { workspaceView: "novel" }];
const original = {
  title: "未命名",
  html: "<p>用户在任务开始前的正文。</p>",
  markdown: "用户在任务开始前的正文。",
  moduleId: "manuscript",
};
const originalRevision = formalDocumentWriteRevision({ documentId, document: original, item });
const baseAuthorization = createFormalWriteAuthorization({
  instruction: "续写当前章节",
  sourceMessageId: "message-live-1",
  targetDocumentIds: [documentId],
  expectedRevisions: { [documentId]: originalRevision },
  targetExists: true,
});

const userEdited = {
  ...original,
  html: "<p>用户在任务开始前的正文。</p><p>生成期间新增的一段，必须保留。</p>",
  markdown: "用户在任务开始前的正文。\n\n生成期间新增的一段，必须保留。",
};
const latestRevision = formalDocumentWriteRevision({ documentId, document: userEdited, item });
assert.notEqual(latestRevision, originalRevision);
assert.deepEqual(liveWriteTargetDecision({
  action: "append",
  expectedRevisions: { [documentId]: originalRevision },
  currentRevisions: { [documentId]: latestRevision },
  workspaceMatches: true,
}), { action: "regenerate_from_latest", changedDocumentIds: [documentId] });
assert.deepEqual(liveWriteTargetDecision({
  action: "append",
  expectedRevisions: { [documentId]: originalRevision },
  currentRevisions: { [documentId]: latestRevision },
  workspaceMatches: true,
  preserveLockedRequested: true,
}), { action: "preserve_locked_snapshot", changedDocumentIds: [documentId] });
assert.equal(supplementRequestsLatestDocument("请按最新文档内容继续生成"), true);
assert.equal(supplementRequestsLatestDocument("再加强一点悬念"), false);
assert.deepEqual(liveWriteTargetDecision({
  action: "rename",
  expectedRevisions: { [documentId]: originalRevision },
  currentRevisions: { [documentId]: latestRevision },
  workspaceMatches: false,
}), { action: "rebase_title_only", changedDocumentIds: [documentId] });

assert.equal(resolveTurnAssociationChange({
  snapshot: { associationEnabled: true, boundDocumentId: "chapter-8", workspacePath: "E:/作品/A" },
  current: { associationEnabled: true, boundDocumentId: "chapter-9", workspacePath: "E:/作品/B" },
  explicitRetarget: false,
}).action, "confirm_target", "只切换工作区不能静默改变正在运行任务的目标");
assert.equal(resolveTurnAssociationChange({
  snapshot: { associationEnabled: true, boundDocumentId: "chapter-8", workspacePath: "E:/作品/A" },
  current: { associationEnabled: true, boundDocumentId: "chapter-9", workspacePath: "E:/作品/B" },
  explicitRetarget: true,
}).action, "reroute", "最新任务明确指定新目标时必须按新目标重路由");
assert.deepEqual(resolveWorkspaceLandingScope({
  workspaceKind: "project",
  workspacePath: "E:/作品/A",
  workspaceName: "作品A",
  instruction: "把当前内容写入作品《作品B》",
  explicitTargetWorkspaceKind: "project",
  explicitTargetWorkspacePath: "E:/作品/B",
  explicitTargetWorkspaceName: "作品B",
}), {
  workspaceKind: "project",
  workspacePath: "E:/作品/B",
  workspaceName: "作品B",
  crossWorkspace: true,
  authorized: true,
  operation: "route",
  reason: "explicit_workspace_transition",
});

const rebased = rebaseFormalWriteAuthorization(baseAuthorization, {
  expectedRevisions: { [documentId]: latestRevision },
  reason: "latest_document_reloaded",
});
assert.equal(rebased.expectedRevisions[documentId], latestRevision);
assert.equal(rebased.candidateHash, undefined);
const candidate = "这是基于用户最新正文生成的续写。";
const bound = bindFormalWriteCandidate(rebased, {
  candidate,
  targetDocumentIds: [documentId],
  expectedRevisions: { [documentId]: latestRevision },
});

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-v284-live-target-"));
try {
  const appRoot = join(tempRoot, "app");
  const workspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "实时正文");
  const state = createBlankProjectState("实时正文");
  state.documents[documentId] = userEdited;
  state.moduleItems.manuscript.push(item);
  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state, operationDocumentIds: [documentId] });
  const persistedBeforeWrite = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(
    formalDocumentWriteRevision({
      documentId,
      document: persistedBeforeWrite.state.documents[documentId],
      item: persistedBeforeWrite.state.moduleItems.manuscript.find((entry) => entry?.[0] === documentId),
    }),
    latestRevision,
    `持久化前后 revision 必须一致：${JSON.stringify({ document: persistedBeforeWrite.state.documents[documentId], item: persistedBeforeWrite.state.moduleItems.manuscript.find((entry) => entry?.[0] === documentId) })}`,
  );
  const result = await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: {
      taskId: "task-live-1",
      executionSurface: "chat",
      operation: "append",
      instruction: "续写当前章节",
      authorizedCandidate: candidate,
      writeAuthorization: bound,
      target: { documentId },
    },
    operations: [{ operationId: "append-live-1", type: "append", targetDocumentId: documentId, content: candidate }],
    expectedRevisions: { [documentId]: latestRevision },
    commitMode: "atomic",
  });
  assert.equal(result.verified, true);
  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.match(loaded.state.documents[documentId].markdown, /生成期间新增的一段，必须保留/u);
  assert.match(loaded.state.documents[documentId].markdown, /基于用户最新正文生成的续写/u);
  assert.equal(loaded.state.histories[documentId][0].content, userEdited.markdown);
  const beforeRenameContent = loaded.state.documents[documentId].markdown;
  const beforeRenameHistoryCount = loaded.state.histories[documentId].length;
  const beforeRenameRevision = formalDocumentWriteRevision({
    documentId,
    document: loaded.state.documents[documentId],
    item: loaded.state.moduleItems.manuscript.find((entry) => entry?.[0] === documentId),
  });
  const renameInstruction = "将当前文档标题改为《雨渠回声》";
  const renameAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction: renameInstruction,
    sourceMessageId: "message-title-1",
    targetDocumentIds: [documentId],
    expectedRevisions: { [documentId]: beforeRenameRevision },
    targetExists: true,
    targetTitle: loaded.state.documents[documentId].title,
  }), {
    candidate: "雨渠回声",
    targetDocumentIds: [documentId],
    expectedRevisions: { [documentId]: beforeRenameRevision },
  });
  const renameResult = await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: {
      taskId: "task-title-1",
      executionSurface: "chat",
      operation: "rename",
      instruction: renameInstruction,
      authorizedCandidate: "雨渠回声",
      writeAuthorization: renameAuthorization,
      target: { documentId },
    },
    operations: [{ operationId: "rename-title-1", type: "rename", targetDocumentId: documentId, requestedTitle: "雨渠回声" }],
    expectedRevisions: { [documentId]: beforeRenameRevision },
    commitMode: "atomic",
  });
  assert.equal(renameResult.verified, true);
  const renamed = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(renamed.state.documents[documentId].title, "雨渠回声");
  assert.equal(renamed.state.documents[documentId].markdown, beforeRenameContent, "标题落盘不得改正文");
  assert.equal(renamed.state.histories[documentId].length, beforeRenameHistoryCount + 1, "标题落盘必须新增历史版本");
  assert.equal(renamed.state.histories[documentId][0].content, beforeRenameContent, "标题历史必须保存改名前完整正文");
  assert.equal(renamed.state.histories[documentId][0].operation, "rename");
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const agentToolsSource = await readFile(new URL("../src/server/conversation-agent-tools.mjs", import.meta.url), "utf8");
assert.match(appSource, /landFormalCandidateInPinnedWorkspace/u, "目标工作区不在前台时必须走后台原子事务");
assert.match(appSource, /const pinnedWorkspace = !workspaceTargetIsActive\(workspaceScope\.workspaceKind, workspaceScope\.workspacePath\)/u,
  "是否后台落盘必须依据任务启动时固定的工作区范围");
assert.match(appSource, /const result = pinnedWorkspace\s*\?\s*await landFormalCandidateInPinnedWorkspace/u,
  "切换到其他作品后必须使用固定工作区的后台原子事务");
assert.match(appSource, /withActiveWorkspaceFormalLandingLock/u, "活动工作区提交期间切换必须等待原子落盘完成");
assert.match(appSource, /正在完成当前文档的原子落盘，完成后自动切换作品/u);
assert.match(appSource, /taskWorkspaceStateForSend = await taskWorkspaceStateForSnapshot\(submittedTaskContextSnapshot\)/u,
  "切换界面后必须重新取得发送时固定的原工作区状态");
assert.match(appSource, /workspaceKind: taskContextSnapshot\.workspaceKind, workspacePath: taskContextSnapshot\.workspacePath/u,
  "统一 Agent 请求必须携带发送时固定的工作区身份");
assert.match(appSource, /savePinnedConversationCompletion[\s\S]*candidateState/u, "切换工作区后原对话与候选状态必须一并保存");
assert.match(agentToolsSource, /args\.operation !== "create" && !text\(args\.expectedRevision\)/u,
  "统一 Agent 修改既有文档前必须持有最近读取所得 revision");
assert.match(agentToolsSource, /const expectedRevisions = \{ \[id\]: text\(args\.expectedRevision\) \}/u,
  "文档工具必须把 Agent 提交的最新 revision 绑定到原子事务");
assert.match(agentToolsSource, /result = await write\(\{ appRoot, workspacePath, requestId, expectedRevisions/u,
  "统一 Agent 必须通过神思原生文档事务写入并验收");
assert.match(serverSource, /generation_restarted_from_latest_document/u, "生成期间修改正文后必须由服务端按最新版重跑");
assert.match(serverSource, /latestDocumentReloaded:\s*true/u);

console.log("Shensi v2.84 live write target tests passed");
