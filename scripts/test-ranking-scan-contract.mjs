import assert from "node:assert/strict";
import {
  createRankingScanContract,
  rankingScanCompletionStatus,
  rankingScanIdempotencyKey,
  rankingScanIntent,
} from "../src/ranking-scan-contract.js";

const now = () => new Date("2026-08-21T08:00:00.000Z");
const contract = createRankingScanContract({
  workspaceId: "work-1",
  sourceMessageId: "message-1",
  scanType: "long",
  platforms: ["qidian"],
  rankings: ["new-book"],
  channel: "male",
  topN: 30,
  requestedAgentProfileId: "agent-profile-1",
  requestedAgentEngine: "opencode",
}, { now });
assert.equal(contract.allowBrowserAccess, false);
assert.equal(contract.allowAuthenticatedPageAccess, false);
assert.equal(contract.allowReportLanding, false);
assert.equal(contract.allowSnapshotWrite, false);
assert.equal(contract.status, "pending");
assert.equal(contract.taskContractType, "read_only_market_research");
assert.equal(contract.authorizationState, "candidate_only");
assert.equal(contract.requiredSkillId, "official:bestseller-ranking-scan");
assert.equal(contract.allowWorkspaceMutation, false);
assert.equal(contract.requestedAt, "2026-08-21T08:00:00.000Z");
assert.equal(contract.requestedAgentProfileId, "agent-profile-1");
assert.equal(contract.requestedAgentEngine, "opencode");
assert.equal(contract.idempotencyKey, rankingScanIdempotencyKey(contract));
assert.equal(rankingScanIntent("扫榜是什么意思").kind, "knowledge");
assert.equal(rankingScanIntent("扫一下起点男频新书榜").kind, "scan");
assert.equal(rankingScanIntent("写第一章").kind, "none");
assert.equal(rankingScanIntent("扫一下起点男频新书榜", { skillEnabled: false }).kind, "none");
assert.equal(rankingScanIntent("@爆款扫榜 扫一下起点男频新书榜", { skillEnabled: false }).kind, "scan");
assert.equal(rankingScanCompletionStatus({ snapshotSaved: true, reportReturned: false }), "partial");
assert.equal(rankingScanCompletionStatus({ snapshotSaved: true, reportReturned: true }), "completed");
assert.equal(rankingScanCompletionStatus({ snapshotSaved: true, reportReturned: true, coverageValidated: false }), "partial");
console.log("Ranking scan contract tests passed");
