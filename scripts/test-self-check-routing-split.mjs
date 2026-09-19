import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  createInitialCapabilityTemplate,
  normalizeCapabilityTemplate,
} from "../src/capability-template.js";
import { resolveProjectCapabilityPlan, reviewCapabilitiesForPrompt } from "../src/module-registry.js";
import { loadShensiContext } from "../src/server/shensi-context.mjs";

assert.equal(CAPABILITY_TEMPLATE_SCHEMA_VERSION, 31);

const initial = createInitialCapabilityTemplate();
const reviewModule = initial.modules.find((module) => module.id === "module:novel-review");
assert.ok(reviewModule, "小说自检模块必须存在");
assert.deepEqual(reviewModule.slots.map((slot) => slot.skillId), [
  "builtin:strong-story-review",
  "builtin:effect-review",
]);
assert.deepEqual(reviewModule.slots[0].capabilities, ["strong_story_reviewer"]);
assert.deepEqual(reviewModule.slots[1].capabilities, ["regular_progress_reviewer", "effect_reviewer"]);

const legacy = normalizeCapabilityTemplate({
  schemaVersion: 29,
  template: initial.template,
  groups: initial.groups,
  modules: initial.modules.map((module) => module.id === "module:novel-review"
    ? {
        ...module,
        slots: [{
          id: "slot:effect-review",
          name: "小说自检",
          skillId: "builtin:effect-review",
          fixedSlotId: "builtin:effect-review",
          capabilities: ["effect_reviewer"],
        }],
      }
    : module),
});
const migratedReview = legacy.modules.find((module) => module.id === "module:novel-review");
assert.deepEqual(migratedReview.slots.map((slot) => slot.skillId), [
  "builtin:strong-story-review",
  "builtin:effect-review",
]);
assert.ok(migratedReview.slots[1].capabilities.includes("effect_reviewer"));
assert.ok(migratedReview.slots[1].capabilities.includes("regular_progress_reviewer"));

const renamedPrompt = normalizeCapabilityTemplate({
  schemaVersion: 29,
  template: initial.template,
  groups: initial.groups,
  modules: initial.modules.map((module) => module.id === "module:prompt-writer"
    ? { ...module, name: "提示词主笔模块" }
    : module),
});
assert.equal(renamedPrompt.modules.find((module) => module.id === "module:prompt-writer")?.name, "AI 漫剧图片资产提示词模块");

const strongPlan = resolveProjectCapabilityPlan({
  activeModule: "manuscript",
  prompt: "请对前三章做强剧情自检，重点检查开篇钩子和追读压力",
  contextDomain: "novel",
});
assert.ok(strongPlan.capabilities.includes("strong_story_reviewer"));
assert.equal(strongPlan.capabilities.includes("regular_progress_reviewer"), false);

const regularPlan = resolveProjectCapabilityPlan({
  activeModule: "manuscript",
  prompt: "请检查第十章的常规推进和关系沉淀",
  contextDomain: "novel",
});
assert.ok(regularPlan.capabilities.includes("regular_progress_reviewer"));
assert.equal(regularPlan.capabilities.includes("strong_story_reviewer"), false);
assert.deepEqual(reviewCapabilitiesForPrompt({ prompt: "完整满血自检" }), [
  "strong_story_reviewer",
  "regular_progress_reviewer",
]);

const root = fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url));
const strongContext = await loadShensiContext({
  shensiRoot: root,
  prompt: "检查前三章",
  activeModule: "manuscript",
  contextDomain: "novel",
  stage: "evaluation",
  skillCapabilities: ["strong_story_reviewer"],
});
assert.match(strongContext.promptText, /强剧情自检/u);
assert.doesNotMatch(strongContext.promptText, /# 常规推进自检/u);

// The semantic capability route uses the reports surface for review work;
// that path must load the same concrete self-check document as manuscript.
const reportsStrongContext = await loadShensiContext({
  shensiRoot: root,
  prompt: "请审查目标文本",
  activeModule: "reports",
  contextDomain: "novel",
  stage: "evaluation",
  skillCapabilities: ["strong_story_reviewer"],
});
assert.match(reportsStrongContext.promptText, /强剧情自检/u);
assert.doesNotMatch(reportsStrongContext.promptText, /# 常规推进自检/u);

const regularContext = await loadShensiContext({
  shensiRoot: root,
  prompt: "检查第十章",
  activeModule: "manuscript",
  contextDomain: "novel",
  stage: "evaluation",
  skillCapabilities: ["regular_progress_reviewer"],
});
assert.match(regularContext.promptText, /常规推进自检/u);
assert.doesNotMatch(regularContext.promptText, /# 强剧情自检/u);

const fullContext = await loadShensiContext({
  shensiRoot: root,
  prompt: "执行满血自检",
  activeModule: "manuscript",
  contextDomain: "novel",
  stage: "audit-final",
  fullAudit: true,
  skillCapabilities: ["strong_story_reviewer", "regular_progress_reviewer"],
});
assert.match(fullContext.promptText, /# 强剧情自检/u);
assert.match(fullContext.promptText, /# 常规推进自检/u);

console.log("Self-check routing split contract passed");
