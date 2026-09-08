import assert from "node:assert/strict";

import { compileContextSections } from "../src/context-compiler.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { formalArtifactCommitEligibility } from "../src/formal-artifact-extractor.js";
import { creativeGuidanceInferenceRecord } from "../src/creative-guidance-record.js";
import { continuationDestinationIntent } from "../src/automatic-landing-policy.js";
import {
  candidateComparisonAnalysisRequested,
  candidateComparisonContextMessages,
} from "../src/conversation-context.js";

const hugeDocument = `全文开头标记\n${"人物沿着雨渠继续追查。\n".repeat(25_000)}全文结尾标记`;
const compiled = compileContextSections({
  ids: ["chapter-huge"],
  requiredIds: ["chapter-huge"],
  fullDocumentIds: ["chapter-huge"],
  titleFor: () => "超长当前章节",
  contentFor: () => hugeDocument,
  maxCharacters: 20_000,
  perDocumentLimit: 6_000,
  query: "续写当前章节，保持雨渠追查线",
});
const hugeManifest = compiled.manifest.find((item) => item.id === "chapter-huge");
assert.deepEqual(compiled.missingRequiredIds, [], "超长必读文档完整读取后必须压缩运行，不得形成上下文门禁");
assert.equal(hugeManifest?.included, true);
assert.equal(hugeManifest?.fullText, true, "fullText 表示全文已被服务读取并校验，不要求逐字塞进提示词");
assert.equal(hugeManifest?.compressed, true);
assert.equal(hugeManifest?.sourceCharacters, hugeDocument.trim().length);
assert.ok(Number(hugeManifest?.chunksRead) > 1, "全文读取回执必须覆盖多个分块");
assert.match(compiled.text, /全文开头标记/u);
assert.match(compiled.text, /全文结尾标记/u);
assert.match(compiled.text, /全文读取压缩回执/u);

const directRoute = buildAdaptiveTaskRoute({
  text: "续写当前章节并直接落盘",
  sourceMessageId: "user-direct-write",
  target: { documentId: "chapter-8", revision: "r8" },
  targetDocumentId: "chapter-8",
  targetDocumentIds: ["chapter-8"],
  expectedRevisions: { "chapter-8": "r8" },
}, { executionSurface: "agent" });
assert.equal(directRoute.writeAuthorization.state, "commit");
assert.equal(directRoute.candidatePreviewRequired, false, "普通正式写作默认不创建候选稿或候选窗口");
assert.equal(directRoute.formalArtifactExpected, true, "不显示候选窗口不能导致正式正文失去受管写入资格");
assert.equal(formalArtifactCommitEligibility({ route: directRoute, runStatus: "completed" }).eligible, true);

const candidateRoute = buildAdaptiveTaskRoute({
  text: "给我三版候选稿看看，不要落盘",
  sourceMessageId: "user-candidates",
  target: { documentId: "chapter-8", revision: "r8" },
  targetDocumentId: "chapter-8",
  targetDocumentIds: ["chapter-8"],
  expectedRevisions: { "chapter-8": "r8" },
}, { executionSurface: "chat" });
assert.equal(candidateRoute.writeAuthorization.state, "candidate_only");
assert.equal(candidateRoute.candidatePreviewRequired, true);

assert.equal(continuationDestinationIntent("续写当前文档"), "current");
assert.equal(continuationDestinationIntent("继续写下一章"), "next");
assert.equal(continuationDestinationIntent("续写"), "ambiguous");
assert.equal(continuationDestinationIntent("直接写第八章"), "none");

const guidanceRecord = creativeGuidanceInferenceRecord({
  userClues: ["现实题材，十二万字，主人公不能靠巧合。"],
  acceptedChanges: ["篇幅确定为十二万字；核心矛盾由职业选择推动。"],
  assistantText: "我建议加入失散兄弟线，这会更刺激。你喜欢吗？",
});
assert.match(guidanceRecord, /十二万字/u);
assert.match(guidanceRecord, /职业选择/u);
assert.doesNotMatch(guidanceRecord, /失散兄弟/u, "创作引导不得记录神思自行提出但用户未采用的建议");

const candidateMessages = [
  { id: "u1", role: "user", content: "给我三版候选稿" },
  { id: "c1", role: "assistant", candidate: "第一稿正文", candidateBranchGroupId: "g1", candidateBranchActive: false },
  { id: "c2", role: "assistant", candidate: "第二稿正文", candidateBranchGroupId: "g1", candidateBranchActive: true },
  { id: "c3", role: "assistant", candidate: "第三稿正文", candidateBranchGroupId: "g1", candidateBranchActive: false },
  { id: "u2", role: "user", content: "分析比较这三个候选稿" },
];
assert.equal(candidateComparisonAnalysisRequested(candidateMessages.at(-1).content), true);
const comparison = candidateComparisonContextMessages(candidateMessages);
assert.deepEqual(comparison.map((message) => message.id), ["c1", "c2", "c3"], "明确要求分析时才临时读取同组全部候选稿");
assert.equal(candidateComparisonContextMessages(candidateMessages.slice(0, -1)).length, 0, "常规状态不得读取未显示的候选稿");

console.log("Shensi v2.88 full-read and direct-writing tests passed");
