import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createBlankNotebookState } from "../src/data.js";
import { saveWorkspaceState, loadWorkspaceState } from "../src/server/workspace.mjs";
import { prepareCommittedDocumentHistory, verifyCommittedDocumentHistory } from "../src/server/document-write-history.mjs";

const emptyDocument = { title: "空白测试", html: "", markdown: "", moduleId: "library", attachments: [], customMetadata: { keep: true } };
const before = { documents: { note: emptyDocument }, histories: {} };
const after = { documents: { note: { ...emptyDocument, html: "<p>开始</p>", markdown: "开始" } }, histories: {} };
const receipts = await prepareCommittedDocumentHistory({ currentState: before, nextState: after, changedDocumentIds: ["note"], transactionId: "unit-1" });
assert.deepEqual(after.histories.note[0].document, after.documents.note);
await verifyCommittedDocumentHistory({ histories: after.histories, receipts });
const damaged = structuredClone(after.histories);
damaged.note[0].document.html = "corrupt";
await assert.rejects(verifyCommittedDocumentHistory({ histories: damaged, receipts }), { code: "DOCUMENT_COMMITTED_HISTORY_UNVERIFIED" });
const stale = { histories: {}, documents: after.documents };
await prepareCommittedDocumentHistory({ currentState: after, nextState: stale, transactionId: "unit-2" });
assert.equal(stale.histories.note.length, 1, "stale renderer cannot erase a mandatory snapshot");
const boardState = { documents: { board: { documentKind: "whiteboard", canvas: { nodes: [] } } }, histories: {} };
const nextBoard = structuredClone(boardState);
assert.deepEqual(await prepareCommittedDocumentHistory({ currentState: boardState, nextState: nextBoard, changedDocumentIds: ["board"], transactionId: "board-excluded" }), []);
assert.deepEqual(nextBoard, boardState, "whiteboard history behavior is unchanged");

const titleOnlyBefore = {
  documents: { note: { ...emptyDocument, title: "待写标题", html: "<h1>待写标题</h1>", markdown: "待写标题" } },
  histories: {},
};
const titleOnlyAfter = {
  documents: { note: { ...emptyDocument, title: "正式标题", html: "<p>第一版正式正文。</p>", markdown: "第一版正式正文。" } },
  histories: {},
};
await prepareCommittedDocumentHistory({
  currentState: titleOnlyBefore,
  nextState: titleOnlyAfter,
  changedDocumentIds: ["note"],
  transactionId: "first-write-title-placeholder",
  source: "chat",
});
assert.equal(titleOnlyAfter.histories.note.length, 1, "空白或只有标题的首次 AI 落盘只保存写入后的完整版本");
assert.equal(titleOnlyAfter.histories.note[0].document.markdown, "第一版正式正文。");

const manuallyEditedBeforeAgent = {
  documents: {
    note: {
      ...emptyDocument,
      title: "人工修订标题",
      html: "<p>尚未手动保存的人工修改。</p>",
      markdown: "尚未手动保存的人工修改。",
    },
  },
  histories: {},
};
const afterAgentOverwrite = {
  documents: {
    note: {
      ...emptyDocument,
      title: "AI 正式稿",
      html: "<p>AI 覆盖后的正式内容。</p>",
      markdown: "AI 覆盖后的正式内容。",
    },
  },
  histories: {},
};
await prepareCommittedDocumentHistory({
  currentState: manuallyEditedBeforeAgent,
  nextState: afterAgentOverwrite,
  changedDocumentIds: ["note"],
  transactionId: "agent-overwrite-safeguard",
  source: "agent",
});
assert.equal(afterAgentOverwrite.histories.note.length, 2, "AI 覆盖未保存人工修改时必须同时保存覆盖前和覆盖后的完整版本");
assert.equal(afterAgentOverwrite.histories.note[0].document.markdown, "AI 覆盖后的正式内容。");
assert.equal(afterAgentOverwrite.histories.note[1].document.markdown, "尚未手动保存的人工修改。");
assert.equal(afterAgentOverwrite.histories.note[1].document.title, "人工修订标题");
assert.equal(afterAgentOverwrite.histories.note[1].preOverwriteSnapshot, true);

const priorVersionAlreadySaved = structuredClone(afterAgentOverwrite.histories.note[1]);
const overwriteWithExistingSafeguard = {
  documents: { note: structuredClone(afterAgentOverwrite.documents.note) },
  histories: { note: [priorVersionAlreadySaved] },
};
await prepareCommittedDocumentHistory({
  currentState: { ...manuallyEditedBeforeAgent, histories: { note: [priorVersionAlreadySaved] } },
  nextState: overwriteWithExistingSafeguard,
  changedDocumentIds: ["note"],
  transactionId: "agent-overwrite-no-duplicate",
  source: "agent",
});
assert.equal(overwriteWithExistingSafeguard.histories.note.length, 2, "当前版本已有完整快照时不得重复保存覆盖前版本");

const testRoot = await mkdtemp(join(tmpdir(), "shensi-agent-history-"));
try {
  const protectedWorkspacePath = join(testRoot, "runtime", "E-drive-data", "笔记", "AI覆盖保护");
  const protectedOptions = { appRoot: testRoot, requestedPath: protectedWorkspacePath };
  const protectedState = createBlankNotebookState({ name: "AI覆盖保护" });
  protectedState.documents.note = {
    ...emptyDocument,
    title: "人工编辑稿",
    html: "<p>用户刚刚修改、但尚未手动保存历史版本的内容。</p>",
    markdown: "用户刚刚修改、但尚未手动保存历史版本的内容。",
  };
  protectedState.moduleItems.library = [["note", "人工编辑稿"]];
  await saveWorkspaceState({ ...protectedOptions, state: protectedState });
  let protectedCurrent = (await loadWorkspaceState(protectedOptions)).state;
  assert.equal(protectedCurrent.histories.note?.length || 0, 0, "首次建立工作区时不应虚构历史版本");

  protectedCurrent.documents.note = {
    ...protectedCurrent.documents.note,
    title: "AI覆盖稿",
    html: "<p>AI 后写并覆盖的正式内容。</p>",
    markdown: "AI 后写并覆盖的正式内容。",
  };
  const protectedCommit = await saveWorkspaceState({
    ...protectedOptions,
    state: protectedCurrent,
    operationDocumentIds: ["note"],
    historyOperations: [{ operationId: "agent-overwrite-op", targetDocumentId: "note", type: "replace" }],
    historySource: "agent",
  });
  protectedCurrent = (await loadWorkspaceState(protectedOptions)).state;
  assert.equal(protectedCommit.committedHistory.length, 1, "AI 覆盖事务必须返回写入后版本凭据");
  assert.equal(protectedCurrent.histories.note.length, 2, "AI 覆盖必须原子保存覆盖前当前稿和覆盖后新稿");
  assert.equal(protectedCurrent.histories.note[0].document.markdown, "AI 后写并覆盖的正式内容。");
  assert.equal(protectedCurrent.histories.note[1].document.markdown, "用户刚刚修改、但尚未手动保存历史版本的内容。");
  assert.equal(protectedCurrent.histories.note[1].preOverwriteSnapshot, true);

  protectedCurrent.documents.createdByAgent = {
    ...emptyDocument,
    title: "AI新建文档",
    html: "<p>AI 新写入的第一版完整内容。</p>",
    markdown: "AI 新写入的第一版完整内容。",
  };
  protectedCurrent.moduleItems.library.push(["createdByAgent", "AI新建文档"]);
  const createCommit = await saveWorkspaceState({
    ...protectedOptions,
    state: protectedCurrent,
    operationDocumentIds: ["createdByAgent"],
    historyOperations: [{ operationId: "agent-create-op", targetDocumentId: "createdByAgent", type: "create" }],
    historySource: "agent",
  });
  protectedCurrent = (await loadWorkspaceState(protectedOptions)).state;
  assert.equal(createCommit.committedHistory.length, 1, "AI 新建文档必须返回第一版历史凭据");
  assert.equal(protectedCurrent.histories.createdByAgent.length, 1, "AI 新建文档写入成功时必须同时创建历史版本");
  assert.equal(protectedCurrent.histories.createdByAgent[0].document.markdown, "AI 新写入的第一版完整内容。");

  const workspacePath = join(testRoot, "runtime", "E-drive-data", "笔记", "完整历史");
  const options = { appRoot: testRoot, requestedPath: workspacePath };
  const state = createBlankNotebookState({ name: "完整历史" });
  state.documents.note = structuredClone(emptyDocument);
  state.moduleItems.library = [["note", "空白测试"]];
  await saveWorkspaceState({ ...options, state });
  const load = async () => (await loadWorkspaceState(options)).state;
  let current = await load();
  assert.ok(current.documents.note);
  for (const nextText of ["完整初稿。", "完整初稿。\n\n追加内容。", "完整改稿。\n\n追加内容。", "完全覆盖后的正文。"] ) {
    current.documents.note = { ...current.documents.note, html: `<p>${nextText}</p>`, markdown: nextText };
    const saved = await saveWorkspaceState({ ...options, state: current });
    assert.equal(saved.committedHistory.length, 1);
    current = await load();
    const committed = current.histories.note[0].document;
    assert.equal(committed.title, current.documents.note.title);
    assert.equal(committed.markdown, current.documents.note.markdown);
    assert.equal(committed.html, `<p>${nextText}</p>`);
    assert.equal(committed.moduleId, current.documents.note.moduleId);
    assert.deepEqual(committed.customMetadata, current.documents.note.customMetadata);
    assert.equal(committed.contentRef, undefined, "历史版本不得保留可变正文文件引用");
    await verifyCommittedDocumentHistory({ histories: current.histories, receipts: saved.committedHistory });
  }
  const count = current.histories.note.length;
  await saveWorkspaceState({ ...options, state: current });
  current = await load();
  assert.equal(current.histories.note.length, count, "unchanged content must not create extra history");
  const selectedVersion = current.histories.note.at(-1);
  const selectedRestore = structuredClone(selectedVersion.document);
  const selectedVersionId = selectedVersion.id;
  const countBeforeRestore = current.histories.note.length;
  current.documents.note = selectedRestore;
  const restored = await saveWorkspaceState({ ...options, state: current });
  current = await load();
  assert.equal(current.histories.note.length, countBeforeRestore, "restoring content identical to any old version must not create a duplicate history entry");
  assert.equal(current.histories.note[0].id, selectedVersionId, "the matching old version must move to the top and become the latest history entry");
  assert.deepEqual(current.histories.note[0].document, selectedRestore, "the promoted version must retain its complete saved document");
  assert.equal(restored.committedHistory[0].reusedHistoryVersion, true, "the committed history receipt must report reuse rather than a duplicate snapshot");
  await verifyCommittedDocumentHistory({ histories: current.histories, receipts: restored.committedHistory });
  assert.equal(current.documents.note.markdown, "完整初稿。");

  const manifest = JSON.parse(await readFile(join(workspacePath, ".shensi", "manifest.json"), "utf8"));
  const filePath = join(workspacePath, manifest.manifest.note.path);
  const diskBefore = await readFile(filePath, "utf8");
  current.documents.note = { ...current.documents.note, html: "<p>不得写入的文本</p>", markdown: "不得写入的文本" };
  process.env.SHENSI_TEST_WORKSPACE_FAULT = "before-save-core";
  process.env.SHENSI_TEST_WORKSPACE_FAULT_COUNT = "2";
  await assert.rejects(saveWorkspaceState({ ...options, state: current }), /before-save-core/);
  assert.equal(await readFile(filePath, "utf8"), diskBefore, "document and its new history version must fail as one transaction");
} finally {
  delete process.env.SHENSI_TEST_WORKSPACE_FAULT;
  delete process.env.SHENSI_TEST_WORKSPACE_FAULT_COUNT;
  const rel = relative(resolve(tmpdir()), resolve(testRoot));
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(testRoot, { recursive: true, force: true });
}
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /await onPersist\(\);[\s\S]{0,1400}await flushWorkspaceSave\(\{ throwOnError: true, recoverConflict: true \}\);[\s\S]{0,1400}conversationAgentRequest\("\/api\/conversation-agent\/start"/u,
  "启动原生 Agent 前必须先把当前编辑稿安全落盘，避免覆盖未保存修改");
console.log("Committed write history: post-write snapshots, restore, no-op, stale history and atomic failure passed");
