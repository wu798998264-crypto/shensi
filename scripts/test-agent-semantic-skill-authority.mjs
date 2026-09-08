import assert from "node:assert/strict";

import { createInitialCapabilityTemplate, resolveCapabilityTemplateRouting } from "../src/capability-template.js";
import { FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";
import { resolveRequiredCapabilities } from "../src/skill-contract.js";
import { normalizeSemanticSkillCapabilities } from "../src/semantic-skill-route.js";

const capabilities = normalizeSemanticSkillCapabilities(["novel_prose_writer", "not-a-capability", "novel_prose_writer"]);
assert.deepEqual(capabilities, ["novel_prose_writer"]);

const required = resolveRequiredCapabilities({
  workspaceMode: "project",
  activeModule: "manuscript",
  prompt: "这段文字故意包含提示词、分镜和场景关键词",
  requestMode: "creative",
  contextDomain: "novel",
  deliverableType: "novel",
  semanticCapabilities: capabilities,
  semanticCapabilitiesAuthoritative: true,
});
assert.ok(required.includes("novel_prose_writer"));
assert.ok(!required.includes("visual_prompt_writer"));

const route = resolveCapabilityTemplateRouting(createInitialCapabilityTemplate(), {
  text: "提示词、分镜和场景关键词不能改变 Agent 的判断",
  workspaceMode: "project",
  activeModule: "manuscript",
  contextDomain: "novel",
  deliverableType: "novel",
  requestMode: "creative",
  requiredCapabilities: required,
  semanticCapabilities: capabilities,
  semanticCapabilitiesAuthoritative: true,
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
const ids = route.activatedSelections.map((selection) => selection.id);
assert.ok(ids.includes("builtin:novel-writer"), "Agent 指定正文能力时必须激活小说正文主笔");
assert.ok(!ids.includes("builtin:visual-asset-prompt-writer"), "原始提示词不得越权激活图片资产 Skill");
assert.ok(!ids.includes("builtin:video-prompt-writer"), "原始提示词不得越权激活视频提示词 Skill");

const emptyDecisionRoute = resolveCapabilityTemplateRouting(createInitialCapabilityTemplate(), {
  text: "小说正文、提示词、分镜、自检",
  workspaceMode: "general",
  activeModule: "manuscript",
  contextDomain: "general",
  deliverableType: "",
  requestMode: "creative",
  requiredCapabilities: resolveRequiredCapabilities({
    workspaceMode: "general",
    activeModule: "manuscript",
    prompt: "",
    requestMode: "creative",
    contextDomain: "general",
    deliverableType: "",
    semanticCapabilities: [],
    semanticCapabilitiesAuthoritative: true,
  }),
  semanticCapabilities: [],
  semanticCapabilitiesAuthoritative: true,
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
assert.equal(emptyDecisionRoute.activatedSelections.length, 0, "Agent 明确不请求 Skill 时不得回退到关键词自动选择");

console.log("Agent semantic Skill authority contracts passed");
