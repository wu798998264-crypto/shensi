import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const executable = process.env.SHENSI_E2E_INSTALLED_EXE || "C:\\Users\\Administrator\\AppData\\Local\\Programs\\Shensi\\Shensi.exe";
const root = await mkdtemp(join(tmpdir(), "shensi-v200-clipboard-"));
const dataRoot = join(root, "data");
const userDataRoot = join(root, "user-data");
const sourcePath = join(root, "外部剪贴板资料.md");
const debugPort = 9342;
await writeFile(sourcePath, "# 外部剪贴板资料\n\n用于验证白板统一粘贴。\n", "utf8");
const escapedPath = sourcePath.replaceAll("'", "''");
const clipboardResult = spawnSync("powershell.exe", ["-NoProfile", "-STA", "-Command", `Add-Type -AssemblyName System.Windows.Forms; $files=New-Object System.Collections.Specialized.StringCollection; [void]$files.Add('${escapedPath}'); [System.Windows.Forms.Clipboard]::SetFileDropList($files)`], { encoding: "utf8", windowsHide: true });
assert.equal(clipboardResult.status, 0, clipboardResult.stderr || "Windows 文件剪贴板写入失败");

const child = spawn(executable, [`--remote-debugging-port=${debugPort}`], {
  env: { ...process.env, SHENSI_DATA_ROOT: dataRoot, SHENSI_MACHINE_DATA_ROOT: dataRoot, SHENSI_DESKTOP_USER_DATA_ROOT: userDataRoot, SHENSI_SKIP_UPDATE_CHECK: "1" },
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let page;
  for (let attempt = 0; attempt < 120 && !page; attempt += 1) {
    try {
      const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
      page = targets.find((target) => target.type === "page" && /127\.0\.0\.1|localhost/u.test(target.url));
    } catch {}
    if (!page) await delay(250);
  }
  assert.ok(page, "安装版主界面未就绪");
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await cdp("Runtime.enable");
  const evaluated = await cdp("Runtime.evaluate", { expression: "window.shensiDesktop.clipboard.readFiles()", awaitPromise: true, returnByValue: true });
  const payload = evaluated.result.value;
  assert.equal(payload.ok, true);
  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, "外部剪贴板资料.md");
  assert.ok(Number(payload.files[0].size) > 0);
  console.log(JSON.stringify({ ok: true, installedClipboardFiles: payload.files.map(({ name, size }) => ({ name, size })) }));
  await cdp("Runtime.evaluate", { expression: "window.shensiDesktop.windowControl.requestApplicationQuit()", awaitPromise: true, returnByValue: true }).catch(() => {});
  await delay(1_000);
} finally {
  socket?.close();
  if (!child.killed) child.kill();
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5_000)]);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== "EBUSY") throw error;
      if (attempt === 9) break;
      await delay(250);
    }
  }
}
