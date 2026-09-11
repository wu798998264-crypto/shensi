import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-agent-runner-http-"));
const port = await new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once("error", rejectPort);
  server.listen(0, "127.0.0.1", () => {
    const selected = server.address().port;
    server.close(() => resolvePort(selected));
  });
});
const child = spawn(process.execPath, ["server.mjs", "--host", "127.0.0.1", "--port", String(port)], {
  cwd: root,
  env: {
    ...process.env,
    SHENSI_DATA_ROOT: join(runtimeRoot, "data"),
    SHENSI_MACHINE_DATA_ROOT: join(runtimeRoot, "machine"),
    SHENSI_SKIP_UPDATE_CHECK: "1",
  },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000); });
const origin = `http://127.0.0.1:${port}`;
const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

try {
  let healthy = false;
  for (let deadline = Date.now() + 30_000; Date.now() < deadline;) {
    try { healthy = (await fetch(`${origin}/api/health`)).ok; } catch {}
    if (healthy) break;
    await delay(100);
  }
  if (!healthy) throw new Error(`运行器安装 HTTP 验收核心未启动：${stderr}`);
  const html = await fetch(`${origin}/`).then((response) => response.text());
  const session = html.match(/name="shensi-session-token" content="([^"]+)"/u)?.[1];
  assert.ok(session, "页面必须返回本地会话令牌");
  const headers = { "X-Shensi-Session": session };
  const statusResponse = await fetch(`${origin}/api/agent-runners/status?force=true`, { headers });
  const statuses = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(statuses.ok, true);
  assert.deepEqual(Object.keys(statuses.runners).sort(), ["claude_code", "codex", "custom", "opencode", "trae_work", "workbuddy"]);
  assert.equal(statuses.runners.codex.installed, true);
  assert.equal(statuses.runners.opencode.installed, true);
  assert.equal(statuses.runners.claude_code.installed, true);
  assert.equal(statuses.runners.custom.configurable, true, "自定义运行器必须返回手动配置入口");

  const installResponse = await fetch(`${origin}/api/agent-runners/install`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ runnerId: "codex" }),
  });
  const install = await installResponse.json();
  assert.equal(install.ok, true);
  assert.ok(install.job?.id);
  let job = install.job;
  for (let deadline = Date.now() + 10_000; Date.now() < deadline && job.status === "running";) {
    await delay(100);
    const response = await fetch(`${origin}/api/agent-runners/install/status?jobId=${encodeURIComponent(job.id)}`, { headers });
    const payload = await response.json();
    job = payload.job;
  }
  assert.equal(job.status, "completed");
  assert.match(job.message, /已安装，无需重复装配/u);
  console.log(JSON.stringify({ ok: true, runners: statuses.runners, installedGuard: job.message }, null, 2));
} finally {
  child.kill();
  await delay(300);
  await rm(runtimeRoot, { recursive: true, force: true }).catch(() => {});
}
