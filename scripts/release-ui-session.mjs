import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [action = "inspect", argument = ""] = process.argv.slice(2);
const port = Number(process.env.SHENSI_CDP_PORT || 9376);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
const target = targets.find(item => item.type === "page" && /^http:\/\/127\.0\.0\.1:/u.test(item.url));
if (!target?.webSocketDebuggerUrl) throw new Error("当前安装版白板窗口未提供验收入口");
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((done, fail) => { socket.addEventListener("open", done, { once: true }); socket.addEventListener("error", fail, { once: true }); });
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const result = JSON.parse(String(event.data));
  const call = pending.get(result.id);
  if (!call) return;
  pending.delete(result.id);
  clearTimeout(call.timer);
  result.error ? call.reject(new Error(result.error.message)) : call.resolve(result.result);
});
const cdp = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`验收接口超时：${method}`)); }, 30_000);
  pending.set(id, { resolve: resolveCall, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const save = async (path, value) => { await mkdir(dirname(resolve(path)), { recursive: true }); await writeFile(resolve(path), value); };
const draftExpression = `(() => ({
  origin: location.origin, title: document.title,
  drafts: JSON.parse(localStorage.getItem('shensi-whiteboard-generation-drafts-v1') || '{}'),
  active: JSON.parse(localStorage.getItem('shensi-whiteboard-generation-active-draft-v1') || 'null')
}))()`;
try {
  if (action === "inspect") {
    console.log(JSON.stringify(await evaluate(`(() => {
      const visible = element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      return {title:document.title,origin:location.origin,bootReady:document.documentElement.dataset.bootReady,
        dialogs:[...document.querySelectorAll('dialog[open]')].map(element=>element.id),
        controls:[...document.querySelectorAll('button,input,select,textarea,[role=treeitem]')].filter(visible).slice(0,85).map(element=>({id:element.id,tag:element.tagName,text:(element.textContent||element.getAttribute('aria-label')||element.getAttribute('title')||'').trim().slice(0,85),type:element.type,dataset:{...element.dataset}}))};
    })()`), null, 2));
  } else if (action === "capture") {
    const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await save(argument, Buffer.from(screenshot.data, "base64"));
    console.log(JSON.stringify({ screenshot: resolve(argument) }));
  } else if (action === "backup-drafts") {
    const value = await evaluate(draftExpression);
    await save(argument, `${JSON.stringify(value, null, 2)}\n`);
    console.log(JSON.stringify({ saved: resolve(argument), entries: Object.keys(value.drafts.entries || {}).length, active: value.active }));
  } else if (action === "verify-drafts") {
    const before = JSON.parse(await readFile(argument, "utf8"));
    const after = await evaluate(draftExpression);
    const canonical = value => JSON.stringify(value && typeof value === "object"
      ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
    const changed = Object.entries(before.drafts.entries || {}).filter(([key, entry]) => canonical(entry.values) !== canonical(after.drafts.entries?.[key]?.values)).map(([key]) => key);
    console.log(JSON.stringify({ unchanged: changed.length === 0, originalEntries: Object.keys(before.drafts.entries || {}).length, changedScopes: changed }));
    if (changed.length) process.exitCode = 1;
  } else if (action === "act") {
    console.log(JSON.stringify(await evaluate(await readFile(argument, "utf8")), null, 2));
  } else throw new Error("未知验收动作");
} finally { socket.close(); }
