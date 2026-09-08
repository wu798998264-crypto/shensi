import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  creativeContractObservationProposal,
  mergeCreativeContractObservation,
} from "../src/creative-contract-observation.js";

const explicit = creativeContractObservationProposal(null, {
  instruction: "以后不要再使用“仿佛”这个词。",
  writingStyleQuality: { rules: [{ type: "word", value: "仿佛", maxOccurrences: 0, source: "current_instruction" }] },
});
assert.equal(explicit?.suggestedRule, "禁止使用“仿佛”。");
assert.equal(explicit?.source, "current_instruction");

const repeated = creativeContractObservationProposal(null, {
  writingStyleQuality: {
    remainingHits: [{ rule: { type: "phrase", value: "命运的齿轮" }, count: 3, allowed: 1 }],
  },
});
assert.match(repeated?.suggestedRule || "", /命运的齿轮/u);

assert.equal(mergeCreativeContractObservation("原合同。", null), "原合同。");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const orchestrator = await readFile(new URL("../src/server/shensi-orchestrator.mjs", import.meta.url), "utf8");
assert.match(app, /creativeContractObservationProposal\(rawReply\?\.reviewArtifact,\s*\{/u);
assert.match(app, /writingStyleQuality:\s*rawReply\?\.writingStyleQuality/u);
assert.doesNotMatch(app, /await\s+promptCreativeContractObservation/u, "创作合同选择不得阻断正文落盘");
assert.match(app, /本次避免/u);
assert.match(app, /写入创作合同/u);
assert.match(app, /暂不记录/u);
assert.match(app, /value === "persist"[\s\S]{0,500}saveCreativeContractObservation/u, "只有明确写入时才持久化创作合同");
assert.match(server, /currentDocumentText:\s*serverDocumentText\(currentWorkspaceSnapshot\?\.documents\?\.\[targetDocumentId\]/u, "续写扫描必须使用服务端核验的当前文档全文");
assert.match(server, /creativeContractText:\s*serverDocumentText\(currentWorkspaceSnapshot\?\.documents\?\.\["index-language-blacklist"\]/u, "语言规则必须读取真实创作合同正文");
assert.match(orchestrator, /runWritingStyleQualityControl\(\{/u, "初稿后必须进入统一软质检");
assert.match(orchestrator, /variant:\s*"writing_style_local"/u, "命中后只能进入一次局部语言修订协议");
assert.match(orchestrator, /blocking:\s*false,[\s\S]{0,80}mayLand:\s*true/u, "质检报告必须明确不阻断落盘");

const authorization = await readFile(new URL("../src/formal-write-authorization.js", import.meta.url), "utf8");
const landing = await readFile(new URL("../src/automatic-landing-policy.js", import.meta.url), "utf8");
assert.doesNotMatch(authorization, /writing-style|writingStyle|repetition-scanner/u, "语言质检不得进入正式写入授权");
assert.doesNotMatch(landing, /writing-style|writingStyle|repetition-scanner/u, "语言质检不得进入自动落盘门禁");

console.log("writing style creative-contract choice stays non-blocking tests passed");
