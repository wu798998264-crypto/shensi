import assert from "node:assert/strict";
import {
  SKILL_CAPABILITY_CATEGORIES,
  resolveSkillCapabilitiesFromCategories,
  skillCapabilityCategoryIds,
  skillCapabilityCategoryLabels,
} from "../src/skill-capability-categories.js";
import { CAPABILITY_DESCRIPTOR_REGISTRY } from "../src/capability-registry.js";

const other = SKILL_CAPABILITY_CATEGORIES.find((category) => category.id === "other");
assert.deepEqual(other, { id: "other", label: "其他", defaultCapability: "other_capability" });
assert.ok(CAPABILITY_DESCRIPTOR_REGISTRY.other_capability, "其他分类必须具有可保存、可校验的能力描述");
assert.deepEqual(resolveSkillCapabilitiesFromCategories({ categories: ["other"] }), ["other_capability"]);
assert.deepEqual(skillCapabilityCategoryIds(["other_capability"]), ["other"]);
assert.deepEqual(skillCapabilityCategoryLabels(["other_capability"]), ["其他"]);

console.log("Skill capability category 'other' tests passed");
