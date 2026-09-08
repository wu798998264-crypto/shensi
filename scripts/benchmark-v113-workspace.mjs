import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createBlankProjectState } from "../src/data.js";
import {
  listWorkspaceNotebooks,
  listWorkspaceProjects,
  loadWorkspaceCurrentContent,
  loadWorkspaceState,
  saveWorkspaceState,
} from "../src/server/workspace.mjs";
import { transferWorkspaceDocuments } from "../src/server/workspace-document-transfer.mjs";

const timed = async (operation) => {
  const started = performance.now();
  const value = await operation();
  return { value, ms: Number((performance.now() - started).toFixed(1)) };
};

const appRoot = process.cwd();
const workspaces = [
  ...await listWorkspaceProjects({ appRoot }),
  ...await listWorkspaceNotebooks(),
];
const inventory = [];
for (const workspace of workspaces) {
  const measured = await timed(() => loadWorkspaceCurrentContent({ appRoot, requestedPath: workspace.workspacePath }));
  inventory.push({
    name: workspace.name,
    documents: Object.keys(measured.value.documents || {}).length,
    loadMs: measured.ms,
  });
}
const largest = [...inventory].sort((left, right) => right.documents - left.documents)[0];
const slowest = [...inventory].sort((left, right) => right.loadMs - left.loadMs)[0];
assert.ok(slowest.loadMs < 5_000, `实际工作区读取过慢：${slowest.name} ${slowest.loadMs}ms`);

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-v113-performance-"));
try {
  const isolatedAppRoot = join(tempRoot, "app");
  const sourcePath = join(isolatedAppRoot, "runtime", "large-source");
  const targetPath = join(isolatedAppRoot, "runtime", "large-target");
  const source = createBlankProjectState("性能源");
  const target = createBlankProjectState("性能目标");
  const documentIds = [];
  for (let index = 1; index <= 600; index += 1) {
    const id = `perf-${index}`;
    documentIds.push(id);
    source.documents[id] = {
      title: `性能文档 ${index}`,
      html: `<p>第 ${index} 份性能正文。${"内容".repeat(200)}</p>`,
      moduleId: "manuscript",
      workspaceView: "novel",
    };
    source.histories[id] = [];
    source.moduleItems.manuscript.push([id, `性能文档 ${index}`, { workspaceView: "novel" }]);
  }
  const sourceSave = await timed(() => saveWorkspaceState({ appRoot: isolatedAppRoot, requestedPath: sourcePath, state: source }));
  await saveWorkspaceState({ appRoot: isolatedAppRoot, requestedPath: targetPath, state: target });
  const coldLoad = await timed(() => loadWorkspaceState({ appRoot: isolatedAppRoot, requestedPath: sourcePath }));
  const warmLoad = await timed(() => loadWorkspaceState({ appRoot: isolatedAppRoot, requestedPath: sourcePath }));
  const transfer = await timed(() => transferWorkspaceDocuments({
    appRoot: isolatedAppRoot,
    operation: "copy",
    sourceWorkspacePath: sourcePath,
    documentIds: documentIds.slice(0, 100),
    targetWorkspacePath: targetPath,
    targetWorkspaceKind: "project",
    targetModuleId: "manuscript",
    targetViewId: "novel",
    targetLocationId: "manuscript:novel:root",
  }));
  assert.equal(transfer.value.transferred.length, 100);
  assert.ok(sourceSave.ms < 8_000, `600 文档首次保存过慢：${sourceSave.ms}ms`);
  assert.ok(coldLoad.ms < 5_000, `600 文档冷读取过慢：${coldLoad.ms}ms`);
  assert.ok(warmLoad.ms < 3_000, `600 文档再次读取过慢：${warmLoad.ms}ms`);
  assert.ok(transfer.ms < 8_000, `100 文档批量移动/复制过慢：${transfer.ms}ms`);
  console.log(JSON.stringify({
    ok: true,
    actualWorkspaces: workspaces.length,
    largest,
    slowest,
    isolated: {
      documents: 600,
      sourceSaveMs: sourceSave.ms,
      coldLoadMs: coldLoad.ms,
      warmLoadMs: warmLoad.ms,
      transfer100Ms: transfer.ms,
    },
  }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
