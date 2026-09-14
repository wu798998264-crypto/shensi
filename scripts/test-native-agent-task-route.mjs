import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  agentTaskRouteFromDelivery,
  agentTaskRouteFromMediaDispatch,
  nativeAgentTaskWayLabel,
} from "../src/conversation-agent-task-route.js";

assert.equal(nativeAgentTaskWayLabel({ execution: { strength: "native_agent" } }), "Agent 执行", "缺少真实分类时不得回退成创作引导");
assert.equal(nativeAgentTaskWayLabel({ execution: { taskRoute: { mode: "creative_guidance" } }, guided: true }), "创作引导");
assert.equal(nativeAgentTaskWayLabel({ execution: { taskRoute: { taskKind: "formal_creation" } } }), "正式创作");
assert.equal(nativeAgentTaskWayLabel({ execution: { taskRoute: { taskKind: "general_qa" } } }), "普通问答");
assert.equal(nativeAgentTaskWayLabel({ execution: { taskRoute: { taskKind: "quality_review" } } }), "内容质检");
assert.equal(nativeAgentTaskWayLabel({ execution: { taskRoute: { taskKind: "software_operation" } } }), "软件操作");
assert.equal(nativeAgentTaskWayLabel({ execution: { taskRoute: { taskKind: "image_generation" } } }), "图片生成");
assert.equal(nativeAgentTaskWayLabel({ execution: { taskRoute: { taskKind: "video_generation" } } }), "视频生成");

assert.deepEqual(agentTaskRouteFromMediaDispatch({ kind: "media", channel: "image" }), {
  mode: "media",
  taskKind: "image_generation",
  direct: true,
});
assert.equal(agentTaskRouteFromDelivery({ mode: "conversation", documentIds: [] }), null, "未提供真实细分类别时必须保留 Agent 执行兜底");
assert.equal(agentTaskRouteFromDelivery({ mode: "conversation", documentIds: [], taskType: "general_qa" }).taskKind, "general_qa");
assert.equal(agentTaskRouteFromDelivery({ mode: "documents", documentIds: ["doc-1"], taskType: "quality_review" }).taskKind, "quality_review");
assert.equal(agentTaskRouteFromDelivery({ mode: "media", documentIds: [], mediaChannels: ["video"] }).taskKind, "video_generation");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /nativeAgentExecution\s*\?\s*nativeAgentTaskWayLabel/u, "原生 Agent 任务卡必须使用真实任务类型映射");
assert.match(appSource, /const mediaDispatch = normalizeConversationMediaDispatchContract\(queuedItem\?\.mediaDispatch\)[\s\S]{0,180}options\.mediaDispatch/u, "直接发送和排队恢复都必须保留已确认媒体意图");
assert.match(appSource, /attachments:\s*refs\.attachments[^\n]+mediaProfiles,[\s\S]{0,80}mediaDispatch/u, "原生 Agent 请求必须把媒体交付合同发给服务端");
assert.match(appSource, /const dispatchComposerContent = \(content, \{[\s\S]{0,260}mediaDispatch = null/u, "对话发送入口必须接收选择框确认的媒体合同");
assert.match(appSource, /void sendMessage\(content,[\s\S]{0,320}mediaDispatch: normalizeConversationMediaDispatchContract\(mediaDispatch\)/u, "选择框确认的媒体合同不得在发送入口丢失");

console.log("Native Agent task route and task-card labels passed");
