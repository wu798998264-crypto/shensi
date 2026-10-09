import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

if (process.platform === "win32" && process.env.SHENSI_TEST_TASKBAR_NATIVE === "1") {
  const executable = fileURLToPath(new URL("../node_modules/electron/dist/electron.exe", import.meta.url));
  await access(executable);
  const root = await mkdtemp(join(tmpdir(), "shensi-taskbar-identity-"));
  const repairSource = await readFile(new URL("./windows/repair-shensi-taskbar-identity.ps1", import.meta.url), "utf8");
  const csharp = repairSource.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1];
  assert.ok(csharp);
  const queryIdentity = async (hwnd, { requireResolved = true } = {}) => {
    assert.ok(Number.isSafeInteger(hwnd) && hwnd > 0);
    const command = `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(csharp).toString("base64")}'))); $identity=[ordered]@{explicit=[ShensiTaskbarIdentity]::Explicit(${hwnd})}; try {$identity.resolved=[ShensiTaskbarIdentity]::Resolved(${hwnd})} catch {$identity.resolvedError=$_.Exception.Message}; $identity | ConvertTo-Json -Compress`;
    try {
      const { stdout } = await promisify(execFile)("powershell.exe", ["-NoProfile", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true, timeout: 15_000 });
      const identity = JSON.parse(stdout.trim());
      if (requireResolved && identity.resolvedError) throw new Error(identity.resolvedError);
      return identity;
    } catch (error) { throw new Error(`Native taskbar identity query failed: ${String(error.stderr || error.message || error.code).slice(-1200)}`); }
  };
  const environment = { ...process.env, SHENSI_TEST_TASKBAR_USER_DATA: root };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [fileURLToPath(new URL("./fixtures/desktop-taskbar-identity.cjs", import.meta.url))], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: environment,
  });
  const lines = createInterface({ input: child.stdout });
  const mailbox = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  const exit = new Promise((resolveExit, rejectExit) => {
    child.once("exit", (code) => resolveExit(code));
    child.once("error", rejectExit);
  });
  let controlPort;
  const sendCommand = (command) => new Promise((resolveCommand, rejectCommand) => {
    const socket = createConnection({ host: "127.0.0.1", port: controlPort }, () => socket.write(`${command}\n`));
    socket.setTimeout(5000, () => socket.destroy(new Error("taskbar fixture control timeout")));
    socket.once("error", rejectCommand);
    socket.once("end", resolveCommand);
    socket.resume();
  });
  lines.on("line", (line) => {
    let event; try { event = JSON.parse(line); } catch { return; }
    const waiter = waiters.shift();
    if (waiter) waiter(event); else mailbox.push(event);
  });
  const next = () => Promise.race([
    mailbox.length ? Promise.resolve(mailbox.shift()) : new Promise((resolveNext) => waiters.push(resolveNext)),
    exit.then((code) => { throw new Error(`taskbar fixture exited (${code}): ${stderr}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`taskbar fixture timed out: ${stderr}`)), 20_000); timer.unref(); }),
  ]);
  try {
    const before = await next();
    assert.equal(before.phase, "before");
    assert.equal(before.pid, child.pid);
    controlPort = before.controlPort;
    assert.ok(Number.isInteger(controlPort) && controlPort > 0);
    // An unbound, generic electron.exe test HWND need not have a resolvable Shell identity.
    // After binding, both the native property and Shell resolver must match.
    const initial = await queryIdentity(before.hwnd, { requireResolved: false });
    await sendCommand("bind");
    const bound = await next();
    const identity = await queryIdentity(bound.hwnd);
    assert.equal(identity.resolved, "com.shensi.creativeengine", "实际 Windows Shell 必须识别为神思，不能继承启动器身份");
    assert.equal(identity.explicit, "com.shensi.creativeengine", "实际 HWND 必须具有显式身份");
    await sendCommand("restore");
    const restored = await next();
    assert.equal(restored.phase, "restored");
    assert.equal(restored.hwnd, bound.hwnd);
    assert.deepEqual(await queryIdentity(bound.hwnd), identity, "恢复时重复绑定必须保持身份不变");
    console.log(`Windows HWND taskbar integration passed (${initial.resolved || "unregistered test HWND"} -> ${identity.resolved}; hide/restore preserved identity)`);
  } finally {
    if (controlPort && child.exitCode === null) await sendCommand("quit").catch(() => {});
    const stopped = await Promise.race([exit.then(() => true), new Promise((resolveWait) => { const timer = setTimeout(() => resolveWait(false), 5000); timer.unref(); })]);
    if (!stopped && Number(child.pid) > 0) await promisify(execFile)("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    lines.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())));
    await rm(root, { recursive: true, force: true });
  }
} else console.log("Native Windows taskbar integration skipped (requires SHENSI_TEST_TASKBAR_NATIVE=1 and an interactive desktop)");
