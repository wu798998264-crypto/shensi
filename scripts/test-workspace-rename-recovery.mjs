import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tempRoot = await mkdtemp(join(tmpdir(), "shensi-workspace-rename-"));
process.env.SHENSI_DATA_ROOT = join(tempRoot, "data");

const { createBlankProjectState, createBlankNotebookState } = await import("../src/data.js");
const {
  createWorkspaceProject,
  createWorkspaceNotebook,
  loadWorkspaceState,
  renameWorkspaceProject,
  renameWorkspaceNotebook,
  saveWorkspaceState,
} = await import("../src/server/workspace.mjs");

const appRoot = join(tempRoot, "app");

try {
  const project = await createWorkspaceProject({ appRoot, name: "并发重命名作品" });
  const projectState = createBlankProjectState({ name: project.name, workspacePath: project.workspacePath });
  projectState.documents["chapter-1"] = {
    title: "第一章",
    markdown: "锁定期间也必须保持完整。",
    html: "<p>锁定期间也必须保持完整。</p>",
    moduleId: "manuscript",
    workspaceView: "novel",
  };
  projectState.moduleItems.manuscript.push(["chapter-1", "第一章", { workspaceView: "novel" }]);
  projectState.messages = [{
    id: "rename-path-proof",
    turnContextSnapshot: { workspacePath: project.workspacePath },
    creativeTask: { target: { workspacePath: project.workspacePath } },
  }];
  await saveWorkspaceState({ appRoot, requestedPath: project.workspacePath, state: projectState });

  const loadedBeforeRename = await loadWorkspaceState({ appRoot, requestedPath: project.workspacePath });
  const saveDuringRename = saveWorkspaceState({
    appRoot,
    requestedPath: project.workspacePath,
    state: loadedBeforeRename.state,
  });
  await Promise.resolve();
  const renamedProject = renameWorkspaceProject({
    appRoot,
    requestedPath: project.workspacePath,
    name: "并发重命名作品-已完成",
  });
  await Promise.all([saveDuringRename, renamedProject]);

  const renamedPath = join(join(process.env.SHENSI_DATA_ROOT, "作品"), "并发重命名作品-已完成");
  assert.equal((await stat(project.workspacePath).catch(() => null)), null, "旧作品目录不应残留");
  assert.equal((await stat(renamedPath)).isDirectory(), true);
  const renamedState = await loadWorkspaceState({ appRoot, requestedPath: renamedPath });
  assert.equal(renamedState.state.projectName, "并发重命名作品-已完成");
  assert.equal(renamedState.state.documents["chapter-1"].markdown, "锁定期间也必须保持完整。");
  assert.equal(renamedState.state.messages[0].turnContextSnapshot.workspacePath, renamedPath);
  assert.equal(renamedState.state.messages[0].creativeTask.target.workspacePath, renamedPath);
  const currentStateText = await readFile(join(renamedPath, ".shensi", "current-state.json"), "utf8");
  assert.match(currentStateText, /并发重命名作品-已完成/u);

  const collisionTarget = await createWorkspaceProject({ appRoot, name: "同名占用" });
  await assert.rejects(
    renameWorkspaceProject({ appRoot, requestedPath: renamedPath, name: collisionTarget.name }),
    /已经存在同名作品/u,
  );
  assert.equal((await stat(renamedPath)).isDirectory(), true, "同名冲突不得移动原作品");

  const notebook = await createWorkspaceNotebook({ name: "并发重命名笔记" });
  const notebookState = createBlankNotebookState({ name: notebook.name, workspacePath: notebook.workspacePath });
  await saveWorkspaceState({ appRoot, requestedPath: notebook.workspacePath, state: notebookState });
  const renamedNotebook = await renameWorkspaceNotebook({
    appRoot,
    requestedPath: notebook.workspacePath,
    name: "并发重命名笔记-已完成",
  });
  const renamedNotebookPath = join(join(process.env.SHENSI_DATA_ROOT, "笔记"), renamedNotebook.name);
  assert.equal((await stat(notebook.workspacePath).catch(() => null)), null, "旧笔记本目录不应残留");
  const loadedNotebook = await loadWorkspaceState({ appRoot, requestedPath: renamedNotebookPath });
  assert.equal(loadedNotebook.state.projectName, "并发重命名笔记-已完成");

  const previewMigrationProject = await createWorkspaceProject({ appRoot, name: "预览路径迁移作品" });
  const previewWorkspacePath = join(appRoot, "runtime", "browser-preview", "作品", previewMigrationProject.name);
  await mkdir(join(previewMigrationProject.workspacePath, ".shensi"), { recursive: true });
  await mkdir(join(previewWorkspacePath, ".shensi"), { recursive: true });
  const projectIdentity = JSON.stringify({ schemaVersion: 1, workspaceId: "preview-path-migration-proof" });
  await writeFile(join(previewMigrationProject.workspacePath, ".shensi", "project-identity.json"), projectIdentity, "utf8");
  await writeFile(join(previewWorkspacePath, ".shensi", "project-identity.json"), projectIdentity, "utf8");
  const previewMigrationState = createBlankProjectState({
    name: previewMigrationProject.name,
    workspacePath: previewMigrationProject.workspacePath,
  });
  previewMigrationState.messages = [{
    id: "preview-path-proof",
    turnContextSnapshot: { workspacePath: previewWorkspacePath },
    creativeTask: {
      target: {
        workspacePath: previewWorkspacePath,
        targetPath: join(previewWorkspacePath, "09_索引", "其他索引", "创作引导.md"),
      },
    },
  }];
  await saveWorkspaceState({
    appRoot,
    requestedPath: previewMigrationProject.workspacePath,
    state: previewMigrationState,
  });
  const migratedPreviewState = await loadWorkspaceState({
    appRoot,
    requestedPath: previewMigrationProject.workspacePath,
  });
  assert.equal(migratedPreviewState.state.messages[0].turnContextSnapshot.workspacePath, previewMigrationProject.workspacePath);
  assert.equal(
    migratedPreviewState.state.messages[0].creativeTask.target.targetPath,
    join(previewMigrationProject.workspacePath, "09_索引", "其他索引", "创作引导.md"),
  );
  const migratedPreviewDiskState = await readFile(
    join(previewMigrationProject.workspacePath, ".shensi", "current-state.json"),
    "utf8",
  );
  assert.doesNotMatch(migratedPreviewDiskState, /runtime[\\/]browser-preview/u);
} finally {
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }).catch(() => {});
}

console.log("workspace rename queue, recovery, collision and notebook regression tests passed");
