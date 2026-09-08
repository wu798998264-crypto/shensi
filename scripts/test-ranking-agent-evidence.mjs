import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  parseRankingAgentResult,
  validateRankingAgentResult,
} from "../src/server/ranking-agent-result.mjs";

const chapterText = "公开章节正文证据".repeat(80);
const chapterHash = createHash("sha256").update(chapterText, "utf8").digest("hex");
const complete = validateRankingAgentResult({
  platformId: "qidian",
  rankingId: "monthly",
  readAt: "2026-08-23T08:00:00.000Z",
  status: "success",
  requestedAnalysisScope: "chapter_evidence",
  items: [{
    platformId: "qidian",
    rankingId: "monthly",
    rank: 1,
    title: "真实作品",
    author: "真实作者",
    bookUrl: "https://www.qidian.com/book/100",
    sourceUrl: "https://www.qidian.com/rank/",
    collectedAt: "2026-08-23T08:00:00.000Z",
  }],
  chapterEvidence: [{
    title: "第1章",
    url: "https://www.qidian.com/chapter/100/1",
    wordCount: chapterText.length,
    contentHash: chapterHash,
    readAt: "2026-08-23T08:00:00.000Z",
  }],
  citations: [{ url: "https://www.qidian.com/rank/", label: "月票榜" }],
  coverage: { requestedChapters: 1, readChapters: 1, missing: [] },
  report: { summary: "基于公开章节证据的分析。", claimedScope: "chapter_evidence" },
}, { platformId: "qidian", requestedTopN: 1 });

assert.equal(complete.accepted, true);
assert.equal(complete.coverageLedger.analysisLevel, "chapter_evidence");
assert.equal(complete.coverageLedger.mayClaimFullText, false, "有限章节证据不得冒充全文分析");
assert.equal(complete.chapterEvidence[0].contentHash, chapterHash);

const unsupportedClaim = validateRankingAgentResult({
  platformId: "qidian",
  rankingId: "monthly",
  readAt: "2026-08-23T08:00:00.000Z",
  status: "success",
  items: complete.items,
  chapterEvidence: [{ title: "第1章", url: "https://www.qidian.com/chapter/100/1" }],
  coverage: { requestedChapters: 10, readChapters: 10 },
  report: { summary: "已经完成全文分析。", claimedScope: "full_text" },
}, { platformId: "qidian", requestedTopN: 1 });

assert.equal(unsupportedClaim.accepted, true, "榜单证据有效时仍可保留候选研究资料");
assert.equal(unsupportedClaim.coverageLedger.analysisLevel, "ranking_only");
assert.equal(unsupportedClaim.coverageLedger.mayClaimFullText, false);
assert.ok(unsupportedClaim.coverageLedger.warnings.some((item) => /全文|正文证据/u.test(item)));
assert.doesNotMatch(unsupportedClaim.report.summary, /完成全文分析/u, "展示报告不得保留未经证据支持的完成声明");

const blocked = validateRankingAgentResult({
  platformId: "fanqie",
  rankingId: "hot",
  readAt: "2026-08-23T08:00:00.000Z",
  status: "failed",
  failures: [{ scope: "chapter", reason: "需要登录或验证码", accessBoundary: "login_required" }],
  items: [],
  citations: [],
  coverage: { requestedChapters: 3, readChapters: 0, missing: ["全部章节"] },
  report: { summary: "无法合法读取正文。", claimedScope: "none" },
}, { platformId: "fanqie", requestedTopN: 10 });

assert.equal(blocked.accepted, false);
assert.equal(blocked.coverageLedger.analysisLevel, "none");
assert.match(blocked.userActionRequired, /上传|合法/u);

const parsed = parseRankingAgentResult(`\n\`\`\`json\n${JSON.stringify(complete.raw)}\n\`\`\`\n`);
assert.equal(parsed.platformId, "qidian", "应兼容 Agent 的 JSON 代码块输出");

console.log("Ranking Agent evidence tests passed");
