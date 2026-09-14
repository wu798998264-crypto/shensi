import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildManagedRouteDocument, filterAgentSkillCatalog } from "../src/managed-route-document.js";
import { createBlankNotebookState } from "../src/data.js";
import { loadWorkspaceState, saveWorkspaceState } from "../src/server/workspace.mjs";

const topology = {
  revision: 7,
  hash: "a".repeat(64),
  capabilityTemplate: {
    template: { id: "template:main", name: "测试面板", relationType: "parallel", description: "面板能力", triggerRules: "按任务", items: [{ id: "placement:test", targetType: "module", targetId: "module:test", role: "peer" }] },
    groups: [{ id: "group:org", name: "组织模组", relationType: "organization", description: "组织能力", triggerRules: "命中下位时启用" }],
    modules: [{
      id: "module:test", name: "测试模块", relationType: "primary-secondary", description: "正文处理", triggerRules: "正式正文",
      slots: [
        { id: "slot:primary", name: "主位", role: "primary", skillId: "builtin:primary", description: "主能力", triggerRules: "正文" },
        { id: "slot:secondary", name: "次位", role: "secondary", skillId: "builtin:secondary", description: "次能力", triggerRules: "改写" },
      ],
    }],
  },
};
const skills = [
  { id: "builtin:primary", name: "主能力", description: "主能力说明", capabilities: ["novel_prose_writer"] },
  { id: "builtin:secondary", name: "次能力", description: "次能力说明", capabilities: ["repair_writer"] },
  { id: "user:outside", name: "面板外能力", description: "不应自动进入", capabilities: ["auxiliary_advisor"] },
];
const route = buildManagedRouteDocument({ topology, skills });
assert.match(route, /路由版本：7/u);
assert.match(route, /主位.*主能力/u);
assert.match(route, /次位.*次能力/u);
assert.match(route, /面板外 Skill 只有本轮被用户明确点名/u);
assert.match(buildManagedRouteDocument({ topology: { ...topology, slots: [{ id: "outside-slot", name: "注册槽", skillId: "user:outside", enabled: true, parentGroupId: "" }] }, skills }), /注册槽/u);
assert.deepEqual(filterAgentSkillCatalog({ catalog: skills, routeTopology: topology, request: { messages: [{ role: "user", content: "普通正文任务" }] } }).map((skill) => skill.id), ["builtin:primary", "builtin:secondary"]);
assert.deepEqual(filterAgentSkillCatalog({ catalog: skills, routeTopology: topology, request: { messages: [{ role: "user", content: "请使用 @outside" }] } }).map((skill) => skill.id), ["builtin:primary", "builtin:secondary", "user:outside"]);

const root = await mkdtemp(join(tmpdir(), "shensi-route-history-"));
try {
  const workspacePath = join(root, "runtime", "E-drive-data", "笔记", "路由历史测试");
  const options = { appRoot: root, requestedPath: workspacePath };
  const initial = createBlankNotebookState({ name: "路由历史测试", workspacePath });
  initial.documents.noteA = { title: "A", markdown: "初稿A", html: "<p>初稿A</p>", moduleId: "library" };
  initial.documents.noteB = { title: "B", markdown: "初稿B", html: "<p>初稿B</p>", moduleId: "library" };
  initial.moduleItems.library = [["noteA", "A"], ["noteB", "B"]];
  await saveWorkspaceState({ ...options, state: initial });
  const loaded = await loadWorkspaceState(options);
  const next = structuredClone(loaded.state);
  next.documents.noteA.markdown = "新稿A";
  next.documents.noteA.html = "<p>新稿A</p>";
  next.documents.noteB.markdown = "新稿B";
  next.documents.noteB.html = "<p>新稿B</p>";
  const saved = await saveWorkspaceState({ ...options, state: next, expectedStateStamp: loaded.stateStamp });
  assert.equal(saved.prewriteHistory.length, 2);
  const after = (await loadWorkspaceState(options)).state;
  assert.ok(after.histories.noteA?.[0]?.fullPrewriteSnapshot);
  assert.ok(after.histories.noteB?.[0]?.fullPrewriteSnapshot);
  assert.ok(after.viewHistories?.["library:default"]?.length || after.moduleHistories?.library?.length || after.projectHistories?.length, "多目标保存必须留下层级快照");
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("Managed route document, panel boundary and hierarchy prewrite history tests passed");
