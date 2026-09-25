import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createEffectiveAgentTimeout } from "../src/server/effective-agent-timeout.mjs";
import { runExternalCliAgent } from "../src/server/external-cli-agent-runner.mjs";

let waiting = true;
let timedOut = false;
const guard = createEffectiveAgentTimeout({
  timeoutMs: 100,
  minimumMs: 50,
  maxPauseMs: 500,
  maxWallClockMs: 900,
  isWaitingForUser: () => waiting,
  onTimeout: () => { timedOut = true; },
  tickMs: 10,
});
await new Promise((resolve) => setTimeout(resolve, 180));
assert.equal(timedOut, false, "等待用户期间不能消耗有效执行预算");
waiting = false;
guard.clear();

const child = new EventEmitter();
child.stdout = new PassThrough();
child.stderr = new PassThrough();
child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
child.kill = () => { child.emit("close", 1); };
let runnerWaiting = true;
const promise = runExternalCliAgent({
  engine: "custom",
  prompt: "等待一个用户选择后继续",
  cwd: process.cwd(),
  cliPath: "fake-agent",
  cliArgs: "run --prompt-file {promptFile}",
  nativeHost: { url: "http://127.0.0.1:43123/mcp", headers: {} },
  timeoutMs: 100,
  isWaitingForUser: () => runnerWaiting,
  spawnProcess: () => {
    setTimeout(() => { runnerWaiting = false; }, 180);
    setTimeout(() => {
      child.stdout.write(`${JSON.stringify({ type: "message", delta: "等待后继续完成" })}\n`);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 0);
    }, 240);
    return child;
  },
});
const result = await promise;
assert.equal(result.text, "等待后继续完成");

console.log("effective agent timeout: ok");
