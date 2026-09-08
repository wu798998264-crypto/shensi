import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilityTemplateNode,
  reorderCapabilityTemplateMember,
} from "../src/capability-template.js";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-skill-panel-drag-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

try {
  const {
    listManagedSkills,
    saveManagedCapabilityTemplate,
    upsertManagedCustomSlot,
    upsertManagedCustomSlotGroup,
  } = await import("../src/server/skill-store.mjs");

  const initial = await listManagedSkills();
  const writer = capabilityTemplateNode(initial.capabilityTemplate.current, "module", "module:novel-writer");
  assert.equal(writer.relationType, "primary-secondary");
  assert.equal(writer.slots.length, 2);

  const reorderedSkills = reorderCapabilityTemplateMember(initial.capabilityTemplate.current, {
    scopeType: "module",
    scopeId: writer.id,
    memberId: writer.slots[1].id,
    targetMemberId: writer.slots[0].id,
    placement: "before",
  });
  const reorderedWriter = capabilityTemplateNode(reorderedSkills, "module", writer.id);
  assert.deepEqual(reorderedWriter.slots.map((slot) => slot.id), [writer.slots[1].id, writer.slots[0].id]);
  assert.deepEqual(reorderedWriter.slots.map((slot) => slot.role), ["primary", "secondary"], "Skill 顺序改变后主要/次要关系必须同步重算");

  const theory = capabilityTemplateNode(reorderedSkills, "group", "group:novel-theory");
  assert.equal(theory.relationType, "organization");
  assert.ok(theory.items.length > 2);
  const reorderedNodes = reorderCapabilityTemplateMember(reorderedSkills, {
    scopeType: "group",
    scopeId: theory.id,
    memberId: theory.items[1].id,
    targetMemberId: theory.items[0].id,
    placement: "before",
  });
  const reorderedTheory = capabilityTemplateNode(reorderedNodes, "group", theory.id);
  assert.equal(reorderedTheory.items[0].id, theory.items[1].id);
  assert.equal(reorderedTheory.items[0].role, "upper", "模块/模组位置改变后上位/下位关系必须同步重算");
  assert.ok(reorderedTheory.items.slice(1).every((item) => item.role === "lower"));

  await saveManagedCapabilityTemplate({
    bundle: reorderedNodes,
    scopeType: "template",
    scopeId: reorderedNodes.template.id,
  });
  const persistedPanel = await listManagedSkills();
  const persistedWriter = capabilityTemplateNode(persistedPanel.capabilityTemplate.current, "module", writer.id);
  const persistedTheory = capabilityTemplateNode(persistedPanel.capabilityTemplate.current, "group", theory.id);
  assert.deepEqual(persistedWriter.slots.map((slot) => slot.id), reorderedWriter.slots.map((slot) => slot.id), "Skill 拖拽顺序必须在重新读取后保留");
  assert.deepEqual(persistedTheory.items.map((item) => item.id), reorderedTheory.items.map((item) => item.id), "模块/模组拖拽顺序必须在重新读取后保留");

  const legacyCatalog = await listManagedSkills();
  const rootSlots = legacyCatalog.customSlots
    .filter((slot) => !slot.parentGroupId)
    .sort((left, right) => Number(left.order) - Number(right.order) || left.id.localeCompare(right.id));
  assert.ok(rootSlots.length >= 2, "测试注册表需要至少两个根级自定义插槽");
  const movedLegacyId = rootSlots.at(-1).id;
  await upsertManagedCustomSlot({ id: movedLegacyId, parentGroupId: "", order: 0 });
  const reorderedLegacy = (await listManagedSkills()).customSlots
    .filter((slot) => !slot.parentGroupId)
    .sort((left, right) => Number(left.order) - Number(right.order));
  assert.equal(reorderedLegacy[0].id, movedLegacyId);
  assert.deepEqual(reorderedLegacy.map((slot) => slot.order), reorderedLegacy.map((_, index) => index), "同组排序必须重建连续且唯一的序号");

  const createdGroup = await upsertManagedCustomSlotGroup({
    name: "拖拽关系验收组",
    description: "验证跨组移动与上位关系清理。",
    groupType: "parallel",
  });
  await upsertManagedCustomSlot({ id: movedLegacyId, parentGroupId: createdGroup.group.id, order: 0 });
  await upsertManagedCustomSlotGroup({
    id: createdGroup.group.id,
    groupType: "organization",
    leaderSlotId: movedLegacyId,
  });
  await upsertManagedCustomSlot({ id: movedLegacyId, parentGroupId: "", order: 0 });
  const movedBackCatalog = await listManagedSkills();
  assert.equal(movedBackCatalog.customSlots.find((slot) => slot.id === movedLegacyId)?.parentGroupId, "", "跨组移动必须持久化父级关系");
  assert.equal(movedBackCatalog.slotGroups.find((group) => group.id === createdGroup.group.id)?.leaderSlotId, "", "上位插槽移出组织组时必须清除失效关系");

  console.log("Skill panel drag, relationship, and persistence contracts passed");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
