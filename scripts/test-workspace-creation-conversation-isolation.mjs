import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createBlankNotebookState, createBlankProjectState } from "../src/data.js";
import { normalizeWorkspaceOperationPlan } from "../src/workspace-operations.js";

const normalized = normalizeWorkspaceOperationPlan({
  id: "create-project-once",
  intent: "按本条指令新建作品",
  operations: [
    {
      type: "project.create",
      name: "新作品",
      creationRequirements: "只带入明确点名的世界观",
      initialDocuments: [
        {
          moduleId: "canon",
          viewId: "novel",
          title: "世界观",
          content: "本条指令明确给出的世界观。",
          sourceDocumentId: "source-note",
        },
      ],
    },
    {
      type: "document.create",
      moduleId: "manuscript",
      viewId: "novel",
      title: "不应成为第二项操作",
      content: "不能在创建操作后另行复制。",
    },
  ],
}, {
  documentIds: ["source-note"],
  documentRevisions: { "source-note": "revision-locked-at-confirmation" },
  documentTitles: { "source-note": "明确来源笔记" },
});

assert.equal(normalized?.operations.length, 1, "创建工作区必须归一化为单个状态替换操作");
assert.equal(normalized.operations[0].type, "project.create");
assert.equal(normalized.operations[0].creationRequirements, "只带入明确点名的世界观");
assert.equal(normalized.operations[0].initialDocuments.length, 1);
assert.equal(normalized.operations[0].initialDocuments[0].sourceDocumentId, "source-note");
assert.equal(normalized.operations[0].initialDocuments[0].sourceExpectedRevision, "revision-locked-at-confirmation",
  "明确来源文档必须锁定确认时 revision");

const unknownSource = normalizeWorkspaceOperationPlan({
  operations: [{
    type: "project.create",
    name: "无越权复制",
    initialDocuments: [{
      moduleId: "canon",
      viewId: "novel",
      title: "未知资料",
      sourceDocumentId: "not-in-inventory",
    }],
  }],
}, { documentIds: ["source-note"] });
assert.deepEqual(unknownSource?.operations[0].initialDocuments, [],
  "清单外来源不得进入新工作区种子");

const notebookPlan = normalizeWorkspaceOperationPlan({
  operations: [{
    type: "notebook.create",
    name: "新笔记本",
    initialDocuments: [{ title: "首条笔记", content: "只来自本条指令。", moduleId: "manuscript", viewId: "script" }],
  }],
});
assert.equal(notebookPlan?.operations[0].initialDocuments[0].moduleId, "library");
assert.equal(notebookPlan?.operations[0].initialDocuments[0].viewId, "novel");

for (const blank of [
  createBlankProjectState({ name: "空白作品", workspacePath: "C:/tmp/project" }),
  createBlankNotebookState({ name: "空白笔记本", workspacePath: "C:/tmp/notebook" }),
]) {
  assert.deepEqual(blank.messages, []);
  assert.equal(blank.conversations.length, 1);
  assert.deepEqual(blank.conversations[0].messages, [], "新工作区不得复制发起创建的对话");
}

async function sourceBlock(file, start, end, limit = 250) {
  const stream = createReadStream(resolve(import.meta.dirname, file), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const collected = [];
  try {
    for await (const line of lines) {
      if (!collected.length && !line.includes(start)) continue;
      if (collected.length && line.includes(end)) return collected.join("\n");
      collected.push(line);
      assert.ok(collected.length < limit, `bounded source block: ${start}`);
    }
    assert.fail(`missing source block: ${start}`);
  } finally {
    lines.close();
    stream.destroy();
  }
}

const creationUi = await sourceBlock("../src/app.js", "const applyWorkspaceCreationSeed =", "const renameProject =");
assert.match(creationUi, /createBlankProjectState/u);
assert.match(creationUi, /createBlankNotebookState/u);
assert.match(creationUi, /workspaceCreationOperationId/u);
assert.match(creationUi, /body: JSON\.stringify\(\{ name, operationId \}\)/u);
assert.doesNotMatch(creationUi, /conversations:\s*clone/u);

const creationApply = await sourceBlock("../src/app.js", "const applyWorkspaceOperationPlan =", "snapshotWorkspaceOperationPlan\(plan\)");
assert.match(creationApply, /operationId:\s*plan\.id/u);
assert.match(creationApply, /savePinnedConversationCompletion/u,
  "创建完成状态必须回写源工作区，而不是把源对话复制到新工作区");

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-workspace-create-idempotency-"));
process.env.SHENSI_DATA_ROOT = join(tempRoot, "data");
const { createWorkspaceNotebook, createWorkspaceProject } = await import("../src/server/workspace.mjs");
const appRoot = join(tempRoot, "app");
try {
  const firstProject = await createWorkspaceProject({ appRoot, name: "幂等作品", operationId: "operation-project-1" });
  const retriedProject = await createWorkspaceProject({ appRoot, name: "幂等作品", operationId: "operation-project-1" });
  assert.equal(retriedProject.workspacePath, firstProject.workspacePath);
  assert.equal(retriedProject.resumed, true, "相同创建任务重试必须复用原作品目录");
  const projectReceipt = JSON.parse(await readFile(join(firstProject.workspacePath, ".shensi", "creation-receipt.json"), "utf8"));
  assert.equal(projectReceipt.operationId, "operation-project-1");

  const distinctProject = await createWorkspaceProject({ appRoot, name: "幂等作品", operationId: "operation-project-2" });
  assert.notEqual(distinctProject.workspacePath, firstProject.workspacePath,
    "不同 operationId 的同名创建仍应分配独立目录");

  const firstNotebook = await createWorkspaceNotebook({ name: "幂等笔记本", operationId: "operation-notebook-1" });
  const retriedNotebook = await createWorkspaceNotebook({ name: "幂等笔记本", operationId: "operation-notebook-1" });
  assert.equal(retriedNotebook.workspacePath, firstNotebook.workspacePath);
  assert.equal(retriedNotebook.resumed, true, "相同创建任务重试必须复用原笔记本目录");
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => {});
}

console.log("workspace creation seed, source lock, blank conversation and idempotency tests passed");
