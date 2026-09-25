import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import {
  expandCliArgs,
  parseExternalCliOutput,
  runExternalCliAgent,
  tokenizeCliArgs,
} from "../src/server/external-cli-agent-runner.mjs";

assert.deepEqual(tokenizeCliArgs('exec --model "provider/model name" --flag \'value with spaces\''), [
  "exec", "--model", "provider/model name", "--flag", "value with spaces",
]);
assert.deepEqual(expandCliArgs("exec --model {model} --prompt-file {promptFile} --workspace {workspace}", {
  model: "",
  promptFile: "C:\\temp\\prompt.md",
  workspace: "C:\\temp\\workspace",
}), ["exec", "--prompt-file", "C:\\temp\\prompt.md", "--workspace", "C:\\temp\\workspace"]);

const parsed = parseExternalCliOutput([
  JSON.stringify({ type: "message", delta: "你好" }),
  JSON.stringify({ type: "message", delta: "，世界" }),
  JSON.stringify({ type: "result", text: "你好，世界" }),
].join("\n"));
assert.equal(parsed.text, "你好，世界");

const events = [];
const child = new EventEmitter();
child.stdout = new PassThrough();
child.stderr = new PassThrough();
child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
child.kill = () => { child.emit("close", 1); };
const resultPromise = runExternalCliAgent({
  engine: "custom",
  prompt: "测试外置 Agent",
  cwd: process.cwd(),
  cliPath: "fake-agent",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {} },
  agentPermissionMode: "shensi_only",
  onEvent: (event) => events.push(event),
  spawnProcess: () => {
    process.nextTick(() => {
      child.stdout.write(`${JSON.stringify({ type: "message", delta: "外置 Agent 已响应" })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  },
});
const result = await resultPromise;
assert.equal(result.text, "外置 Agent 已响应");
assert.equal(result.executionRuntime, "custom_agent");
assert.ok(events.some((event) => event.phase === "text_delta"));
assert.ok(events.some((event) => event.phase === "thinking"));

const workBuddyChild = new EventEmitter();
workBuddyChild.stdout = new PassThrough();
workBuddyChild.stderr = new PassThrough();
workBuddyChild.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
workBuddyChild.kill = () => { workBuddyChild.emit("close", 1); };
const routeLeak = JSON.stringify({
  routes: [{ placementId: "route:short-fiction", kind: "group", name: "短篇小说模组" }],
  autoLoadedSkills: [{ placementId: "slot:writer", name: "短篇小说主笔" }],
  selectedPlacement: { placementId: "slot:writer" },
});
const workBuddyResultPromise = runExternalCliAgent({
  engine: "workbuddy",
  prompt: "测试 WorkBuddy 输出边界",
  cwd: process.cwd(),
  cliPath: "fake-workbuddy",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {}, toolNames: [] },
  agentPermissionMode: "shensi_only",
  spawnProcess: () => {
    process.nextTick(() => {
      workBuddyChild.stdout.write(`${JSON.stringify({ type: "message", delta: `${routeLeak}\n这是 WorkBuddy 的正常回答。` })}\n`);
      workBuddyChild.stdout.end();
      workBuddyChild.stderr.end();
      workBuddyChild.emit("close", 0);
    });
    return workBuddyChild;
  },
});
const workBuddyResult = await workBuddyResultPromise;
assert.equal(workBuddyResult.text, "这是 WorkBuddy 的正常回答。", "WorkBuddy 最终结果不得包含内部路由 JSON");

const workBuddyLeakEvents = [];
const workBuddySchemaChild = new EventEmitter();
workBuddySchemaChild.stdout = new PassThrough();
workBuddySchemaChild.stderr = new PassThrough();
workBuddySchemaChild.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
workBuddySchemaChild.kill = () => { workBuddySchemaChild.emit("close", 1); };
const workBuddySchemaResultPromise = runExternalCliAgent({
  engine: "workbuddy",
  prompt: "测试 WorkBuddy 裸 Schema 流式边界",
  cwd: process.cwd(),
  cliPath: "fake-workbuddy",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {}, toolNames: [] },
  agentPermissionMode: "shensi_only",
  onEvent: (event) => workBuddyLeakEvents.push(event),
  spawnProcess: () => {
    process.nextTick(() => {
      workBuddySchemaChild.stdout.write(`${JSON.stringify({ type: "message", delta: "I'll read the document and route first.\n" })}\n`);
      workBuddySchemaChild.stdout.write(`${JSON.stringify({ type: "message", delta: '"type": "object",\n"required": ["mode", "documentIds"],\n' })}\n`);
      workBuddySchemaChild.stdout.write(`${JSON.stringify({ type: "message", delta: '"properties": {"mode": {"type": "string"}},\n"additionalProperties": false\n}\n已按《秤》完成。' })}\n`);
      workBuddySchemaChild.stdout.end();
      workBuddySchemaChild.stderr.end();
      workBuddySchemaChild.emit("close", 0);
    });
    return workBuddySchemaChild;
  },
});
const workBuddySchemaResult = await workBuddySchemaResultPromise;
assert.equal(workBuddySchemaResult.text, "已按《秤》完成。", "WorkBuddy 裸 Schema 的终态正文必须保留");
assert.equal(workBuddyLeakEvents.filter((event) => event.phase === "text_delta").length, 0, "WorkBuddy 内部前言和 Schema 不得在流式事件中泄露");

// WorkBuddy may report a recoverable DeferExecuteTool/MCP error and then
// continue with a valid assistant answer.  The runner must preserve that
// answer so the conversation service can perform its normal delivery checks;
// a single provider-side tool error is not a terminal process failure.
const recoverableErrorChild = new EventEmitter();
recoverableErrorChild.stdout = new PassThrough();
recoverableErrorChild.stderr = new PassThrough();
recoverableErrorChild.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
recoverableErrorChild.kill = () => { recoverableErrorChild.emit("close", 1); };
const recoverableErrorResult = await runExternalCliAgent({
  engine: "workbuddy",
  prompt: "测试 WorkBuddy 可恢复工具错误",
  cwd: process.cwd(),
  cliPath: "fake-workbuddy",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {}, toolNames: [] },
  agentPermissionMode: "shensi_only",
  spawnProcess: () => {
    process.nextTick(() => {
      recoverableErrorChild.stdout.write(`${JSON.stringify({ type: "error", error: { code: "TOOL_FAILED", message: "interaction_delivery 参数校验失败" } })}\n`);
      recoverableErrorChild.stdout.write(`${JSON.stringify({ type: "message", delta: "工具错误已恢复，正文仍然有效。" })}\n`);
      recoverableErrorChild.stdout.end();
      recoverableErrorChild.stderr.end();
      recoverableErrorChild.emit("close", 0);
    });
    return recoverableErrorChild;
  },
});
assert.equal(recoverableErrorResult.text, "工具错误已恢复，正文仍然有效。", "WorkBuddy 可恢复工具错误后必须保留最终正文");

// The same recovery rule applies when a desktop CLI exits non-zero after
// streaming its answer.  The answer is retained as a warning-bearing result;
// only an empty response is a terminal external-runner failure.
const nonZeroAfterTextChild = new EventEmitter();
nonZeroAfterTextChild.stdout = new PassThrough();
nonZeroAfterTextChild.stderr = new PassThrough();
nonZeroAfterTextChild.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
nonZeroAfterTextChild.kill = () => { nonZeroAfterTextChild.emit("close", 1); };
const nonZeroAfterTextResult = await runExternalCliAgent({
  engine: "workbuddy",
  prompt: "测试 WorkBuddy 非零退出码恢复",
  cwd: process.cwd(),
  cliPath: "fake-workbuddy",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {}, toolNames: [] },
  agentPermissionMode: "shensi_only",
  spawnProcess: () => {
    process.nextTick(() => {
      nonZeroAfterTextChild.stdout.write(`${JSON.stringify({ type: "message", delta: "退出前已经完成的正文。" })}\n`);
      nonZeroAfterTextChild.stderr.write("recoverable bridge warning");
      nonZeroAfterTextChild.stdout.end();
      nonZeroAfterTextChild.stderr.end();
      nonZeroAfterTextChild.emit("close", 1);
    });
    return nonZeroAfterTextChild;
  },
});
assert.equal(nonZeroAfterTextResult.text, "退出前已经完成的正文。", "非零退出码但已有正文时必须保留正文");
assert.match(nonZeroAfterTextResult.runnerWarnings?.join("\n") || "", /退出码为 1/u);

const quotaChild = new EventEmitter();
quotaChild.stdout = new PassThrough();
quotaChild.stderr = new PassThrough();
quotaChild.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
quotaChild.kill = () => { quotaChild.emit("close", 1); };
await assert.rejects(runExternalCliAgent({
  engine: "workbuddy",
  prompt: "测试 WorkBuddy 额度终态",
  cwd: process.cwd(),
  cliPath: "fake-workbuddy",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {}, toolNames: [] },
  agentPermissionMode: "shensi_only",
  spawnProcess: () => {
    process.nextTick(() => {
      quotaChild.stdout.write(`${JSON.stringify({ type: "message", delta: "429 额度已用尽，请访问 codebuddy.cn/profile/usage 购买加量包" })}\n`);
      quotaChild.stdout.end();
      quotaChild.stderr.end();
      quotaChild.emit("close", 0);
    });
    return quotaChild;
  },
}), (error) => error?.code === "WORKBUDDY_QUOTA_EXHAUSTED" && /额度已用尽/u.test(error?.message || ""), "退出码 0 的额度错误不得标记为完成");

const ordinary429Child = new EventEmitter();
ordinary429Child.stdout = new PassThrough();
ordinary429Child.stderr = new PassThrough();
ordinary429Child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
ordinary429Child.kill = () => { ordinary429Child.emit("close", 1); };
const ordinary429Result = await runExternalCliAgent({
  engine: "workbuddy",
  prompt: "测试正文中的普通数字",
  cwd: process.cwd(),
  cliPath: "fake-workbuddy",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {}, toolNames: [] },
  agentPermissionMode: "shensi_only",
  spawnProcess: () => {
    process.nextTick(() => {
      ordinary429Child.stdout.write(`${JSON.stringify({ type: "message", delta: "方案共有 429 个样本，正文生成正常。" })}\n`);
      ordinary429Child.stdout.end();
      ordinary429Child.stderr.end();
      ordinary429Child.emit("close", 0);
    });
    return ordinary429Child;
  },
});
assert.equal(ordinary429Result.text, "方案共有 429 个样本，正文生成正常。", "普通正文中的 429 不得误判为厂商错误");

console.log(JSON.stringify({ ok: true, parser: "jsonl", fakeRunner: result.executionRuntime }, null, 2));
