import assert from "node:assert/strict";

import { catalogWithManagedPlacements, compileManagedRouteBundle } from "../src/managed-route-document.js";

const moduleNode = (id, name, relationType, slots) => ({ id, name, relationType, triggerRules: `${name}路由规则`, slots });
const skillSlot = (id, skillId, role) => ({ id, skillId, role, name: id, triggerRules: `${id}用途` });

const topology = {
  revision: 12,
  hash: "b".repeat(64),
  capabilityTemplate: {
    template: {
      id: "template:main",
      name: "创作面板",
      relationType: "parallel",
      triggerRules: "只选择顶层能力分支",
      items: [
        { id: "placement:fiction", targetType: "group", targetId: "group:fiction", role: "peer" },
        { id: "placement:image", targetType: "module", targetId: "module:image", role: "peer" },
        { id: "placement:shared-root", targetType: "module", targetId: "module:shared", role: "peer" },
      ],
    },
    groups: [
      {
        id: "group:fiction",
        name: "小说模组",
        relationType: "organization",
        triggerRules: "小说任务先判断理论层级",
        items: [
          { id: "placement:advisor", targetType: "module", targetId: "module:advisor", role: "upper" },
          { id: "placement:female", targetType: "group", targetId: "group:female", role: "lower" },
          { id: "placement:shared-fiction", targetType: "module", targetId: "module:shared", role: "lower" },
        ],
      },
      {
        id: "group:female",
        name: "女频模组",
        relationType: "organization",
        triggerRules: "女频任务按通用加专精处理",
        items: [
          { id: "placement:female-general", targetType: "module", targetId: "module:female-general", role: "upper" },
          { id: "placement:identity", targetType: "module", targetId: "module:identity", role: "lower" },
        ],
      },
    ],
    modules: [
      moduleNode("module:advisor", "小说理论顾问", "parallel", [skillSlot("slot:advisor", "skill:advisor", "peer")]),
      moduleNode("module:female-general", "女频通用理论", "parallel", [skillSlot("slot:female-general", "skill:female-general", "peer")]),
      moduleNode("module:identity", "真假千金", "parallel", [skillSlot("slot:identity", "skill:identity", "peer")]),
      moduleNode("module:image", "图片资产", "organization", [
        skillSlot("slot:image-main", "skill:image-main", "upper"),
        skillSlot("slot:image-character", "skill:image-character", "lower"),
      ]),
      moduleNode("module:shared", "共享模块", "primary-secondary", [
        skillSlot("slot:shared-main", "skill:shared-main", "primary"),
        skillSlot("slot:shared-secondary", "skill:shared-secondary", "secondary"),
      ]),
    ],
  },
};

const skills = [
  { id: "skill:advisor", name: "小说理论顾问" },
  { id: "skill:female-general", name: "女频通用理论" },
  { id: "skill:identity", name: "真假千金" },
  { id: "skill:image-main", name: "图片资产通用提示词" },
  { id: "skill:image-character", name: "角色专项图片提示词" },
  { id: "skill:shared-main", name: "共享主笔" },
  { id: "skill:shared-secondary", name: "共享辅助" },
];

const bundle = compileManagedRouteBundle({ topology, skills });
assert.equal(bundle.revision, 12);
assert.equal(bundle.topologyHash, topology.hash);
assert.match(bundle.panel.text, /面板路由/u);
assert.match(bundle.panel.text, /## 本层职责与决策/u);
assert.match(bundle.panel.text, /## 读取顺序/u);
assert.match(bundle.panel.text, /## 事实边界/u);
assert.match(bundle.panel.text, /## 统一语义优先级/u);
assert.match(bundle.panel.text, /不能因为词语相似/u);
assert.match(bundle.panel.text, /自定义模组或模块保存后/u);
assert.match(bundle.panel.text, /不能借用数组中的第一个位置/u);
assert.match(bundle.panel.text, /不需要工程化管理 Skill/u);
assert.match(bundle.panel.text, /小说模组/u);
assert.match(bundle.panel.text, /图片资产/u);
assert.doesNotMatch(bundle.panel.text, /真假千金/u, "面板路由不能展开深层 Skill 或模块");

const fictionRoute = bundle.routes.find((route) => route.nodeId === "group:fiction");
assert.ok(fictionRoute);
assert.match(fictionRoute.text, /## 本层职责与决策/u);
assert.match(fictionRoute.text, /下级数量=/u);
assert.match(fictionRoute.text, /下一层路由=模块路由/u);
assert.match(fictionRoute.text, /小说理论顾问/u);
assert.match(fictionRoute.text, /女频模组/u);
assert.doesNotMatch(fictionRoute.text, /女频通用理论/u, "模组路由只能列直接成员");

const identityRoute = bundle.routes.find((route) => route.nodeId === "module:identity");
assert.ok(identityRoute);
assert.match(identityRoute.text, /## 上位协作/u);
assert.match(identityRoute.text, /能力=/u);
assert.match(identityRoute.text, /Skill=真假千金/u);
assert.doesNotMatch(identityRoute.text, /真假千金路由规则/u, "分层路由正文不得回填 triggerRules 摘要");
assert.match(identityRoute.text, /触发条件=/u, "模块路由必须说明插槽触发条件");

const identityPlacement = bundle.skillPlacements.find((placement) => placement.skillId === "skill:identity");
assert.ok(identityPlacement.placementId.includes("placement:fiction>placement:female>placement:identity"));
assert.deepEqual(
  identityPlacement.organizationUpperPlacementIds.map((placementId) => bundle.skillPlacements.find((placement) => placement.placementId === placementId)?.skillId),
  ["skill:advisor", "skill:female-general"],
  "嵌套组织关系必须按外层到内层加载上位 Skill",
);
assert.deepEqual(identityPlacement.routePlacementIds, [
  "template:main",
  "template:main>placement:fiction",
  "template:main>placement:fiction>placement:female",
  "template:main>placement:fiction>placement:female>placement:identity",
]);

const imageLower = bundle.skillPlacements.find((placement) => placement.skillId === "skill:image-character");
assert.deepEqual(
  imageLower.organizationUpperPlacementIds.map((placementId) => bundle.skillPlacements.find((placement) => placement.placementId === placementId)?.skillId),
  ["skill:image-main"],
  "图片资产下位 Skill 默认继承通用提示词主笔",
);

const sharedPlacements = bundle.skillPlacements.filter((placement) => placement.skillId === "skill:shared-main");
assert.equal(sharedPlacements.length, 2);
assert.notEqual(sharedPlacements[0].placementId, sharedPlacements[1].placementId, "复用 Skill 必须按完整路径区分位置");
const sharedAtRoot = sharedPlacements.find((placement) => placement.pathNames.includes("创作面板") && !placement.pathNames.includes("小说模组"));
const sharedInFiction = sharedPlacements.find((placement) => placement.pathNames.includes("小说模组"));
assert.equal(sharedAtRoot.organizationUpperPlacementIds.length, 0, "并行位置不应产生组织上位");
assert.deepEqual(
  sharedInFiction.organizationUpperPlacementIds.map((placementId) => bundle.skillPlacements.find((placement) => placement.placementId === placementId)?.skillId),
  ["skill:advisor"],
  "位于组织下位的主次模块只继承外层组织上位，不把主要成员误当作上位",
);

const catalog = catalogWithManagedPlacements({ catalog: skills, routeBundle: bundle });
assert.equal(catalog.length, skills.length);
assert.equal(catalog.find((skill) => skill.id === "skill:shared-main").placements.length, 2);
assert.equal(catalog.find((skill) => skill.id === "skill:identity").placements.length, 1);

console.log("hierarchical panel route compiler tests passed");
