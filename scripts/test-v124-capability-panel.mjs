import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  capabilityTemplateNode,
  capabilityTemplateNodeIsVisible,
  createInitialCapabilityTemplate,
  isKernelManagedCapabilityNode,
  normalizeCapabilityTemplate,
  resolveCapabilityTemplateRouting,
} from "../src/capability-template.js";
import { capabilityAssetTypeLabel } from "../src/skill-ui-model.js";

assert.equal(CAPABILITY_TEMPLATE_SCHEMA_VERSION, 29);
const bundle = normalizeCapabilityTemplate(createInitialCapabilityTemplate());
const migratedLegacyBundle = normalizeCapabilityTemplate({
  ...createInitialCapabilityTemplate(),
  template: {
    ...createInitialCapabilityTemplate().template,
    name: "神思能力模板",
    description: "神思能力模板决定当前模板的能力上限。",
    triggerRules: "读取当前模板后执行。",
  },
});
assert.equal(migratedLegacyBundle.template.name, "Skill 面板");
assert.doesNotMatch(migratedLegacyBundle.template.description, /模板/u);
assert.doesNotMatch(migratedLegacyBundle.template.triggerRules, /模板/u);
assert.equal(capabilityAssetTypeLabel("template"), "面板");
const memory = capabilityTemplateNode(bundle, "module", "module:shared-memory");
assert.ok(memory, "记忆模块必须显示在 Skill 面板数据中");
assert.equal(memory.name, "记忆模块");
assert.equal(memory.kernelManaged, false);
assert.equal(isKernelManagedCapabilityNode("module", memory.id), false);
assert.equal(capabilityTemplateNodeIsVisible(bundle, "module", memory.id), true);
memory.disabled = true;
const disabled = normalizeCapabilityTemplate(bundle);
assert.equal(capabilityTemplateNode(disabled, "module", memory.id).disabled, true);
const route = resolveCapabilityTemplateRouting(disabled, { text: "读取长期记忆并继续创作" });
assert.ok(route.diagnostics.disabledNodeIds.includes(memory.id));

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const skillStore = await readFile(new URL("../src/server/skill-store.mjs", import.meta.url), "utf8");
assert.match(app, /data-skill-settings-tab="slots"[^>]*>Skill 面板<\/button>/u);
assert.match(app, /保存并更新路由/u);
assert.match(app, /一键还原初始面板/u);
assert.match(app, /编辑面板信息/u);
assert.match(app, /data-capability-context-action="reveal"/u, "模块和模组右键菜单必须提供打开所在文件夹");
assert.match(app, /data-skill-context-action="reveal"/u, "Skill 右键菜单必须提供打开所在文件夹");
assert.match(app, /const revealSkillFolder = async/u);
assert.match(app, /kind: scopeType, scopeType, scopeId, id: scopeId/u);
assert.match(app, /kind: "capability-asset"/u);
assert.match(server, /const resolveSkillRevealTarget = async/u);
assert.match(server, /pathname === "\/api\/skills\/reveal" && request\.method === "POST"/u);
assert.match(server, /已打开 Skill 所在文件夹/u);
assert.doesNotMatch(app, /data-open-route-history/u, "面板底部不得保留重复的路由历史入口");
assert.match(app, /面板历史版本/u, "面板右键菜单必须提供联合历史入口");
assert.match(app, /模组历史版本/u, "模组右键菜单必须提供联合历史入口");
assert.match(app, /模块历史版本/u, "模块右键菜单必须提供联合历史入口");
assert.match(app, /恢复\$\{historyTypeLabel\}与路由/u, "联合历史必须明确同时恢复结构与路由");
assert.match(app, /\$\{historyTypeLabel\} v\$\{entry\.version\} · 路由 r/u, "历史列表必须同时显示结构版本和路由版本");
assert.match(skillStore, /const appendUnifiedRouteHistory =/u, "路由版本递增必须建立统一历史记录");
assert.match(skillStore, /routeRevision: registry\.routeRevision/u);
assert.match(skillStore, /topologyHash: routeTopology\.hash/u);
assert.match(skillStore, /routingAudit,/u);
assert.match(skillStore, /routeDiff,/u);
assert.match(skillStore, /routeSnapshot,/u);
assert.match(skillStore, /appendUnifiedRouteHistory\(registry, history\)/u, "启停、移动、删除等路由修改必须统一记录历史");
assert.match(skillStore, /该历史版本的任务路由审计未通过/u, "恢复失败时必须保持当前版本不变");
assert.match(skillStore, /当前正在使用的\$\{scopeType === "template" \? "面板" : scopeType === "group" \? "模组" : "模块"\}—路由联合版本不能删除/u);

console.log("v1.2.4 Skill panel naming and configurable memory module contracts passed");
