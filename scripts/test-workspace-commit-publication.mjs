import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mkdtemp } from "node:fs/promises";

const root = await mkdtemp(join(tmpdir(), "shensi-workspace-commit-publication-"));
process.env.SHENSI_DATA_ROOT = root;
try {
  const { loadWorkspaceState } = await import(`../src/server/workspace.mjs?publication=${Date.now()}`);
  const workspacePath = join(root, "作品", "混合提交测试");
  const internal = join(workspacePath, ".shensi");
  await mkdir(join(internal, "history-isolated"), { recursive: true });
  const current = {
    schemaVersion: 3,
    workspaceKind: "project",
    projectName: "混合提交测试",
    workspaceCommitId: "commit-current",
    documents: {},
    conversations: [],
  };
  const isolated = {
    schemaVersion: 3,
    workspaceCommitId: "commit-shard",
    documents: {},
    views: {},
    volumes: {},
    modules: {},
    project: null,
    rollback: "rollback/conversations-and-branches.json",
    rollbackObjects: "rollback/document-objects.json",
    rollbackObjectCount: 0,
  };
  await writeFile(join(internal, "current-state.json"), JSON.stringify(current), "utf8");
  await writeFile(join(internal, "history-isolated", "index.json"), JSON.stringify(isolated), "utf8");
  await writeFile(join(internal, "manifest.json"), JSON.stringify({ schemaVersion: 1, manifest: {} }), "utf8");
  await writeFile(join(internal, "commit.json"), JSON.stringify({ commitId: "commit-current" }), "utf8");
  await assert.rejects(
    loadWorkspaceState({ appRoot: root, requestedPath: workspacePath }),
    (error) => error?.code === "WORKSPACE_COMMIT_MISMATCH" && error?.statusCode === 409,
    "current-state 与 history shard commit 不一致时必须拒绝加载混合内容",
  );

  isolated.workspaceCommitId = "commit-current";
  await writeFile(join(internal, "history-isolated", "index.json"), JSON.stringify(isolated), "utf8");
  await assert.rejects(
    loadWorkspaceState({ appRoot: root, requestedPath: workspacePath }),
    (error) => error?.code === "WORKSPACE_COMMIT_MISMATCH" && error?.statusCode === 409,
    "commit ID 一致但发布 marker 缺少分片 hash 时也必须拒绝加载",
  );
  console.log("workspace commit/shard mixed-version rejection tests passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()));
  await rm(resolved, { recursive: true, force: true });
  delete process.env.SHENSI_DATA_ROOT;
}
