import assert from "node:assert/strict";
import { buildFrontendTaskRoute, frontendRouteCanUseGeneralLane } from "../src/frontend-task-route.js";

const general = buildFrontendTaskRoute({ text: "为什么天空是蓝色的？", workspaceKind: "project", routeRevision: 7 });
assert.equal(general.kind, "general_chat");
assert.equal(general.routeRevision, 7);
assert.equal(frontendRouteCanUseGeneralLane(general), true);

const notebookGeneral = buildFrontendTaskRoute({ text: "请解释一下第三轮", workspaceKind: "notebook", routeRevision: 9 });
assert.equal(notebookGeneral.kind, "general_chat", "笔记本只是工作区上下文，不应强制普通对话读取完整面板路由");
assert.equal(frontendRouteCanUseGeneralLane(notebookGeneral), true);

for (const text of ["请用一句话回答：水的化学式是什么？只输出化学式。", "只输出 OK", "请用两句话回复：测试"]) {
  const probe = buildFrontendTaskRoute({ text, workspaceKind: "notebook" });
  assert.equal(probe.kind, "general_chat", `短精确回复探针不得误走完整面板路由：${text}`);
  assert.equal(frontendRouteCanUseGeneralLane(probe), true);
}

const panel = buildFrontendTaskRoute({ text: "请把当前章节续写并保存到正文", workspaceKind: "project", routeRevision: 8 });
assert.equal(panel.kind, "panel_candidate");
assert.equal(panel.requiresPanelRoute, true);
assert.equal(frontendRouteCanUseGeneralLane(panel), false);

const attachment = buildFrontendTaskRoute({ text: "看一下这个", workspaceKind: "project", hasAttachments: true });
assert.equal(attachment.kind, "panel_candidate");

const uncertain = buildFrontendTaskRoute({ text: "请处理这个复杂任务", workspaceKind: "project" });
assert.equal(uncertain.kind, "panel_candidate");

console.log("frontend task route tests passed");
