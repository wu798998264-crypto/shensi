import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "shensi-local-h3-driver-"));
process.env.SHENSI_LOCAL_H3_ROOT = root;
const runtimeRoot = join(root, "v0.1.1");
await mkdir(runtimeRoot, { recursive: true });
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const endpoint = `http://127.0.0.1:${port}`;
const pidFile = join(root, "pids.json");
const runtime = { version: "v0.1.1", workflowVersion: "0.1.1", baseUrl: endpoint, managedByShensi: true, launch: { command: [process.execPath, fileURLToPath(new URL("./fixtures/local-h3-managed-runtime.mjs", import.meta.url)), String(port), pidFile] } };
await writeFile(join(runtimeRoot, "runtime.json"), JSON.stringify(runtime));
await writeFile(join(runtimeRoot, "workflow.json"), JSON.stringify({
  "1": { class_type: "LoadImage", inputs: { image: "{{IMAGE_NAME}}", upload: "image" } },
  "2": { class_type: "UNETLoader", inputs: {} }, "3": { class_type: "CLIPLoader", inputs: {} },
  "4": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { text: "{{PROMPT}}" } },
  "5": { class_type: "CreateVideo", inputs: {} }, "6": { class_type: "SaveVideo", inputs: {} },
}));
const { LocalH3VideoDriver } = await import("../src/server/media-provider-drivers.mjs");
const { startLocalH3Runtime, stopLocalH3Runtime, ensureLocalH3Runtime } = await import("../src/server/local-h3-runtime.mjs");
const driver = new LocalH3VideoDriver();
const settings = { provider: "本地 H3", adapter: "api", baseUrl: endpoint, model: "minimax-h3-reference-video" };
const subprocessProbe = () => new Promise((resolve, reject) => {
  const code = `import { ensureLocalH3Runtime } from ${JSON.stringify(new URL("../src/server/local-h3-runtime.mjs", import.meta.url).href)}; console.log(JSON.stringify(await ensureLocalH3Runtime({ settings: ${JSON.stringify(settings)} })));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env, windowsHide: true });
  let out = ""; let err = "";
  child.stdout.on("data", (c) => out += c); child.stderr.on("data", (c) => err += c);
  child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
});
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
try {
  assert.equal((await driver.probeCapabilities({ settings })).started, false);
  await assert.rejects(ensureLocalH3Runtime({ settings }), { providerErrorCode: "LOCAL_H3_NOT_STARTED" });
  const results = await Promise.all([startLocalH3Runtime({ settings, timeoutMs: 5_000 }), startLocalH3Runtime({ settings, timeoutMs: 5_000 })]);
  assert.equal(results[0].ready, true);
  assert.equal(results[0].pid, results[1].pid, "并发启动不能重复创建进程");
  assert.equal((await subprocessProbe()).ready, true, "真实 worker 子进程必须读到受管启动状态");
  const workRoot = join(root, "work"); const reference = join(root, "reference.png");
  await writeFile(reference, "fake-png");
  const submitted = await driver.submit({ job: { id: "job-1", idempotencyKey: "idem-1", channel: "video", request: { prompt: "让人物自然眨眼", settings, duration: 5, aspectRatio: "16:9" } }, settings, references: [{ absolutePath: reference, mimeType: "image/png" }], workRoot });
  assert.equal(submitted.providerTaskId, "prompt-1");
  assert.match((await fetch(`${endpoint}/fixture/prompt`).then((r) => r.json())).submitted, /让人物自然眨眼/u);
  assert.equal((await driver.getStatus({ job: submitted, workRoot })).providerStatus, "completed");
  const downloaded = await driver.download({ job: submitted, workRoot, outputPath: join(root, "result.mp4") });
  assert.equal(await readFile(downloaded.path, "utf8"), "fake-mp4");
  const pids = JSON.parse(await readFile(pidFile, "utf8"));
  await stopLocalH3Runtime({ settings });
  assert.equal(alive(pids.pid), false, "停止必须确认推理进程退出");
  assert.equal(alive(pids.descendantPid), false, "停止必须包含受管理的子进程树");
  assert.equal((await driver.probeCapabilities({ settings })).available, false);
  await assert.rejects(subprocessProbe(), /LOCAL_H3_NOT_STARTED|尚未启动/u);
  await writeFile(join(runtimeRoot, "runtime.json"), JSON.stringify({ ...runtime, requiresExternalRuntime: true }));
  assert.equal((await driver.probeCapabilities({ settings })).installed, false, "仅适配器不能冒充装配完成");
  await assert.rejects(startLocalH3Runtime({ settings }), { providerErrorCode: "LOCAL_H3_RUNTIME_INCOMPLETE" });
  console.log("local H3: cross-process lifecycle + fixture protocol passed (not real inference)");
} finally {
  await stopLocalH3Runtime({ settings }).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
