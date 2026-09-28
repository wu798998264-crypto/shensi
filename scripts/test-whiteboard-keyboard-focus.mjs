import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const extract = (startText, endText) => {
  const start = app.indexOf(startText);
  assert.ok(start >= 0, startText);
  const end = app.indexOf(endText, start);
  assert.ok(end > start, endText);
  return app.slice(start, end + endText.length);
};
const listeners = {};
const calls = [];
let selected = [];
let modal = null;
class Element {
  constructor({ directory = false, control = "", readonly = false, popover = false, edge = "" } = {}) {
    Object.assign(this, { directory, control, readonly, popover, edge });
    this.dataset = { directoryToken: "document:board", document: "board", canvasEdge: edge };
  }
  closest(selector) {
    if (this.directory && ["[data-directory-token]", "[data-document]"].includes(selector)) return this;
    if (this.edge && selector === "[data-canvas-edge]") return this;
    if (this.popover && selector === ".whiteboard-generation-popover") return this;
    return this.control && selector.split(/,\s*/u).includes(this.control) ? this : null;
  }
  matches(selector) {
    if (selector === "textarea[data-canvas-text][readonly]") return this.control === "textarea" && this.readonly;
    return Boolean(this.control && selector.split(/,\s*/u).includes(this.control));
  }
}
const directoryRow = new Element({ directory: true });
const background = new Element();
const document = {
  activeElement: directoryRow,
  querySelector: () => modal,
  addEventListener: (name, handler) => { listeners[`document:${name}`] = handler; },
};
const elements = {
  documentList: { addEventListener: (name, handler) => { listeners[`directory:${name}`] = handler; } },
  whiteboardEditor: Object.assign(new Element(), {
    addEventListener: (name, handler) => { listeners[`canvas:${name}`] = handler; },
    focus: (options) => { assert.equal(options.preventScroll, true); document.activeElement = elements.whiteboardEditor; },
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  }),
  whiteboardMarquee: { style: {}, hidden: true },
};
const ui = { directorySelectedTokens: new Set(["document:board"]), whiteboardSelectedDocumentId: "board", whiteboardSelectedEdgeIds: new Set() };
const state = { activeDocument: "board", activeModule: "library" };
const context = vm.createContext({
  Element, document, elements, ui, state,
  activeWhiteboardDocument: () => ({ id: "board", canvas: {} }),
  selectedWhiteboardNodeIds: () => selected,
  selectWhiteboardNode: () => { selected = []; },
  selectWhiteboardEdge: (id) => { selected = []; ui.whiteboardSelectedEdgeDocumentId = "board"; ui.whiteboardSelectedEdgeIds = new Set([id]); },
  deleteWhiteboardNodes: (ids) => { calls.push(["cards", ...ids]); selected = []; },
  deleteWhiteboardNode: (id) => { calls.push(["cards", id]); selected = []; },
  deleteWhiteboardEdges: (ids) => calls.push(["edges", ...ids]),
  deleteWhiteboardEdge: (id) => calls.push(["edges", id]),
  directoryModuleForTarget: () => "library",
  directorySelectionContext: () => ({ tokens: [...ui.directorySelectedTokens] }),
  confirmDirectorySelectionDelete: () => { calls.push(["directory"]); modal = {}; },
  syncDirectorySelectionClasses: () => {},
  selectedTransferDocumentIds: () => ["board"],
  setDocumentClipboard: (action) => calls.push(["directory-clipboard", action]),
  copyWhiteboardCards: () => { calls.push(["card-copy"]); return true; },
  cutWhiteboardCards: () => { calls.push(["card-cut"]); return true; },
  whiteboardGenerationDialogs: () => [],
  flushWhiteboardWheelZoom: () => {}, commitWhiteboardViewportGesture: () => {},
  collapseWhiteboardContextMenu: () => {}, closeWhiteboardGenerationDialogsOutside: () => {},
  finishWhiteboardEditing: () => {}, whiteboardNativeMediaControlHit: () => false,
  whiteboardWorldPoint: (x, y) => ({ x, y }),
});
vm.runInContext([
  extract("const focusWhiteboardCanvasKeyboard = ", "\n};"),
  extract('elements.documentList.addEventListener("keydown",', "\n});"),
  extract('elements.whiteboardEditor.addEventListener("pointerdown",', "\n});"),
  extract('document.addEventListener("keydown", (event) => {\n  if (event.defaultPrevented || !activeWhiteboardDocument()', "\n});"),
].join("\n"), context);
const event = (overrides = {}) => ({
  key: "Delete", button: 0, clientX: 100, clientY: 100, pointerId: 1,
  target: document.activeElement, defaultPrevented: false, stopped: false,
  preventDefault() { this.defaultPrevented = true; },
  stopPropagation() { this.stopped = true; },
  stopImmediatePropagation() { this.stopped = true; },
  ...overrides,
});
const dispatchKey = (overrides = {}) => {
  const keyEvent = event(overrides);
  if (keyEvent.target.directory) listeners["directory:keydown"](keyEvent);
  if (!keyEvent.stopped) listeners["document:keydown"](keyEvent);
  return keyEvent;
};
const reset = () => {
  calls.length = 0; selected = []; modal = null;
  ui.whiteboardSelectedEdgeDocumentId = null; ui.whiteboardSelectedEdgeIds = new Set();
  document.activeElement = directoryRow;
};

// Real canvas handler, starting with the directory focused: marquee must
// transfer focus even though it prevents the browser's default focus action.
reset();
const marquee = event({ target: background });
listeners["canvas:pointerdown"](marquee);
assert.equal(marquee.defaultPrevented, true);
assert.equal(ui.whiteboardDrag.mode, "select");
assert.equal(document.activeElement, elements.whiteboardEditor);
selected = ["image-1", "image-2"];
dispatchKey();
assert.deepEqual(calls, [["cards", "image-1", "image-2"]]);
assert.equal(modal, null, "首次框选删除不得弹出目录删除框");
calls.length = 0;
dispatchKey();
assert.deepEqual(calls, [], "删除完成后重复 Delete 不得删除整个白板");

reset();
listeners["canvas:pointerdown"](event({ target: new Element({ edge: "edge-1" }) }));
dispatchKey();
assert.deepEqual(calls, [["edges", "edge-1"]]);

// Deliberately clicking the directory again must still delete/copy its item,
// even when the board retains visible card selections.
reset(); selected = ["retained-card"];
dispatchKey();
assert.deepEqual(calls, [["directory"]]);
for (const key of ["c", "x"]) {
  reset(); selected = ["retained-card"];
  dispatchKey({ key, ctrlKey: true });
  assert.deepEqual(calls, [["directory-clipboard", key === "c" ? "copy" : "cut"]]);
}

// Writable fields, forms and native media controls must retain their focus.
for (const control of ["input", "select", "textarea", "[contenteditable='true']", "button", "audio", "video"]) {
  reset(); selected = ["retained-card"];
  const target = new Element({ control });
  document.activeElement = target;
  context.target = target;
  vm.runInContext("focusWhiteboardCanvasKeyboard(target)", context);
  assert.equal(document.activeElement, target, `${control} focus must be preserved`);
  if (["input", "select", "textarea", "[contenteditable='true']"].includes(control)) {
    dispatchKey(); assert.deepEqual(calls, [], "编辑文字的 Delete 不得删除卡片");
  }
}
reset();
const prompt = new Element({ control: "[contenteditable='true']", popover: true });
document.activeElement = prompt;
listeners["canvas:pointerdown"](event({ target: prompt }));
assert.equal(document.activeElement, prompt);
reset(); context.target = new Element({ control: "textarea", readonly: true });
vm.runInContext("focusWhiteboardCanvasKeyboard(target)", context);
assert.equal(document.activeElement, elements.whiteboardEditor, "只读文字卡片仍应能选中后删除");
reset(); selected = ["image-1"]; modal = {};
document.activeElement = elements.whiteboardEditor;
dispatchKey(); assert.deepEqual(calls, [], "模态窗口中不得删除背景卡片");
console.log("Whiteboard keyboard focus: first marquee/edge Delete, repeat Delete, explicit directory actions and editing boundaries passed");
