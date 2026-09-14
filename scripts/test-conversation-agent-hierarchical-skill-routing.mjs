import assert from "node:assert/strict";

import { catalogWithManagedPlacements, compileManagedRouteBundle } from "../src/managed-route-document.js";
import { createConversationAgentTools } from "../src/server/conversation-agent-tools.mjs";

const topology = {
  revision: 3,
  hash: "c".repeat(64),
  capabilityTemplate: {
    template: { id: "template:test", name: "测试面板", relationType: "parallel", items: [
      { id: "p:fiction", targetType: "group", targetId: "group:fiction" },
      { id: "p:shared-root", targetType: "module", targetId: "module:shared" },
    ] },
    groups: [
      { id: "group:fiction", name: "小说模组", relationType: "organization", items: [
        { id: "p:theory", targetType: "module", targetId: "module:theory", role: "upper" },
        { id: "p:special", targetType: "module", targetId: "module:special", role: "lower" },
        { id: "p:shared-lower", targetType: "module", targetId: "module:shared", role: "lower" },
      ] },
    ],
    modules: [
      { id: "module:theory", name: "理论模块", relationType: "parallel", slots: [{ id: "slot:theory", skillId: "skill:theory" }] },
      { id: "module:special", name: "专项模块", relationType: "organization", slots: [
        { id: "slot:general", skillId: "skill:general", role: "upper" },
        { id: "slot:special", skillId: "skill:special", role: "lower" },
      ] },
      { id: "module:shared", name: "共享模块", relationType: "primary-secondary", slots: [
        { id: "slot:shared", skillId: "skill:shared", role: "primary" },
        { id: "slot:shared-secondary", skillId: "skill:shared-secondary", role: "secondary" },
      ] },
    ],
  },
};
const baseCatalog = [
  { id: "skill:theory", name: "通用理论" },
  { id: "skill:general", name: "分类通用" },
  { id: "skill:special", name: "专项写作" },
  { id: "skill:shared", name: "共享写作" },
  { id: "skill:shared-secondary", name: "共享辅助写作" },
];
const routeBundle = compileManagedRouteBundle({ topology, skills: baseCatalog });
const catalog = catalogWithManagedPlacements({ catalog: baseCatalog, routeBundle });
const special = routeBundle.skillPlacements.find((placement) => placement.skillId === "skill:special");
assert.ok(special);

const events = [], reads = [];
const tools = createConversationAgentTools({
  requestId: "route-test",
  sourceMessageId: "route-user",
  instruction: "完成专项任务",
  catalog,
  routeBundle,
  readSkill: async (id) => {
    reads.push(id);
    return { id, name: baseCatalog.find((skill) => skill.id === id)?.name, text: `${id}全文`, fullText: true };
  },
  emit: async (type, payload) => events.push({ type, payload }),
  signal: new AbortController().signal,
});
const invoke = async (namespace, tool, args) => {
  const result = await tools.invoke({ namespace, tool, arguments: args });
  return { success: result.success, value: JSON.parse(result.contentItems[0].text) };
};

const moduleRoute = await invoke("routes", "read", { placementId: special.modulePlacementId });
assert.equal(moduleRoute.success, true);
assert.equal(moduleRoute.value.routes.at(-1).name, "专项模块");
assert.ok(moduleRoute.value.routes.some((route) => route.name === "小说模组"), "直接读取模块时必须自动补齐祖先模组路由");

const automatic = await invoke("skills", "read", { placementId: special.placementId });
assert.equal(automatic.success, true);
assert.deepEqual(automatic.value.loadedSkills.map((skill) => skill.id), ["skill:theory", "skill:general", "skill:special"]);
assert.equal(automatic.value.upperParticipation, "auto");
assert.ok(automatic.value.routeContext.some((route) => route.name === "小说模组"));
assert.ok(automatic.value.routeContext.some((route) => route.name === "专项模块"));
assert.deepEqual(reads, ["skill:theory", "skill:general", "skill:special"]);

await invoke("skills", "read", { placementId: special.placementId, upperParticipation: "include" });
assert.deepEqual(reads, ["skill:theory", "skill:general", "skill:special"], "同一任务重复读取必须复用真实 Skill 内容");
assert.equal(events.filter((event) => event.type === "resource_read").length, 3);
assert.ok(events.some((event) => event.type === "route_read"));
assert.ok(events.some((event) => event.type === "route_decision" && event.payload.upperParticipation === "auto"));

const missingReason = await invoke("skills", "read", { placementId: special.placementId, upperParticipation: "skip" });
assert.equal(missingReason.success, false);
assert.match(missingReason.value.error, /必须说明/u);

const skipReads = [], skipEvents = [];
const skipTools = createConversationAgentTools({
  requestId: "route-skip-test",
  sourceMessageId: "route-skip-user",
  instruction: "用户已经提供完整提取结果，只执行专项写作",
  catalog,
  routeBundle,
  readSkill: async (id) => { skipReads.push(id); return { id, text: `${id}全文`, fullText: true }; },
  emit: async (type, payload) => skipEvents.push({ type, payload }),
  signal: new AbortController().signal,
});
const skippedRaw = await skipTools.invoke({ namespace: "skills", tool: "read", arguments: { placementId: special.placementId, upperParticipation: "skip", upperReason: "用户已提供完整的上位提取结果，本轮仅做后续专项加工" } });
assert.equal(skippedRaw.success, true, skippedRaw.contentItems[0].text);
assert.deepEqual(skipReads, ["skill:special"]);
assert.ok(skipEvents.some((event) => event.type === "route_decision" && event.payload.reason));

const shared = catalog.find((skill) => skill.id === "skill:shared");
assert.equal(shared.placements.length, 2);
const ambiguous = await invoke("skills", "read", { id: "skill:shared" });
assert.equal(ambiguous.success, false);
assert.match(ambiguous.value.error, /多个面板位置/u);
const exact = await invoke("skills", "read", { placementId: shared.placements[0].placementId });
assert.equal(exact.success, true);
assert.equal(exact.value.loadedSkills.at(-1).id, "skill:shared");
const secondaryAtRoot = catalog.find((skill) => skill.id === "skill:shared-secondary").placements.find((placement) => !placement.pathNames.includes("小说模组"));
const secondary = await invoke("skills", "read", { placementId: secondaryAtRoot.placementId });
assert.equal(secondary.success, true);
assert.deepEqual(secondary.value.loadedSkills.map((skill) => skill.id), ["skill:shared-secondary"], "主次关系选择次要时不得把主要误当作组织上位自动叠加");

console.log("conversation Agent hierarchical Skill routing tests passed");
