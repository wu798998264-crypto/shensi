import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  capabilityTemplateNode,
  createInitialCapabilityTemplate,
  normalizeCapabilityTemplate,
  pruneCapabilityTemplateEmptySlots,
  removeCapabilityTemplateSlot,
  validateCapabilityTemplate,
} from "../src/capability-template.js";
import { FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";

const initial = createInitialCapabilityTemplate();
const scrambledRoles = structuredClone(initial);
const scrambledWriter = scrambledRoles.modules.find((module) => module.id === "module:novel-writer");
scrambledWriter.slots[0].role = "secondary";
scrambledWriter.slots[1].role = "primary";
const normalizedRoles = normalizeCapabilityTemplate(scrambledRoles).modules.find((module) => module.id === "module:novel-writer").slots.map((slot) => slot.role);
assert.deepEqual(normalizedRoles, ["primary", "secondary"], "旧角色字段排错时必须按当前顺序自动恢复主要/次要，不形成保存门禁");
assert.equal(validateCapabilityTemplate(scrambledRoles).valid, true, "旧角色字段错乱不得阻止保存");
const promptWriterId = "module:prompt-writer";
const promptWriter = capabilityTemplateNode(initial, "module", promptWriterId);
assert.ok(promptWriter);
assert.ok(promptWriter.slots.length >= 2);

const removedSlotId = promptWriter.slots[0].id;
const afterRemoval = removeCapabilityTemplateSlot(initial, { moduleId: promptWriterId, slotId: removedSlotId });
const updatedPromptWriter = capabilityTemplateNode(afterRemoval, "module", promptWriterId);
assert.equal(updatedPromptWriter.slots.some((slot) => slot.id === removedSlotId), false, "拔除后插槽必须从模块结构中移除");
assert.equal(validateCapabilityTemplate(afterRemoval).valid, true, "删除主要插槽后剩余插槽应按关系重新成为主要插槽");

const withEmpty = structuredClone(afterRemoval);
withEmpty.modules.find((module) => module.id === promptWriterId).slots.push({
  id: "slot:legacy-empty",
  name: "遗留空插槽",
  skillId: "",
  fixedSlotId: "builtin:prompt-writer",
  official: true,
});
const pruned = pruneCapabilityTemplateEmptySlots(withEmpty);
assert.equal(
  capabilityTemplateNode(pruned, "module", promptWriterId).slots.some((slot) => slot.id === "slot:legacy-empty"),
  false,
  "历史遗留空插槽不得继续显示或落盘",
);

const emptyModule = structuredClone(initial);
const emptyModuleId = "module:novel-guidance";
const guidance = capabilityTemplateNode(emptyModule, "module", emptyModuleId);
for (const slot of [...guidance.slots]) {
  const next = removeCapabilityTemplateSlot(emptyModule, { moduleId: emptyModuleId, slotId: slot.id });
  emptyModule.modules = next.modules;
  emptyModule.groups = next.groups;
  emptyModule.template = next.template;
}
assert.equal(capabilityTemplateNode(emptyModule, "module", emptyModuleId).slots.length, 0, "最后一个插槽也应允许拔除");
assert.equal(validateCapabilityTemplate(emptyModule).valid, true, "空模块应保持可保存并可重新添加插槽");

assert.equal(capabilityTemplateNode(initial, "module", "module:novel-engineering"), null, "工程化管理不再作为可路由 Skill 模块");
assert.equal(FIXED_SKILL_SLOT_CATALOG.some((slot) => slot.id === "builtin:structure-engineering"), false, "固定 Skill 目录不得继续暴露工程化管理占位 Skill");

const legacyEngineering = structuredClone(initial);
legacyEngineering.schemaVersion = 30;
legacyEngineering.modules.push({
  id: "module:novel-engineering", nodeType: "module", name: "工程化管理机制", relationType: "parallel", official: true,
  slots: [{ id: "slot:novel-engineering", name: "工程化管理", skillId: "builtin:structure-engineering", fixedSlotId: "builtin:structure-engineering", official: true }],
});
legacyEngineering.groups.find((group) => group.id === "group:novel").items.push({
  id: "place:novel:engineering", targetType: "module", targetId: "module:novel-engineering", role: "peer",
});
const migratedEngineering = normalizeCapabilityTemplate(legacyEngineering);
assert.equal(capabilityTemplateNode(migratedEngineering, "module", "module:novel-engineering"), null, "旧面板升级后必须清除工程化管理模块");
assert.equal(capabilityTemplateNode(migratedEngineering, "group", "group:novel").items.some((item) => item.targetId === "module:novel-engineering"), false, "旧工程化管理位置不得残留在长篇模组");
const pollutedCurrentSnapshot = structuredClone(legacyEngineering);
pollutedCurrentSnapshot.schemaVersion = initial.schemaVersion;
assert.equal(capabilityTemplateNode(normalizeCapabilityTemplate(pollutedCurrentSnapshot), "module", "module:novel-engineering"), null, "恢复版本号较新的污染快照时也不得复活工程化管理模块");
const customReservedId = structuredClone(initial);
customReservedId.modules.push({
  id: "module:novel-engineering", nodeType: "module", name: "用户自建模块", relationType: "parallel", official: false,
  slots: [{ id: "slot:user-owned", name: "用户能力", skillId: "user:owned-skill", official: false }],
});
assert.equal(capabilityTemplateNode(normalizeCapabilityTemplate(customReservedId), "module", "module:novel-engineering")?.name, "用户自建模块", "仅复用保留 ID 但不符合旧官方指纹的用户节点不得被误删");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server/skill-store.mjs", import.meta.url), "utf8");
assert.match(app, /removeCapabilityTemplateSlot\(bundle, \{ moduleId: scope\.node\.id, slotId \}\)/u);
assert.match(app, /const members = scope\.scopeType === "module"[\s\S]{0,180}\.filter\(\(slot\) => Boolean\(slot\.skillId\)\)/u);
assert.match(app, /const renderMember = \(member\) => scope\.scopeType === "module"[\s\S]{0,120}renderCapabilitySkillCell/u);
assert.match(server, /const adapted = pruneCapabilityTemplateEmptySlots\(bundle\)/u);

console.log("capability slot removal and re-add lifecycle contracts passed");
