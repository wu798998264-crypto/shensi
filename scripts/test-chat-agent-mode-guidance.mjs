import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  chatAgentGuidance,
  chatAgentGuidanceKey,
  chatAgentModeAvailability,
} from "../src/chat-agent-mode-guidance.js";

const bothProfile = {
  id: "text-default",
  provider: "OpenAI",
  adapter: "cli",
  agentEngine: "codex",
  executionMode: "both",
  executionModes: ["chat", "agent"],
};
const apiProfile = {
  id: "deepseek-api",
  provider: "DeepSeek",
  adapter: "api",
  executionMode: "chat",
  executionModes: ["chat"],
};

for (const prompt of [
  "请修改这三个源码文件并运行定向测试验证",
  "执行 npm 脚本，构建安装包并完成覆盖安装",
  "调用 MCP 和外部应用，检查磁盘日志后持续等待任务完成",
]) {
  const result = chatAgentGuidance(prompt);
  assert.equal(result.recommended, true, prompt);
  assert.match(result.message, /请选择可用的 Agent 配置/u);
}

for (const prompt of [
  "解释一下这个人物为什么犹豫",
  "续写当前章节的下一段",
  "为当前文档起一个标题",
  "把这一段改得更克制一些",
  "讨论这个结局是否合理",
]) {
  assert.equal(chatAgentGuidance(prompt).recommended, false, prompt);
}

assert.deepEqual(chatAgentModeAvailability(bothProfile), { chat: false, agent: true, sameConnection: false });
assert.deepEqual(chatAgentModeAvailability(apiProfile), { chat: false, agent: true, sameConnection: false });
assert.equal(chatAgentGuidanceKey("  运行测试\n并打包  "), chatAgentGuidanceKey("运行测试 并打包"));
assert.notEqual(chatAgentGuidanceKey("运行测试"), chatAgentGuidanceKey("普通问答"));

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(appSource, /chatAgentGuidance\(content\)/u, "统一 Agent 入口启用后不得再用关键词弹出模式引导");
assert.doesNotMatch(appSource, /ui\.pendingChatAgentGuidance = \{[\s\S]{0,500}renderMessages/u);
assert.match(appSource, /id="chatProviderSelect" hidden aria-hidden="true"[^>]*><option value="codex_agent" selected>/u, "用户界面只能保留隐藏的旧字段兼容值");
assert.match(appSource, /<header><strong>模型与运行器<\/strong>/u);
assert.match(appSource, /const executionSurface = "agent";/u);
assert.doesNotMatch(appSource, /action === "chat"[\s\S]{0,160}dispatchComposerContent/u, "不具备能力时不得继续使用 Chat 自动重提原任务");
assert.doesNotMatch(appSource, /elements\.chatProviderSelect\.addEventListener\("change"/u, "隐藏的兼容字段不得继续承担用户模式切换入口");
assert.doesNotMatch(appSource, /<strong>联系方式<\/strong>|微信：wu798998264|support-block|神思赞助收款码|支持神思持续开发/u, "关于页不得继续展示联系方式或赞助信息");
assert.match(appSource, /我制作神思，是希望真正改变 AI 写作中“模型替作者决定一切”的模式，让工具负责整理、执行和检查，让创作者保留方向、审美与最终判断。/u, "关于页必须保留给用户的留言");

console.log("Unified Agent compatibility contracts passed");
