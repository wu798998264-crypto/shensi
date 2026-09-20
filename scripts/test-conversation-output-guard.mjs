import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeConversationOutput, sanitizeUserFacingError, sanitizeWorkBuddyConversationOutput } from "../src/conversation-output-guard.js";
import { nativeAgentTerminalPresentation } from "../src/conversation-agent-task-route.js";
import { parseExternalCliOutput } from "../src/server/external-cli-agent-runner.mjs";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";

const leaked = `面板内容宿主已在本轮受控上下文中直接提供，我确实已读取到。我现在按合同要求补全交付声明。
Parameter validation failed for tool "mcp__shensi__interaction_delivery": root: must have required property 'mode'
Expected parameter schema:
{"type":"object","required":["mode","documentIds"],"properties":{"mode":{"type":"string"}}}
Please adjust the params to match the schema and try again.
{"mode":"conversation","taskType":"general_qa","routingMode":"general","documentIds":[],"mediaChannels":[]}
交付已补全。

**核对结论**：可以，我能读取面板。`;
const visible = sanitizeConversationOutput(leaked);
assert.equal(visible, "**核对结论**：可以，我能读取面板。", "内部交付协议必须从普通回答中移除");
assert.doesNotMatch(visible, /Parameter validation|Expected parameter schema|routingMode|interaction_delivery|交付已补全|面板内容宿主/iu);
assert.equal(sanitizeUserFacingError("Parameter validation failed for tool mcp__shensi__interaction_delivery"), "本轮交付校验未完成，结果已保留；请重试。");

const normal = "面板路由负责选择顶层模组，命中后再读取对应模块。";
assert.equal(sanitizeConversationOutput(normal), normal, "普通回答不能被过度清洗");
const parsed = parseExternalCliOutput([
  JSON.stringify({ type: "message", delta: leaked }),
  JSON.stringify({ type: "result", text: leaked }),
].join("\n"));
assert.equal(sanitizeConversationOutput(parsed.text), visible, "外置 CLI 最终文本必须使用同一输出边界");

const workBuddyRouteLeak = `${JSON.stringify({
  routes: [{ placementId: "template:shensi>place:template:short-fiction", kind: "group", name: "短篇小说模组" }],
  autoLoadedSkills: [{ placementId: "slot:writer", name: "短篇小说主笔", text: "internal skill body" }],
  selectedPlacement: { placementId: "slot:writer", pathNames: ["Skill 面板", "短篇小说模组", "短篇小说主笔"] },
})}\n\n这是正常回答。`;
assert.equal(sanitizeWorkBuddyConversationOutput(workBuddyRouteLeak), "这是正常回答。", "WorkBuddy 路由对象不得泄露到用户回答");
assert.doesNotMatch(sanitizeWorkBuddyConversationOutput(workBuddyRouteLeak), /routes|autoLoadedSkills|placementId|internal skill body/iu);
assert.equal(sanitizeConversationOutput(workBuddyRouteLeak), workBuddyRouteLeak.trim(), "通用输出边界不能受 WorkBuddy 专用规则影响");
assert.equal(sanitizeWorkBuddyConversationOutput('{"routes":[{"placementId":"x"}],"autoLoadedSkills":[{"name":"x"}', { final: false }), "", "流式未闭合的 WorkBuddy 路由对象不得提前显示");
assert.equal(sanitizeWorkBuddyConversationOutput('{"routes":[{"placementId":"x"}],"autoLoadedSkills":[{"name":"x"}'), "", "WorkBuddy 最终不应显示截断的内部路由对象");

const terminal = nativeAgentTerminalPresentation({ status: "completed", text: leaked, resultWarnings: ["Parameter validation failed for tool mcp__shensi__interaction_delivery"] });
assert.equal(terminal.content, visible);
assert.deepEqual(terminal.warnings, [], "原始工具协议错误不得进入任务卡警告");

const root = await mkdtemp(join(tmpdir(), "shensi-output-guard-"));
try {
  const service = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs"),
    skillCatalog: async () => [],
    readRoute: async () => "",
    run: async ({ workspaceToolRuntime, deliveryReview }) => {
      if (!deliveryReview) await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "delivery", arguments: { mode: "conversation", taskType: "general_qa", routingMode: "general", routingReason: "普通问答不需要面板 Skill", documentIds: [] } });
      return { text: leaked };
    },
  });
  const started = await service.start({
    workspacePath: join(root, "workspace"), workspaceKind: "notebook", conversationId: "output-guard",
    sourceMessageId: "output-guard-user", instruction: "问一个普通问题", messages: [{ role: "user", content: "你能读取面板吗？" }],
    settings: { agentEngine: "workbuddy", model: "" },
  });
  let result;
  for (let index = 0; index < 200; index += 1) {
    result = await service.status(started.id);
    if (["completed", "failed"].includes(result.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.text, visible);
  assert.doesNotMatch(result.text, /Parameter validation|Expected parameter schema|routingMode|interaction_delivery|交付已补全/iu);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Conversation output boundary, CLI parsing and terminal presentation passed");
