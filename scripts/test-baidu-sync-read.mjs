import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyStorageRootRead, previewStorageRootRead } from "../src/server/storage-manager.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-baidu-read-"));
const currentRoot = join(root, "current");
const syncRoot = join(root, "baidu-sync");
const emptyRoot = join(root, "empty");

const put = async (base, relativePath, content) => {
  const target = join(base, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
};

try {
  await Promise.all([mkdir(currentRoot), mkdir(syncRoot), mkdir(emptyRoot)]);
  await put(currentRoot, join("作品", "本机作品", ".shensi", "current-state.json"), "same-state");
  await put(syncRoot, join("作品", "本机作品", ".shensi", "current-state.json"), "same-state");
  await put(currentRoot, join("作品", "本机作品", "本机独有.md"), "local-only");
  await put(currentRoot, join("作品", "本机作品", "第一章.md"), "local-version");
  await put(syncRoot, join("作品", "本机作品", "第一章.md"), "remote-version");
  await put(syncRoot, join("笔记", "其他设备笔记", "同步内容.md"), "remote-only");

  const preview = await previewStorageRootRead({ targetRoot: syncRoot, currentRoot });
  assert.equal(preview.readable, true);
  assert.equal(preview.projectCount, 1);
  assert.equal(preview.notebookCount, 1);
  assert.equal(preview.targetOnlyCount, 1);
  assert.equal(preview.currentOnlyCount, 1);
  assert.equal(preview.identicalCount, 1);
  assert.equal(preview.differentCount, 1);
  assert.ok(preview.snapshotId);

  let activated = "";
  const applied = await applyStorageRootRead({
    targetRoot: syncRoot,
    currentRoot,
    expectedSnapshotId: preview.snapshotId,
    activateRoot: async (target) => { activated = target; },
  });
  assert.equal(applied.applied, true);
  assert.equal(activated, syncRoot);
  assert.equal(await readFile(join(currentRoot, "作品", "本机作品", "本机独有.md"), "utf8"), "local-only", "读取同步内容不得改写原数据目录");

  await assert.rejects(
    applyStorageRootRead({ targetRoot: emptyRoot, currentRoot, activateRoot: async () => {} }),
    /没有检测到可读取的神思/u,
  );

  const [appSource, serverSource] = await Promise.all([
    readFile(join(process.cwd(), "src", "app.js"), "utf8"),
    readFile(join(process.cwd(), "server.mjs"), "utf8"),
  ]);
  assert.match(appSource, /id="readBaiduSync"[^>]*>读取同步内容</u);
  assert.match(appSource, /id="confirmBaiduSyncRead"[^>]*>确认读取并切换</u);
  assert.match(appSource, /\/api\/storage\/read-preview/u);
  assert.match(appSource, /\/api\/storage\/read-apply/u);
  assert.match(serverSource, /pathname === "\/api\/storage\/read-preview"/u);
  assert.match(serverSource, /pathname === "\/api\/storage\/read-apply"/u);

  console.log(JSON.stringify({
    ok: true,
    projectCount: preview.projectCount,
    notebookCount: preview.notebookCount,
    targetOnlyCount: preview.targetOnlyCount,
    differentCount: preview.differentCount,
    originalDirectoryPreserved: true,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
