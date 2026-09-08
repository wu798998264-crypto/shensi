import assert from "node:assert/strict";

import { createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { createInitialCapabilityTemplate, resolveCapabilityTemplateRouting } from "../src/capability-template.js";
import { FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { resolveRequiredCapabilities } from "../src/skill-contract.js";
import { compileTaskContract } from "../src/task-contract.js";
import { detectShensiRunProfile } from "../src/server/shensi-orchestrator.mjs";
import {
  normalizeUnifiedAgentDecision,
  parseUnifiedAgentDecision,
  unifiedAgentEntryUserPrompt,
} from "../src/unified-agent-entry.js";
import { readFile } from "node:fs/promises";

const direct = parseUnifiedAgentDecision(`模型前缀\n{\n  "lane":"direct_reply",\n  "reply":"你好，我在。",\n  "confidence":0.98\n}\n模型后缀`);
assert.equal(direct.lane, "direct_reply");
assert.equal(direct.reply, "你好，我在。");
assert.deepEqual(direct.skillQueries, []);
assert.deepEqual(direct.readPlan, []);

const guided = normalizeUnifiedAgentDecision({
  lane: "guided_dialogue",
  objective: "逐步构思男频爽文",
  reply: "先锁定读者持续追读的核心满足。你最想让主角靠什么方式持续变强？",
  deliverableType: "novel",
  skillQueries: ["小说创作引导"],
  readPlan: [{ reference: "世界观设定", required: false, purpose: "避免重复询问已有设定" }],
  guidance: {
    deliverableType: "novel",
    questionCluster: "core-promise",
    question: "你最想让主角靠什么方式持续变强？",
    interactionMode: "discussion",
  },
});
assert.equal(guided.lane, "guided_dialogue");
assert.equal((guided.guidance.question.match(/[？?]/gu) || []).length, 1);
assert.equal(guided.requestMode, "creative_guidance");
assert.deepEqual(guided.skillQueries, ["小说创作引导"]);
assert.equal(guided.readPlan[0].reference, "世界观设定");

const guidedRoute = buildAdaptiveTaskRoute({
  agentDecision: guided,
  text: "这段原始文字故意不包含任何创作关键词",
  sourceMessageId: "message-guidance-semantic-1",
  target: { documentId: "", revision: "", managed: true, ambiguous: false },
}, { executionSurface: "agent" });
assert.equal(guidedRoute.mode, "creative_guidance", "创作引导必须服从 Agent 语义决定，不能回退到关键词分类");
assert.equal(guidedRoute.writeAuthorization.state, "none", "创作引导不得获得写入权限");

const shortFictionGuidanceCapabilities = resolveRequiredCapabilities({
  prompt: "继续处理这个方向",
  requestMode: "creative_guidance",
  deliverableType: "short_fiction",
});
assert.ok(shortFictionGuidanceCapabilities.includes("short_fiction_guidance"), "Skill 路由必须服从 Agent 判断的产物类型");
assert.ok(!shortFictionGuidanceCapabilities.includes("novel_guidance"), "原始文字不能用关键词覆盖 Agent 判断的产物类型");
const semanticGuidanceProfile = detectShensiRunProfile({
  prompt: "直接写",
  routingText: "这段文字故意没有类型关键词",
  requestMode: "creative_guidance",
  semanticDeliverableType: "short_fiction",
  semanticLane: "guided_dialogue",
});
assert.equal(semanticGuidanceProfile.deliverableType, "short_fiction");
assert.equal(semanticGuidanceProfile.direct, false, "Agent 判定为创作引导后，旧关键词不得把本轮强行改成直接生成");
assert.equal(semanticGuidanceProfile.explicitGuidanceOnly, true, "guided_dialogue 必须保持在引导任务内，不能被旧关键词升级为生产");
const semanticNovelPromptCapabilities = resolveRequiredCapabilities({
  prompt: "请设计一组图片提示词作为讨论例子，但最终任务仍是小说创作",
  requestMode: "creative_guidance",
  deliverableType: "novel",
});
assert.ok(semanticNovelPromptCapabilities.includes("novel_guidance"));
assert.ok(!semanticNovelPromptCapabilities.includes("prompt_guidance"), "Agent 已确定小说产物时，正文中的提示词示例不能覆盖 Skill 路由");
const semanticGuidanceSkillRoute = resolveCapabilityTemplateRouting(createInitialCapabilityTemplate(), {
  text: "# Agent 语义能力需求\n- 小说创作引导",
  workspaceMode: "project",
  activeModule: "manuscript",
  contextDomain: "novel",
  deliverableType: "novel",
  requestMode: "creative_guidance",
  requiredCapabilities: ["guidance_control", "novel_guidance"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
assert.ok(semanticGuidanceSkillRoute.activatedSelections.some((selection) => (
  selection.id === "builtin:creative-guidance"
  && selection.name === "小说创作引导"
)), "Agent 判定为小说引导后必须实际激活并展示小说创作引导 Skill");

const taskDecision = normalizeUnifiedAgentDecision({
  lane: "task_execution",
  relation: "new_task",
  objective: "把本轮结果追加到发送时打开的文档",
  requestMode: "creative",
  deliverableType: "novel",
  confidence: 0.94,
  skillQueries: ["小说正文主笔"],
  readPlan: [{ reference: "submitted_document", required: true, purpose: "承接当前章节" }],
  writePlan: { intent: "commit", targetKind: "current", targetRef: "submitted_document", operation: "append" },
});
assert.equal(taskDecision.writePlan.targetRef, "submitted_document");
assert.equal(taskDecision.writePlan.operation, "append");

const qualityReviewDecision = normalizeUnifiedAgentDecision({
  lane: "task_execution",
  taskKind: "quality_review",
  relation: "new_task",
  objective: "检查上一轮提到的正文",
  requestMode: "general",
  deliverableType: "document",
  skillCapabilities: [],
  readPlan: [{ reference: "第4～10章正文", required: true, purpose: "检查正文质量" }],
  writePlan: { intent: "none", targetKind: "unspecified", operation: "none" },
});
assert.equal(qualityReviewDecision.relation, "inspect_task");
assert.equal(qualityReviewDecision.requestMode, "creative");
assert.equal(qualityReviewDecision.deliverableType, "report");
assert.ok(qualityReviewDecision.skillCapabilities.includes("effect_reviewer"), "内容质检必须选择小说自检能力");

const qualityCapabilitiesFromLegacyGeneralMode = resolveRequiredCapabilities({
  requestMode: "general",
  semanticCapabilities: ["effect_reviewer"],
  semanticCapabilitiesAuthoritative: true,
});
assert.ok(qualityCapabilitiesFromLegacyGeneralMode.includes("effect_reviewer"), "旧模式字段不得丢掉 Agent 已选择的自检能力");

const provisionalFallbackContract = compileTaskContract({
  taskType: "writing",
  objective: "旧的临时目标",
  deliverables: [{ kind: "prose", targetDocumentId: "chapter-99" }],
  persistence: "commit",
  targetResolution: "exact",
  semanticSource: "fallback",
  sourceMessageId: "quality-review-followup",
});
const qualityRoute = buildAdaptiveTaskRoute({
  agentDecision: qualityReviewDecision,
  taskContract: provisionalFallbackContract,
  text: "继续处理刚才那些内容。",
  sourceMessageId: "quality-review-followup",
  target: { documentId: "chapter-3", revision: "rev-3", managed: true, ambiguous: false },
  targetDocumentIds: ["chapter-3"],
}, { executionSurface: "agent" });
assert.equal(qualityRoute.mode, "creative", "内容质检不能显示为普通问答");
assert.equal(qualityRoute.diagnosisIntent, true);
assert.equal(qualityRoute.taskContract, null, "旧的临时合同不能参与执行");
assert.equal(qualityRoute.provisionalTaskContract?.deliverables?.[0]?.targetDocumentId, "chapter-99");
assert.deepEqual(qualityRoute.intentEnvelope.targetDocumentIds, ["chapter-3"], "旧的临时目标不能覆盖 Agent 本轮目标");
assert.equal(qualityRoute.intentEnvelope.taskType, "diagnosis");

const skillInstallDecision = normalizeUnifiedAgentDecision({
  lane: "task_execution",
  objective: "导入本轮附带的能力包",
  requestMode: "workspace_operation",
  operation: { kind: "skill_install", reason: "用户明确要求导入并绑定本轮提供的 Skill" },
  writePlan: { intent: "none", targetKind: "unspecified", operation: "none" },
});
assert.deepEqual(skillInstallDecision.operation, {
  kind: "skill_install",
  reason: "用户明确要求导入并绑定本轮提供的 Skill",
});
assert.equal(normalizeUnifiedAgentDecision({
  lane: "task_execution",
  operation: { kind: "unknown_operation" },
})?.operation, null, "未知高影响操作不得进入执行链");
assert.equal(normalizeUnifiedAgentDecision({
  lane: "direct_reply",
  reply: "只讨论如何设计 Skill。",
  operation: { kind: "skill_install" },
})?.operation, null, "闲聊不能携带高影响操作授权");

const route = buildAdaptiveTaskRoute({
  agentDecision: taskDecision,
  text: "这只是普通聊天——这段故意与任务决策冲突",
  authorizationInstruction: "把本轮结果追加到发送时打开的文档",
  sourceMessageId: "message-semantic-1",
  target: { documentId: "doc-at-submit", revision: "rev-1", managed: true, ambiguous: false },
  targetDocumentIds: ["doc-at-submit"],
  expectedRevisions: { "doc-at-submit": "rev-1" },
  targetExists: true,
}, { executionSurface: "agent" });
assert.equal(route.mode, "creative", "Agent 决策必须覆盖旧关键词分类结果");
assert.equal(route.writeAuthorization.state, "commit");
assert.equal(route.writeAuthorization.action, "append");
assert.deepEqual(route.writeAuthorization.targetDocumentIds, ["doc-at-submit"]);
assert.match(route.writeAuthorization.reason, /agent_semantic_commit/u);

const readOnly = createFormalWriteAuthorization({
  instruction: "请直接写入当前文档——文本故意与结构化决定冲突",
  sourceMessageId: "message-semantic-2",
  targetDocumentIds: ["doc-at-submit"],
  expectedRevisions: { "doc-at-submit": "rev-1" },
  semanticWritePlan: { intent: "none", targetKind: "current", targetRef: "submitted_document", operation: "none" },
});
assert.equal(readOnly.state, "none", "执行层不得再用关键词推翻 Agent 的只读判断");
assert.equal(readOnly.reason, "agent_semantic_no_write");

const unresolved = createFormalWriteAuthorization({
  instruction: "创建文档",
  sourceMessageId: "message-semantic-3",
  targetDocumentIds: [],
  semanticWritePlan: { intent: "commit", targetKind: "new", targetRef: "待命名文档", operation: "create" },
});
assert.equal(unresolved.state, "none");
assert.equal(unresolved.reason, "agent_semantic_target_unresolved", "没有真实目标时 Agent 也不能绕过宿主核验");

const compactPrompt = JSON.parse(unifiedAgentEntryUserPrompt({
  messages: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", content: `消息${index}` })),
  explicitSkills: ["skill-a"],
  explicitReferences: ["doc-a"],
  submittedDocument: { id: "doc-at-submit", revision: "rev-1" },
}));
assert.equal(compactPrompt.recentMessages.length, 8, "快速入口不得重复携带全部长历史");
assert.deepEqual(compactPrompt.explicitSkills, ["skill-a"]);
assert.equal(compactPrompt.submittedDocument.id, "doc-at-submit");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(serverSource, /resolveSkillRuntime\([\s\S]{0,260}\}\), \{ executionSurface: "chat" \}/u, "长文路由不得再以 Chat 语义归类能力模板");
assert.doesNotMatch(serverSource, /if \(agentDecision\.lane === "guided_dialogue"\) \{\s*const guidanceState/u,
  "guided_dialogue 不能在 Skill 路由之前提前返回");
assert.doesNotMatch(appSource, /if \(creativeGuidanceRequested && !guidanceDialog\)/u,
  "首轮不得根据本地关键词直接递归创建创作引导");
assert.match(appSource, /localRuntimeReply = materialInspectionActive/u,
  "普通消息不得被本地关键词路由绕过统一 Agent");
assert.match(serverSource, /semanticDeliverableType:\s*deliverableType/u,
  "正式创作引导编排器必须接收 Agent 判断的产物类型");
assert.match(serverSource, /semanticLane:\s*agentDecision\.lane/u,
  "正式编排器必须接收 Agent 判断的任务类型，阻止旧关键词二次改道");
assert.match(serverSource, /lane:\s*agentDecision\.lane/u,
  "正式链返回时必须保留 guided_dialogue，以便前端续接同一引导会话");
const executionCardSource = appSource.slice(appSource.indexOf("const renderExecutionProcess"), appSource.indexOf("const renderAssistantWaiting"));
assert.match(executionCardSource, /qualityReviewExecution[\s\S]*内容质检/u, "质检任务必须显示成内容质检");
assert.doesNotMatch(executionCardSource, /<dt>任务合同<\/dt>|<dt>判定依据<\/dt>|能力路由追踪/u,
  "普通执行卡片不得显示内部合同或路由术语");

console.log("Agent semantic decision contracts passed");
