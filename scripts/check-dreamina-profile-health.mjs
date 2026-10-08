import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dreaminaCliEnvironment, dreaminaCliRuntime } from "../src/server/dreamina-cli-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profiles = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["default", "chenan", "guobazai", "tashuo-juyougeng", "xiaoyujie"];

// A fresh capability probe can legitimately take close to the bridge's
// 150-second control-plane deadline (version, credit, task-resource and model
// capability checks).  Keep a bounded margin so healthy profiles are not
// misclassified while still guaranteeing that a stalled profile terminates.
const healthTimeoutMs = Math.max(10_000, Number(process.env.SHENSI_DREAMINA_HEALTH_TIMEOUT_MS) || 180_000);

const terminate = (child) => {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.unref?.();
    return;
  }
  child.kill("SIGKILL");
};

const invoke = (profileId) => new Promise((resolveInvoke) => {
  const runtime = dreaminaCliRuntime({ dreaminaCliProfile: profileId });
  const child = spawn(process.execPath, [join(root, "src", "cli", "dreamina-video-cli.mjs"), "--check"], {
    cwd: root,
    env: {
      ...dreaminaCliEnvironment({ dreaminaCliProfile: profileId }, process.env),
      SHENSI_DREAMINA_CONNECTION_CACHE_MS: "0",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    terminate(child);
    resolveInvoke({
      profileId,
      executable: runtime.executable,
      profileHome: runtime.profileHome,
      providerStateRoot: runtime.providerStateRoot,
      ok: false,
      timeout: true,
      timeoutMs: healthTimeoutMs,
      errorCode: "DREAMINA_HEALTH_CHECK_TIMEOUT",
      error: `配置健康检查超过 ${Math.ceil(healthTimeoutMs / 1000)} 秒未完成`,
    });
  }, healthTimeoutMs);
  timer.unref?.();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    let payload = null;
    try { payload = JSON.parse(stdout.trim()); } catch {}
    resolveInvoke({
      profileId,
      executable: runtime.executable,
      profileHome: runtime.profileHome,
      providerStateRoot: runtime.providerStateRoot,
      ok: code === 0 && payload?.ok === true,
      credit: payload?.credit ?? null,
      vipLevel: payload?.vipLevel || "",
      version: payload?.version ?? null,
      error: code === 0 ? "" : stderr.trim() || stdout.trim() || `exit ${code}`,
    });
  });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveInvoke({ profileId, ok: false, error: error.message });
  });
});

const results = [];
for (const profileId of profiles) results.push(await invoke(profileId));
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.every((item) => item.ok) ? 0 : 1;
