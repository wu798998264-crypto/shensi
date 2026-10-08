import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createVerifiedDataSnapshot,
  restoreVerifiedDataSnapshot,
} from "../src/server/update-data-guard.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "shensi-update-tombstone-preservation-"));
const dataRoot = join(sandbox, "data");
const tombstonePath = join(dataRoot, "config", "workspace-tombstones-v1.json");
const workspaceStatePath = join(dataRoot, "笔记", "我的笔记", ".shensi", "current-state.json");
try {
  await mkdir(join(dataRoot, "config"), { recursive: true });
  await mkdir(join(dataRoot, "笔记", "我的笔记", ".shensi"), { recursive: true });
  await writeFile(join(dataRoot, "document.json"), "latest-before-update\n");
  await writeFile(tombstonePath, JSON.stringify({ schemaVersion: 1, tombstones: {
    "E:/作品/旧内容": { workspaceKind: "project", deletedAt: "2026-10-01T00:00:00.000Z" },
  } }));
  await writeFile(workspaceStatePath, JSON.stringify({ documents: {
    "deleted-note": { title: "将被删除", html: "旧内容" },
    "keep-note": { title: "保留", html: "正文" },
  }, moduleItems: { library: [["deleted-note", "将被删除"], ["keep-note", "保留"]] }, trash: [] }));
  const snapshot = await createVerifiedDataSnapshot({ dataRoot, targetVersion: "9.2.5-test", operation: "upgrade" });

  await writeFile(join(dataRoot, "document.json"), "partial-update\n");
  await writeFile(tombstonePath, JSON.stringify({ schemaVersion: 1, tombstones: {
    "E:/作品/旧内容": { workspaceKind: "project", deletedAt: "2026-10-01T00:00:00.000Z" },
    "E:/作品/今天删除": { workspaceKind: "notebook", deletedAt: "2026-10-05T12:00:00.000Z" },
  } }));
  await writeFile(workspaceStatePath, JSON.stringify({ documents: {
    "keep-note": { title: "保留", html: "正文" },
  }, moduleItems: { library: [["keep-note", "保留"]] }, trash: [{
    id: "deleted-note", trashId: "trash-deleted-note", kind: "file", deletedAtIso: "2026-10-05T12:00:00.000Z",
  }] }));

  await restoreVerifiedDataSnapshot({ dataRoot, snapshotRoot: snapshot.snapshotRoot });
  assert.equal(await readFile(join(dataRoot, "document.json"), "utf8"), "latest-before-update\n");
  const restored = JSON.parse(await readFile(tombstonePath, "utf8"));
  assert.ok(restored.tombstones["E:/作品/今天删除"], "更新期间新增的删除墓碑不得被旧快照覆盖");
  assert.ok(restored.tombstones["E:/作品/旧内容"], "快照中的已有删除墓碑仍需保留");
  const restoredWorkspace = JSON.parse(await readFile(workspaceStatePath, "utf8"));
  assert.equal(restoredWorkspace.documents["deleted-note"], undefined, "更新回滚不得复活更新期间删除的文档");
  assert.ok(restoredWorkspace.trash.some((entry) => entry.trashId === "trash-deleted-note"), "更新期间的文档删除记录必须保留");
  console.log("Update rollback preserves newer workspace deletion tombstones");
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

