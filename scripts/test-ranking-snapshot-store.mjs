import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RankingSnapshotStore } from "../src/server/ranking-snapshot-store.mjs";

const root = await mkdtemp(join(tmpdir(), "ranking-snapshot-"));
try {
  const store = new RankingSnapshotStore({ root });
  const source = { taskId: "task-1", idempotencyKey: "key-1", platformId: "qidian", rankingId: "monthly", collectedAt: "2026-08-21T08:00:00.000Z", sourceUrls: ["https://www.qidian.com/rank/"], quality: { status: "ok" }, items: [{ rank: 1, title: "星门夜渡", author: "林舟" }], evidenceLedger: { route: "agent_fallback", coverage: { analysisLevel: "ranking_only", mayClaimFullText: false }, citations: [{ url: "https://www.qidian.com/rank/" }] } };
  const first = await store.save(source);
  const duplicate = await store.save(source);
  assert.equal(duplicate.snapshotId, first.snapshotId);
  assert.equal(duplicate.deduplicated, true);
  const loaded = await store.load(first.snapshotId);
  assert.equal(loaded.collectedAt, source.collectedAt);
  assert.equal(loaded.schemaVersion, 2);
  assert.deepEqual(loaded.evidenceLedger, source.evidenceLedger, "来源和覆盖账本必须进入不可变快照");
  assert.equal(await store.verify(first.snapshotId), true);
  const next = await store.save({ ...source, taskId: "task-2", idempotencyKey: "key-2", collectedAt: "2026-08-22T08:00:00.000Z" });
  assert.notEqual(next.snapshotId, first.snapshotId);
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Ranking snapshot store tests passed");
