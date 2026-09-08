import assert from "node:assert/strict";
import { createRankingAgentExecutor } from "../src/server/ranking-agent-executor.mjs";

const listeners = new Map();
let captured = null;
const provider = {
  on(type, listener) {
    const values = listeners.get(type) || new Set();
    values.add(listener);
    listeners.set(type, values);
    return () => values.delete(listener);
  },
  async startTurn(prompt, options) {
    captured = { prompt, options };
    const requestId = options.taskPacket.requestId;
    queueMicrotask(() => {
      const run = {
        id: "run-1", turnId: "turn-1", requestId, status: "completed", engine: "codex", agentModel: "gpt-test",
        text: JSON.stringify({
          platformId: "qidian", rankingId: "monthly", readAt: "2026-08-23T08:00:00.000Z", status: "success",
          items: [{ rank: 1, title: "作品", author: "作者", bookUrl: "https://www.qidian.com/book/1", sourceUrl: "https://www.qidian.com/rank/", collectedAt: "2026-08-23T08:00:00.000Z" }],
          chapterEvidence: [], citations: [{ url: "https://www.qidian.com/rank/" }], failures: [], coverage: { requestedChapters: 0, readChapters: 0, missing: [] }, report: { summary: "榜单分析", claimedScope: "ranking_only" },
        }),
        executionSourceReceipt: { verified: true },
      };
      for (const listener of listeners.get("run_completed") || []) listener(run);
    });
    return { id: "run-1", turnId: "turn-1", requestId, status: "running" };
  },
  async interrupt() { return null; },
};

const executor = createRankingAgentExecutor({ provider, defaultProjectCwd: "C:/workspace", timeoutMs: 5_000 });
const skill = {
  id: "official:bestseller-ranking-scan",
  content: "完整 Skill 与必读规则",
  contextBlock: { type: "controlled_skill", id: "official:bestseller-ranking-scan", name: "爆款扫榜", text: "source-proof\n完整 Skill 与必读规则" },
};
const response = await executor({
  phase: "platform_collection", taskId: "task-1", operationId: "operation-1", platformId: "qidian", fallbackReason: "collector failed", skill,
  contract: { scanType: "long", platforms: ["qidian"], rankings: ["monthly"], channel: "male", genre: "", topN: 1 },
  evidence: {}, execution: { projectCwd: "C:/workspace", agentSettings: {} },
});

assert.equal(response.result.platformId, "qidian");
assert.equal(response.execution.engine, "codex");
assert.equal(captured.options.taskPacket.trustedReadOnlyNetwork, true);
assert.equal(captured.options.taskPacket.rankingScan, true);
assert.equal(captured.options.taskRoute.authorizationState, "candidate_only");
assert.equal(captured.options.taskRoute.commitOwner, "none");
assert.equal(captured.options.contextBlocks[0].type, "controlled_skill");
assert.match(captured.options.contextBlocks[0].text, /完整 Skill 与必读规则/u);
assert.equal(captured.options.contextBlocks[1].mimeType, "application/json");
assert.match(captured.prompt, /实际使用当前 Agent 可用的联网搜索/u);

console.log("Ranking Agent executor tests passed");
