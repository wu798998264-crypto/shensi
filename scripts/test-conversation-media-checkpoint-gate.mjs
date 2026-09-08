import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mediaCapabilityProfileSignature } from "../src/media-capability-probe.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-media-checkpoint-"));
const dataRoot = join(runtimeRoot, "data");
const userDataRoot = join(runtimeRoot, "electron-user");
await mkdir(dataRoot, { recursive: true });
await mkdir(userDataRoot, { recursive: true });

const debugPort = 9345;
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
if (!target) throw new Error(`媒体检查点验收页面未启动：${stderr.slice(-1000)}`);

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

try {
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#chatInput')", "应用启动");
  await evaluate(`if (document.querySelector('#creativeStartWelcomeDialog')?.open) document.querySelector('#dismissCreativeStartWelcome')?.click(); true`);
  await evaluate(`document.querySelector('#projectButton').click(); true`);
  await waitFor("document.querySelector('#newWorkspaceButton')", "作品列表");
  await evaluate(`document.querySelector('#newWorkspaceButton').click(); true`);
  await waitFor("document.querySelector('#textDialog')?.open", "新建检查点验收作品");
  await evaluate(`(() => {
    const input = document.querySelector('#textDialogInput');
    input.value = '对话媒体检查点验收作品';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#textDialogForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('对话媒体检查点验收作品')", "检查点验收作品创建");
  await waitFor("document.querySelector('.autosave-state')?.dataset.state === 'saved'", "首次保存完成");
  let profile = null;
  for (let deadline = Date.now() + 15_000; Date.now() < deadline && !profile;) {
    profile = await evaluate(`(async () => {
      const session = await fetch('/api/recovery/session').then((response) => response.json());
      const loaded = await fetch('/api/workspace/load', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspacePath: session.activeWorkspace.workspacePath }),
      }).then((response) => response.json());
      const settings = loaded.state?.settings;
      if (!settings) return null;
      return settings.imageConnections.find((candidate) => candidate.id === settings.activeImageConnectionId)
        || settings.imageConnections[0];
    })()`);
    if (!profile) await delay(100);
  }
  assert.ok(profile?.id, "故障注入验收必须取得隔离工作区的图片配置");
  const checkedAt = new Date().toISOString();
  const probeSession = {
    media: {
      [`image:${profile.id}`]: {
        ok: true,
        connected: true,
        available: true,
        capabilityState: "available",
        generationCapabilityState: "available",
        softwareIntegrated: true,
        visibilityChecked: true,
        models: ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"],
        generationPermissionChecked: true,
        profileSignature: mediaCapabilityProfileSignature("image", profile),
        checkedAt,
      },
    },
  };
  await evaluate(`sessionStorage.setItem('shensi-capability-probes-v1', ${JSON.stringify(JSON.stringify(probeSession))}); true`);
  await cdp("Page.reload", { ignoreCache: true });
  await delay(600);
  await waitFor("document.documentElement.dataset.bootReady === 'true' && document.querySelector('#chatInput')", "核验状态恢复");
  await waitFor("document.querySelector('#projectButton')?.textContent.includes('对话媒体检查点验收作品')", "验收工作区恢复");
  await evaluate(`(() => {
    document.querySelector('[data-module="manuscript"]')?.click();
    document.querySelector('#addDocument')?.click();
    return true;
  })()`);
  await waitFor("document.querySelector('#textDialog')?.open", "新建混合保存验收文档");
  await evaluate(`(() => {
    const input = document.querySelector('#textDialogInput');
    input.value = '媒体提交前混合保存验收';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#textDialogForm').requestSubmit();
    return true;
  })()`);
  await waitFor("document.querySelector('#editor')?.isContentEditable", "混合保存验收文档可编辑");
  await evaluate(`(() => {
    const editor = document.querySelector('#editor');
    editor.innerHTML = '<p>必须和对话媒体任务一起保存的正文修改</p>';
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '正文修改' }));
    return true;
  })()`);
  await evaluate(`(() => {
    const originalFetch = window.fetch.bind(window);
    window.__mediaGateCalls = { checkpoint: 0, workspaceSave: 0, mediaSubmit: 0, sequence: [], savedStates: [] };
    window.fetch = async (input, init = {}) => {
      const url = String(typeof input === 'string' ? input : input?.url || '');
      const method = String(init?.method || 'GET').toUpperCase();
      if (method === 'POST' && url.includes('/api/recovery/checkpoint')) {
        window.__mediaGateCalls.checkpoint += 1;
        window.__mediaGateCalls.sequence.push('checkpoint');
        return new Response(JSON.stringify({ ok: false, message: '故障注入：快速检查点不可用' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'POST' && url.includes('/api/workspace/save')) {
        window.__mediaGateCalls.workspaceSave += 1;
        window.__mediaGateCalls.sequence.push('workspace-save');
        if (typeof init.body === 'string') {
          try {
            const request = JSON.parse(init.body);
            window.__mediaGateCalls.savedStates.push(request.state || null);
          } catch {}
        }
        return new Response(JSON.stringify({ ok: false, message: '故障注入：规范工作区保存不可用' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      if (method === 'POST' && url.includes('/api/generation/jobs/media')) {
        window.__mediaGateCalls.mediaSubmit += 1;
        window.__mediaGateCalls.sequence.push('media-submit');
        return new Response(JSON.stringify({ ok: false, code: 'TEST_MEDIA_SUBMISSION_BLOCKED', message: '验收已抵达媒体提交边界' }), { status: 503, headers: { 'content-type': 'application/json' } });
      }
      return originalFetch(input, init);
    };
    return true;
  })()`);
  await evaluate(`(() => {
    const input = document.querySelector('#chatInput');
    input.value = '使用 OpenAI 生成一张蓝色圆形图片';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#chatForm').requestSubmit();
    return true;
  })()`);
  // The instruction explicitly chooses OpenAI, so the profile/model steps are
  // intentionally skipped and only the still-missing image parameters remain.
  await waitFor("document.querySelector('[data-choice-type=\"media_image_aspect\"]') && document.querySelector('[data-choice-type=\"media_image_quality\"]')", "媒体参数选择");
  await evaluate(`(() => {
    document.querySelector('[data-choice-type="media_image_aspect"]').click();
    document.querySelector('[data-choice-type="media_image_quality"]').click();
    document.querySelector('[data-choice-type="media_image_parameters_confirm"]').click();
    return true;
  })()`);
  await waitFor("window.__mediaGateCalls.mediaSubmit > 0", "抵达媒体提交边界", 30_000);
  await waitFor("window.__mediaGateCalls.workspaceSave > 0", "后台工作区保存已尝试", 30_000);
  const calls = await evaluate("window.__mediaGateCalls");
  assert.equal(calls.mediaSubmit, 1, "明确的服务错误不得自动重复收费提交");
  assert.ok(calls.workspaceSave >= 1, "完整工作区保存必须在后台继续重试");
  const resultText = await evaluate("document.querySelector('#chatFeed')?.innerText || ''");
  assert.match(resultText, /验收已抵达媒体提交边界/u, "故障注入必须证明流程已越过旧检查点阻断位置");
  console.log(JSON.stringify({
    ok: true,
    checkpointCalls: calls.checkpoint,
    workspaceSaveCalls: calls.workspaceSave,
    mediaSubmitCalls: calls.mediaSubmit,
    sequence: calls.sequence,
    generationContinuedWhileWorkspaceSaveFailed: true,
  }, null, 2));
} finally {
  socket.close();
  child.kill();
  await delay(500);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
