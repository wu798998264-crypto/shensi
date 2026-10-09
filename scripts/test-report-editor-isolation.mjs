import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import vm from "node:vm";

const region = async (start, end) => {
  const stream = createReadStream(new URL("../src/app.js", import.meta.url), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const selected = [];
  let collecting = false;
  try {
    for await (const line of lines) {
      if (collecting && line.startsWith(end)) break;
      if (line.startsWith(start)) collecting = true;
      if (collecting) selected.push(line);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  assert.ok(selected.length, `Missing source region: ${start}`);
  assert.ok(selected.length <= 250, "Regression reads must stay bounded");
  return selected.join("\n");
};

const captureSource = await region("const captureActiveDocumentViewState =", "const applyDocumentTabState =");
const state = {
  activeDocument: "report-novel",
  documents: {
    "report-novel": { documentKind: "document", html: "<p>小说报告</p>" },
    "report-script": { documentKind: "document", html: "<p>剧本报告</p>" },
    "report-adaptation": { documentKind: "document", html: "<p>改编报告</p>" },
    editable: { documentKind: "document", html: "<p>原正文</p>" },
  },
  documentViewStates: {},
};
const editor = { hidden: true, contentEditable: "false", dataset: { document: "report-novel" } };
const context = vm.createContext({
  state, elements: { editor, editorCanvas: { scrollTop: 0 } },
  // Reports use the shared read-only panel, not the manuscript preview flag.
  documentPreviewActive: () => false,
  serializableEditorHtml: () => "<p>上一份编辑文档的内容</p>",
  updateDocumentViewState: (views, id, next) => ({ ...views, [id]: next }),
});
vm.runInContext(captureSource, context);
for (const id of ["report-novel", "report-script", "report-adaptation"]) {
  state.activeDocument = id;
  editor.dataset.document = id;
  const original = state.documents[id].html;
  vm.runInContext("captureActiveDocumentViewState()", context);
  assert.equal(state.documents[id].html, original, "Hidden editor must not overwrite a report when switching tabs");
}
state.activeDocument = "editable";
editor.hidden = false;
editor.contentEditable = "true";
editor.dataset.document = "editable";
vm.runInContext("captureActiveDocumentViewState()", context);
assert.equal(state.documents.editable.html, "<p>上一份编辑文档的内容</p>", "Editable document capture must remain available");

const refreshSource = await region("const refreshAuthorCockpitFromDisk =", "let externalWorkspaceRefreshPromise =");
let resolveRead;
let activated = null;
const refreshState = {
  workspaceKind: "project", settings: { workspacePath: "test-project", apiKey: "" },
  projectName: "隔离项目", activeDocument: "report-novel", activeModule: "reports",
  documents: state.documents, activities: [],
};
const refreshContext = vm.createContext({
  state: refreshState, ui: { authorCockpitRefreshing: false, workspaceDirty: false },
  elements: { editor: { dataset: {} } },
  workspaceIdentity: () => refreshState.settings.workspacePath,
  renderCompilationDecisionSummary: () => {},
  documentSaveHashes: () => new Map(),
  fetchWorkspacePayload: () => new Promise((resolve) => { resolveRead = resolve; }),
  isAuthorCockpitModule: (id) => ["index", "reports"].includes(id),
  AUTHOR_COCKPIT_MODULE_ID: "index",
  activateProjectState: (next) => { activated = next; Object.assign(refreshState, next); },
  renderAll: () => {}, nowTime: () => "12:00", showToast: () => {},
  persist: () => {}, Date, Set,
});
vm.runInContext(refreshSource, refreshContext);
const refresh = vm.runInContext("refreshAuthorCockpitFromDisk()", refreshContext);
refreshState.activeDocument = "report-script";
resolveRead({ state: { documents: state.documents, activities: [] }, stateStamp: "new" });
await refresh;
assert.equal(activated.activeDocument, "report-script", "Async refresh must preserve the latest selection, not the starting selection");

activated = null;
const switchedRefresh = vm.runInContext("refreshAuthorCockpitFromDisk()", refreshContext);
refreshState.settings.workspacePath = "another-project";
resolveRead({ state: { documents: state.documents, activities: [] } });
assert.equal(await switchedRefresh, false, "A stale refresh must not activate a different workspace");
assert.equal(activated, null);
console.log("Report hidden-editor capture, latest navigation and cross-workspace refresh isolation passed");
