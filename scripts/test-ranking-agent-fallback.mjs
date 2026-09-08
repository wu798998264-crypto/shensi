import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRankingScanContract } from "../src/ranking-scan-contract.js";
import { RankingScanRunner } from "../src/server/ranking-scan-runner.mjs";
import { RankingSnapshotStore } from "../src/server/ranking-snapshot-store.mjs";

const root = await mkdtemp(join(tmpdir(), "ranking-agent-fallback-"));
try {
  const fullSkill = [
    "# 爆款扫榜",
    "必须读取公开榜单并保留真实来源。",
    "# Skill 必读规则文件：references/data-quality.md",
    "没有正文证据不得声称完成全文分析。",
  ].join("\n\n");
  let skillLoads = 0;
  let agentRuns = 0;
  const runner = new RankingScanRunner({
    snapshotStore: new RankingSnapshotStore({ root }),
    collectors: {
      qidian: async () => { throw new Error("可信采集器实时解析失败"); },
    },
    verifyCollector: async () => true,
    skillLoader: async () => {
      skillLoads += 1;
      return {
        id: "official:bestseller-ranking-scan",
        content: fullSkill,
        contentHash: createHash("sha256").update(fullSkill, "utf8").digest("hex"),
        fullText: true,
        truncated: false,
        skillReadFailures: [],
        ruleFiles: [{ path: "references/data-quality.md" }],
      };
    },
    agentExecutor: async ({ phase, platformId, skill, signal }) => {
      agentRuns += 1;
      assert.equal(signal.aborted, false);
      if (phase === "analysis") return {
        execution: { engine: "codex", model: "gpt-test", runId: "agent-analysis-1" },
        result: { finalReport: { summary: "已经完成全文分析，并形成趋势结论。", trends: [], limitations: ["没有公开章节正文证据"] } },
      };
      assert.equal(platformId, "qidian");
      assert.match(skill.content, /必读规则文件/u, "Agent 必须收到包含必读引用的完整 Skill");
      return {
        execution: { engine: "codex", model: "gpt-test", runId: "agent-run-1" },
        result: {
          platformId,
          rankingId: "monthly",
          readAt: "2026-08-23T08:00:00.000Z",
          status: "success",
          items: Array.from({ length: 15 }, (_, index) => ({
            platformId,
            rankingId: "monthly",
            rank: index + 1,
            title: `作品${index + 1}`,
            author: `作者${index + 1}`,
            bookUrl: `https://www.qidian.com/book/${index + 1}`,
            sourceUrl: "https://www.qidian.com/rank/",
            collectedAt: "2026-08-23T08:00:00.000Z",
            sourceMode: "controlled_browser",
          })),
          chapterEvidence: [],
          citations: [{ url: "https://www.qidian.com/rank/", label: "起点月票榜" }],
          coverage: { requestedChapters: 0, readChapters: 0, missing: ["未请求正文"] },
          failures: [],
          report: { summary: "仅基于公开榜单和简介的趋势分析。", claimedScope: "ranking_only" },
        },
      };
    },
  });
  const contract = createRankingScanContract({
    workspaceId: "workspace-1",
    sourceMessageId: "message-1",
    platforms: ["qidian"],
    rankings: ["monthly"],
    channel: "male",
    topN: 15,
    allowSnapshotWrite: true,
  });
  const started = runner.start(contract, { agentExecution: { engine: "codex" } });
  const duplicate = runner.start({ ...contract, operationId: "duplicate-operation" }, { agentExecution: { engine: "codex" } });
  assert.equal(duplicate.taskId, started.taskId);
  const completed = await runner.wait(started.taskId);
  assert.equal(skillLoads, 1, "同一任务只能完整加载一次爆款扫榜 Skill");
  assert.equal(agentRuns, 2, "同一任务只允许一次 Agent 采集兜底和一次最终分析，不得因重复点击再次提交");
  assert.equal(completed.status, "completed");
  assert.equal(completed.sourceLedger[0].route, "agent_fallback");
  assert.match(completed.sourceLedger[0].fallbackReason, /采集器/u);
  assert.equal(completed.skillReceipt.fullText, true);
  assert.equal(completed.coverageLedger.analysisLevel, "ranking_only");
  assert.equal(completed.report.authorizationState, "candidate_only");
  assert.equal(completed.report.coverage.mayClaimFullText, false);
  assert.doesNotMatch(completed.report.marketOverview, /完成全文分析/u, "最终分析阶段同样不得绕过正文覆盖门禁");

  let shouldNotRun = 0;
  const missingSkillRunner = new RankingScanRunner({
    snapshotStore: new RankingSnapshotStore({ root: join(root, "missing-skill") }),
    collectors: {},
    verifyCollector: async () => true,
    skillLoader: async () => ({ id: "official:bestseller-ranking-scan", content: "目录简介", fullText: false, truncated: true, skillReadFailures: [{ path: "references/data-quality.md", reason: "missing" }] }),
    agentExecutor: async () => { shouldNotRun += 1; return {}; },
  });
  const missingSkillTask = missingSkillRunner.start(createRankingScanContract({
    ...contract,
    id: "missing-skill-task",
    operationId: "missing-skill-operation",
    requestedAt: "2026-08-24T08:00:00.000Z",
  }));
  const missingSkill = await missingSkillRunner.wait(missingSkillTask.taskId);
  assert.equal(missingSkill.status, "failed");
  assert.equal(shouldNotRun, 0, "Skill 全文未加载成功时不得伪装为已执行 Agent");
  assert.match(missingSkill.error, /Skill.*全文|必读/u);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("Ranking Agent fallback tests passed");
