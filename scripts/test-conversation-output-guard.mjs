import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasWorkBuddyInternalConversationMarker, sanitizeConversationOutput, sanitizeUserFacingError, sanitizeWorkBuddyConversationOutput } from "../src/conversation-output-guard.js";
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
const normalPlan = `优化方案：\n\n1. 保留正常回答。\n2. 示例配置：\n\n\`\`\`json\n{"mode":"strict","properties":{"title":"string"}}\n\`\`\``;
assert.equal(sanitizeConversationOutput(normalPlan), normalPlan, "普通优化方案和用户需要的 JSON 示例不得被误删");
assert.equal(sanitizeWorkBuddyConversationOutput(normalPlan), normalPlan, "WorkBuddy 深度边界也不得把正常优化方案或 JSON 示例误当内部过程");
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

const workBuddyToolAndSchemaLeak = `{"error":"本轮已经读取面板能力分支，必须真实读取对应 Skill 后以 skills 方式交付；不能改报为通用问答","code":"TOOL_FAILED"}

"type": "object",
"required": ["mode", "documentIds"],
"properties": {
  "mode": {"type": "string"},
  "routingMode": {"type": "string"}
},
"additionalProperties": false
}

能。刚才我实际读了三层，结果是真实返回的：`;
const workBuddyClean = sanitizeWorkBuddyConversationOutput(workBuddyToolAndSchemaLeak);
assert.equal(workBuddyClean, "能。刚才我实际读了三层，结果是真实返回的：", "WorkBuddy 工具错误和裸 Schema 不得泄露到回答");
assert.doesNotMatch(workBuddyClean, /TOOL_FAILED|routingMode|additionalProperties|properties|mcp__shensi__/iu);
assert.equal(sanitizeWorkBuddyConversationOutput('{"error":"本轮已经读取面板能力分支","code":"TOOL_FAILED"}', { final: false }), "", "WorkBuddy 流式工具错误不得提前显示");

const workBuddyBareSchemaLeak = `I'll read the document and route first.

"type": "object",
"required": ["mode", "documentIds"],
"properties": {
  "mode": {"type": "string"},
  "taskType": {"type": "string"},
  "routingMode": {"type": "string"},
  "documentIds": {"type": "array"}
},
"additionalProperties": false
}

已按《秤》改成一条 30 秒视频分镜提示词。`;
assert.equal(
  sanitizeWorkBuddyConversationOutput(workBuddyBareSchemaLeak),
  "已按《秤》改成一条 30 秒视频分镜提示词。",
  "WorkBuddy 裸 Schema 和英文内部前言不得泄露到回答",
);
assert.equal(
  sanitizeWorkBuddyConversationOutput(workBuddyBareSchemaLeak.slice(0, workBuddyBareSchemaLeak.indexOf("已按"))),
  "",
  "WorkBuddy 未完成 Schema 在流式阶段不得闪现",
);
assert.equal(hasWorkBuddyInternalConversationMarker("I'll read the document and route first."), true, "WorkBuddy 英文内部前言必须锁住流式输出");
assert.equal(hasWorkBuddyInternalConversationMarker('"type": "object",\n"required": ["mode"]'), true, "WorkBuddy Schema 必须锁住流式输出");

const splitWorkBuddyLeak = [
  "I'll read the doc",
  "ument and route first.\n\n\"type\": \"object\",\n",
  '"required": ["mode", "documentIds"],\n"properties": {\n"mode": {"type": "string"}\n},\n"additionalProperties": false\n}\n\n这是最终方案。',
];
assert.equal(sanitizeWorkBuddyConversationOutput(splitWorkBuddyLeak.join("")), "这是最终方案。", "跨分片拼接后的 WorkBuddy 内部协议必须完整清除");

const workBuddyDocumentSchemaFragment = `"type": "object",

"required": [

  "operation",

  "documentId",

  "operationId"

],

"properties": {

  "operation": {"type": "string"},

  "documentId": {"type": "string"},

  "operationId": {"type": "string"}

},

"additionalProperties": false
}

短篇科幻小说创作能力规则`;
assert.equal(sanitizeWorkBuddyConversationOutput(workBuddyDocumentSchemaFragment), "短篇科幻小说创作能力规则", "WorkBuddy documents.write 裸 Schema 片段不得泄露到正文");
assert.equal(sanitizeWorkBuddyConversationOutput(workBuddyDocumentSchemaFragment.slice(0, workBuddyDocumentSchemaFragment.indexOf("短篇"))), "", "WorkBuddy documents.write 裸 Schema 流式片段不得提前显示");

// Regression fixture for the real failure mode: WorkBuddy concatenates a
// media-profile catalog, route/Skill catalog, delivery-tool error, full JSON
// Schema and a media receipt before its actual answer.  None of those
// transport values may become user-facing prose, and a valid final answer
// must survive the cleanup intact.
const workBuddyMediaRouteLeak = `${JSON.stringify({
  image: [{ id: "image-cockpit-aggregate-api", name: "聚合api", provider: "自定义兼容接口", model: "gpt-image-2.5" }],
  video: [],
})}\n${JSON.stringify([{ id: "short-video-skill", name: "短视频脚本", capabilities: ["video_prompt"] }])}\n${JSON.stringify({
  error: "本轮已经读取面板能力分支，必须真实读取对应 Skill 后以 skills 方式交付；不能改报为通用问答",
  code: "TOOL_FAILED",
})}\n${JSON.stringify({
  type: "object",
  required: ["mode", "documentIds"],
  properties: { mode: { type: "string" }, taskType: { type: "string" }, routingMode: { type: "string" }, documentIds: { type: "array" } },
  additionalProperties: false,
})}\n${JSON.stringify({
  id: "generation-image-cockpit-aggregate-api",
  status: "complete",
  attachment: { mimeType: "image/png", relativePath: "assets/generated.png" },
  backedUpToAllAssets: true,
})}\n已按要求完成图片生成，图片已返回。`;
assert.equal(
  sanitizeWorkBuddyConversationOutput(workBuddyMediaRouteLeak),
  "已按要求完成图片生成，图片已返回。",
  "WorkBuddy 完整媒体/路由/工具回执泄露样本必须只保留最终正文",
);
assert.doesNotMatch(
  sanitizeWorkBuddyConversationOutput(workBuddyMediaRouteLeak),
  /image-cockpit|short-video-skill|TOOL_FAILED|additionalProperties|generation-image/iu,
);

const workBuddyBatchLandingReceipt = JSON.stringify({
  schemaVersion: 1,
  type: "shensibatchlanding_receipt",
  batchId: "batch-629975861f2e699e30fcb171d8cff16f",
  status: "completed",
  succeeded: 1,
  failed: 0,
  results: [],
  committedAt: "2026-09-24T02:45:38.970Z",
  verified: true,
  requestId: "agent-481c6def-033e-bbca-73a3-d2e757759d4d",
  retryOperations: [],
});
assert.equal(
  sanitizeWorkBuddyConversationOutput(`${workBuddyBatchLandingReceipt}\n\n当前版本已覆盖写入原文档。`),
  "当前版本已覆盖写入原文档。",
  "WorkBuddy 批量落盘回执不得混入最终回答",
);
assert.equal(sanitizeWorkBuddyConversationOutput(workBuddyBatchLandingReceipt, { final: false }), "", "WorkBuddy 批量落盘回执在流式阶段不得闪现");
assert.equal(hasWorkBuddyInternalConversationMarker(workBuddyBatchLandingReceipt), true, "WorkBuddy 批量落盘回执必须锁住流式输出");

const workBuddyDocumentReceipt = JSON.stringify({
  documentId: "note-1789954929811",
  title: "回声稿",
  moduleId: "manuscript",
  status: "committed",
  verified: true,
  receipt: { operation: "documents.write" },
});
assert.equal(sanitizeWorkBuddyConversationOutput(`${workBuddyDocumentReceipt}\n\n正文已写入。`), "正文已写入。", "WorkBuddy 成功写入回执不得泄露到对话");
assert.equal(sanitizeWorkBuddyConversationOutput(workBuddyDocumentReceipt), "本轮操作已完成。", "只有成功工具回执时应显示简洁完成提示");
assert.equal(sanitizeWorkBuddyConversationOutput(workBuddyDocumentReceipt, { final: false }), "", "成功工具回执在流式阶段不得提前显示");

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
    run: async ({ workspaceToolRuntime, deliveryReview, onToolEvent }) => {
      if (!deliveryReview) {
        onToolEvent({ phase: "text_delta", text: "I'll read the doc" });
        await new Promise((resolve) => setTimeout(resolve, 180));
        onToolEvent({ phase: "text_delta", text: "ument and route first.\n\n" });
        await new Promise((resolve) => setTimeout(resolve, 180));
        await workspaceToolRuntime.invoke({ namespace: "interaction", tool: "delivery", arguments: { mode: "conversation", taskType: "general_qa", routingMode: "general", routingReason: "普通问答不需要面板 Skill", documentIds: [] } });
      }
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
  assert.equal(result.events.filter((event) => event.type === "text_delta").length, 0, "WorkBuddy 终态前不得向对话区下发可能包含内部过程的正文分片");
  assert.doesNotMatch(result.text, /Parameter validation|Expected parameter schema|routingMode|interaction_delivery|交付已补全/iu);

  const codexApiService = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs-codex-api"),
    skillCatalog: async () => [],
    readRoute: async () => "",
    run: async () => ({ text: workBuddyMediaRouteLeak }),
  });
  const codexApiStarted = await codexApiService.start({
    workspacePath: join(root, "workspace"), workspaceKind: "notebook", conversationId: "output-guard-codex-api",
    sourceMessageId: "output-guard-codex-api-user", instruction: "生成图片并说明结果", messages: [{ role: "user", content: "生成图片并说明结果" }],
    settings: { agentEngine: "codex_api", model: "gpt" },
  });
  let codexApiResult;
  for (let index = 0; index < 200; index += 1) {
    codexApiResult = await codexApiService.status(codexApiStarted.id);
    if (["completed", "failed"].includes(codexApiResult.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(codexApiResult.status, "completed", codexApiResult.error);
  assert.equal(codexApiResult.text, "已按要求完成图片生成，图片已返回。", "其他配置也必须复用同一内部过程过滤边界");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Conversation output boundary, CLI parsing and terminal presentation passed");
