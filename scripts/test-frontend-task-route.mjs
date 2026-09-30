import assert from "node:assert/strict";
import { buildFrontendTaskRoute, frontendRouteCanUseGeneralLane } from "../src/frontend-task-route.js";

const general = buildFrontendTaskRoute({ text: "为什么天空是蓝色的？", workspaceKind: "project", routeRevision: 7 });
assert.equal(general.kind, "general_chat");
assert.equal(general.routeRevision, 7);
assert.equal(frontendRouteCanUseGeneralLane(general), true);

const panel = buildFrontendTaskRoute({ text: "请把当前章节续写并保存到正文", workspaceKind: "project", routeRevision: 8 });
assert.equal(panel.kind, "panel_candidate");
assert.equal(panel.requiresPanelRoute, true);
assert.equal(frontendRouteCanUseGeneralLane(panel), false);

const attachment = buildFrontendTaskRoute({ text: "看一下这个", workspaceKind: "project", hasAttachments: true });
assert.equal(attachment.kind, "panel_candidate");

const uncertain = buildFrontendTaskRoute({ text: "请处理这个复杂任务", workspaceKind: "project" });
assert.equal(uncertain.kind, "panel_candidate");

console.log("frontend task route tests passed");
