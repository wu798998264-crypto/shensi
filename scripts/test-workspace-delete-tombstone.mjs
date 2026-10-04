import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const sandbox = await mkdtemp(join(tmpdir(), "shensi-delete-tombstone-"));
process.env.SHENSI_DATA_ROOT = join(sandbox, "data");
const appRoot = join(sandbox, "app");
const { createBlankProjectState, createBlankNotebookState } = await import("../src/data.js");
const {
  createWorkspaceProject,
  createWorkspaceNotebook,
  deleteWorkspaceProject,
  deleteWorkspaceNotebook,
  listWorkspaceProjects,
  listWorkspaceNotebooks,
  loadWorkspaceState,
  saveWorkspaceState,
} = await import("../src/server/workspace.mjs");

const expectDeleted = async (operation, label) => {
  await assert.rejects(operation, (error) => error?.code === "WORKSPACE_DELETED_PATH", label);
};

try {
  const project = await createWorkspaceProject({ appRoot, name: "删除墓碑作品" });
  await saveWorkspaceState({ appRoot, requestedPath: project.workspacePath, state: createBlankProjectState({ name: project.name, workspacePath: project.workspacePath }) });
  await deleteWorkspaceProject({ appRoot, requestedPath: project.workspacePath });
  await expectDeleted(
    saveWorkspaceState({ appRoot, requestedPath: project.workspacePath, state: createBlankProjectState({ name: "陈旧写入" }) }),
    "删除后的陈旧保存必须被墓碑拒绝",
  );
  await expectDeleted(
    loadWorkspaceState({ appRoot, requestedPath: project.workspacePath }),
    "删除后的旧路径读取必须被墓碑拒绝",
  );
  const workspaceModuleUrl = pathToFileURL(join(process.cwd(), "src/server/workspace.mjs")).href;
  const childScript = `const m=await import(${JSON.stringify(workspaceModuleUrl)}); try { m.loadWorkspaceState({appRoot:${JSON.stringify(appRoot)},requestedPath:${JSON.stringify(project.workspacePath)} }).then(()=>process.exit(2)).catch(e=>process.exit(e.code==='WORKSPACE_DELETED_PATH'?0:3)); } catch { process.exit(4); }`;
  execFileSync(process.execPath, ["--input-type=module", "-e", childScript], {
    env: { ...process.env, SHENSI_DATA_ROOT: process.env.SHENSI_DATA_ROOT },
    stdio: "ignore",
  });
  assert.equal((await listWorkspaceProjects({ appRoot })).some((item) => item.workspacePath === project.workspacePath), false);

  const notebook = await createWorkspaceNotebook({ name: "删除墓碑笔记本" });
  await saveWorkspaceState({ appRoot, requestedPath: notebook.workspacePath, state: createBlankNotebookState({ name: notebook.name, workspacePath: notebook.workspacePath }) });
  await deleteWorkspaceNotebook({ appRoot, requestedPath: notebook.workspacePath });
  await expectDeleted(
    saveWorkspaceState({ appRoot, requestedPath: notebook.workspacePath, state: createBlankNotebookState({ name: "陈旧笔记写入" }) }),
    "删除后的笔记本陈旧保存必须被墓碑拒绝",
  );
  assert.equal((await listWorkspaceNotebooks()).some((item) => item.workspacePath === notebook.workspacePath), false);
  console.log(JSON.stringify({ ok: true, checks: ["project-save", "project-load", "project-list", "notebook-save", "notebook-list"] }));
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
