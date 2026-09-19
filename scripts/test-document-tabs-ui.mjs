import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-document-tabs-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
const artifactRoot = join(root, "artifacts");
const screenshotPath = join(artifactRoot, "document-tabs-ui.png");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });
await mkdir(artifactRoot, { recursive: true });

const debugPort = 9361;
const electron = join(root, "node_modules", "electron", "dist", "electron.exe");
const desktopEntry = join(root, "packaging", "windows", "desktop-app");
const child = spawn(electron, [
  `--remote-debugging-port=${debugPort}`,
  "--disable-gpu",
  "--disable-gpu-compositing",
  desktopEntry,
], {
  cwd: root,
  env: {
    ...process.env,
    SHENSI_DATA_ROOT: dataRoot,
    SHENSI_MACHINE_DATA_ROOT: dataRoot,
    SHENSI_DESKTOP_USER_DATA_ROOT: userDataRoot,
    SHENSI_SKIP_UPDATE_CHECK: "1",
    SHENSI_DISABLE_HARDWARE_ACCELERATION: "1",
    SHENSI_TEST_DESKTOP_RUNTIME: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const delay = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
let target = null;
for (let deadline = Date.now() + 30_000; Date.now() < deadline && !target;) {
  try {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
  } catch {}
  if (!target) await delay(200);
}
if (!target) throw new Error(`多文档标签页验收页面未启动：${stderr.slice(-1000)}`);

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolvePromise, reject) => {
  socket.addEventListener("open", resolvePromise, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (!message.id || !pending.has(message.id)) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
const cdp = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve: resolvePromise, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const waitFor = async (expression, label, timeout = 30_000) => {
  for (let deadline = Date.now() + timeout; Date.now() < deadline;) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await delay(100);
  }
  throw new Error(`等待超时：${label}；${stderr.slice(-800)}`);
};

const createDocument = async (name, { fromBlank = false } = {}) => {
  if (fromBlank) {
    await evaluate("document.querySelector('[data-blank-tab-create]').click(); true");
  } else {
    await evaluate("document.querySelector('#addDocument').click(); true");
  }
  await waitFor("document.querySelector('#textDialog')?.open", `打开新建文档对话框：${name}`);
  await evaluate(`(() => {
    const field=document.querySelector('#textDialogCreateKindField');
    const documentKind=field?.querySelector('[data-create-kind=document]');
    if(documentKind&&!documentKind.classList.contains('active'))documentKind.click();
    document.querySelector('#textDialogInput').value=${JSON.stringify(name)};
    document.querySelector('#textDialogForm').requestSubmit();
    return true;
  })()`);
  await waitFor(`document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim() === ${JSON.stringify(name)}`, `创建并激活${name}`);
  return name;
};

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: 920, deviceScaleFactor: 1, mobile: false });
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#documentTabs')", "应用启动", 45_000);
  await evaluate("document.querySelector('#projectButton').click(); true");
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate("document.querySelector('#newWorkspaceButton').click(); true");
  await waitFor("document.querySelector('#textDialog')?.open", "新建作品");
  await evaluate(`(() => {document.querySelector('#textDialogInput').value='多文档标签页验收';document.querySelector('#textDialogForm').requestSubmit();return true;})()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('多文档标签页验收')", "作品创建");
  await evaluate("if(document.querySelector('#creativeStartWelcomeDialog')?.open)document.querySelector('#dismissCreativeStartWelcome')?.click(); true");

  const documentIds = [];
  documentIds.push(await createDocument("标签页文档 1"));
  assert.equal(await evaluate("document.querySelectorAll('.document-tab').length"), 1, "默认新建文档只占用一个标签");

  for (let index = 2; index <= 8; index += 1) {
    await evaluate("document.querySelector('[data-document-tab-add]').click(); true");
    await waitFor("document.querySelector('[data-blank-tab-create]')", `打开空白标签 ${index}`);
    documentIds.push(await createDocument(`标签页文档 ${index}`, { fromBlank: true }));
  }
  assert.equal(await evaluate("document.querySelectorAll('.document-tab').length"), 8, "最多保留八个标签");
  assert.equal(await evaluate("document.querySelector('[data-document-tab-add]').disabled"), true, "达到上限后必须禁用加号");

  await evaluate("document.querySelector('[data-document-tab-select][title=\"标签页文档 1\"]').click(); true");
  await waitFor(`document.querySelector('[data-document-tab-select][title="标签页文档 1"]')?.closest('.document-tab')?.classList.contains('active')`, "切换已有标签");
  assert.equal(await evaluate("document.querySelectorAll('.document-tab').length"), 8, "已打开文档不得重复创建标签");

  await evaluate(`(() => {
    const editor=document.querySelector('#editor');
    editor.innerHTML=Array.from({length:90},(_,index)=>'<p>滚动位置验收段落 '+index+'：多文档标签页应保存各自的阅读状态。</p>').join('');
    editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'验收'}));
    return true;
  })()`);
  await waitFor("!document.querySelector('#documentModeButton').hidden", "文档模式按钮");
  if (await evaluate("document.querySelector('#editorCanvas').classList.contains('document-preview-mode')")) {
    await evaluate("document.querySelector('#documentModeButton').click(); true");
  }
  await evaluate("document.querySelector('#editorCanvas').scrollTop=700;document.querySelector('#editorCanvas').dispatchEvent(new Event('scroll'));true");
  await delay(400);
  await evaluate("document.querySelector('#documentModeButton').click(); true");
  await waitFor("document.querySelector('#editorCanvas').classList.contains('document-preview-mode')", "文档一进入阅读模式");

  await evaluate(`document.querySelector('[data-document-tab-select][title="标签页文档 2"]').click(); true`);
  await waitFor("document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim()==='标签页文档 2'", "切换文档二");
  assert.equal(await evaluate("document.querySelector('#editorCanvas').classList.contains('document-preview-mode')"), false, "文档二不得继承文档一的阅读模式");
  await evaluate(`document.querySelector('[data-document-tab-select][title="标签页文档 1"]').click(); true`);
  await waitFor("document.querySelector('#editorCanvas').classList.contains('document-preview-mode')", "文档一恢复阅读模式");
  await delay(350);
  assert.ok(await evaluate("document.querySelector('#editorCanvas').scrollTop >= 650"), "文档一必须恢复独立滚动位置");

  const beforeReload = await evaluate(`({
    titles:[...document.querySelectorAll('.document-tab-select')].map((item)=>item.textContent.trim()),
    active:document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim(),
    saveTitle:document.querySelector('#saveVersionButton')?.title,
    overlap:(()=>{const tabs=document.querySelector('#documentTabs').getBoundingClientRect();const actions=document.querySelector('.editor-header-actions').getBoundingClientRect();return tabs.right>actions.left+1;})(),
    tabOutline:(()=>{
      const header=document.querySelector('.editor-header');
      const tabs=document.querySelector('#documentTabs');
      const active=document.querySelector('.document-tab.active');
      const before=getComputedStyle(active,'::before');
      const after=getComputedStyle(active,'::after');
      return {
        headerBorderBottom:getComputedStyle(header).borderBottomWidth,
        activeBorderBottom:getComputedStyle(active).borderBottomWidth,
        tabsPaddingLeft:getComputedStyle(tabs).paddingLeft,
        beforeBackground:before.backgroundImage,
        afterBackground:after.backgroundImage,
        beforeBorder:[before.borderRightWidth,before.borderBottomWidth],
        afterBorder:[after.borderLeftWidth,after.borderBottomWidth],
      };
    })()
  })`);
  assert.equal(beforeReload.saveTitle, "保存《标签页文档 1》历史版本");
  assert.equal(beforeReload.overlap, false, "标签页不得遮挡右侧工具栏");
  assert.equal(beforeReload.tabOutline.headerBorderBottom, "0px", "标题栏不得再用实体底边穿过活动页签");
  assert.equal(beforeReload.tabOutline.activeBorderBottom, "0px", "活动页签底部不得绘制横线");
  assert.equal(beforeReload.tabOutline.tabsPaddingLeft, "8px", "首个页签必须为左侧外向圆角预留空间");
  assert.match(beforeReload.tabOutline.beforeBackground, /radial-gradient/u, "活动页签左下角必须使用单层平滑圆弧");
  assert.match(beforeReload.tabOutline.afterBackground, /radial-gradient/u, "活动页签右下角必须使用单层平滑圆弧");
  assert.deepEqual(beforeReload.tabOutline.beforeBorder, ["0px", "0px"], "左侧圆弧不得叠加直线边框");
  assert.deepEqual(beforeReload.tabOutline.afterBorder, ["0px", "0px"], "右侧圆弧不得叠加直线边框");

  await delay(3_000);
  await cdp("Page.reload", {});
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('多文档标签页验收') && document.querySelector('#editorCanvas') && document.querySelectorAll('.document-tab').length===8", "重启恢复八个标签", 45_000);
  await delay(1200);
  await waitFor("document.querySelector('#editorCanvas') && document.querySelectorAll('.document-tab').length===8", "重启后界面稳定", 15_000);
  const afterReload = await evaluate(`({
    titles:[...document.querySelectorAll('.document-tab-select')].map((item)=>item.textContent.trim()),
    active:document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim(),
    preview:document.querySelector('#editorCanvas').classList.contains('document-preview-mode'),
    scrollTop:document.querySelector('#editorCanvas').scrollTop
  })`);
  assert.deepEqual(afterReload.titles, beforeReload.titles, "重启后必须恢复标签顺序");
  assert.equal(afterReload.active, beforeReload.active, "重启后必须恢复活动标签");
  assert.equal(afterReload.preview, true, "重启后必须恢复文档阅读模式");
  assert.ok(afterReload.scrollTop >= 650, "重启后必须恢复滚动位置");

  await evaluate(`document.querySelector('[data-document-tab-select][title="标签页文档 2"]').click(); true`);
  await waitFor("document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim()==='标签页文档 2'", "第二个标签进入选中状态");
  const separatorOutline = await evaluate(`(() => {
    const tabs=[...document.querySelectorAll('.document-tab')];
    const active=tabs[1];
    const next=tabs[2];
    const inactivePairEnd=tabs[3];
    const activeBefore=getComputedStyle(active,'::before');
    const nextBefore=getComputedStyle(next,'::before');
    const inactiveBefore=getComputedStyle(inactivePairEnd,'::before');
    const add=getComputedStyle(document.querySelector('[data-document-tab-add]'));
    return {
      activeBeforeTop:activeBefore.top,
      activeBeforeBottom:activeBefore.bottom,
      activeBeforeHeight:activeBefore.height,
      activeBeforeRadius:activeBefore.borderRadius,
      activeBeforeBackground:activeBefore.backgroundImage,
      nextBeforeContent:nextBefore.content,
      nextBeforeBackground:nextBefore.backgroundImage,
      inactiveBeforeContent:inactiveBefore.content,
      inactiveBeforeTop:inactiveBefore.top,
      inactiveBeforeWidth:inactiveBefore.width,
      addBorderLeft:add.borderLeftWidth,
    };
  })()`);
  assert.ok(Number.parseFloat(separatorOutline.activeBeforeTop) > 16, "第二个及后续活动标签左侧不得继承普通隔离线的顶部位置");
  assert.equal(separatorOutline.activeBeforeBottom, "0px", "活动标签左侧外向圆角必须贴合标签栏底部");
  assert.equal(separatorOutline.activeBeforeHeight, "10px", "活动标签左侧只允许保留外向圆角几何");
  assert.equal(separatorOutline.activeBeforeRadius, "0px", "活动标签左侧不得继承胶囊形隔离线圆角");
  assert.match(separatorOutline.activeBeforeBackground, /radial-gradient/u, "活动标签左侧必须保持外向圆角");
  assert.equal(separatorOutline.nextBeforeContent, "none", "活动标签右侧不得显示普通隔离线");
  assert.equal(separatorOutline.nextBeforeBackground, "none", "活动标签右侧不得残留隔离线背景");
  assert.equal(separatorOutline.inactiveBeforeContent, '\"\"', "仅两个未选中标签之间应显示隔离线");
  assert.equal(separatorOutline.inactiveBeforeTop, "8px", "未选中标签隔离线应保持上下留白");
  assert.equal(separatorOutline.inactiveBeforeWidth, "1px", "未选中标签隔离线应保持细线宽度");
  assert.equal(separatorOutline.addBorderLeft, "0px", "加号左侧不得显示隔离线");

  const beforeDrag = await evaluate(`({
    titles:[...document.querySelectorAll('.document-tab-select')].map((item)=>item.textContent.trim()),
    active:document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim(),
    draggable:[...document.querySelectorAll('.document-tab')].every((item)=>item.draggable),
    addDraggable:document.querySelector('[data-document-tab-add]').draggable
  })`);
  assert.equal(beforeDrag.draggable, true, "所有文档和空白标签都必须可拖动");
  assert.equal(beforeDrag.addDraggable, false, "加号不得参与标签排序");
  await evaluate(`(() => {
    const tabs=[...document.querySelectorAll('.document-tab')];
    const source=tabs[0];
    const target=tabs[2];
    const transfer=new DataTransfer();
    source.dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    const bounds=target.getBoundingClientRect();
    target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:bounds.right-4}));
    target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientX:bounds.right-4}));
    return true;
  })()`);
  const expectedDragOrder = [beforeDrag.titles[1], beforeDrag.titles[2], beforeDrag.titles[0], ...beforeDrag.titles.slice(3)];
  await waitFor(`JSON.stringify([...document.querySelectorAll('.document-tab-select')].map((item)=>item.textContent.trim())) === ${JSON.stringify(JSON.stringify(expectedDragOrder))}`, "使用鼠标拖动标签向右重排");
  const afterDrag = await evaluate(`({
    titles:[...document.querySelectorAll('.document-tab-select')].map((item)=>item.textContent.trim()),
    active:document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim()
  })`);
  assert.deepEqual(afterDrag.titles, expectedDragOrder, "拖放后必须按新顺序显示标签");
  assert.equal(afterDrag.active, beforeDrag.active, "拖动排序不得切换当前文档");

  await delay(3_000);
  await evaluate("window.__documentTabsReloadMarker='pending'; true");
  await cdp("Page.reload", {});
  await waitFor("typeof window.__documentTabsReloadMarker === 'undefined'", "标签顺序持久化后的页面重载", 15_000);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('多文档标签页验收') && document.querySelectorAll('.document-tab').length===8", "重启恢复拖动后的标签顺序", 45_000);
  await delay(800);
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.document-tab-select')].map((item)=>item.textContent.trim())"), afterDrag.titles, "拖动后的顺序必须随工作区持久化");
  assert.equal(await evaluate("document.querySelector('.document-tab.active .document-tab-select')?.textContent.trim()"), afterDrag.active, "重启后仍须保持原活动标签");

  const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
  console.log(JSON.stringify({ ok: true, screenshotPath, documentIds, checks: ["default replacement", "blank tab creation", "eight tab limit", "deduplication", "per-document mode", "scroll restoration", "restart restoration", "header no overlap", "smooth active-tab outline", "inactive-only separators", "add button without separator", "drag reorder", "drag order persistence"] }));
} catch (error) {
  console.log(JSON.stringify(await evaluate("({tabs:[...document.querySelectorAll('.document-tab-select')].map(item=>item.textContent.trim()),active:document.querySelector('.document-tab.active .document-tab-select')?.textContent,toast:document.querySelector('#toast')?.textContent,dialog:document.querySelector('#textDialog')?.open,body:document.body.innerText.slice(-1200)})").catch(() => ({}))));
  throw error;
} finally {
  socket.close();
  child.kill();
  await delay(800);
  await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
}
