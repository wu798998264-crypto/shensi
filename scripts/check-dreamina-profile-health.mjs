import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dreaminaCliEnvironment, dreaminaCliRuntime } from "../src/server/dreamina-cli-profile.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profiles = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["default", "chenan", "guobazai", "tashuo-juyougeng", "xiaoyujie"];

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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (code) => {
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
  child.on("error", (error) => resolveInvoke({ profileId, ok: false, error: error.message }));
});

const results = [];
for (const profileId of profiles) results.push(await invoke(profileId));
process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.every((item) => item.ok) ? 0 : 1;
