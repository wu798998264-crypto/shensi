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

const testRoot = await mkdtemp(join(tmpdir(), "shensi-agent-history-"));
try {
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
  const selectedRestore = structuredClone(current.histories.note.at(-1).document);
  current.documents.note = selectedRestore;
  const restored = await saveWorkspaceState({ ...options, state: current });
  current = await load();
  assert.deepEqual(current.histories.note[0].document, selectedRestore, "restoring an old version must save the restored result as the newest history version");
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
console.log("Committed write history: post-write snapshots, restore, no-op, stale history and atomic failure passed");
