import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { acpAuthFailure, isDesktopOwnedGateway } from "../src/server/workbuddy-desktop-bridge.mjs";

const source = await readFile(new URL("../src/server/workbuddy-desktop-bridge.mjs", import.meta.url), "utf8");
assert.match(source, /codebuddy\.\*--serve/u, "必须发现 WorkBuddy 桌面认证网关");
assert.match(source, /Get-NetTCPConnection -State Listen/u, "网关端口必须按进程动态发现");
assert.match(source, /gateway:\s*true/u, "桌面网关候选必须带有明确来源标记");
assert.match(source, /ParentChain/u, "网关候选必须记录父进程链");
assert.match(source, /--session-id/u, "桌面网关候选必须带会话 ID");
assert.match(source, /!candidate\.gateway && !candidate\.modern/u, "官方 sidecar 必须优先于现代网关候选");
assert.match(source, /isDesktopOwnedGateway\(candidate\)/u, "只能选择桌面宿主创建的 ACP 网关");
assert.match(source, /acpAuthFailure\(result\)/u, "ACP 生命周期错误必须经过统一鉴权分类");

assert.equal(isDesktopOwnedGateway({
  gateway: true,
  desktopOwned: true,
  processName: "WorkBuddy.exe",
}), true, "官方 WorkBuddy 会话网关应当可用");
assert.equal(isDesktopOwnedGateway({
  gateway: true,
  desktopOwned: false,
  processName: "node.exe",
}), false, "裸 node/codebuddy 网关不得冒充桌面登录态");
assert.equal(isDesktopOwnedGateway({
  gateway: true,
  desktopOwned: true,
  processName: "workbuddy-helper.exe",
}), false, "非 WorkBuddy 主进程不得作为桌面网关");

const auth = acpAuthFailure({
  error: {
    code: -32000,
    message: "Authentication required",
    data: { category: "auth" },
  },
});
assert.equal(auth?.code, "WORKBUDDY_AUTH_REQUIRED");
assert.match(auth?.message || "", /未登录/u);

const nestedAuth = acpAuthFailure({
  result: {
    _meta: {
      "codebuddy.ai/errorMessage": JSON.stringify({ message: "Authentication required. Please use /login command" }),
    },
  },
});
assert.equal(nestedAuth?.code, "WORKBUDDY_AUTH_REQUIRED");

assert.equal(acpAuthFailure({ result: { status: "completed" } }), null, "正常完成不得误报鉴权失败");
console.log("WorkBuddy modern gateway and auth classification contract passed");
