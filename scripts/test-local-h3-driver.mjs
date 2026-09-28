import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-local-h3-driver-"));
process.env.SHENSI_LOCAL_H3_ROOT = root;
const runtimeRoot = join(root, "v0.1.1");
await mkdir(runtimeRoot, { recursive: true });
await writeFile(join(runtimeRoot, "runtime.json"), JSON.stringify({ version: "v0.1.1", workflowVersion: "0.1.1", baseUrl: "http://127.0.0.1:0", managedByShensi: true }), "utf8");
await writeFile(join(runtimeRoot, "workflow.json"), JSON.stringify({
  "1": { class_type: "LoadImage", inputs: { image: "{{IMAGE_NAME}}", upload: "image" } },
  "2": { class_type: "UNETLoader", inputs: {} },
  "3": { class_type: "CLIPLoader", inputs: {} },
  "4": { class_type: "MiniMaxH3ReferenceToVideo", inputs: { text: "{{PROMPT}}" } },
  "5": { class_type: "CreateVideo", inputs: {} },
  "6": { class_type: "SaveVideo", inputs: {} },
}), "utf8");
const output = Buffer.from("fake-mp4");
let promptBody = "";
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const json = (value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  if (url.pathname === "/system_stats") return json({ system: { os: "windows" } });
  if (url.pathname === "/object_info") return json({ MiniMaxH3ReferenceToVideo: {}, CreateVideo: {}, SaveVideo: {} });
  if (url.pathname === "/upload/image") { request.resume(); request.on("end", () => json({ name: "reference.png", subfolder: "", type: "input" })); return; }
  if (url.pathname === "/prompt") { promptBody = await new Promise((resolve) => { let body = ""; request.on("data", (chunk) => { body += chunk; }); request.on("end", () => resolve(body)); }); return json({ prompt_id: "prompt-1" }); }
  if (url.pathname === "/history/prompt-1") return json({ "prompt-1": { status: { status_str: "success", completed: true }, outputs: { "6": { videos: [{ filename: "h3.mp4", subfolder: "", type: "output" }] } } } });
  if (url.pathname === "/view") { response.writeHead(200, { "Content-Type": "video/mp4" }); response.end(output); return; }
  json({ message: "not found" }, 404);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
await writeFile(join(runtimeRoot, "runtime.json"), JSON.stringify({ version: "v0.1.1", workflowVersion: "0.1.1", baseUrl: `http://127.0.0.1:${port}`, managedByShensi: true }), "utf8");
const { LocalH3VideoDriver } = await import("../src/server/media-provider-drivers.mjs");
const driver = new LocalH3VideoDriver();
const settings = { provider: "本地 H3", adapter: "api", baseUrl: `http://127.0.0.1:${port}`, model: "minimax-h3-reference-video", timeoutMs: 60_000 };
const probe = await driver.probeCapabilities({ settings });
assert.equal(probe.available, true);
assert.equal(probe.message, "本地 H3 已就绪");
const workRoot = join(root, "work");
const reference = join(root, "reference.png");
await writeFile(reference, Buffer.from("fake-png"));
const submitted = await driver.submit({ job: { id: "job-1", idempotencyKey: "idem-1", channel: "video", request: { prompt: "让人物自然眨眼", settings, duration: 5, aspectRatio: "16:9" } }, settings, references: [{ absolutePath: reference, mimeType: "image/png" }], workRoot });
assert.equal(submitted.providerTaskId, "prompt-1");
assert.match(promptBody, /让人物自然眨眼/u);
const status = await driver.getStatus({ job: submitted, workRoot });
assert.equal(status.providerStatus, "completed");
const resultPath = join(root, "result.mp4");
const downloaded = await driver.download({ job: submitted, workRoot, outputPath: resultPath });
assert.equal(downloaded.mimeType, "video/mp4");
assert.deepEqual(await readFile(downloaded.path), output);
server.close();
console.log("local H3 driver: ok");
