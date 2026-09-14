import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(app, /id="capabilityRouteFieldLabel">模块路由</u);
assert.match(app, /scopeType === "template" \? "面板路由" : scopeType === "group" \? "模组路由" : "模块路由"/u);
assert.match(app, /const saveLabel = "保存并更新路由"/u);
assert.match(app, /applyCapabilityNodeEditor\(event\.currentTarget\);\s*await saveCapabilityTemplateScope\(\);/u, "节点编辑提交必须同时保存结构并更新路由");
assert.match(app, /data-save-capability-scope \$\{validation\.valid && ui\.capabilityTemplateDirty \? "" : "disabled"\}/u, "自动保存完成后不得再次建立重复版本");
assert.doesNotMatch(app, /应用到草稿/u);
assert.doesNotMatch(app, /data-open-route-history/u, "底部重复历史入口必须移除");
assert.match(app, /scopeType === "template" \? "面板历史版本" : scopeType === "group" \? "模组历史版本" : "模块历史版本"/u);
assert.match(app, /面板路由只选择顶层模组或模块/u);
assert.match(app, /命中下位时默认调用上位，只有语义判断确实不需要时才能记录理由后跳过/u);

console.log("Skill panel hierarchical route UI contracts passed");
