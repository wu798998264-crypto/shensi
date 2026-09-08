import assert from "node:assert/strict";
import vm from "node:vm";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { readSourceWindow } from "./read-source-window.mjs";
import { createBlankProjectState, createBlankNotebookState, createInitialState, MODULE_VIEWS } from "../src/data.js";
import { reconcileActiveDocumentState } from "../src/active-document-state.js";
import { authorCockpitSections } from "../src/author-cockpit.js";
import { CREATIVE_GUIDANCE_DOCUMENT_ID, creativeGuidanceDocumentPatch } from "../src/creative-guidance-record.js";
import { SKILL_UI_EN } from "../src/ui-i18n.js";

const appPath = new URL("../src/app.js", import.meta.url);
const id = CREATIVE_GUIDANCE_DOCUMENT_ID;
const windows = await Promise.all([
  readSourceWindow(appPath, "// Preserve existing guidance records", 14),
  readSourceWindow(appPath, "const ensureWorkspaceCreativeGuidanceSession =", 20),
  readSourceWindow(appPath, "const openWorkspaceCreativeGuidance =", 25),
  readSourceWindow(appPath, "const renderEditor =", 75),
]);
const migration = windows[0].split('  if (state.workspaceKind === "project" && !state.moduleItems.index.some(([id]) => id === "index-language-blacklist"))')[0];
const functionSource = (source) => source.slice(0, source.indexOf("\n};") + 4);
assert.ok(!migration.includes('state.documents["index-language-blacklist"]'), "Only the guidance compatibility block may run in this test");

const defaults = createInitialState();
assert.equal(defaults.documents[id], undefined);
assert.equal(defaults.moduleItems.index.some(([documentId]) => documentId === id), false);

for (const uiLanguage of ["zh-CN", "en-US"]) {
  const state = createBlankProjectState({ name: "无默认引导文档", settings: { uiLanguage } });
  const before = structuredClone(state);
  const env = { state, ui: {}, CREATIVE_GUIDANCE_DOCUMENT_ID, creativeGuidanceDocumentPatch };
  vm.runInNewContext(migration, env);
  vm.runInNewContext(migration, env);
  assert.deepEqual(state, before, "Schema repair must not create guidance documents or mutate a new project");
  assert.equal(state.documents[id], undefined);
  assert.equal(state.conversations[0].boundDocumentId, null);
  reconcileActiveDocumentState(state, MODULE_VIEWS);
  assert.equal(Boolean(state.activeDocument), false, "Startup must not select a placeholder document");
  assert.equal(authorCockpitSections(state).some((section) => section.items.some((item) => item.id === id)), false);
}

// Historical records (including intentional blank documents) remain available.
for (const content of ["", "已确认：主角保留最后一次记忆。"]) {
  const state = createBlankProjectState();
  state.documents[id] = { title: "创作引导", html: content ? `<p>${content}</p>` : "", markdown: content, revision: "saved-revision" };
  state.histories[id] = [{ id: "history-1", document: { markdown: "旧记录" } }];
  state.activeDocument = id;
  const original = structuredClone(state.documents[id]);
  const histories = structuredClone(state.histories);
  const env = { state, ui: {}, CREATIVE_GUIDANCE_DOCUMENT_ID, creativeGuidanceDocumentPatch };
  vm.runInNewContext(migration, env);
  vm.runInNewContext(migration, env);
  assert.equal(state.moduleItems.index.filter(([documentId]) => documentId === id).length, 1);
  assert.equal(state.documents[id].html, original.html);
  assert.equal(state.documents[id].markdown, original.markdown);
  assert.equal(state.documents[id].revision, original.revision);
  assert.deepEqual(state.histories, histories);
  assert.equal(state.activeDocument, id);
}

const runStart = async (state) => {
  let focusCount = 0;
  let beginCount = 0;
  const conversation = state.conversations[0];
  const env = {
    state,
    workspaceHasNoActiveEntry: () => false,
    activeConversation: () => conversation,
    conversationCreativeGuidanceIsActive: () => Boolean(conversation.creativeGuidance?.active),
    beginConversationCreativeGuidance: (guidance) => {
      beginCount++;
      conversation.creativeGuidance = { ...guidance, active: true, sessionId: "guidance-session" };
    },
    elements: { chatInput: { focus: () => { focusCount++; } } },
    selectDocument: () => assert.fail("Starting a conversation must not select a guidance document"),
    ensureStateSchema: () => assert.fail("Starting a conversation must not materialize workspace documents"),
    persist: () => assert.fail("Starting a conversation must not save a placeholder document"),
  };
  const context = vm.createContext(env);
  vm.runInContext(`${functionSource(windows[1])}\n${functionSource(windows[2])}\nglobalThis.start = openWorkspaceCreativeGuidance;`, context);
  const documents = structuredClone(state.documents);
  const activeDocument = state.activeDocument;
  assert.equal(await env.start(), true);
  assert.equal(await env.start(), true);
  assert.equal(focusCount, 2);
  assert.equal(beginCount, 1, "Repeated start must reuse the guidance session");
  assert.equal(state.activeDocument, activeDocument, "Existing drafts must stay open");
  assert.deepEqual(state.documents, documents);
  assert.equal(conversation.boundDocumentId, null);
};
await runStart(createBlankProjectState());
const authored = createBlankProjectState();
authored.documents["chapter-1"] = { title: "开头", html: "<p>已有正文。</p>" };
authored.activeDocument = "chapter-1";
await runStart(authored);

const node = () => {
  const classes = new Set();
  return {
    hidden: false, dataset: {}, innerHTML: "", textContent: "",
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this[name] = value; },
  };
};
const editorHead = windows[3].split("  const isWhiteboard =")[0];
assert.ok(editorHead.includes('if (!documentState) {') && !editorHead.includes("const isWhiteboard"));
for (const state of [createBlankProjectState(), createBlankNotebookState()]) {
  const nodes = {};
  const elements = new Proxy(nodes, { get: (target, key) => target[key] ??= node() });
  const saveButton = node();
  const env = {
    state, elements, ui: { documentFind: { open: false } },
    workspaceHasNoActiveEntry: () => false,
    escapeHtml: (value) => value, uiText: (value) => value,
    document: { querySelector: () => saveButton },
  };
  for (const name of ["clearEditorNarrativePlaceholder", "dismissWhiteboardGenerationDialogsOutsideActiveSurface", "scheduleCodexAgentDocumentDirectorySync", "renderWritingTimer", "renderMemoryReviewEntry", "renderCompilationDecisionSummary", "renderWhiteboardGenerationCollapsedSessions"]) env[name] = () => {};
  const before = structuredClone(state);
  vm.runInNewContext(`${editorHead}\n};\nrenderEditor();`, env);
  assert.deepEqual(state, before, "Empty-state text must never be written to workspace documents");
  assert.equal(elements.editor.dataset.document, "");
  assert.equal(elements.editor.contentEditable, "false");
  assert.equal(saveButton.disabled, true);
  assert.equal(elements.chapterTitlePanel.hidden, true);
  if (state.workspaceKind === "project") {
    assert.match(elements.editor.innerHTML, /这里将呈现你的作品/u);
    assert.match(elements.editor.innerHTML, /右侧聊一个想法/u);
    assert.equal(elements.editor.classList.contains("workspace-empty"), true);
  } else {
    assert.equal(elements.editor.innerHTML, "", "Notebook startup remains unchanged");
  }
}
assert.ok(SKILL_UI_EN["这里将呈现你的作品"]);
assert.ok(SKILL_UI_EN["可以先在右侧聊一个想法，或者带入已有稿件。"]);

// Persist and reload in an isolated data directory; never touch real workspaces.
const tempParent = await realpath(tmpdir());
const tempRoot = await mkdtemp(join(tempParent, "shensi-creative-start-regression-"));
const previousDataRoot = process.env.SHENSI_DATA_ROOT;
const previousMachineRoot = process.env.SHENSI_MACHINE_DATA_ROOT;
process.env.SHENSI_DATA_ROOT = tempRoot;
process.env.SHENSI_MACHINE_DATA_ROOT = join(tempRoot, "machine");
try {
  const { saveWorkspaceState, loadWorkspaceState } = await import("../src/server/workspace.mjs");
  const workspacePath = join(tempRoot, "作品", "无预建文档");
  const state = createBlankProjectState({ name: "无预建文档", workspacePath });
  await saveWorkspaceState({ appRoot: tempRoot, requestedPath: workspacePath, state });
  const loaded = await loadWorkspaceState({ appRoot: tempRoot, requestedPath: workspacePath });
  assert.equal(loaded.state.documents[id], undefined, "Save/reload must not restore the removed default document");
  assert.equal(Boolean(loaded.state.activeDocument), false);
  assert.equal(loaded.state.conversations[0].boundDocumentId, null);
  const files = await readdir(workspacePath, { recursive: true });
  assert.equal(files.some((path) => /(?:创作引导|creative[- _]?guidance)\.md$/iu.test(path)), false, "No guidance Markdown file may be generated on disk");
} finally {
  if (previousDataRoot === undefined) delete process.env.SHENSI_DATA_ROOT;
  else process.env.SHENSI_DATA_ROOT = previousDataRoot;
  if (previousMachineRoot === undefined) delete process.env.SHENSI_MACHINE_DATA_ROOT;
  else process.env.SHENSI_MACHINE_DATA_ROOT = previousMachineRoot;
  const resolved = await realpath(tempRoot);
  assert.equal(dirname(resolved).toLowerCase(), tempParent.toLowerCase());
  assert.ok(basename(resolved).startsWith("shensi-creative-start-regression-"));
  await rm(resolved, { recursive: true, force: true });
}
console.log("Creative start: no placeholder document; legacy records, draft focus and conversation guidance preserved");
