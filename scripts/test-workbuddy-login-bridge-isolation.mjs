import assert from "node:assert/strict";
import { verifyKnownAgentRunnerLogin } from "../src/server/agent-runner-installer.mjs";

const desktopLaunch = {
  executable: "C:\\WorkBuddy\\node.exe",
  prefixArgs: ["C:\\CustomInstall\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy"],
  installSource: "workbuddy_desktop",
};

let bundledCliCalls = 0;
const unavailable = await verifyKnownAgentRunnerLogin({
  runnerId: "workbuddy",
  resolveLaunch: async () => desktopLaunch,
  inspectBridge: async () => ({ authenticated: null, state: "bridge_unavailable", message: "sidecar is starting" }),
  runProcess: async () => { bundledCliCalls += 1; return { stdout: "not logged in", stderr: "" }; },
});
assert.equal(unavailable.authenticated, null, "桌面桥接暂不可用不能误报登录失效");
assert.equal(unavailable.state, "bridge_unavailable");
assert.equal(bundledCliCalls, 0, "桌面桥接不可用时不得绕过桌面凭据执行捆绑 CLI 登录探针");

const loggedOut = await verifyKnownAgentRunnerLogin({
  runnerId: "workbuddy",
  resolveLaunch: async () => desktopLaunch,
  inspectBridge: async () => ({ authenticated: false, state: "auth_required", message: "401" }),
  runProcess: async () => { bundledCliCalls += 1; return { stdout: "SHENSI_LOGIN_PROBE_OK", stderr: "" }; },
});
assert.equal(loggedOut.authenticated, false, "只有 ACP 明确鉴权失败才允许要求重新登录");
assert.equal(loggedOut.state, "login_required");
assert.equal(bundledCliCalls, 0, "明确 ACP 鉴权失败也不得用另一凭据上下文覆盖结果");

let desktopProbeCalls = 0;
const authenticated = await verifyKnownAgentRunnerLogin({
  runnerId: "workbuddy",
  resolveLaunch: async () => desktopLaunch,
  inspectBridge: async () => ({ authenticated: true, state: "ready", models: ["hy3"], modelLabels: { hy3: "Hy3" } }),
  runDesktopBridge: async () => { desktopProbeCalls += 1; return { text: "SHENSI_LOGIN_PROBE_OK" }; },
  runProcess: async () => { bundledCliCalls += 1; return { stdout: "", stderr: "" }; },
});
assert.equal(authenticated.authenticated, true);
assert.equal(authenticated.state, "ready");
assert.deepEqual(authenticated.models, ["hy3"]);
assert.equal(desktopProbeCalls, 1, "桌面登录验证必须走同一 ACP 会话");
assert.equal(bundledCliCalls, 0, "已连接桌面 ACP 时不得回退到捆绑 CLI");

const bridgeFailure = await verifyKnownAgentRunnerLogin({
  runnerId: "workbuddy",
  resolveLaunch: async () => desktopLaunch,
  inspectBridge: async () => ({ authenticated: true, state: "ready" }),
  runDesktopBridge: async () => { throw Object.assign(new Error("sidecar lost"), { code: "WORKBUDDY_DESKTOP_BRIDGE_UNAVAILABLE" }); },
  runProcess: async () => { bundledCliCalls += 1; return { stdout: "not logged in", stderr: "" }; },
});
assert.equal(bridgeFailure.authenticated, null, "ACP 中断不是登录失效");
assert.equal(bridgeFailure.state, "bridge_unavailable");
assert.equal(bundledCliCalls, 0, "ACP 中断不得触发跨上下文 CLI 登录探针");

let headlessCliCalls = 0;
const headless = await verifyKnownAgentRunnerLogin({
  runnerId: "workbuddy",
  resolveLaunch: async () => ({ executable: "C:\\npm\\codebuddy.exe", prefixArgs: [], installSource: "npm" }),
  inspectBridge: async () => ({ authenticated: null, state: "bridge_unavailable" }),
  runProcess: async () => { headlessCliCalls += 1; return { stdout: "SHENSI_LOGIN_PROBE_OK", stderr: "" }; },
});
assert.equal(headless.authenticated, true, "独立 CLI 仍应保留原有登录探针");
assert.equal(headlessCliCalls, 1);

console.log("WorkBuddy desktop bridge login isolation contract passed");
