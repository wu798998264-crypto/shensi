import assert from "node:assert/strict";
import { assessRankingData, normalizeRankingEntry } from "../src/server/ranking-data-quality.mjs";

const base = Array.from({ length: 15 }, (_, index) => normalizeRankingEntry({
  platformId: "qidian", rankingId: "monthly", rankingName: "月票榜", rank: index + 1,
  title: `作品${index + 1}`, author: `作者${index + 1}`, sourceUrl: "https://www.qidian.com/rank/",
  rawPublicMetrics: { 月票: 1000 - index }, collectedAt: "2026-08-21T08:00:00.000Z",
}));
assert.equal(assessRankingData(base).status, "ok");
const duplicate = [...base.slice(0, 9), base[0], { ...base[1], title: "", author: "" }];
const partial = assessRankingData(duplicate);
assert.equal(partial.status, "partial");
assert.equal(partial.duplicateEntries, 1);
assert.equal(partial.invalidEntries, 1);
assert.ok(partial.warnings.some((item) => /稀疏/u.test(item)));
assert.equal(base[0].publicMetrics.月票, undefined, "平台原始指标不得伪装成统一指标");
console.log("Ranking data quality tests passed");
