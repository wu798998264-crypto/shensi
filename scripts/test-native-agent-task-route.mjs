import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  agentTaskRouteFromDelivery,
  agentTaskRouteFromMediaDispatch,
  nativeAgentLifecycleStageLabel,
  nativeAgentTaskWayLabel,
  nativeAgentTerminalPresentation,
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

const failed = nativeAgentTerminalPresentation({
  status: "failed",
  partialText: "我将先读取短篇小说分支。",
  error: 'unexpected status 502: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}',
  pendingWarnings: ["先前验收提示"],
  resultWarnings: [],
});
assert.equal(failed.status, "failed");
assert.match(failed.content, /我将先读取短篇小说分支。[\s\S]*任务失败：[\s\S]*usage_limit_reached/u, "预告文字之后必须追加真实失败原因");
assert.match(failed.result, /^任务失败：[\s\S]*usage_limit_reached/u);
assert.deepEqual(failed.warnings, ["先前验收提示"], "空的终态警告数组不得清除已记录提示");
assert.equal(nativeAgentLifecycleStageLabel({ status: "failed" }), "任务失败");

const completedWithWarning = nativeAgentTerminalPresentation({
  status: "completed",
  text: "正式结果",
  pendingWarnings: ["已显示结果，但一项验收未完成"],
  resultWarnings: [],
});
assert.equal(completedWithWarning.status, "soft_warning");
assert.equal(completedWithWarning.content, "正式结果");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(appSource, /nativeAgentExecution\s*\?\s*nativeAgentTaskWayLabel/u, "原生 Agent 任务卡必须使用真实任务类型映射");
assert.match(appSource, /const mediaDispatch = normalizeConversationMediaDispatchContract\(queuedItem\?\.mediaDispatch\)[\s\S]{0,180}options\.mediaDispatch/u, "直接发送和排队恢复都必须保留已确认媒体意图");
assert.match(appSource, /attachments:\s*refs\.attachments[^\n]+mediaProfiles,[\s\S]{0,80}mediaDispatch/u, "原生 Agent 请求必须把媒体交付合同发给服务端");
assert.match(appSource, /const dispatchComposerContent = \(content, \{[\s\S]{0,260}mediaDispatch = null/u, "对话发送入口必须接收选择框确认的媒体合同");
assert.match(appSource, /void sendMessage\(content,[\s\S]{0,320}mediaDispatch: normalizeConversationMediaDispatchContract\(mediaDispatch\)/u, "选择框确认的媒体合同不得在发送入口丢失");
assert.match(appSource, /taskRoute:\s*clone\(taskRoute\),[\s\S]{0,420}deliverableType:\s*taskRoute\.deliverableType[\s\S]{0,420}selectedModulePlacementId:[\s\S]{0,420}selectedSkillPlacementIds:[\s\S]{0,420}relationType:[\s\S]{0,160}relationRole:[\s\S]{0,160}routeReason:/u, "原生 Agent 请求必须携带完整结构化路由合同");
assert.match(serverSource, /const suppliedTaskRoute = body\.taskRoute[\s\S]{0,320}body\.taskRoute\.dispatchProtocol === SHENSI_AGENT_DISPATCH_PROTOCOL/u, "服务端只接受协议版本匹配的结构化路由");
assert.match(serverSource, /let taskRoute = suppliedTaskRoute\s*\?[\s\S]{0,520}\}\s*:\s*buildAdaptiveTaskRoute\(/u, "服务端必须优先复用已编译的结构化路由，仅对旧请求重新推断");
assert.match(serverSource, /const agentActiveModule = String\(body\.activeModule \|\| body\.targetModuleId \|\| body\.targetModule \|\| taskRoute\.targetModule/u, "目标模块必须从结构化合同贯穿到运行时");
assert.match(serverSource, /const agentDeliverableType = String\(body\.deliverableType \|\| taskRoute\.deliverableType/u, "交付类型必须从结构化合同贯穿到运行时");
assert.match(serverSource, /prompt:\s*agentSemanticAuthority \|\| suppliedTaskRoute \? "" : routingText/u, "结构化路由存在时不得再用原始文字重复猜测 Skill 语义");

console.log("Native Agent task route and task-card labels passed");
