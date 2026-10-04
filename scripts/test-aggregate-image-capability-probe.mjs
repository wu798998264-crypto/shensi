import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const listen = (server) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(server.address().port));
});

const upstream = createServer((request, response) => {
  if (request.url !== "/v1/models") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ data: [{ id: "gpt-image-2.5", object: "model" }] }));
});

const upstreamPort = await listen(upstream);
const dataRoot = await mkdtemp(join(tmpdir(), "shensi-image-probe-"));
const serverPort = 47000 + Math.floor(Math.random() * 500);
const child = spawn(process.execPath, ["server.mjs", "--port", String(serverPort)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    SHENSI_DATA_ROOT: dataRoot,
    SHENSI_MACHINE_DATA_ROOT: dataRoot,
    SHENSI_DISABLE_MEDIA_RECOVERY_WORKERS: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let childClosed = false;
const childExit = new Promise((resolve) => child.once("close", (code, signal) => {
  childClosed = true;
  resolve({ code, signal });
}));

const stop = async () => {
  if (!child.killed) child.kill();
  if (!childClosed) await childExit;
  await rm(dataRoot, { recursive: true, force: true });
  await new Promise((resolve) => upstream.close(resolve));
};

try {
  let health;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      health = await fetch(`http://127.0.0.1:${serverPort}/api/health`);
      if (health.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(health?.ok, true, "本地核心应启动以执行能力探测契约");
  const html = await (await fetch(`http://127.0.0.1:${serverPort}/`)).text();
  const sessionToken = html.match(/shensi-session-token" content="([^"]+)"/u)?.[1];
  assert.ok(sessionToken, "页面应提供本地会话令牌");

  const response = await fetch(`http://127.0.0.1:${serverPort}/api/media/capabilities/probe`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shensi-session": sessionToken },
    body: JSON.stringify({
      channel: "image",
      settings: {
        id: "image-cockpit-aggregate-api",
        connectionId: "image-cockpit-aggregate-api",
        adapter: "api",
        provider: "自定义兼容接口",
        protocol: "images",
        baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
        model: "gpt-image-2.5",
        apiKey: "probe-only-token",
      },
    }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.connected, true);
  assert.equal(payload.available, true);
  assert.equal(payload.driverRegistered, false, "聚合图片 API 仍应走同步适配器路径");
  assert.equal(payload.executionMode, "synchronous_api");
  assert.equal(payload.verificationLevel, "model_visibility");
  assert.equal(payload.reason, undefined);
  assert.ok(payload.models.some((item) => item.slug === "gpt-image-2.5"));
  console.log("aggregate image capability probe uses non-billing model catalog and keeps adapter path");
} finally {
  await stop();
}
