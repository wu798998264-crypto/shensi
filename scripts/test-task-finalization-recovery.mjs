import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  terminalGenerationAttempt,
  waitForGenerationAttemptTerminal,
} from "../src/generation-attempt-client.js";

const inactiveRunningAttempt = {
  active: false,
  attempt: {
    requestId: "run-inactive-123",
    status: "running",
    executionStatus: "running",
    candidate: "已安全保存的正文候选",
    execution: { result: "生成候选后连接中断" },
  },
};

const inactive = terminalGenerationAttempt(inactiveRunningAttempt);
assert.equal(inactive?.ok, false, "服务端已无活动任务时，旧 running 记录必须收口，不能无限轮询");
assert.equal(inactive?.inactive, true);

let requests = 0;
const recoveredInactive = await waitForGenerationAttemptTerminal({
  requestId: "run-inactive-123",
  intervalMs: 1,
  fetchAttempt: async () => {
    requests += 1;
    return {
      ok: true,
      json: async () => inactiveRunningAttempt,
    };
  },
});
assert.equal(recoveredInactive.inactive, true);
assert.equal(requests, 1, "失去后台所有权的任务必须在一次核对后结束等待");

const terminalPayload = {
  active: false,
  attempt: {
    requestId: "run-terminal-123",
    status: "awaiting_action",
    executionStatus: "terminal",
    resultData: { payload: { ok: true, text: "正式正文", execution: { status: "ready_to_land" } } },
  },
};
const terminal = terminalGenerationAttempt(terminalPayload);
assert.equal(terminal?.ok, true);
assert.equal(terminal?.payload?.text, "正式正文");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /signal:\s*AbortSignal\.timeout\(90_000\)/u, "工作区落盘必须有有界等待");
const autoLandingSource = appSource.slice(appSource.indexOf("const autoLandCodexAgentCandidate"), appSource.indexOf("const monitorNativeConversation"));
assert.match(autoLandingSource, /pending\.landingStatus\s*=\s*"saving"/u, "模型结束后必须进入真实落盘阶段");
assert.match(autoLandingSource, /pending\.execution\s*=\s*\{[\s\S]{0,12000}landingStatus:/u, "真实落盘结果必须回写到任务终态");
assert.match(appSource, /seconds > 20[\s\S]{0,500}scheduleStaleTextGenerationReconciliation/u, "心跳失联必须自动触发后台终态核对");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /code:\s*"RUN_NOT_ACTIVE"/u, "补充接口必须返回可机读的任务终态代码");
assert.doesNotMatch(serverSource, /await recoverLegacyReplacementTransactions\(\);/u, "旧媒体任务锁不得阻塞主窗口启动");
assert.match(serverSource, /void recoverLegacyReplacementTransactions\(\)[\s\S]{0,500}startupDeferred:\s*true/u, "启动恢复应转为可观测的后台重试");

console.log("Task finalization recovery checks passed.");
