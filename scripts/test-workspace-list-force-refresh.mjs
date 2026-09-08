import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

const extractFunction = (startMarker, endMarker) => {
  const start = appSource.indexOf(startMarker);
  const end = appSource.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `无法提取 ${startMarker}`);
  return appSource.slice(start, end);
};

const buildRefresh = (kind) => {
  const project = kind === "project";
  const functionName = project ? "refreshProjects" : "refreshNotebooks";
  const source = extractFunction(
    `const ${functionName} =`,
    project ? "const refreshNotebooks =" : "const refreshWorkspaceEntries =",
  );
  const factory = Function(
    "ui",
    "state",
    "fetchWorkspaceRequest",
    "applyStoredWorkspaceOrder",
    "persistWorkspaceListSnapshot",
    "renderProjectMenu",
    "showToast",
    "WORKSPACE_LIST_CACHE_MS",
    `"use strict"; ${source}; return ${functionName};`,
  );
  return factory;
};

const verifyForcedRefreshAfterOlderRequest = async (kind) => {
  const project = kind === "project";
  const listKey = project ? "projects" : "notebooks";
  const endpoint = project ? "/api/projects/list" : "/api/notebooks/list";
  const payloadKey = listKey;
  const oldEntry = { name: "未命名", workspacePath: "C:/old", managed: true };
  const newEntry = { name: project ? "新作品" : "新笔记本", workspacePath: "C:/new", managed: true };
  let releaseOlder;
  const olderRequest = new Promise((resolve) => { releaseOlder = resolve; });
  const ui = {
    projects: project ? [oldEntry] : [],
    notebooks: project ? [] : [oldEntry],
    workspaceListCacheAt: { project: 0, notebook: 0 },
    workspaceListPromises: { project: null, notebook: null },
    workspaceListLoading: { project: false, notebook: false },
    workspaceListError: "",
  };
  ui.workspaceListPromises[kind] = olderRequest;
  let fetchCount = 0;
  const refresh = buildRefresh(kind)(
    ui,
    { settings: { workspacePath: "C:/active" }, projectName: "当前" },
    async (requestedEndpoint) => {
      assert.equal(requestedEndpoint, endpoint);
      fetchCount += 1;
      return { ok: true, json: async () => ({ ok: true, [payloadKey]: [oldEntry, newEntry] }) };
    },
    (_workspaceKind, entries) => entries,
    () => {},
    () => {},
    () => {},
    5 * 60_000,
  );

  const first = refresh({ force: true, render: false });
  const second = refresh({ force: true, render: false });
  releaseOlder(true);
  assert.equal(await first, true);
  assert.equal(await second, true);
  assert.equal(fetchCount, 1, `${kind} 的并发强制刷新只能共享一个创建后的新请求`);
  assert.ok(ui[listKey].some((entry) => entry.workspacePath === newEntry.workspacePath), `${kind} 强制刷新不得保留创建前的旧列表`);
};

await verifyForcedRefreshAfterOlderRequest("project");
await verifyForcedRefreshAfterOlderRequest("notebook");

console.log("Workspace list forced-refresh race regression passed");
