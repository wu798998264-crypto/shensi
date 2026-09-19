import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  AGENT_ENGINE_IDS,
  agentProfilesForEngine,
} from "../src/agent-engine-registry.js";

const appSource = await readFile(resolve("src", "app.js"), "utf8");

for (const id of ["whiteboardTextAgentEngine", "whiteboardTextAgentConnection"]) {
  assert.match(appSource, new RegExp(`id=\\"${id}\\"`), `白板 Agent 选择器必须存在：${id}`);
}
assert.match(appSource, /<input type="hidden" id="whiteboardTextAgentConnection" name="agentConnectionId"/u, "Agent 配置应由系统自动同步，不显示可选下拉框");
assert.match(appSource, /<span>文字配置<\/span>/u, "取消用户可见模式后，白板面板应直接显示统一文字配置选项");
assert.match(appSource, /name="agentEngine"/u, "卡片提交必须携带 Agent 运行器");
assert.match(appSource, /name="agentConnectionId"/u, "卡片提交必须携带 Agent 配置 ID");
assert.match(appSource, /agentEngine:\s*String\(formData\.get\("agentEngine"\)/u, "提交时必须使用卡片选择的运行器");
assert.match(appSource, /agentConnectionId:\s*String\(formData\.get\("agentConnectionId"\)/u, "提交时必须使用卡片选择的配置");
assert.match(appSource, /selectedAgentEngine\s*=\s*AGENT_ENGINE_IDS\.includes\(textRequestSettings\?\.agentEngine\)/u, "运行器可用性校验必须针对卡片所选运行器");
assert.match(appSource, /activeTextAgentConnectionId:\s*profile\.id/u, "Agent 请求必须锁定卡片所选配置 ID");
assert.match(appSource, /elements\.whiteboardTextAgentEngine\.addEventListener\("change"/u, "Agent 配置变化必须刷新卡片配置");
assert.doesNotMatch(appSource, /elements\.whiteboardTextAgentConnection\.addEventListener\("change"/u, "隐藏的 Agent 配置字段不应提供独立选择事件");

const profiles = [
  { id: "codex", provider: "OpenAI", adapter: "cli", agentEngine: "codex", executionModes: ["agent"] },
  { id: "deepseek", provider: "DeepSeek", adapter: "cli", agentEngine: "deepseek_opencode", executionModes: ["agent"] },
  { id: "opencode-deepseek", provider: "DeepSeek", adapter: "cli", agentEngine: "opencode", executionModes: ["agent"] },
];
assert.deepEqual(agentProfilesForEngine(profiles, "deepseek_opencode").map((profile) => profile.id), ["deepseek"]);
assert.deepEqual(agentProfilesForEngine(profiles, "opencode").map((profile) => profile.id), ["opencode-deepseek"]);
assert.deepEqual(AGENT_ENGINE_IDS, ["codex", "codex_api", "deepseek_opencode", "opencode", "claude_code", "workbuddy", "custom"]);

console.log("Whiteboard Agent runtime picker contract tests passed");
