import assert from "node:assert/strict";

import { compileManagedRouteBundle } from "../src/managed-route-document.js";

const slot = (id, skillId, description) => ({
  id,
  name: id,
  skillId,
  role: "peer",
  description,
  capabilities: ["novel_prose_writer"],
});

const topology = {
  revision: 9,
  hash: "c".repeat(64),
  capabilityTemplate: {
    template: {
      id: "template:locality",
      name: "稳定路由面板",
      description: "在顶层选择创作或辅助能力。",
      relationType: "parallel",
      items: [
        { id: "place:writing", targetType: "group", targetId: "group:writing", role: "peer" },
        { id: "place:auxiliary", targetType: "group", targetId: "group:auxiliary", role: "peer" },
      ],
    },
    groups: [
      {
        id: "group:writing",
        name: "写作模组",
        description: "组织正文主笔与质量复核。",
        relationType: "parallel",
        deliverableTypes: ["novel"],
        items: [
          { id: "place:writer", targetType: "module", targetId: "module:writer", role: "peer" },
          { id: "place:review", targetType: "module", targetId: "module:review", role: "peer" },
        ],
      },
      {
        id: "group:auxiliary",
        name: "辅助模组",
        description: "处理独立辅助任务。",
        relationType: "parallel",
        items: [
          { id: "place:helper", targetType: "module", targetId: "module:helper", role: "peer" },
        ],
      },
    ],
    modules: [
      {
        id: "module:writer",
        name: "正文主笔模块",
        description: "完成小说正文。",
        relationType: "parallel",
        slots: [slot("slot:writer", "skill:writer", "生成正式正文。")],
      },
      {
        id: "module:review",
        name: "质量复核模块",
        description: "检查正文质量。",
        relationType: "parallel",
        slots: [slot("slot:review", "skill:review", "检查节奏与一致性。")],
      },
      {
        id: "module:helper",
        name: "辅助模块",
        description: "提供独立辅助能力。",
        relationType: "parallel",
        slots: [slot("slot:helper", "skill:helper", "完成辅助任务。")],
      },
    ],
  },
};

const skills = [
  { id: "skill:writer", name: "正文主笔", capabilities: ["novel_prose_writer"] },
  { id: "skill:review", name: "质量复核", capabilities: ["effect_reviewer"] },
  { id: "skill:helper", name: "辅助能力", capabilities: ["auxiliary_advisor"] },
];

const compile = (value) => compileManagedRouteBundle({ topology: value, skills });
const entries = (bundle) => [bundle.panel, ...bundle.routes];
const entryMap = (bundle) => new Map(entries(bundle).map((entry) => [entry.placementId, entry]));
const changedRouteIds = (before, after) => {
  const afterRoutes = entryMap(after);
  return entries(before).flatMap((entry) => afterRoutes.get(entry.placementId)?.text === entry.text ? [] : [entry.placementId]);
};
const changedLineCount = (before, after) => {
  const left = String(before).split("\n");
  const right = String(after).split("\n");
  return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => left[index] === right[index] ? 0 : 1)
    .reduce((total, changed) => total + changed, 0);
};
const routeForNode = (bundle, nodeId) => entries(bundle).find((entry) => entry.nodeId === nodeId);

const baseline = compile(topology);
assert.deepEqual(compile(topology), baseline, "相同结构重复编译必须逐字稳定");
assert.equal(baseline.routes.filter((route) => route.kind === "group").length, 2, "每个可达模组必须自动创建路由文档");
assert.equal(baseline.routes.filter((route) => route.kind === "module").length, 3, "每个可达模块必须自动创建路由文档");
assert.equal(new Set(entries(baseline).map((entry) => entry.placementId)).size, entries(baseline).length, "每份路由文档必须绑定唯一位置");
for (const route of entries(baseline)) {
  assert.match(route.text, /^# (?:面板|模组|模块)路由/u);
  assert.match(route.text, /## 路由元数据/u);
  assert.match(route.text, /## 本层职责与决策/u);
  assert.match(route.text, /## 当前层成员/u);
  assert.match(route.text, /## 更新规则/u);
  assert.match(route.text, /微调必须保持最小差异/u);
  assert.match(route.text, /不得因一次局部调整整体重写或扩写路由/u);
  assert.match(route.text, /## 读取顺序/u);
  assert.match(route.text, /## 事实边界/u);
  assert.doesNotMatch(route.text, /\b(?:undefined|null)\b/u);
  assert.ok(route.text.length < 12_000, `路由文档必须保持可控长度：${route.placementId}`);
}

const panelTweak = structuredClone(topology);
panelTweak.capabilityTemplate.template.description = "在顶层稳定选择创作或辅助能力。";
const panelResult = compile(panelTweak);
assert.deepEqual(changedRouteIds(baseline, panelResult), [baseline.panel.placementId], "面板微调只能改变面板路由");
assert.equal(changedLineCount(baseline.panel.text, panelResult.panel.text), 1, "面板职责微调只能改变对应一行");

const groupTweak = structuredClone(topology);
groupTweak.capabilityTemplate.groups.find((group) => group.id === "group:writing").description = "组织正文主笔与成稿质量复核。";
const groupResult = compile(groupTweak);
const writingGroup = routeForNode(baseline, "group:writing");
assert.deepEqual(
  changedRouteIds(baseline, groupResult),
  [baseline.panel.placementId, writingGroup.placementId],
  "模组微调只能改变自身路由和面板中的直接成员摘要",
);
assert.equal(changedLineCount(writingGroup.text, routeForNode(groupResult, "group:writing").text), 1);
assert.equal(routeForNode(groupResult, "module:writer").text, routeForNode(baseline, "module:writer").text, "模组职责微调不得重写下级模块路由");
assert.equal(routeForNode(groupResult, "group:auxiliary").text, routeForNode(baseline, "group:auxiliary").text, "模组职责微调不得波及无关模组");

const moduleTweak = structuredClone(topology);
moduleTweak.capabilityTemplate.modules.find((module) => module.id === "module:writer").description = "完成小说正式正文。";
const moduleResult = compile(moduleTweak);
const writerModule = routeForNode(baseline, "module:writer");
assert.deepEqual(
  changedRouteIds(baseline, moduleResult),
  [writingGroup.placementId, writerModule.placementId],
  "模块微调只能改变自身路由和直接父模组摘要",
);
assert.equal(changedLineCount(writerModule.text, routeForNode(moduleResult, "module:writer").text), 1);
assert.equal(routeForNode(moduleResult, "module:review").text, routeForNode(baseline, "module:review").text, "模块微调不得重写同层模块");
assert.equal(moduleResult.panel.text, baseline.panel.text, "深层模块微调不得重写面板路由");

const slotTweak = structuredClone(topology);
slotTweak.capabilityTemplate.modules.find((module) => module.id === "module:writer").slots[0].description = "生成可直接交付的正式正文。";
const slotResult = compile(slotTweak);
assert.deepEqual(changedRouteIds(baseline, slotResult), [writerModule.placementId], "插槽微调只能改变所属模块路由");
assert.equal(changedLineCount(writerModule.text, routeForNode(slotResult, "module:writer").text), 1);

console.log("managed route locality, quality and controllability checks passed");
