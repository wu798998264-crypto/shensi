const assert = require("node:assert/strict");
const { readFileSync, mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { app, BrowserWindow } = require("electron");

// Real Chromium focus/bubbling, with disposable data and no user's documents.
const root = process.env.SHENSI_KEYBOARD_TEST_APP_ROOT
  ? resolve(process.env.SHENSI_KEYBOARD_TEST_APP_ROOT) : join(__dirname, "..");
const source = readFileSync(join(root, "src", "app.js"), "utf8");
const extract = (startText, endText) => {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, startText);
  return source.slice(start, end + endText.length);
};
const handlers = [
  extract("const focusWhiteboardCanvasKeyboard = ", "\n};"),
  extract('elements.documentList.addEventListener("keydown",', "\n});"),
  extract('elements.whiteboardEditor.addEventListener("pointerdown",', "\n});"),
  extract('document.addEventListener("keydown", (event) => {\n  if (event.defaultPrevented || !activeWhiteboardDocument()', "\n});"),
].join("\n");
assert.match(source, /id="whiteboardEditor" tabindex="-1"/u);
app.setPath("userData", mkdtempSync(join(tmpdir(), "shensi-keyboard-focus-")));
app.commandLine.appendSwitch("disable-gpu-sandbox");

app.whenReady().then(async () => {
  let exitCode = 0;
  const window = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { contextIsolation: true, sandbox: true } });
  const evaluate = (code) => window.webContents.executeJavaScript(code, true);
  const key = async (keyCode) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await new Promise((done) => setTimeout(done, 50));
  };
  try {
    await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html>
      <nav id="directory"><button id="row" data-directory-token="document:board" data-document="board">白板</button></nav>
      <section id="whiteboardEditor" tabindex="-1" style="position:absolute;left:200px;top:50px;width:600px;height:500px">
        <div id="edge" data-canvas-edge="edge-1">连线</div><input id="prompt" value="保留文字"><div id="marquee" hidden></div>
      </section><dialog id="confirm">删除白板</dialog>`));
    await evaluate(`
      const calls = []; let selected = [];
      const elements = { documentList: document.querySelector('#directory'), whiteboardEditor: document.querySelector('#whiteboardEditor'), whiteboardMarquee: document.querySelector('#marquee') };
      const ui = { directorySelectedTokens: new Set(['document:board']), whiteboardSelectedDocumentId:'board', whiteboardSelectedEdgeIds:new Set() };
      const state = { activeDocument:'board', activeModule:'library' };
      const activeWhiteboardDocument = () => ({id:'board',canvas:{}});
      const selectedWhiteboardNodeIds = () => selected;
      const selectWhiteboardNode = () => { selected = []; };
      const selectWhiteboardEdge = (id) => { selected = []; ui.whiteboardSelectedEdgeDocumentId='board'; ui.whiteboardSelectedEdgeIds=new Set([id]); };
      const deleteWhiteboardNodes = (ids) => {calls.push(['cards', ...ids]); selected=[];};
      const deleteWhiteboardNode = (id) => deleteWhiteboardNodes([id]);
      const deleteWhiteboardEdges = (ids) => {calls.push(['edges', ...ids]); ui.whiteboardSelectedEdgeIds.clear();};
      const deleteWhiteboardEdge = (id) => deleteWhiteboardEdges([id]);
      const directoryModuleForTarget = () => 'library';
      const directorySelectionContext = () => ({tokens:[...ui.directorySelectedTokens]});
      const confirmDirectorySelectionDelete = () => {calls.push(['directory']); document.querySelector('#confirm').showModal();};
      const syncDirectorySelectionClasses = () => {};
      const selectedTransferDocumentIds = () => ['board'];
      const setDocumentClipboard = (action) => calls.push(['directory-clipboard', action]);
      const whiteboardGenerationDialogs = () => [];
      const flushWhiteboardWheelZoom = () => {};
      const commitWhiteboardViewportGesture = () => {};
      const collapseWhiteboardContextMenu = () => {};
      const closeWhiteboardGenerationDialogsOutside = () => {};
      const finishWhiteboardEditing = () => {};
      const whiteboardNativeMediaControlHit = () => false;
      const whiteboardWorldPoint = (x,y) => ({x,y});
      ${handlers}
    `);
    await evaluate("document.querySelector('#row').focus()");
    assert.equal(await evaluate("document.activeElement.id"), "row");
    window.webContents.sendInputEvent({ type: "mouseDown", x: 450, y: 300, button: "left", clickCount: 1 });
    window.webContents.sendInputEvent({ type: "mouseUp", x: 450, y: 300, button: "left", clickCount: 1 });
    await new Promise((done) => setTimeout(done, 50));
    assert.equal(await evaluate("ui.whiteboardDrag.mode"), "select");
    assert.equal(await evaluate("document.activeElement.id"), "whiteboardEditor");
    await evaluate("selected = ['card-1','card-2']");
    await key("Delete");
    assert.deepEqual(await evaluate("calls"), [["cards", "card-1", "card-2"]]);
    assert.equal(await evaluate("document.querySelector('#confirm').open"), false);
    await key("Delete");
    assert.equal(await evaluate("calls.length"), 1);
    await evaluate("calls.length=0; selected=['retained-card']; document.querySelector('#prompt').focus()");
    await key("Delete");
    assert.deepEqual(await evaluate("calls"), []);
    await evaluate("document.querySelector('#row').focus()");
    await key("Delete");
    assert.deepEqual(await evaluate("calls"), [["directory"]]);
    assert.equal(await evaluate("document.querySelector('#confirm').open"), true);
    console.log(JSON.stringify({ ok: true, engine: process.versions.electron,
      sourceRoot: root, cases: ["first-marquee-delete", "repeat-delete", "input-focus", "explicit-directory-delete"] }));
  } catch (error) {
    exitCode = 1; console.error(error.stack || error);
  } finally {
    window.destroy(); app.exit(exitCode);
  }
});
