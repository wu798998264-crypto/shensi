import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { decodeCodexImageItem, decodeCodexImageResult, runCodexImageAppServer } from "../src/cli/codex-image-app-server.mjs";
import { resolveLocalCodexLaunch } from "../src/cli/codex-launch.mjs";
import { parseStructuredCliError } from "../src/server/adapters.mjs";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl7ZQAAAABJRU5ErkJggg==";

const bundledLaunch = await resolveLocalCodexLaunch({
  environment: { LOCALAPPDATA: "C:\\Local", APPDATA: "C:\\Roaming", PATH: "" },
  platform: "win32",
  accessFile: async (candidate) => /codex\.exe$/iu.test(candidate),
  readDirectory: async () => [
    { name: "zz-random-old", isDirectory: () => true },
    { name: "aa-random-new", isDirectory: () => true },
  ],
  resolveVersion: async (candidate) => candidate.includes("zz-random-old")
    ? "codex-cli 0.148.0-alpha.9"
    : "codex-cli 0.149.0-alpha.4.1",
});
assert.match(bundledLaunch.executable, /aa-random-new[\\/]codex\.exe$/u, "随机哈希目录不能让旧 Codex 覆盖较新的 CLI");

const decoded = decodeCodexImageResult(PNG_BASE64);
assert.equal(decoded.extension, "png");
assert.equal(decoded.bytes.length, 67);
assert.equal(decodeCodexImageResult(`data:image/png;base64,${PNG_BASE64}`).extension, "png");
assert.throws(() => decodeCodexImageResult("not-an-image"), (error) => error.code === "OPENAI_IMAGE_INVALID_RESULT");

const savedImageRoot = await mkdtemp(join(tmpdir(), "shensi-gpt-image-test-"));
try {
  const savedImagePath = join(savedImageRoot, "saved-result.png");
  await writeFile(savedImagePath, Buffer.from(PNG_BASE64, "base64"));
  const saved = await decodeCodexImageItem({ type: "imageGeneration", status: "completed", result: "generated", savedPath: savedImagePath });
  assert.equal(saved.extension, "png");
  assert.equal(saved.bytes.length, 67);
  assert.equal((await readFile(saved.savedPath)).length, 67);
} finally {
  await rm(savedImageRoot, { recursive: true, force: true });
}

const structuredError = parseStructuredCliError(`真实错误\nSHENSI_MEDIA_ERROR_JSON:${Buffer.from(JSON.stringify({ code: "OPENAI_IMAGE_INVALID_RESULT", providerErrorCode: "OPENAI_IMAGE_INVALID_RESULT", submissionOutcomeKnown: true, message: "真实错误" }), "utf8").toString("base64url")}`);
assert.equal(structuredError.code, "OPENAI_IMAGE_INVALID_RESULT");
assert.equal(structuredError.submissionOutcomeKnown, true);
assert.equal(structuredError.structuredMessage, "真实错误");

const fakeServer = async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
  };
  let input = "";
  const reply = (message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin = new Writable({
    write(chunk, _encoding, done) {
      input += chunk.toString("utf8");
      const lines = input.split(/\r?\n/);
      input = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const request = JSON.parse(line);
        if (request.method === "initialize") reply({ id: request.id, result: { platformFamily: "windows" } });
        else if (request.method === "account/read") reply({ id: request.id, result: { account: { type: "chatgpt", email: "test@example.com" } } });
        else if (request.method === "modelProvider/capabilities/read") reply({ id: request.id, result: { imageGeneration: true, namespaceTools: true, webSearch: true } });
        else if (request.method === "thread/start") reply({ id: request.id, result: { thread: { id: "thread-image-test" } } });
        else if (request.method === "turn/start") {
          observedTurnInput = request.params.input;
          reply({ id: request.id, result: { turn: { id: "turn-image-test" } } });
          queueMicrotask(() => {
            reply({ method: "item/completed", params: { item: { id: "image-item-1", type: "imageGeneration", status: "completed", result: PNG_BASE64 } } });
            reply({ method: "turn/completed", params: { turn: { id: "turn-image-test", status: "completed" } } });
          });
        }
      }
      done();
    },
  });
  return { child };
};

let observedThread = "";
let observedImage = null;
let observedTurnInput = [];
const results = await runCodexImageAppServer({
  cwd: process.cwd(),
  model: "gpt-test",
  prompt: "generate one image",
  imageCount: 1,
  timeoutMs: 60_000,
  launchServer: fakeServer,
  resolveImagegenSkill: async () => join(process.cwd(), "imagegen", "SKILL.md"),
  onThread: async ({ threadId }) => { observedThread = threadId; },
  onImage: async (image) => {
    observedImage = image;
    return { path: "mock-result.png" };
  },
});

assert.equal(observedThread, "thread-image-test");
assert.equal(observedImage.extension, "png");
assert.equal(results.length, 1);
assert.equal(results[0].path, "mock-result.png");
assert.equal(results[0].bytes.length, 67);
assert.deepEqual(observedTurnInput[0], { type: "skill", name: "imagegen", path: join(process.cwd(), "imagegen", "SKILL.md") });
assert.equal(observedTurnInput[1].type, "text");

const messageOnlyServer = async () => {
  const server = await fakeServer();
  const originalWrite = server.child.stdin._write.bind(server.child.stdin);
  server.child.stdin._write = (chunk, encoding, done) => {
    const source = chunk.toString("utf8");
    if (!source.includes('"method":"turn/start"')) return originalWrite(chunk, encoding, done);
    const request = JSON.parse(source.trim());
    server.child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-message-only" } } })}\n`);
    queueMicrotask(() => {
      server.child.stdout.write(`${JSON.stringify({ method: "item/completed", params: { item: { id: "message-1", type: "agentMessage", text: "图片工具未执行：请求缺少参考图。" } } })}\n`);
      server.child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-message-only", status: "completed" } } })}\n`);
    });
    done();
  };
  return server;
};

await assert.rejects(
  runCodexImageAppServer({ cwd: process.cwd(), model: "gpt-test", prompt: "missing reference", imageCount: 1, timeoutMs: 60_000, launchServer: messageOnlyServer }),
  (error) => error.code === "OPENAI_IMAGE_INCOMPLETE_RESULT" && /请求缺少参考图/u.test(error.message),
);

const turnOnlyServer = async () => {
  const server = await fakeServer();
  const originalWrite = server.child.stdin._write.bind(server.child.stdin);
  server.child.stdin._write = (chunk, encoding, done) => {
    const source = chunk.toString("utf8");
    if (!source.includes('"method":"turn/start"')) return originalWrite(chunk, encoding, done);
    const request = JSON.parse(source.trim());
    server.child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-without-image-tool" } } })}\n`);
    queueMicrotask(() => {
      server.child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-without-image-tool", status: "completed" } } })}\n`);
    });
    done();
  };
  return server;
};

await assert.rejects(
  runCodexImageAppServer({ cwd: process.cwd(), model: "gpt-test", prompt: "generate one image", imageCount: 1, timeoutMs: 60_000, launchServer: turnOnlyServer }),
  (error) => error.code === "OPENAI_IMAGE_TOOL_NOT_INVOKED" && /未提交生图任务/u.test(error.message),
);

const retiredBuiltIns = normalizeGenerationProfiles({
  activeImageConnectionId: "image-openai-cli",
  imageConnections: [
    { id: "image-default", adapter: "cli", provider: "OpenAI", protocol: "images", baseUrl: "https://api.openai.com/v1", model: "gpt-image-2", timeoutMs: "660000", cliPath: "shensi-openai-image", cliArgs: "--same", remarkName: "" },
    { id: "image-openai-cli", adapter: "cli", provider: "OpenAI", protocol: "images", baseUrl: "https://api.openai.com/v1", model: "gpt-image-2", timeoutMs: "660000", cliPath: "shensi-openai-image", cliArgs: "--same", remarkName: "" },
  ],
}, { image: { "image-cockpit-aggregate-api": "aggregate-test-key" } });
assert.equal(retiredBuiltIns.imageConnections.filter((profile) => ["image-default", "image-openai-cli"].includes(profile.id)).length, 0);
assert.equal(retiredBuiltIns.activeImageConnectionId, "image-cockpit-aggregate-api");

const distinctRemarks = normalizeGenerationProfiles({
  imageConnections: [
    { id: "image-a", adapter: "cli", provider: "OpenAI", protocol: "images", baseUrl: "https://api.openai.com/v1", model: "gpt-image-2", timeoutMs: "660000", cliPath: "shensi-openai-image", cliArgs: "--same", remarkName: "麻雀" },
    { id: "image-b", adapter: "cli", provider: "OpenAI", protocol: "images", baseUrl: "https://api.openai.com/v1", model: "gpt-image-2", timeoutMs: "660000", cliPath: "shensi-openai-image", cliArgs: "--same", remarkName: "蒲鹰" },
  ],
});
assert.equal(distinctRemarks.imageConnections.filter((profile) => profile.cliPath === "shensi-openai-image").length, 2);

const namedBuiltInAliasesAreStillRetired = normalizeGenerationProfiles({
  activeImageConnectionId: "image-default",
  imageConnections: [
    { id: "image-default", adapter: "cli", provider: "OpenAI", protocol: "images", baseUrl: "https://api.openai.com/v1", model: "gpt-image-2", timeoutMs: "660000", cliPath: "shensi-openai-image", cliArgs: "--same", remarkName: "麻雀" },
    { id: "image-openai-cli", adapter: "cli", provider: "OpenAI", protocol: "images", baseUrl: "https://api.openai.com/v1", model: "gpt-image-2", timeoutMs: "660000", cliPath: "shensi-openai-image", cliArgs: "--same", remarkName: "" },
  ],
}, { image: { "image-cockpit-aggregate-api": "aggregate-test-key" } });
assert.equal(namedBuiltInAliasesAreStillRetired.imageConnections.filter((profile) => ["image-default", "image-openai-cli"].includes(profile.id)).length, 0);
assert.equal(namedBuiltInAliasesAreStillRetired.activeImageConnectionId, "image-cockpit-aggregate-api");

console.log("Shensi v2.5.1 GPT Image app-server tests passed");
