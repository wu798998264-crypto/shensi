import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRankingScanContract } from "../src/ranking-scan-contract.js";
import { RankingScanRunner } from "../src/server/ranking-scan-runner.mjs";
import { RankingSnapshotStore } from "../src/server/ranking-snapshot-store.mjs";

const root = await mkdtemp(join(tmpdir(), "ranking-runner-"));
try {
  const skillLoader = async () => ({ id: "official:bestseller-ranking-scan", content: "完整扫榜方法与质量规则", contentHash: "test-skill", fullText: true, truncated: false, skillReadFailures: [], ruleFiles: [] });
  const agentExecutor = async ({ phase }) => ({ execution: { engine: "codex", model: "test", runId: `run-${phase}` }, result: { finalReport: { summary: "基于快照的结构化分析" } } });
  let collects = 0;
  const runner = new RankingScanRunner({
    snapshotStore: new RankingSnapshotStore({ root }),
    collectors: { qidian: async () => { collects += 1; return Array.from({ length: 15 }, (_, index) => ({ platformId: "qidian", rankingId: "monthly", rank: index + 1, title: `作品${index}`, author: `作者${index}`, sourceUrl: "https://www.qidian.com/rank/", collectedAt: "2026-08-21T08:00:00.000Z" })); } },
    verifyCollector: async () => true,
    skillLoader,
    agentExecutor,
  });
  const base = createRankingScanContract({ workspaceId: "w1", sourceMessageId: "m1", scanType: "long", platforms: ["qidian"], rankings: ["monthly"], channel: "male", topN: 15, allowSnapshotWrite: true });
  const first = runner.start(base);
  const duplicate = runner.start({ ...base, operationId: "other" });
  assert.equal(duplicate.taskId, first.taskId);
  const result = await runner.wait(first.taskId);
  assert.equal(collects, 1);
  assert.equal(result.status, "completed");
  assert.ok(result.snapshotIds.length);
  assert.ok(result.report);
  assert.equal(runner.status(first.taskId).taskId, first.taskId, "状态查询不得创建新任务");

  const missingReportRunner = new RankingScanRunner({
    snapshotStore: new RankingSnapshotStore({ root: join(root, "missing-report") }),
    collectors: runner.collectors,
    verifyCollector: async () => true,
    skillLoader,
    agentExecutor,
    analyzer: async () => null,
  });
  const missingReportTask = missingReportRunner.start(createRankingScanContract({ ...base, id: "missing-report", operationId: "missing-report-operation", requestedAt: "2026-08-22T08:00:00.000Z" }));
  const missingReportResult = await missingReportRunner.wait(missingReportTask.taskId);
  assert.equal(missingReportResult.status, "partial", "后台采集完成但报告未返回不能标记 completed");

  let continuedAfterCancel = false;
  const cancelRunner = new RankingScanRunner({
    snapshotStore: new RankingSnapshotStore({ root: join(root, "cancel") }),
    collectors: { qidian: async ({ signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { continuedAfterCancel = true; resolve([]); }, 200);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("cancelled", "AbortError")); }, { once: true });
    }) },
    verifyCollector: async () => true,
    skillLoader,
    agentExecutor,
  });
  const cancelTask = cancelRunner.start(createRankingScanContract({ ...base, id: "cancel-task", operationId: "cancel-operation", requestedAt: "2026-08-23T08:00:00.000Z" }));
  cancelRunner.cancel(cancelTask.taskId);
  const cancelled = await cancelRunner.wait(cancelTask.taskId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(continuedAfterCancel, false, "取消后不得继续采集");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("Ranking scan idempotency tests passed");
