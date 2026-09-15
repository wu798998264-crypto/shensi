import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(app, /id="capabilityRouteFieldLabel">模块路由</u);
assert.match(app, /name="routeDocument" rows="12" readonly/u, "层级编辑器必须显示只读的正式 routeDocument");
assert.match(app, /name="triggerRules" type="hidden"/u, "triggerRules 只能保留为隐藏兼容字段");
assert.doesNotMatch(app, /textarea name="triggerRules"/u, "界面不得把 triggerRules 作为路由正文");
assert.match(app, /scopeType === "template" \? "面板路由" : scopeType === "group" \? "模组路由" : "模块路由"/u);
assert.match(app, /const saveLabel = "保存并更新路由"/u);
assert.match(app, /applyCapabilityNodeEditor\(event\.currentTarget\);\s*await saveCapabilityTemplateScope\(\);/u, "节点编辑提交必须同时保存结构并更新路由");
assert.match(app, /data-save-capability-scope \$\{validation\.valid && ui\.capabilityTemplateDirty \? "" : "disabled"\}/u, "自动保存完成后不得再次建立重复版本");
assert.doesNotMatch(app, /应用到草稿/u);
assert.doesNotMatch(app, /data-open-route-history/u, "底部重复历史入口必须移除");
assert.match(app, /scopeType === "template" \? "面板历史版本" : scopeType === "group" \? "模组历史版本" : "模块历史版本"/u);
const capabilityMenu = app.match(/<div class="context-menu" id="capabilityNodeContextMenu"[\s\S]*?<\/div>/u)?.[0] || "";
assert.ok(capabilityMenu.indexOf('data-capability-context-action="disable"') < capabilityMenu.indexOf('data-capability-context-action="history"'), "层级节点历史版本必须紧跟在禁用下面");
assert.ok(capabilityMenu.indexOf('data-capability-context-action="history"') < capabilityMenu.indexOf('data-capability-context-action="edit"'), "层级节点历史版本必须位于编辑之前");
assert.match(app, /scopeType === "template" \? "编辑面板信息" : scopeType === "group" \? "编辑模组" : "编辑模块"/u);
assert.match(app, /data-capability-context-action="copy"[^>]*>[\s\S]{0,80}>创建副本<\/span>/u);
assert.match(app, /data-skill-context-action="copy"[^>]*>[\s\S]{0,80}>创建副本<\/span>/u);
assert.match(app, /id="copyOfficialSkillFromDetail"[^>]*>创建副本<\/button>/u);
assert.doesNotMatch(app, /复制为可编辑副本/u, "面板、模组、模块与 Skill 的副本操作必须统一命名为创建副本");
assert.match(app, /面板路由只选择顶层模组或模块/u);
assert.match(app, /命中下位时默认调用上位，只有语义判断确实不需要时才能记录理由后跳过/u);

console.log("Skill panel hierarchical route UI contracts passed");
