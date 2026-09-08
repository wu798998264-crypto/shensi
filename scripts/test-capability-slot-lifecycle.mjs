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

const initial = createInitialCapabilityTemplate();
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

assert.throws(
  () => removeCapabilityTemplateSlot(initial, { moduleId: "module:novel-engineering", slotId: "slot:novel-engineering" }),
  /内置运行机制/u,
  "内核工程模块仍必须禁止拔除",
);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server/skill-store.mjs", import.meta.url), "utf8");
assert.match(app, /removeCapabilityTemplateSlot\(bundle, \{ moduleId: scope\.node\.id, slotId \}\)/u);
assert.match(app, /\.filter\(\(slot\) => Boolean\(slot\.skillId\)\)\.map\(\(slot\) => renderCapabilitySkillCell/u);
assert.match(server, /const adapted = pruneCapabilityTemplateEmptySlots\(bundle\)/u);

console.log("capability slot removal and re-add lifecycle contracts passed");
