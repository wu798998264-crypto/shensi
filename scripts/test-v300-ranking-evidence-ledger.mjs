import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createRankingScanContract } from "../src/ranking-scan-contract.js";
import { RankingScanRunner } from "../src/server/ranking-scan-runner.mjs";

const now = () => new Date("2026-08-24T00:00:00.000Z");
const saved = [];
const snapshotStore = {
  async save(value) {
    const snapshot = { ...value, snapshotId: `snapshot-${saved.length + 1}` };
    saved.push(snapshot);
    return snapshot;
  },
  async verify(snapshotId) { return saved.some((item) => item.snapshotId === snapshotId); },
};
const skill = {
  id: "official:bestseller-ranking-scan",
  version: "test",
  content: "爆款扫榜完整 Skill 正文\n必读规则：保留正文证据与访问边界。",
  contentHash: "skill-hash",
  fullText: true,
  truncated: false,
  ruleFiles: [{ path: "references/evidence.md" }],
};
const chapter = "这是一段公开章节正文。".repeat(40);
const chapterHash = createHash("sha256").update(chapter, "utf8").digest("hex");
let receivedSkill = null;
const runner = new RankingScanRunner({
  snapshotStore,
  collectors: { qidian: async () => { throw new Error("可信采集器暂不可用"); } },
  verifyCollector: async () => true,
  skillLoader: async () => skill,
  agentExecutor: async ({ phase, skill: received }) => {
    receivedSkill = received;
    if (phase === "analysis") return {
      execution: { engine: "codex", model: "gpt-test", runId: "analysis-1" },
      result: { summary: "基于公开章节证据的趋势分析", citations: [{ url: "https://www.qidian.com/rank" }] },
    };
    return {
      execution: { engine: "codex", model: "gpt-test", runId: "collection-1" },
      result: {
        platformId: "qidian", rankingId: "monthly", readAt: now().toISOString(), status: "success",
        items: Array.from({ length: 15 }, (_, index) => ({ rank: index + 1, title: `真实作品${index + 1}`, author: `作者${index + 1}`, bookUrl: `https://www.qidian.com/book/${index + 1}`, sourceUrl: "https://www.qidian.com/rank", collectedAt: now().toISOString() })),
        chapterEvidence: [{ title: "第1章", url: "https://www.qidian.com/chapter/1", wordCount: chapter.length, contentHash: chapterHash, readAt: now().toISOString() }],
        citations: [{ url: "https://www.qidian.com/rank", label: "月榜" }],
        coverage: { requestedChapters: 2, readChapters: 1, missing: ["第2章（公开页不可读）"] },
        report: { summary: "基于公开章节的分析", claimedScope: "chapter_evidence" },
      },
    };
  },
  analyzer: async () => ({ marketOverview: "本地快照分析", coverage: {} }),
  now,
});

const contract = createRankingScanContract({
  id: "ranking-v300", operationId: "operation-v300", idempotencyKey: "ranking-v300-key",
  workspaceId: "workspace-v300", platforms: ["qidian"], rankings: ["monthly"], topN: 15,
  allowSnapshotWrite: true, allowBrowserAccess: true,
}, { now, idFactory: (prefix) => `${prefix}-fixed` });
runner.start(contract);
const task = await runner.wait(contract.id);
assert.equal(task.status, "completed", JSON.stringify({ error: task.error, failedPlatforms: task.failedPlatforms, analysisFailure: task.analysisFailure }));
assert.equal(task.skillReceipt.fullText, true, "未完整加载 Skill 不得开始扫榜");
assert.equal(task.skillReceipt.contentLength, skill.content.length);
assert.deepEqual(task.skillReceipt.ruleFiles, ["references/evidence.md"]);
assert.equal(receivedSkill.content, skill.content, "Agent 必须收到完整 Skill 正文");
assert.equal(task.sourceLedger[0].route, "agent_fallback", "采集器失败必须交由当前 Agent 接管");
assert.equal(task.sourceLedger[0].chapterEvidence[0].contentHash, chapterHash);
assert.equal(task.coverageLedger.mayClaimFullText, false, "未读全书正文时不得声称全文分析");
assert.match(task.report.marketOverview, /公开章节/u, "报告应保留经过证据约束的结论");
assert.equal(task.report.authorizationState, "candidate_only", "扫榜报告默认只能作为研究候选资料");
assert.equal(saved.length, 1);
assert.equal(saved[0].evidenceLedger.route, "agent_fallback");

console.log("v3.0 扫榜证据账本测试通过");
