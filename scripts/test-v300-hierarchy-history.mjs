import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveHistoryTaskScope } from "../src/history-task-scope.js";

assert.deepEqual(resolveHistoryTaskScope([
  { documentId: "chapter-1", moduleId: "manuscript", viewId: "novel", volumeId: "volume-1" },
  { documentId: "chapter-2", moduleId: "manuscript", viewId: "novel", volumeId: "volume-1" },
]), { type: "volume", id: "volume-1" }, "同卷批量修改必须创建卷级历史");

assert.deepEqual(resolveHistoryTaskScope([
  { documentId: "chapter-1", moduleId: "manuscript", viewId: "novel" },
  { documentId: "canon-world", moduleId: "canon", viewId: "novel" },
]), { type: "project", id: "project" }, "跨模块批量修改必须创建作品级历史");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /if \(scope && scope\.type !== "document"\) snapshotResolvedHistoryScope/u, "批量写入必须先保存对应层级历史");
assert.match(app, /for \(const documentId of documentIds\)[\s\S]{0,180}snapshotDocument/u, "层级历史之外必须逐文档保存完整历史");
assert.match(app, /data-history-version-name/u, "历史版本必须支持命名");
assert.match(app, /data-history-version-note/u, "历史版本必须支持备注");

console.log("Shensi v3.0 hierarchy history tests passed");
