import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilityTemplateNode,
  resolveCapabilityTemplateRouting,
  reorderCapabilityTemplateMember,
  swapCapabilityTemplateMembers,
} from "../src/capability-template.js";
import { BUILTIN_SKILL_CATALOG } from "../src/module-registry.js";

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

  const primaryFixture = structuredClone(initial.capabilityTemplate.current);
  const primaryModule = capabilityTemplateNode(primaryFixture, "module", writer.id);
  primaryModule.slots.push({
    ...structuredClone(primaryModule.slots[1]),
    id: "slot:novel-writer-third-candidate",
    name: "第三候选主笔",
    description: "交换时必须与完整插槽对象一起移动。",
    triggerRules: "第三候选测试规则",
  });
  const swappedPrimary = swapCapabilityTemplateMembers(primaryFixture, {
    scopeType: "module",
    scopeId: writer.id,
    memberId: primaryModule.slots[2].id,
    targetMemberId: primaryModule.slots[0].id,
  });
  const swappedPrimaryModule = capabilityTemplateNode(swappedPrimary, "module", writer.id);
  assert.deepEqual(swappedPrimaryModule.slots.map((slot) => slot.id), [
    "slot:novel-writer-third-candidate",
    writer.slots[1].id,
    writer.slots[0].id,
  ], "主次关系必须支持末位候选与主要节点精确交换");
  assert.deepEqual(swappedPrimaryModule.slots.map((slot) => slot.role), ["primary", "secondary", "secondary"]);
  assert.equal(swappedPrimaryModule.slots[0].triggerRules, "第三候选测试规则", "精确交换必须保留完整插槽对象字段");

  const routeOptions = {
    text: "我要写小说正文",
    workspaceMode: "project",
    contextDomain: "novel",
    deliverableType: "novel",
    requiredCapabilities: ["novel_prose_writer"],
    fixedSlots: BUILTIN_SKILL_CATALOG,
  };
  const beforePrimaryRoute = resolveCapabilityTemplateRouting(initial.capabilityTemplate.current, routeOptions);
  const afterPrimaryRoute = resolveCapabilityTemplateRouting(swappedPrimary, routeOptions);
  assert.equal(beforePrimaryRoute.activatedSelections.find((selection) => selection.templateModuleId === writer.id)?.id, "builtin:novel-writer", "交换前路由应使用原主要 Skill");
  assert.equal(afterPrimaryRoute.activatedSelections.find((selection) => selection.templateModuleId === writer.id)?.id, "builtin:chinese-novelist-skill", "交换后 Agent 路由必须使用新的主要 Skill");

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

  const swappedTheory = swapCapabilityTemplateMembers(reorderedSkills, {
    scopeType: "group",
    scopeId: theory.id,
    memberId: theory.items[2].id,
    targetMemberId: theory.items[0].id,
  });
  const swappedTheoryNode = capabilityTemplateNode(swappedTheory, "group", theory.id);
  assert.deepEqual(swappedTheoryNode.items.slice(0, 3).map((item) => item.id), [
    theory.items[2].id,
    theory.items[1].id,
    theory.items[0].id,
  ], "组织关系必须支持下位节点与上位节点精确交换");
  assert.deepEqual(swappedTheoryNode.items.map((item) => item.role), ["upper", "lower", "lower", "lower", "lower"]);

  const beforeTheoryRoute = resolveCapabilityTemplateRouting(reorderedSkills, {
    text: "使用小说理论顾问分析一个尚未分类的新题材",
    workspaceMode: "project",
    contextDomain: "novel",
    deliverableType: "novel",
    requiredCapabilities: ["novel_prose_writer"],
    fixedSlots: BUILTIN_SKILL_CATALOG,
  });
  const afterTheoryRoute = resolveCapabilityTemplateRouting(swappedTheory, {
    text: "使用小说理论顾问分析一个尚未分类的新题材",
    workspaceMode: "project",
    contextDomain: "novel",
    deliverableType: "novel",
    requiredCapabilities: ["novel_prose_writer"],
    fixedSlots: BUILTIN_SKILL_CATALOG,
  });
  const beforeTheorySelection = beforeTheoryRoute.activatedSelections.find((selection) => selection.id === "builtin:novel-theory-advisor");
  const afterTheorySelection = afterTheoryRoute.activatedSelections.find((selection) => selection.id === "builtin:novel-theory-advisor");
  assert.equal(beforeTheorySelection?.relationRole, "upper", "交换前路由应识别原上位理论");
  assert.equal(afterTheorySelection?.relationRole, "lower", "交换后 Agent 路由必须读取新的上位/下位关系");

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

  assert.throws(() => swapCapabilityTemplateMembers(initial.capabilityTemplate.current, {
    scopeType: "module",
    scopeId: writer.id,
    memberId: writer.slots[0].id,
    targetMemberId: theory.items[0].id,
  }), /找不到要交换的插槽或目标位置/u, "不同作用域的成员不得跨容器交换");
  const novelGroup = capabilityTemplateNode(initial.capabilityTemplate.current, "group", "group:novel");
  const kernelPlacement = novelGroup.items.find((item) => item.targetId === "module:novel-engineering");
  const movablePlacement = novelGroup.items.find((item) => item.targetId !== "module:novel-engineering");
  assert.ok(kernelPlacement && movablePlacement, "测试面板应包含内置工程机制和普通模块");
  assert.throws(() => swapCapabilityTemplateMembers(initial.capabilityTemplate.current, {
    scopeType: "group",
    scopeId: novelGroup.id,
    memberId: kernelPlacement.id,
    targetMemberId: movablePlacement.id,
  }), /内置运行机制不可调整位置/u, "内置锁定节点不得参与精确交换");
  assert.throws(() => swapCapabilityTemplateMembers(initial.capabilityTemplate.current, {
    scopeType: "group",
    scopeId: novelGroup.id,
    memberId: movablePlacement.id,
    targetMemberId: kernelPlacement.id,
  }), /内置运行机制不可调整位置/u, "内置锁定目标不得被普通节点替换");

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
