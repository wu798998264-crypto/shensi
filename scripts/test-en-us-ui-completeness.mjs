import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { translateUiText } from "../src/ui-i18n.js";

for (const source of [
  "已读取",
  "Agent 正在处理",
  "目标文档",
  "任务路由历史",
  "发布 Skill 到广场",
  "Skill 广场",
  "其他",
  "确认",
  "自定义运行器",
]) {
  assert.doesNotMatch(translateUiText(source, "en-US"), /[\u3400-\u9fff]/u, `missing critical translation: ${source}`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-en-us-ui-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });

const debugPort = 9476;
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
for (let deadline = Date.now() + 45_000; Date.now() < deadline && !target;) {
  try {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
    target = targets.find((item) => item.type === "page" && /127\.0\.0\.1|localhost/u.test(item.url));
  } catch {}
  if (!target) await delay(200);
}
if (!target) throw new Error(`English UI test page did not start: ${stderr.slice(-1000)}`);

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
  throw new Error(`Timed out waiting for ${label}: ${stderr.slice(-800)}`);
};
const visibleChinese = async (scope = "document.body") => evaluate(`(() => {
  const root = ${scope};
  const cjk = /[\\u3400-\\u9fff]/u;
  const allowed = /(神思|即梦|可灵|阿里云百炼|火山方舟|豆包|通义千问|海螺|全本小说网|柏物语|短剧最前线)/gu;
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    return !element.hidden && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  };
  const findings = [];
  const push = (element, kind, value) => {
    const text = String(value || '').replace(allowed, '').replace(/\\s+/g, ' ').trim();
    if (!text || !cjk.test(text)) return;
    const selector = element.id ? '#' + element.id : element.tagName.toLowerCase() + (element.classList.length ? '.' + [...element.classList].slice(0, 2).join('.') : '');
    findings.push({ selector, kind, text: String(value || '').replace(/\\s+/g, ' ').trim().slice(0, 240) });
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent && visible(parent) && !['SCRIPT','STYLE','TEXTAREA'].includes(parent.tagName)) push(parent, 'text', node.nodeValue);
  }
  for (const element of root.querySelectorAll('[title],[aria-label],[placeholder],select')) {
    if (!visible(element)) continue;
    for (const attr of ['title','aria-label','placeholder']) push(element, attr, element.getAttribute(attr));
    if (element instanceof HTMLSelectElement) push(element, 'selected-option', element.selectedOptions[0]?.textContent);
  }
  return findings.slice(0, 80);
})()`);
const assertClean = async (label, scope = "document.body") => {
  await delay(80);
  const findings = await visibleChinese(scope);
  assert.deepEqual(findings, [], `${label} contains untranslated UI: ${JSON.stringify(findings)}`);
};

try {
  await cdp("Runtime.enable");
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#settingsButton')", "application boot", 45_000);
  await evaluate("document.querySelector('#settingsButton').click(); true");
  await waitFor("document.querySelector('#settingsDialog')?.open", "settings dialog");
  await evaluate(`(() => { const language = document.querySelector('#settingsForm [name="uiLanguage"]'); language.value = 'en-US'; language.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await waitFor("document.documentElement.lang === 'en'", "English locale");

  for (const section of ["account", "quick", "basic", "typography", "theme", "model", "skill", "experience", "sync", "about"]) {
    await evaluate(`document.querySelector('[data-settings-section="${section}"]').click(); true`);
    await waitFor(`!document.querySelector('[data-settings-page="${section}"]').hidden`, `${section} settings`);
    if (section === "model") {
      for (const channel of ["text", "image", "video", "audio"]) {
        await evaluate(`document.querySelector('[data-model-settings-channel="${channel}"]').click(); true`);
        await waitFor(`!document.querySelector('[data-model-channel-panel="${channel}"]').hidden`, `${channel} model settings`);
        await assertClean(`${channel} model settings`, `document.querySelector('#settingsDialog')`);
      }
    } else if (section === "skill") {
      for (const tab of ["slots", "custom", "marketplace"]) {
        await evaluate(`document.querySelector('[data-skill-settings-tab="${tab}"]').click(); true`);
        await delay(250);
        await assertClean(`${tab} Skill settings`, `document.querySelector('#settingsDialog')`);
      }
      await evaluate("document.querySelector('[data-skill-settings-tab=\"slots\"]').click(); true");
      await delay(200);
      if (await evaluate("Boolean(document.querySelector('[data-open-route-history]'))")) {
        await evaluate("document.querySelector('[data-open-route-history]').click(); true");
        await waitFor("document.querySelector('#capabilityHistoryDialog')?.open", "route history");
        await assertClean("route history", `document.querySelector('#capabilityHistoryDialog')`);
        await evaluate("document.querySelector('#capabilityHistoryDialog').close(); true");
      }
    } else {
      await assertClean(`${section} settings`, `document.querySelector('#settingsDialog')`);
    }
  }

  await evaluate("document.querySelector('#settingsForm').requestSubmit(); true");
  await waitFor("document.querySelector('.toast:not([hidden])')?.textContent.includes('Settings saved')", "saved English locale");
  await evaluate("document.querySelector('#settingsDialog').close(); true");
  await waitFor("!document.querySelector('#settingsDialog')?.open && document.documentElement.lang === 'en'", "closed settings with saved English locale");
  await evaluate("document.querySelector('#conversationPermissionMenu').open = true; true");
  await assertClean("main conversation and permission menu");
  console.log("real Electron en-US UI completeness passed");
} finally {
  socket.close();
  child.kill();
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    delay(3_000),
  ]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(runtimeRoot, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await delay(250);
    }
  }
}
