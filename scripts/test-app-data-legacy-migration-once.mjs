import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateLegacyData } from "../src/server/app-data.mjs";

const sandbox = await mkdtemp(join(tmpdir(), "shensi-legacy-migration-once-"));
const source = join(sandbox, "legacy");
const target = join(sandbox, "active");
const legacyDocument = join(source, "笔记", "我的笔记", "被删除的旧文档.md");
const activeDocument = join(target, "笔记", "我的笔记", "被删除的旧文档.md");
try {
  await mkdir(join(source, "笔记", "我的笔记"), { recursive: true });
  await writeFile(legacyDocument, "旧文件不可在更新后复活", "utf8");
  assert.equal(await migrateLegacyData(source, target), true, "空目标首次允许完整迁移");
  assert.equal(await readFile(activeDocument, "utf8"), "旧文件不可在更新后复活");
  await rm(activeDocument);
  assert.equal(await migrateLegacyData(source, target), false, "完成的迁移不得重跑");
  assert.equal(await stat(activeDocument).catch(() => null), null, "目标已删除文件不得从保留的旧副本复活");

  const establishedTarget = join(sandbox, "established");
  await mkdir(join(establishedTarget, "笔记", "我的笔记"), { recursive: true });
  await writeFile(join(establishedTarget, "笔记", "我的笔记", "最新正文.md"), "当前数据根为唯一权威版本", "utf8");
  assert.equal(await migrateLegacyData(source, establishedTarget), false, "已有作品/笔记目录不得隐式合并旧内容");
  assert.equal(await stat(join(establishedTarget, "笔记", "我的笔记", "被删除的旧文档.md")).catch(() => null), null);
  const marker = JSON.parse(await readFile(join(establishedTarget, ".shensi-legacy-migration-v2.json"), "utf8"));
  assert.equal(marker.mode, "target-already-populated");
  assert.equal(marker.completed, true);

  const interruptedTarget = join(sandbox, "interrupted");
  await mkdir(interruptedTarget, { recursive: true });
  await writeFile(join(interruptedTarget, ".shensi-legacy-migration-v2.json"), JSON.stringify({
    schemaVersion: 2,
    completed: false,
    mode: "copying",
    sourceRoot: resolve(source),
    completedMarkers: ["作品"],
  }), "utf8");
  await migrateLegacyData(source, interruptedTarget);
  assert.equal(await readFile(join(interruptedTarget, "笔记", "我的笔记", "被删除的旧文档.md"), "utf8"), "旧文件不可在更新后复活", "中断迁移必须继续未完成的顶层目录");
  console.log(JSON.stringify({ ok: true, checks: ["first-migration", "deleted-file-not-reimported", "authoritative-target-not-merged", "interrupted-migration-resume"] }));
} finally {
  assert.ok(resolve(sandbox).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}\\`));
  await rm(sandbox, { recursive: true, force: true });
}
