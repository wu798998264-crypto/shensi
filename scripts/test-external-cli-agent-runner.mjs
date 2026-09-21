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

console.log(JSON.stringify({ ok: true, parser: "jsonl", fakeRunner: result.executionRuntime }, null, 2));
