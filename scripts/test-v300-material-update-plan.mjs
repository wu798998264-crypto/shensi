import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compilePostCommitProjection } from "../src/post-commit-projection.js";

const projection = compilePostCommitProjection({
  documents: [{ documentId: "chapter-8", moduleId: "manuscript", contextDomain: "novel" }],
});
assert.deepEqual(projection.outline.automaticDocumentIds, [], "正文落盘后不得自动改大纲");
assert.deepEqual(projection.canon.automaticDocumentIds, [], "正文落盘后不得自动改设定");
assert.equal(projection.outline.requiresExplicitAuthorization, true);
assert.equal(projection.canon.requiresExplicitAuthorization, true);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const materialUpdatePlan = await readFile(new URL("../src/material-update-plan.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /kind:\s*"post_landing_materials"/u, "正式写入后不得用资料更新选择框打断当前工作流");
assert.doesNotMatch(app, /手动保存历史版本[\s\S]{0,650}(?:offer|runConfirmed)PostLandingMaterialsUpdate/u,
  "手动保存历史版本只保存版本，不得隐式启动资料更新");
assert.doesNotMatch(app, /queueMicrotask\(\(\)\s*=>\s*offerPostLandingMaterialsUpdate/u,
  "候选正式落盘后不得自动弹出资料更新流程");
assert.match(app, /explicitPostLandingMaterialsUpdateRequested/u, "用户仍可用明确指令主动更新作品资料");
assert.match(app, /runExplicitPostLandingMaterialsUpdate/u, "明确指令必须进入资料差异检查流程");
assert.match(app, /runConfirmedPostLandingMaterialsUpdate/u, "资料更新仍必须沿用已确认的安全增量链");
assert.match(materialUpdatePlan, /本阶段禁止写入任何文档/u, "更新资料前必须先进行只读差异检查");
assert.match(materialUpdatePlan, /没有正文原句证据的项目不得返回/u, "不得无证据改写作品资料");
assert.match(materialUpdatePlan, /新增或局部修改没有形成可安全定位/u, "局部更新不得退回全文覆盖");

console.log("Shensi v3.0 material update plan tests passed");
