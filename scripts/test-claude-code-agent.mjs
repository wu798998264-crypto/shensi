import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { join } from "node:path";

import { claudeCodeCommandArgs, parseClaudeCodeJsonResult, resolveLocalClaudeCodeLaunch } from "../src/cli/claude-code-launch.mjs";
import { runClaudeCodeAgentTurn } from "../src/server/claude-code-agent-runner.mjs";
import { executionModeCapabilities } from "../src/model-execution-capabilities.js";
import { generationProfileLabel, normalizeGenerationProfiles } from "../src/generation-profiles.js";

assert.deepEqual(
  claudeCodeCommandArgs({ model: "claude-sonnet-5", prompt: "只回复 OK", maxTurns: 2 }),
  ["-p", "只回复 OK", "--output-format", "json", "--model", "claude-sonnet-5", "--max-turns", "2", "--permission-mode", "default"],
  "Claude Code 必须使用参数数组而不是拼接 shell 命令",
);
assert.deepEqual(parseClaudeCodeJsonResult(JSON.stringify({ result: "OK", session_id: "session-1" })), {
  text: "OK",
  sessionId: "session-1",
});

let launched = null;
const result = await runClaudeCodeAgentTurn({
  prompt: "只回复 OK",
  model: "claude-sonnet-5",
  cwd: process.cwd(),
  launch: async (command, args, options) => {
    launched = { command, args, options };
    return { exitCode: 0, stdout: JSON.stringify({ result: "OK", session_id: "session-1" }), stderr: "" };
  },
});
assert.equal(launched.command, "claude");
assert.equal(launched.options.shell, false);
assert.equal(launched.args[launched.args.indexOf("--permission-mode") + 1], "dontAsk");
assert.equal(launched.args[launched.args.indexOf("--setting-sources") + 1], "", "仅限神思必须隔离用户、项目和本地设置");
assert.equal(launched.args.includes("--safe-mode"), false, "safe-mode 会连同显式神思 MCP 一起禁用");
assert.ok(launched.args.includes("--disable-slash-commands"), "仅限神思必须禁用环境 Skill");
assert.equal(result.text, "OK");
assert.equal(result.sessionId, "session-1");
assert.equal(result.permissionMode, "shensi_only");

let approvalLaunch;
const approvalResult = await runClaudeCodeAgentTurn({
  prompt: "只回复 APPROVAL_OK",
  model: "claude-sonnet-5",
  cwd: process.cwd(),
  agentPermissionMode: "approval_required",
  requestApproval: async () => ({ answer: "deny" }),
  launch: async (command, args, options) => {
    approvalLaunch = { command, args, options };
    return { exitCode: 0, stdout: JSON.stringify({ result: "APPROVAL_OK", session_id: "approval-session" }), stderr: "" };
  },
});
assert.equal(approvalLaunch.args[approvalLaunch.args.indexOf("--permission-mode") + 1], "default", "操作需确认必须使用 Claude Code 支持的默认审批模式");
assert.equal(approvalLaunch.args[approvalLaunch.args.indexOf("--permission-prompt-tool") + 1], "mcp__shensi__permission_prompt");
assert.equal(approvalLaunch.args.includes("--setting-sources"), false, "操作需确认必须保留运行器环境能力");
assert.equal(approvalLaunch.args.includes("--allowedTools"), false, "操作需确认不得自动放行神思写入工具");
assert.equal(approvalResult.permissionMode, "approval_required");

let fullAccessLaunch;
const fullAccessResult = await runClaudeCodeAgentTurn({
  prompt: "只回复 FULL_OK",
  model: "claude-sonnet-5",
  cwd: process.cwd(),
  agentPermissionMode: "full_access",
  launch: async (command, args, options) => {
    fullAccessLaunch = { command, args, options };
    return { exitCode: 0, stdout: JSON.stringify({ result: "FULL_OK", session_id: "full-session" }), stderr: "" };
  },
});
assert.equal(fullAccessLaunch.args[fullAccessLaunch.args.indexOf("--permission-mode") + 1], "bypassPermissions");
assert.ok(fullAccessLaunch.args.includes("--dangerously-skip-permissions"));
assert.equal(fullAccessLaunch.args.includes("--allowedTools"), false, "完全权限不需要额外自动放行名单");
assert.equal(fullAccessResult.permissionMode, "full_access");

const managed = await runClaudeCodeAgentTurn({
  prompt: "只回复 SHENSI_CLAUDE_DEEPSEEK_OK",
  model: "deepseek-v4-pro[1m]",
  provider: "DeepSeek",
  baseUrl: "https://api.deepseek.com/anthropic",
  apiKey: "test-only-deepseek-secret",
  credentialSource: "shensi",
  cwd: process.cwd(),
  launch: async (command, args, options) => {
    assert.equal(command, "claude");
    assert.equal(args.includes("test-only-deepseek-secret"), false, "安全凭据不得进入命令参数");
    assert.equal(options.environment.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(options.environment.ANTHROPIC_AUTH_TOKEN, "test-only-deepseek-secret");
    assert.equal(options.environment.ANTHROPIC_MODEL, "deepseek-v4-pro[1m]");
    assert.equal(options.environment.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-v4-pro[1m]");
    return { exitCode: 0, stdout: JSON.stringify({ result: "SHENSI_CLAUDE_DEEPSEEK_OK", session_id: "deepseek-session" }), stderr: "" };
  },
});
assert.equal(managed.actualProvider, "deepseek");
assert.equal(managed.actualModel, "deepseek-v4-pro[1m]");

const homeDirectory = "C:\\Users\\Tester";
const npmNative = join(homeDirectory, "AppData", "Roaming", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
assert.deepEqual(await resolveLocalClaudeCodeLaunch({
  platform: "win32",
  homeDirectory,
  environment: { PATH: "" },
  accessFile: async (candidate) => {
    if (candidate === npmNative) return;
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
}), { executable: npmNative, prefixArgs: [] }, "Windows 必须识别 npm 安装的 Claude Code 原生可执行文件");

assert.deepEqual(executionModeCapabilities({
  adapter: "cli",
  provider: "DeepSeek",
  agentEngine: "claude_code",
  credentialSource: "shensi",
  protocol: "anthropic_messages",
  baseUrl: "https://api.deepseek.com/anthropic",
}).modes, ["agent"], "Claude Code+DeepSeek 安全凭据配置统一使用 Agent 处理器");
assert.equal(generationProfileLabel({ agentEngine: "claude_code", provider: "DeepSeek", adapter: "cli" }, "text"), "Claude Code+DeepSeek");

const normalizedComposite = normalizeGenerationProfiles({
  textConnections: [{
    id: "text-claude-code-deepseek",
    name: "Claude Code+DeepSeek",
    provider: "DeepSeek",
    adapter: "cli",
    protocol: "anthropic_messages",
    executionMode: "both",
    executionModes: ["chat", "agent"],
    agentEngine: "claude_code",
    model: "deepseek-v4-pro",
    credentialSource: "shensi",
    baseUrl: "https://api.deepseek.com/anthropic",
    cliPath: "claude",
  }],
  activeTextConnectionId: "text-claude-code-deepseek",
});
const normalizedCompositeProfile = normalizedComposite.textConnections.find((profile) => profile.id === "text-claude-code-deepseek");
assert.equal(normalizedCompositeProfile.agentEngine, "claude_code", "新式 Claude Code+DeepSeek 配置不得被旧 DeepSeek OpenCode 迁移覆盖");
assert.deepEqual(normalizedCompositeProfile.executionModes, ["agent"]);

const [appSource, serverSource, providerSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/codex-agent-provider.mjs", import.meta.url), "utf8"),
]);
assert.match(appSource, /<option value="claude_code">Claude Code<\/option>/u);
assert.match(appSource, /Claude Code\+\$\{preset\.label \|\| providerId\}/u);
assert.match(serverSource, /executionRuntime: "claude_code_agent"/u);
assert.match(serverSource, /provider:\s*claudeCodeSettings\.provider/u);
assert.match(providerSource, /detectClaudeCodeInstallation/u);

console.log("Claude Code Agent runner tests passed");
