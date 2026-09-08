import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createBlankNotebookState } from "../src/data.js";
import { saveWorkspaceState, loadWorkspaceState } from "../src/server/workspace.mjs";
import { prepareFullPrewriteHistory, verifyFullPrewriteHistory } from "../src/server/document-prewrite-history.mjs";

const emptyDocument = { title: "空白测试", html: "", markdown: "", moduleId: "library", attachments: [], customMetadata: { keep: true } };
const before = { documents: { note: emptyDocument }, histories: {} };
const after = { documents: { note: { ...emptyDocument, html: "<p>开始</p>", markdown: "开始" } }, histories: {} };
const receipts = await prepareFullPrewriteHistory({ currentState: before, nextState: after, changedDocumentIds: ["note"], transactionId: "unit-1" });
assert.deepEqual(after.histories.note[0].document, emptyDocument);
await verifyFullPrewriteHistory({ histories: after.histories, receipts });
const damaged = structuredClone(after.histories);
damaged.note[0].document.html = "corrupt";
await assert.rejects(verifyFullPrewriteHistory({ histories: damaged, receipts }), { code: "DOCUMENT_PREWRITE_HISTORY_UNVERIFIED" });
const stale = { histories: {}, documents: after.documents };
await prepareFullPrewriteHistory({ currentState: after, nextState: stale, transactionId: "unit-2" });
assert.equal(stale.histories.note.length, 1, "stale renderer cannot erase a mandatory snapshot");
const boardState = { documents: { board: { documentKind: "whiteboard", canvas: { nodes: [] } } }, histories: {} };
const nextBoard = structuredClone(boardState);
assert.deepEqual(await prepareFullPrewriteHistory({ currentState: boardState, nextState: nextBoard, changedDocumentIds: ["board"], transactionId: "board-excluded" }), []);
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
    const original = structuredClone(current.documents.note);
    current.documents.note = { ...original, html: `<p>${nextText}</p>`, markdown: nextText };
    const saved = await saveWorkspaceState({ ...options, state: current });
    assert.equal(saved.prewriteHistory.length, 1);
    current = await load();
    assert.deepEqual(current.histories.note[0].document, original);
    await verifyFullPrewriteHistory({ histories: current.histories, receipts: saved.prewriteHistory });
  }
  const count = current.histories.note.length;
  await saveWorkspaceState({ ...options, state: current });
  current = await load();
  assert.equal(current.histories.note.length, count, "unchanged content must not create extra history");
  const beforeRestore = structuredClone(current.documents.note);
  current.documents.note = structuredClone(current.histories.note.at(-1).document);
  const restored = await saveWorkspaceState({ ...options, state: current });
  current = await load();
  assert.deepEqual(current.histories.note[0].document, beforeRestore, "restoring an old version first preserves the current complete version");
  await verifyFullPrewriteHistory({ histories: current.histories, receipts: restored.prewriteHistory });
  assert.equal(current.documents.note.markdown, "");

  const manifest = JSON.parse(await readFile(join(workspacePath, ".shensi", "manifest.json"), "utf8"));
  const filePath = join(workspacePath, manifest.manifest.note.path);
  const diskBefore = await readFile(filePath, "utf8");
  current.documents.note = { ...current.documents.note, html: "<p>不得写入的文本</p>", markdown: "不得写入的文本" };
  process.env.SHENSI_TEST_WORKSPACE_FAULT = "before-prewrite-history";
  process.env.SHENSI_TEST_WORKSPACE_FAULT_COUNT = "1";
  await assert.rejects(saveWorkspaceState({ ...options, state: current }), /before-prewrite-history/);
  assert.equal(await readFile(filePath, "utf8"), diskBefore, "history failure must occur before touching the document");
} finally {
  delete process.env.SHENSI_TEST_WORKSPACE_FAULT;
  delete process.env.SHENSI_TEST_WORKSPACE_FAULT_COUNT;
  const rel = relative(resolve(tmpdir()), resolve(testRoot));
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(testRoot, { recursive: true, force: true });
}
console.log("Full prewrite history: empty/full snapshots, writes, no-op, stale history and failure-before-write passed");
