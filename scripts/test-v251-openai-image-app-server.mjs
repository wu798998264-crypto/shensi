import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { decodeCodexImageItem, decodeCodexImageResult, runCodexImageAppServer } from "../src/cli/codex-image-app-server.mjs";
import { resolveLocalCodexLaunch } from "../src/cli/codex-launch.mjs";
import { generateImageWithAdapter, parseStructuredCliError } from "../src/server/adapters.mjs";
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
  await assert.rejects(
    decodeCodexImageItem({ type: "imageGeneration", status: "completed", result: "generated", savedPath: join(savedImageRoot, "missing-result.png") }),
    (error) => error.code === "OPENAI_IMAGE_INVALID_RESULT",
    "CLI 报告完成但结果文件不存在时不得验收成功",
  );
} finally {
  await rm(savedImageRoot, { recursive: true, force: true });
}

const structuredError = parseStructuredCliError(`真实错误\nSHENSI_MEDIA_ERROR_JSON:${Buffer.from(JSON.stringify({ code: "OPENAI_IMAGE_INVALID_RESULT", providerErrorCode: "OPENAI_IMAGE_INVALID_RESULT", submissionOutcomeKnown: true, message: "真实错误" }), "utf8").toString("base64url")}`);
assert.equal(structuredError.code, "OPENAI_IMAGE_INVALID_RESULT");
assert.equal(structuredError.submissionOutcomeKnown, true);
assert.equal(structuredError.structuredMessage, "真实错误");

// OpenAI CLI capability probes must not inherit Dreamina account identity
// requirements.  The CLI's own --check receipt has no dreaminaCliProfile.
const adaptersSource = await readFile(new URL("../src/server/adapters.mjs", import.meta.url), "utf8");
const openAiProbeStart = adaptersSource.indexOf('settings.imageChannel === true && settings.cliPath === OPENAI_IMAGE_CLI_ALIAS');
const dreaminaProbeStart = adaptersSource.indexOf('settings.imageChannel === true && settings.cliPath === DREAMINA_IMAGE_CLI_ALIAS');
assert.ok(openAiProbeStart >= 0 && dreaminaProbeStart > openAiProbeStart, "OpenAI/即梦探测分支必须存在且有明确边界");
const openAiProbe = adaptersSource.slice(openAiProbeStart, dreaminaProbeStart);
assert.doesNotMatch(openAiProbe, /dreaminaCliProfile|DREAMINA_PROFILE_(?:REQUIRED|ID_MISMATCH)/u, "OpenAI CLI 探测不得要求即梦配置 ID");
assert.match(openAiProbe, /payload\.sessionChecked/u, "OpenAI CLI 探测必须使用自身 --check 回执");

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
        else if (request.method === "thread/start") {
          observedThreadParams = request.params;
          reply({ id: request.id, result: { thread: { id: "thread-image-test" } } });
        }
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
let observedThreadParams = {};
const results = await runCodexImageAppServer({
  cwd: process.cwd(),
  model: "gpt-test",
  prompt: "generate one image",
  imageCount: 1,
  referenceImages: [join(process.cwd(), "reference.jpg")],
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
assert.deepEqual(observedTurnInput[2], { type: "localImage", path: join(process.cwd(), "reference.jpg"), detail: "original" }, "参考图必须作为真实图像输入，而不是只传路径文字");
assert.equal(observedThreadParams.ephemeral, false, "图片线程必须保留，才能在超时后诊断和找回");

const notificationServer = (notifications) => async () => {
  const server = await fakeServer();
  const originalWrite = server.child.stdin._write.bind(server.child.stdin);
  server.child.stdin._write = (chunk, encoding, done) => {
    const source = chunk.toString("utf8");
    if (!source.includes('"method":"turn/start"')) return originalWrite(chunk, encoding, done);
    const request = JSON.parse(source.trim());
    server.child.stdout.write(`${JSON.stringify({ id: request.id, result: { turn: { id: "turn-failure-test" } } })}\n`);
    queueMicrotask(() => {
      for (const message of notifications) server.child.stdout.write(`${JSON.stringify(message)}\n`);
    });
    done();
  };
  return server;
};
const runNotifications = (notifications) => runCodexImageAppServer({
  cwd: process.cwd(), model: "gpt-test", prompt: "test only", timeoutMs: 60_000,
  resolveImagegenSkill: async () => "mock-skill",
  launchServer: notificationServer(notifications),
});
await assert.rejects(runNotifications([
  { method: "error", params: { willRetry: false, error: { message: "Invalid image request", additionalDetails: "reference invalid", codexErrorInfo: "badRequest" } } },
]), (error) => error.providerErrorCode === "badRequest" && error.submissionOutcomeKnown === true && /reference invalid/u.test(error.message), "官方终止错误必须立即结束，不能等十分钟再进入未知提交循环");
await assert.rejects(runNotifications([
  { method: "turn/completed", params: { turn: { status: "failed", error: { message: "Authentication rejected", codexErrorInfo: "unauthorized" } } } },
]), (error) => error.providerErrorCode === "unauthorized" && /Authentication rejected/u.test(error.message), "终态 turn.error 不得被误报为没有调用工具");
await assert.rejects(runNotifications([
  { method: "item/completed", params: { item: { type: "imageGeneration", status: "failed", result: "", failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: 1_800_000_000 } } } },
]), (error) => error.providerErrorCode === "usageLimitExceeded" && error.submissionOutcomeKnown === true && /额度已耗尽/u.test(error.message), "图片工具的 failure 字段必须保留真实额度原因");
await assert.rejects(runNotifications([
  { method: "item/started", params: { item: { type: "imageGeneration", id: "started-image" } } },
  { method: "error", params: { willRetry: false, error: { message: "connection lost after submission", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } } } },
]), (error) => error.submissionOutcomeKnown === false, "工具启动后断流仍是未知提交，不能自动重投");
const afterRetry = await runNotifications([
  { method: "error", params: { willRetry: true, error: { message: "reconnecting", codexErrorInfo: "serverOverloaded" } } },
  { method: "item/completed", params: { item: { type: "imageGeneration", status: "completed", result: PNG_BASE64 } } },
  { method: "turn/completed", params: { turn: { status: "completed" } } },
]);
assert.equal(afterRetry.length, 1, "可恢复通知不能截断随后成功的图像返回");

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

let unauthenticatedTurnStarts = 0;
const unauthenticatedServer = async () => {
  const server = await fakeServer();
  const originalWrite = server.child.stdin._write.bind(server.child.stdin);
  server.child.stdin._write = (chunk, encoding, done) => {
    const source = chunk.toString("utf8");
    if (source.includes('"method":"turn/start"')) unauthenticatedTurnStarts += 1;
    if (!source.includes('"method":"account/read"')) return originalWrite(chunk, encoding, done);
    const request = JSON.parse(source.trim());
    server.child.stdout.write(`${JSON.stringify({ id: request.id, result: { account: null } })}\n`);
    done();
  };
  return server;
};
await assert.rejects(
  runCodexImageAppServer({ cwd: process.cwd(), model: "gpt-test", prompt: "未登录禁止生成", imageCount: 1, timeoutMs: 60_000, launchServer: unauthenticatedServer }),
  (error) => error.code === "MISSING_CREDENTIALS",
  "未登录必须返回真实凭证错误",
);
assert.equal(unauthenticatedTurnStarts, 0, "未登录不得调用收费生成");

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

// A successful CLI exit without an output file is not a successful image
// generation.  Keep this local: it exercises the exact parser boundary
// without invoking the OpenAI CLI or spending credits.
const cliNoResultRoot = await mkdtemp(join(tmpdir(), "shensi-gpt-image-no-result-"));
try {
  await assert.rejects(
    generateImageWithAdapter({
      settings: {
        provider: "OpenAI",
        adapter: "cli",
        protocol: "images",
        model: "gpt-image-2.5",
        cliPath: process.execPath,
        cliArgs: '-e "process.exit(0)"',
        workspacePath: cliNoResultRoot,
      },
      prompt: "本地夹具：CLI 不产生结果文件",
      aspectRatio: "1:1",
      quality: "standard",
      imageCount: 1,
    }),
    (error) => /媒体 CLI 未输出可读取的文件/u.test(String(error?.message || "")),
    "CLI 退出成功但没有结果文件时必须明确失败，不能伪造生成成功",
  );
} finally {
  await rm(cliNoResultRoot, { recursive: true, force: true });
}

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

await import("./test-openai-image-terminal-recovery.mjs");
console.log("Shensi v2.5.1 GPT Image app-server and no-result-file tests passed");
