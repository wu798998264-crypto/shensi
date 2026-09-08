import assert from "node:assert/strict";
import { executionModeOptionState, executionModeCapabilities, modeValueForCapabilities } from "../src/model-execution-capabilities.js";

// Text connections no longer expose a separately selectable Chat surface.  The
// capability probe is intentionally independent of provider/adapter details so
// stale legacy executionModes values cannot re-enable the old UI path.
const profiles = [
  { adapter: "api", provider: "OpenAI" },
  { adapter: "api", provider: "OpenAI", protocol: "responses", agentEngine: "codex_api" },
  { adapter: "api", provider: "自定义兼容接口", protocol: "responses", agentEngine: "codex_api" },
  { adapter: "api", provider: "DeepSeek", protocol: "responses", agentEngine: "codex_api" },
  { adapter: "cli", provider: "OpenAI", agentEngine: "codex" },
  { adapter: "cli", provider: "Claude", agentEngine: "claude_code", credentialSource: "claude" },
  { adapter: "cli", provider: "Claude", agentEngine: "claude_code", credentialSource: "shensi", protocol: "messages", baseUrl: "https://api.anthropic.com" },
  { adapter: "cli", provider: "自定义兼容接口", agentEngine: "opencode" },
  {
    adapter: "cli",
    provider: "DeepSeek",
    agentEngine: "opencode",
    credentialSource: "shensi",
    protocol: "chat_completions",
    baseUrl: "https://api.deepseek.com/v1",
  },
  {
    adapter: "cli",
    provider: "OpenAI",
    agentEngine: "opencode",
    credentialSource: "opencode",
  },
];

for (const profile of profiles) {
  const capability = executionModeCapabilities(profile);
  assert.deepEqual(capability.modes, ["agent"]);
  assert.equal(capability.source, "unified_agent_runtime");
}

const optionState = executionModeOptionState({
  adapter: "api",
  provider: "自定义兼容接口",
  agentEngine: "codex_api",
  executionModes: ["chat", "agent"],
});
assert.deepEqual(optionState.modes, ["agent"]);
assert.equal(optionState.source, "unified_agent_runtime");
assert.equal(optionState.options.chat.enabled, false, "Chat 不得重新成为用户可选模式");
assert.match(optionState.options.chat.reason, /统一由 Agent/u);
assert.equal(optionState.options.agent.enabled, true);
assert.equal(optionState.options.both.enabled, false);
assert.match(optionState.options.both.reason, /不再提供独立 Chat/u);

// Any legacy request value is normalized to the single Agent execution path.
for (const requested of ["", "chat", "both", "agent", "unknown"]) {
  assert.equal(modeValueForCapabilities(requested, optionState), "agent");
}
assert.deepEqual(
  executionModeCapabilities({ adapter: "api", provider: "OpenAI", executionModes: ["chat", "agent"] }, { existing: true }).modes,
  ["agent"],
  "旧配置中的 Chat/both 标记只能作为兼容数据，不能恢复双模式能力",
);
console.log("Execution mode capability matrix tests passed");
