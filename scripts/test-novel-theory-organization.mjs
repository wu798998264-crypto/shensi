import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  createInitialCapabilityTemplate,
  normalizeCapabilityTemplate,
  resolveCapabilityTemplateRouting,
} from "../src/capability-template.js";
import { FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";
import { loadOfficialSkill } from "../src/server/skill-store.mjs";
import { loadTypeTheoryContext } from "../src/server/shensi-context.mjs";

const shensiRoot = fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url));
assert.equal(CAPABILITY_TEMPLATE_SCHEMA_VERSION, 29);

const template = createInitialCapabilityTemplate();
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const theoryGroup = template.groups.find((group) => group.id === "group:novel-theory");
assert.equal(theoryGroup.relationType, "organization");
assert.deepEqual(theoryGroup.items.map((item) => item.role), ["upper", "lower", "lower", "lower", "lower"]);
assert.match(appSource, /const renderCapabilityNodeCell = \(item, node, scope\) => \{[\s\S]{0,500}capabilityRoleLabel\(item\?\.role \|\| "peer"\)/u,
  "模组内部卡片必须显示其在父模组中的上位/下位角色，不能误显子模块自己的并行关系");
assert.equal(theoryGroup.items[0].targetId, "module:novel-theory-advisor");

const advisor = template.modules.find((module) => module.id === "module:novel-theory-advisor");
assert.equal(advisor.slots[0].skillId, "builtin:novel-theory-advisor");
const female = template.modules.find((module) => module.id === "module:female-web-theory");
assert.equal(female.relationType, "organization");
assert.deepEqual(female.slots.map((slot) => slot.skillId), [
  "builtin:female-general-theory",
  "builtin:female-web-theory",
  "builtin:true-false-heiress-theory",
]);
assert.deepEqual(female.slots.map((slot) => slot.role), ["upper", "lower", "lower"]);

const legacy = structuredClone(template);
legacy.schemaVersion = 26;
legacy.modules = legacy.modules.filter((module) => module.id !== "module:novel-theory-advisor");
const legacyFemale = legacy.modules.find((module) => module.id === "module:female-web-theory");
legacyFemale.name = "女频爽文理论模块";
legacyFemale.relationType = "organization";
legacyFemale.slots = legacyFemale.slots.filter((slot) => ![
  "builtin:female-general-theory",
].includes(slot.skillId));
legacyFemale.slots[0].skillId = "user:custom-female-payoff";
legacyFemale.slots[0].disabled = true;
legacyFemale.slots.push({
  id: "slot:custom-female-theory",
  name: "用户女频理论",
  skillId: "user:custom-female-theory",
  fixedSlotId: "",
  disabled: true,
  official: false,
});
const legacyTheoryGroup = legacy.groups.find((group) => group.id === "group:novel-theory");
legacyTheoryGroup.relationType = "parallel";
legacyTheoryGroup.items = legacyTheoryGroup.items.filter((item) => item.targetId !== "module:novel-theory-advisor");
const migrated = normalizeCapabilityTemplate(legacy);
const migratedTheory = migrated.groups.find((group) => group.id === "group:novel-theory");
assert.equal(migratedTheory.relationType, "organization");
assert.equal(migratedTheory.items[0].targetId, "module:novel-theory-advisor");
assert.deepEqual(migratedTheory.items.map((item) => item.role), ["upper", "lower", "lower", "lower", "lower"]);
const migratedFemale = migrated.modules.find((module) => module.id === "module:female-web-theory");
assert.equal(migratedFemale.slots[0].skillId, "builtin:female-general-theory");
assert.equal(migratedFemale.slots[1].skillId, "user:custom-female-payoff", "用户对原爽文插槽的绑定必须保留");
assert.equal(migratedFemale.slots[1].disabled, true, "用户对原爽文插槽的禁用状态必须保留");
assert.equal(migratedFemale.slots.at(-1).skillId, "user:custom-female-theory", "用户自定义插槽必须保留");

const theoryIds = new Set([
  "builtin:novel-theory-advisor",
  "builtin:female-general-theory",
  "builtin:female-web-theory",
  "builtin:true-false-heiress-theory",
]);
const routeFor = (text) => resolveCapabilityTemplateRouting(template, {
  text,
  workspaceMode: "project",
  contextDomain: "novel",
  deliverableType: "novel",
  requiredCapabilities: ["novel_prose_writer"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
const routeTheory = (text) => routeFor(text).activatedSelections.map((selection) => selection.id).filter((id) => theoryIds.has(id));

const pureAbuse = routeTheory("我要写一个女频虐文正文");
assert.deepEqual(pureAbuse, [
  "builtin:novel-theory-advisor",
  "builtin:female-general-theory",
]);
assert.ok(!pureAbuse.includes("builtin:female-web-theory"), "纯虐文不得调用女频爽文理论");
const pureAbusePlan = routeFor("我要写一个女频虐文正文");
const pureAbuseSelections = pureAbusePlan.activatedSelections.filter((selection) => theoryIds.has(selection.id));
assert.ok(pureAbuseSelections.every((selection) => selection.organizationGroupId === "group:novel-theory"), "嵌套理论模块必须共享上位理论模组的组织预算");
assert.equal(pureAbusePlan.compiledCapabilityPlan.budgets.used.advisor, 1, "同一小说理论组织只占用一份顾问预算");

const abuseThenPayoff = routeTheory("写一篇先虐后爽的女频小说正文");
assert.deepEqual(new Set(abuseThenPayoff), new Set([
  "builtin:novel-theory-advisor",
  "builtin:female-general-theory",
  "builtin:female-web-theory",
]));

const heiress = routeTheory("写一个真假千金女频正文");
assert.deepEqual(new Set(heiress), new Set([
  "builtin:novel-theory-advisor",
  "builtin:female-general-theory",
  "builtin:true-false-heiress-theory",
]));
assert.ok(!heiress.includes("builtin:female-web-theory"), "真假千金未明确爽文时不得自动追加爽文理论");

const ordinaryFemale = routeTheory("写一个普通女频现言正文");
assert.deepEqual(new Set(ordinaryFemale), new Set([
  "builtin:novel-theory-advisor",
  "builtin:female-general-theory",
]));

const explicitUnknownTheory = routeTheory("使用小说理论顾问分析一个尚未分类的新题材");
assert.deepEqual(explicitUnknownTheory, ["builtin:novel-theory-advisor"], "没有下位理论命中时必须由上位小说理论顾问返回");

const pureAbuseContext = await loadTypeTheoryContext({
  shensiRoot,
  prompt: "我要写一个女频虐文正文",
  workspaceKind: "project",
});
assert.match(pureAbuseContext.label, /女频通用理论/u);
assert.match(pureAbuseContext.promptText, /# 小说类型理论研究/u);
assert.match(pureAbuseContext.promptText, /# 女频小说通用理论/u);
assert.doesNotMatch(pureAbuseContext.promptText, /# 女频爽文创作概论/u);

const payoffContext = await loadTypeTheoryContext({
  shensiRoot,
  prompt: "写一篇先虐后爽的女频小说正文",
  workspaceKind: "project",
});
assert.match(payoffContext.label, /女频通用理论 \+ 女频爽文/u);
assert.match(payoffContext.promptText, /# 女频爽文创作概论/u);

for (const id of ["builtin:novel-theory-advisor", "builtin:female-general-theory"]) {
  const skill = await loadOfficialSkill({ id, shensiRoot });
  assert.equal(skill.testStatus, "passed");
  assert.ok(skill.content.length > 1_000, `${id} 必须读取完整官方理论内容`);
}

console.log("Novel theory organization and female-genre routing checks passed");
