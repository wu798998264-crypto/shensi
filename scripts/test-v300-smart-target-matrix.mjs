import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBlankProjectState } from "../src/data.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { resolveDocumentTarget } from "../src/document-target-resolver.js";
import { executeDocumentTransaction } from "../src/server/native-document-transaction-service.mjs";
import { liveWriteTargetDecision } from "../src/live-write-target-policy.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const inventory = [
  { documentId: "setting-world", title: "世界观设定", moduleId: "settings", contextDomain: "setting" },
  { documentId: "chapter-3", title: "第3章", moduleId: "manuscript", contextDomain: "novel" },
  { documentId: "chapter-8", title: "第8章 未命名", moduleId: "manuscript", contextDomain: "novel" },
];

assert.deepEqual(resolveDocumentTarget({
  instruction: "生成第10章正文",
  boundTarget: inventory[1],
  activeTarget: inventory[0],
  inventory,
}), {
  status: "resolved",
  target: { documentId: "chapter-10", chapterNumber: 10, title: "第10章 未命名", moduleId: "manuscript", contextDomain: "novel", operation: "create" },
  reason: "explicit_instruction_target",
});

assert.equal(resolveDocumentTarget({
  instruction: "修改世界观设定",
  boundTarget: inventory[1],
  semanticTargets: [inventory[0]],
  activeTarget: inventory[2],
  inventory,
}).target.documentId, "setting-world", "绑定正文时明确修改设定必须落到设定");

assert.equal(resolveDocumentTarget({
  instruction: "续写当前文档",
  boundTarget: inventory[2],
  activeTarget: inventory[0],
  inventory,
}).target.documentId, "chapter-8");

assert.equal(resolveDocumentTarget({
  instruction: "直接改写选区",
  selectionTarget: inventory[1],
  boundTarget: inventory[2],
  inventory,
}).reason, "explicit_selection_target");

assert.equal(resolveDocumentTarget({ instruction: "继续", inventory: [] }).status, "needs_choice");

assert.deepEqual(liveWriteTargetDecision({
  action: "append",
  expectedRevisions: { "chapter-8": "old" },
  currentRevisions: { "chapter-8": "latest" },
}), { action: "regenerate_from_latest", changedDocumentIds: ["chapter-8"] }, "用户生成期间修改正文时默认读取最新版");
assert.deepEqual(liveWriteTargetDecision({
  action: "append",
  expectedRevisions: { "chapter-8": "old" },
  currentRevisions: { "chapter-8": "latest" },
  preserveLockedRequested: true,
}), { action: "preserve_locked_snapshot", changedDocumentIds: ["chapter-8"] }, "只有明确要求旧版本时才固定旧 revision");

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-v300-title-optional-"));
try {
  const appRoot = join(tempRoot, "app");
  const workspacePath = join(appRoot, "runtime", "E-drive-data", "作品", "标题可选");
  await saveWorkspaceState({ appRoot, requestedPath: workspacePath, state: createBlankProjectState("标题可选") });
  const instruction = "生成第十章正文并落盘";
  const candidate = "雨水沿着废弃高架落下，主角在站台尽头看见了那盏迟到七年的灯。";
  const authorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
    instruction,
    sourceMessageId: "user-create-10",
    targetDocumentIds: ["chapter-10"],
    expectedRevisions: { "chapter-10": "" },
    targetExists: false,
  }), { candidate, targetDocumentIds: ["chapter-10"], expectedRevisions: { "chapter-10": "" } });
  const receipt = await executeDocumentTransaction({
    appRoot,
    workspacePath,
    task: { taskId: "task-create-10", executionSurface: "chat", operation: "create", instruction, authorizedCandidate: candidate, writeAuthorization: authorization, target: { documentId: "chapter-10", directoryId: "manuscript" } },
    operations: [{ operationId: "create-10", type: "create", targetDocumentId: "chapter-10", targetDirectoryId: "manuscript", content: candidate }],
    expectedRevisions: { "chapter-10": "" },
    commitMode: "atomic",
  });
  assert.equal(receipt.verified, true);
  const loaded = await loadWorkspaceState({ appRoot, requestedPath: workspacePath });
  assert.equal(loaded.state.documents["chapter-10"].title, "未命名", "缺少标题时正文必须先落盘并保留可后补的占位标题");
  assert.equal(loaded.state.moduleItems.manuscript.some((item) => item?.[0] === "chapter-10"), true, "章节容器与目录关联必须随正文一起创建");
  assert.equal(loaded.state.documents["chapter-10"].markdown, candidate);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

console.log("Shensi v3.0 smart target and optional title tests passed");
