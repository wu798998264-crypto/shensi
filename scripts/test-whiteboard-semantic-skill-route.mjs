import assert from "node:assert/strict";

import {
  normalizeSemanticSkillCapabilities,
  semanticSkillRouteMetadata,
  skillSelectionMatchesSemanticCapabilities,
} from "../src/semantic-skill-route.js";
import {
  planWhiteboardSkillRoute,
  whiteboardAutoSkillSelections,
} from "../src/whiteboard-skill-route.js";

assert.deepEqual(
  normalizeSemanticSkillCapabilities(["novel_prose_writer", "not-a-capability", "novel_prose_writer"]),
  ["novel_prose_writer"],
);
assert.deepEqual(
  semanticSkillRouteMetadata(["novel_prose_writer"]),
  {
    requestMode: "creative",
    deliverableType: "novel",
    contextDomain: "novel",
    activeModule: "manuscript",
    capability: "novel_prose_writer",
    capabilities: ["novel_prose_writer"],
    semanticCapabilitiesAuthoritative: true,
  },
);

const semanticRoute = planWhiteboardSkillRoute({
  prompt: "请生成提示词并做分镜",
  workspaceKind: "project",
  skillCapabilities: ["novel_prose_writer"],
});
assert.equal(semanticRoute.requestMode, "creative");
assert.equal(semanticRoute.deliverableType, "novel");
assert.equal(semanticRoute.activeModule, "manuscript");
assert.equal(semanticRoute.semanticCapabilitiesAuthoritative, true);
assert.deepEqual(semanticRoute.skillCapabilities, ["novel_prose_writer"]);

const agentDecisionRoute = planWhiteboardSkillRoute({
  prompt: "示例中提到图片提示词和短剧改编，但实际仍写小说正文",
  workspaceKind: "project",
  agentDecision: {
    lane: "task_execution",
    taskKind: "content_creation",
    objective: "写小说正文",
    requestMode: "creative",
    deliverableType: "novel",
    sourceMode: "original",
    skillCapabilities: ["novel_prose_writer"],
  },
  skillCapabilities: ["novel_prose_writer"],
});
assert.equal(agentDecisionRoute.deliverableType, "novel");
assert.equal(agentDecisionRoute.contextDomain, "novel");
assert.equal(agentDecisionRoute.activeModule, "manuscript");

const semanticGuidanceRoute = planWhiteboardSkillRoute({
  prompt: "请直接写正文，不要追问",
  semanticCapabilities: ["short_drama_guidance"],
});
assert.equal(semanticGuidanceRoute.requestMode, "creative_guidance");
assert.equal(semanticGuidanceRoute.deliverableType, "short_drama_script");
assert.equal(semanticGuidanceRoute.contextDomain, "script");

const semanticReviewRoute = planWhiteboardSkillRoute({
  prompt: "请生成提示词并做分镜",
  skillCapabilities: ["effect_reviewer"],
});
assert.equal(semanticReviewRoute.activeModule, "reports");
assert.equal(semanticReviewRoute.deliverableType, "");

const genericSemanticRoute = planWhiteboardSkillRoute({
  prompt: "请规划世界观大纲",
  skillCapabilities: ["creative_guidance"],
});
assert.equal(genericSemanticRoute.contextDomain, "general", "结构化能力存在时不得再从原始关键词推断文体");
assert.equal(genericSemanticRoute.activeModule, "manuscript", "结构化能力存在时不得再从原始关键词推断模块");

const legacyRoute = planWhiteboardSkillRoute({ prompt: "请生成提示词并做分镜", workspaceKind: "project" });
assert.notEqual(legacyRoute.requestMode, undefined, "旧调用仍应返回完整路由");
assert.equal(legacyRoute.semanticCapabilitiesAuthoritative, undefined);
const rejectedSemanticRoute = planWhiteboardSkillRoute({ prompt: "继续处理", skillCapabilities: ["not-a-capability"] });
assert.equal(rejectedSemanticRoute.semanticCapabilitiesAuthoritative, true);
assert.deepEqual(rejectedSemanticRoute.skillCapabilities, []);

assert.equal(skillSelectionMatchesSemanticCapabilities(
  { authorizedCapabilities: ["novel_prose_writer"] },
  ["novel_prose_writer"],
), true);
assert.equal(skillSelectionMatchesSemanticCapabilities(
  { authorizedCapabilities: ["novel_prose_writer"] },
  ["setting_planner"],
), false);

const runtime = {
  slotSkills: {
    writer: { id: "builtin:novel-writer", name: "小说主笔", activationSource: "capability_template_builtin", authorizedCapabilities: ["novel_prose_writer"] },
    guidance: { id: "builtin:creative-guidance", name: "创作引导", activationSource: "capability_template_builtin", authorizedCapabilities: ["novel_guidance"] },
  },
  builtinFallbackCapabilities: ["novel_prose_writer", "novel_guidance"],
};
const semanticSelections = whiteboardAutoSkillSelections({
  runtime,
  activatedSelections: [
    { id: "builtin:novel-writer", name: "小说主笔", authorizedCapabilities: ["novel_prose_writer"] },
    { id: "builtin:creative-guidance", name: "创作引导", authorizedCapabilities: ["novel_guidance"] },
  ],
  skillCapabilities: ["novel_prose_writer"],
});
assert.deepEqual(semanticSelections.map((selection) => selection.id), ["builtin:novel-writer"]);
assert.deepEqual(
  whiteboardAutoSkillSelections({
    runtime,
    activatedSelections: [
      { id: "builtin:novel-writer", name: "小说主笔", authorizedCapabilities: ["novel_prose_writer"] },
    ],
    semanticCapabilities: ["novel_prose_writer"],
  }).map((selection) => selection.id),
  ["builtin:novel-writer"],
);
assert.deepEqual(whiteboardAutoSkillSelections({ runtime, activatedSelections: [], skillCapabilities: [] }), [], "Agent 明确不请求能力时不得回退到关键词自动选择");
assert.deepEqual(
  whiteboardAutoSkillSelections({ runtime, activatedSelections: [] }).map((selection) => selection.id),
  ["builtin:creative-guidance", "builtin:novel-writer"],
  "未提供结构化能力的旧调用必须保留既有选择行为",
);

const appSource = await (await import("node:fs/promises")).readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /agentDecision:\s*autoRoute\?\.agentDecision\s*\?\?\s*null/u,
  "白板生成必须复用 Skill 路由已经取得的 Agent 决策，不能再次调用 Agent 判断");
assert.match(appSource, /decisionResolution:[\s\S]{0,220}agentDecision,[\s\S]{0,220}languagePolicy/u,
  "白板复用的 Agent 决策必须真正进入聊天请求体");

console.log("Whiteboard semantic Skill route contracts passed");
