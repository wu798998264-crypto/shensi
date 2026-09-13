import assert from "node:assert/strict";
import { projectConversationAgentSkillCatalog } from "../src/server/conversation-agent-skill-catalog.mjs";
import { createConversationAgentTools } from "../src/server/conversation-agent-tools.mjs";

const skill = (id, name = id) => ({ id, name, description: `${name}说明`, capabilities: [`cap:${id}`], testStatus: "passed" });
const slot = (id, skillId, { disabled = false } = {}) => ({ id: `slot:${id}`, name: id, skillId, disabled });
const moduleNode = (id, relationType, slots, extras = {}) => ({ id: `module:${id}`, nodeType: "module", name: id, relationType, slots, disabled: false, ...extras });
const placement = (id, targetType, targetId) => ({ id: `place:${id}`, targetType, targetId });

const builtins = [
  skill("builtin:outer-upper", "外层上位"),
  skill("builtin:inner-upper", "内层上位"),
  skill("builtin:lower", "下位细分"),
  skill("builtin:primary", "主要"),
  skill("builtin:secondary", "次要"),
  skill("builtin:parallel-a", "并行甲"),
  skill("builtin:parallel-b", "并行乙"),
  skill("builtin:disabled", "已禁用"),
  skill("builtin:detached", "游离"),
];

const template = {
  id: "template:test",
  nodeType: "template",
  name: "测试面板",
  relationType: "parallel",
  disabled: false,
  items: [
    placement("outer", "group", "group:outer"),
    placement("primary", "module", "module:primary"),
    placement("parallel", "module", "module:parallel"),
    placement("disabled", "module", "module:disabled"),
  ],
};

const catalog = projectConversationAgentSkillCatalog({
  builtins,
  fixedSlots: builtins,
  user: [],
  capabilityTemplate: { current: {
    template,
    groups: [
      {
        id: "group:outer", nodeType: "group", name: "外层组织", relationType: "organization", disabled: false,
        items: [placement("outer-upper", "module", "module:outer-upper"), placement("outer-lower", "group", "group:inner")],
      },
      {
        id: "group:inner", nodeType: "group", name: "内层组织", relationType: "organization", disabled: false,
        items: [placement("inner-upper", "module", "module:inner-upper"), placement("inner-lower", "module", "module:lower")],
      },
    ],
    modules: [
      moduleNode("outer-upper", "primary-secondary", [slot("outer-upper", "builtin:outer-upper")]),
      moduleNode("inner-upper", "primary-secondary", [slot("inner-upper", "builtin:inner-upper")]),
      moduleNode("lower", "primary-secondary", [slot("lower", "builtin:lower")]),
      moduleNode("primary", "primary-secondary", [slot("primary", "builtin:primary"), slot("secondary", "builtin:secondary")]),
      moduleNode("parallel", "parallel", [slot("parallel-a", "builtin:parallel-a"), slot("parallel-b", "builtin:parallel-b"), slot("disabled", "builtin:disabled", { disabled: true })]),
      moduleNode("disabled", "parallel", [slot("disabled-node", "builtin:disabled")], { disabled: true }),
      moduleNode("detached", "parallel", [slot("detached", "builtin:detached")]),
    ],
  } },
});

assert.deepEqual(catalog.map((item) => item.id).sort(), [
  "builtin:inner-upper",
  "builtin:lower",
  "builtin:outer-upper",
  "builtin:parallel-a",
  "builtin:parallel-b",
  "builtin:primary",
  "builtin:secondary",
].sort(), "目录只能暴露当前面板可达、启用且有效的 Skill");

const lower = catalog.find((item) => item.id === "builtin:lower");
assert.equal(lower.relationType, "organization");
assert.equal(lower.relationRole, "lower");
assert.deepEqual(lower.requiredUpperSkillIds, ["builtin:outer-upper", "builtin:inner-upper"],
  "嵌套组织关系必须按外层到内层记录上位 Skill");
assert.deepEqual(catalog.find((item) => item.id === "builtin:secondary").requiredUpperSkillIds, [],
  "主次关系中的次要 Skill 是替换，不得自动并用主要 Skill");
assert.deepEqual(catalog.find((item) => item.id === "builtin:parallel-b").requiredUpperSkillIds, [],
  "并行关系不得自动制造依赖");

const readOrder = [];
const events = [];
const tools = createConversationAgentTools({
  catalog,
  readSkill: async (id) => {
    readOrder.push(id);
    return { id, name: builtins.find((item) => item.id === id)?.name || id, text: `规则正文：${id}`, fullText: true };
  },
  emit: async (type, payload) => events.push({ type, payload }),
});
const response = await tools.invoke({ namespace: "skills", tool: "read", arguments: { id: "builtin:lower" } });
assert.equal(response.success, true);
const loaded = JSON.parse(response.contentItems[0].text);
assert.deepEqual(readOrder, ["builtin:outer-upper", "builtin:inner-upper", "builtin:lower"],
  "读取下位 Skill 时必须先真实读取外层和内层上位 Skill");
assert.deepEqual(events.filter((event) => event.type === "resource_read").map((event) => event.payload.id), readOrder,
  "每个真实读取的上位和下位 Skill 都必须进入任务卡证据");
assert.deepEqual(loaded.loadedSkills.map((item) => item.id), readOrder);
assert.ok(loaded.text.indexOf("builtin:outer-upper") < loaded.text.indexOf("builtin:inner-upper"));
assert.ok(loaded.text.indexOf("builtin:inner-upper") < loaded.text.indexOf("builtin:lower"));

const duplicateCatalog = projectConversationAgentSkillCatalog({
  builtins: [skill("builtin:upper-one"), skill("builtin:upper-two"), skill("builtin:shared-lower")],
  fixedSlots: [skill("builtin:upper-one"), skill("builtin:upper-two"), skill("builtin:shared-lower")],
  user: [],
  capabilityTemplate: { current: {
    template: { id: "template:duplicates", nodeType: "template", name: "重复位置", relationType: "parallel", items: [placement("one", "group", "group:one"), placement("two", "group", "group:two")] },
    groups: [
      { id: "group:one", nodeType: "group", name: "组织一", relationType: "organization", items: [placement("one-upper", "module", "module:upper-one"), placement("one-lower", "module", "module:shared-one")] },
      { id: "group:two", nodeType: "group", name: "组织二", relationType: "organization", items: [placement("two-upper", "module", "module:upper-two"), placement("two-lower", "module", "module:shared-two")] },
    ],
    modules: [
      moduleNode("upper-one", "parallel", [slot("upper-one", "builtin:upper-one")]),
      moduleNode("upper-two", "parallel", [slot("upper-two", "builtin:upper-two")]),
      moduleNode("shared-one", "parallel", [slot("shared-one", "builtin:shared-lower")]),
      moduleNode("shared-two", "parallel", [slot("shared-two", "builtin:shared-lower")]),
    ],
  } },
});
const shared = duplicateCatalog.find((item) => item.id === "builtin:shared-lower");
assert.equal(shared.requiresPlacementSelection, true, "同一 Skill 在不同组织路径中不得合并成无关上位 Skill 的并集");
assert.equal(shared.requiredUpperSkillIds.length, 0);
const duplicateReads = [];
const duplicateTools = createConversationAgentTools({
  catalog: duplicateCatalog,
  readSkill: async (id) => { duplicateReads.push(id); return { id, name: id, text: `规则正文：${id}`, fullText: true }; },
});
const ambiguous = await duplicateTools.invoke({ namespace: "skills", tool: "read", arguments: { id: shared.id } });
assert.equal(ambiguous.success, false);
assert.match(ambiguous.contentItems[0].text, /placementId/u, "歧义关系必须明确反馈，不能静默多读无关 Skill");
const firstPlacement = shared.placements.find((item) => item.path.some((part) => part.id === "group:one"));
const placed = await duplicateTools.invoke({ namespace: "skills", tool: "read", arguments: { id: shared.id, placementId: firstPlacement.placementId } });
assert.equal(placed.success, true);
assert.deepEqual(duplicateReads, ["builtin:upper-one", "builtin:shared-lower"]);

const fallback = projectConversationAgentSkillCatalog({ builtins: [skill("builtin:fallback")], user: [], capabilityTemplate: null });
assert.deepEqual(fallback.map((item) => item.id), ["builtin:fallback"],
  "面板暂时不可读取时必须安全回退，不能让对话 Agent 失去全部 Skill");

console.log("Conversation Agent Skill relationship projection checks passed");
