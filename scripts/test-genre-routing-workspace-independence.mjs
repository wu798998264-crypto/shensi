import assert from "node:assert/strict";

import {
  CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  createInitialCapabilityTemplate,
  normalizeCapabilityTemplate,
  resolveCapabilityTemplateRouting,
} from "../src/capability-template.js";
import { FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";

assert.equal(CAPABILITY_TEMPLATE_SCHEMA_VERSION, 31);

const expectedModes = ["project", "notebook"];
const initial = createInitialCapabilityTemplate();
for (const groupId of ["group:novel", "group:short-drama", "group:short-fiction", "group:public-account", "group:short-video"]) {
  assert.deepEqual(initial.groups.find((group) => group.id === groupId)?.workspaceModes, expectedModes, `${groupId} must follow genre rather than workspace mode`);
}

const creativeDeliverableTypes = new Set(["novel", "short_drama_script", "short_fiction", "public_account", "short_video_script", "visual_prompt"]);
const creativeCapabilities = new Set([
  "creative_guidance", "novel_guidance", "short_drama_guidance", "public_account_guidance", "short_fiction_guidance", "short_video_guidance", "prompt_guidance",
  "story_planner", "setting_planner", "novel_prose_writer", "original_script_writer", "adaptation_writer", "short_fiction_writer", "public_account_writer", "short_video_script_writer",
  "visual_prompt_writer", "prompt_writer", "theory_advisor", "effect_reviewer", "memory_advisor", "experience_advisor", "experience_observer", "article_illustration_planner",
]);
const isCreativePolicy = (entry = {}) => (entry.deliverableTypes ?? []).some((type) => creativeDeliverableTypes.has(type))
  || (entry.replacementCapabilities ?? entry.capabilities ?? []).some((capability) => creativeCapabilities.has(capability));
const assertGenreOnlyWorkspacePolicy = (entry, label) => {
  if (!isCreativePolicy(entry)) return;
  assert.ok(entry.workspaceModes?.includes("project"), `${label} must remain usable in a project`);
  assert.ok(entry.workspaceModes?.includes("notebook"), `${label} must remain usable in a notebook`);
};
for (const slot of FIXED_SKILL_SLOT_CATALOG) assertGenreOnlyWorkspacePolicy(slot, slot.id);
for (const module of initial.modules) {
  if (module.deliverableTypes?.length) assertGenreOnlyWorkspacePolicy(module, module.id);
  for (const slot of module.slots) {
    // An empty slot policy inherits the authoritative fixed Skill catalog;
    // only an explicit slot-level workspace restriction can narrow it.
    if (slot.skillId && slot.workspaceModes?.length) assertGenreOnlyWorkspacePolicy(slot, `${module.id}/${slot.id}`);
  }
}

const legacy = structuredClone(initial);
legacy.schemaVersion = 28;
for (const group of legacy.groups) {
  if (group.id.startsWith("group:novel")) group.workspaceModes = ["project"];
}
for (const module of legacy.modules) {
  if (module.id.startsWith("module:novel") || ["module:female-web-theory", "module:creation-experience"].includes(module.id)) {
    module.workspaceModes = ["project"];
    for (const slot of module.slots) if (slot.official) slot.workspaceModes = ["project"];
  }
}
const legacyReconstructor = legacy.modules
  .find((module) => module.id === "module:auxiliary-skills")
  ?.slots.find((slot) => slot.skillId === "builtin:short-drama-script-reconstructor");
legacyReconstructor.workspaceModes = ["project", "general"];
const migrated = normalizeCapabilityTemplate(legacy);
assert.deepEqual(migrated.groups.find((group) => group.id === "group:novel")?.workspaceModes, expectedModes, "saved v28 novel group must migrate away from project-only routing");
assert.deepEqual(
  migrated.modules.find((module) => module.id === "module:auxiliary-skills")?.slots.find((slot) => slot.skillId === "builtin:short-drama-script-reconstructor")?.workspaceModes,
  expectedModes,
  "saved v28 short-drama reconstruction Skill must migrate away from the legacy project/general policy",
);

const route = resolveCapabilityTemplateRouting(migrated, {
  text: "我要写个女频虐文",
  workspaceMode: "notebook",
  activeModule: "manuscript",
  contextDomain: "general",
  deliverableType: "novel",
  requestMode: "creative_guidance",
  requiredCapabilities: ["novel_guidance", "experience_advisor"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
const ids = route.activatedSelections.map((selection) => selection.id);
assert.ok(ids.includes("builtin:creative-guidance"), "notebook novel guidance must load the novel guidance Skill");
assert.ok(ids.includes("builtin:novel-theory-advisor"), "notebook novel routing must first load the upper novel theory advisor");
assert.ok(ids.includes("builtin:female-general-theory"), "female fiction in a notebook must load the female general theory Skill");
assert.ok(!ids.includes("builtin:female-web-theory"), "pure tragic female fiction must not be forced through the female wish-fulfilment theory");
assert.ok(ids.includes("builtin:experience-advisor"), "notebook novel writing may reuse relevant writing experience");

const notebookReconstructionRoute = resolveCapabilityTemplateRouting(migrated, {
  text: "请把我提供的短剧视频逆推成重构剧本",
  workspaceMode: "notebook",
  activeModule: "manuscript",
  contextDomain: "script",
  deliverableType: "short_drama_script",
  requestMode: "creative",
  requiredCapabilities: ["auxiliary_advisor"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
const notebookReconstructor = notebookReconstructionRoute.activatedSelections.find((selection) => selection.id === "builtin:short-drama-script-reconstructor");
assert.ok(notebookReconstructor, "short-drama reconstruction must route in a notebook by genre");
assert.deepEqual(notebookReconstructor.activationPolicy.workspaceModes, expectedModes, "compiled execution policy must explicitly preserve both creative workspace modes");

console.log("Genre-first capability routing across project and notebook passed");
