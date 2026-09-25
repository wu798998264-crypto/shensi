import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimCreativeStartWelcome } from "../src/server/first-run-experience-store.mjs";
import { readSourceWindow } from "./read-source-window.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-first-run-welcome-"));
try {
  const firstPath = join(root, "first.json");
  const first = await claimCreativeStartWelcome({ path: firstPath, now: () => "2026-09-25T00:00:00.000Z" });
  const second = await claimCreativeStartWelcome({ path: firstPath });
  assert.equal(first.show, true, "一台设备首次打开必须显示创作引导提示");
  assert.equal(second.show, false, "持久化领取后再次打开不得自动显示");
  assert.equal(JSON.parse(await readFile(firstPath, "utf8")).source, "first_software_open");

  const migratedPath = join(root, "migrated.json");
  const migrated = await claimCreativeStartWelcome({ path: migratedPath, legacySeen: true });
  const migratedAgain = await claimCreativeStartWelcome({ path: migratedPath });
  assert.equal(migrated.show, false, "旧版本已经看过提示的用户升级后不得再次显示");
  assert.equal(migrated.migrated, true);
  assert.equal(migratedAgain.show, false);

  const concurrentPath = join(root, "concurrent.json");
  const concurrent = await Promise.all(Array.from({ length: 4 }, () => claimCreativeStartWelcome({ path: concurrentPath })));
  assert.equal(concurrent.filter((item) => item.show).length, 1, "多个窗口并发启动时只能有一个窗口领取首次提示");

  const [appSource, serverSource] = await Promise.all([
    readSourceWindow(new URL("../src/app.js", import.meta.url), "const showCreativeStartWelcomeOnce = async", 42),
    readSourceWindow(new URL("../server.mjs", import.meta.url), 'pathname === "/api/ui/creative-start-welcome/claim"', 8),
  ]);
  assert.match(appSource, /legacySeen/u, "前端必须迁移旧 localStorage 已读标记");
  assert.match(appSource, /markCreativeStartWelcomeSeen\(\)/u, "服务器领取后仍应写入本地兼容标记");
  assert.match(serverSource, /claimCreativeStartWelcome/u, "首次展示资格必须由持久化服务原子领取");
  console.log("creative start welcome one-time persistence tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
