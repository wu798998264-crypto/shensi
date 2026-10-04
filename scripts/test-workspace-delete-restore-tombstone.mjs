import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = await mkdtemp(join(tmpdir(), "shensi-delete-restore-tombstone-"));
process.env.SHENSI_DATA_ROOT = join(sandbox, "data");
const appRoot = join(sandbox, "app");
const { createBlankProjectState } = await import("../src/data.js");
const {
  createWorkspaceProject,
  deleteWorkspaceProject,
  listDeletedWorkspaces,
  loadWorkspaceState,
  restoreDeletedWorkspace,
  saveWorkspaceState,
} = await import("../src/server/workspace.mjs");

try {
  const created = await createWorkspaceProject({ appRoot, name: "恢复原名验收" });
  await saveWorkspaceState({
    appRoot,
    requestedPath: created.workspacePath,
    state: createBlankProjectState({ name: created.name, workspacePath: created.workspacePath }),
  });
  await deleteWorkspaceProject({ appRoot, requestedPath: created.workspacePath });
  const trash = await listDeletedWorkspaces({ appRoot });
  assert.equal(trash.length, 1, "删除后必须进入工作区回收站");

  // Restoring to the same name must be allowed even though the old path has a
  // tombstone. The restore transaction clears it only after the archive move
  // is complete, then republishes the canonical state.
  const restored = await restoreDeletedWorkspace({ appRoot, trashId: trash[0].trashId });
  assert.equal(restored.workspacePath, created.workspacePath, "空出的原名称应优先用于恢复");
  const loaded = await loadWorkspaceState({ appRoot, requestedPath: created.workspacePath });
  assert.ok(loaded.state, "恢复到原名称后必须可正常读取");

  // A second delete leaves the original path protected while it is in trash;
  // a delayed autosave from the pre-delete renderer must not recreate it.
  await deleteWorkspaceProject({ appRoot, requestedPath: created.workspacePath });
  await assert.rejects(
    saveWorkspaceState({
      appRoot,
      requestedPath: created.workspacePath,
      state: createBlankProjectState({ name: "陈旧恢复前写入" }),
    }),
    (error) => error?.code === "WORKSPACE_DELETED_PATH",
    "恢复后再次删除仍必须拒绝陈旧写入",
  );

  // Deleting several workspaces concurrently must serialize writes to the
  // shared tombstone registry; losing one entry would allow one stale renderer
  // to recreate its old path after restart.
  const concurrent = await Promise.all(["并发删除甲", "并发删除乙", "并发删除丙"].map(async (name) => {
    const item = await createWorkspaceProject({ appRoot, name });
    await saveWorkspaceState({
      appRoot,
      requestedPath: item.workspacePath,
      state: createBlankProjectState({ name: item.name, workspacePath: item.workspacePath }),
    });
    await deleteWorkspaceProject({ appRoot, requestedPath: item.workspacePath });
    return item;
  }));
  for (const item of concurrent) {
    await assert.rejects(
      saveWorkspaceState({ appRoot, requestedPath: item.workspacePath, state: createBlankProjectState({ name: "并发陈旧写入" }) }),
      (error) => error?.code === "WORKSPACE_DELETED_PATH",
      `并发删除后的墓碑不得丢失：${item.name}`,
    );
  }
  console.log(JSON.stringify({ ok: true, checks: ["restore-original-name", "restore-load", "post-restore-delete-protection", "concurrent-tombstone-writes"] }));
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

