import assert from "node:assert/strict";
import {
  generationAttemptCandidateById,
  generationAttemptCandidateVariants,
  generationAttemptReviewRecoveryFailure,
  publicGenerationAttempt,
  resolveGenerationAttemptReviewGate,
} from "../src/server/generation-attempt-store.mjs";
import { buildNativeReviewArtifact } from "../src/server/native-creative-artifacts.mjs";
import {
  generationResultMayDefaultLand,
  terminalGenerationAttempt,
} from "../src/generation-attempt-client.js";

const failureText = "本轮质量审查未返回有效报告，不能提交。正文、报告和记忆均未改变；可以按原任务重试。";
const legacy = {
  schemaVersion: 4,
  requestId: "review-recovery-failed-001",
  taskKind: "creative",
  targetDocumentId: "report-novel",
  status: "awaiting_action",
  executionStatus: "terminal",
  validationStatus: "warning",
  landingStatus: "ready",
  landingEligible: true,
  adoptedCandidate: failureText,
  candidates: [{ text: failureText, stage: "finished", index: 0 }],
  execution: { status: "retry_required", finalVerdict: "soft_warning", stages: [{ id: "audit-invalid-output" }] },
  resultData: { payload: { ok: true, text: failureText, execution: { status: "retry_required" } } },
  reviewArtifact: null,
};
const unchanged = JSON.stringify(legacy);
const recovered = publicGenerationAttempt(legacy);
assert.equal(JSON.stringify(legacy), unchanged, "恢复视图不能修改原记录、候选或历史 payload");
assert.equal(recovered.status, "failed");
assert.equal(recovered.execution.status, "retry_required");
assert.equal(recovered.execution.finalVerdict, "");
assert.equal(recovered.artifactSummary.review, "invalid");
assert.equal(recovered.validationStatus, "blocked");
assert.equal(recovered.landingStatus, "not_requested");
assert.equal(recovered.landingEligible, false);
assert.equal(recovered.recoverableAfterRestart, false);
assert.equal(recovered.candidate, "");
assert.deepEqual(recovered.candidateVariants, []);
assert.equal(recovered.resultData, null, "失败 payload 不能被 terminalGenerationAttempt 当作完成成果");
assert.equal(recovered.recoveryEvidence.candidate, failureText);
assert.deepEqual(recovered.recoveryEvidence.resultData, legacy.resultData);
assert.equal(terminalGenerationAttempt({ active: false, attempt: recovered }).ok, false);
assert.equal(generationResultMayDefaultLand({ candidate: recovered.candidate, generationAttempt: recovered }), false);
assert.deepEqual(generationAttemptCandidateVariants(legacy), []);
assert.equal(generationAttemptCandidateById(legacy, "candidate-old"), null);

const validText = "# 前三章自检报告\n\n第一章：灯下身份有证据。\n第二章：照片缺角有铺垫。\n第三章：两条毛巾承接明确。";
const validReview = buildNativeReviewArtifact({
  targetDocumentId: "report-novel",
  candidate: validText,
  verdict: { outcome: "ready_to_land", hardReasons: [], warnings: [] },
  evaluation: { pass: true },
});
const valid = {
  ...legacy,
  adoptedCandidate: validText,
  candidates: [{ text: validText, stage: "audit", index: 0 }],
  validationStatus: "passed",
  execution: { status: "ready_to_land", validationStatus: "passed", landingStatus: "ready" },
  resultData: { payload: { ok: true, text: validText, execution: { status: "ready_to_land" } } },
  reviewArtifact: validReview,
};
assert.equal(generationAttemptReviewRecoveryFailure(valid), "");
assert.equal(publicGenerationAttempt(valid).candidate, validText);
assert.equal(publicGenerationAttempt(valid).landingEligible, true);
assert.equal(terminalGenerationAttempt({ active: false, attempt: publicGenerationAttempt(valid) }).ok, true);

for (const status of ["failed", "retry_required", "cancelled", "interrupted"]) {
  const failed = { ...valid, status };
  assert.equal(generationAttemptReviewRecoveryFailure(failed), "TEXT_REVIEW_FAILED");
  assert.equal(publicGenerationAttempt(failed).landingEligible, false, "失败终态即使残留匹配审查也不能自动恢复成果");
}
assert.equal(generationAttemptReviewRecoveryFailure({
  ...valid,
  resultData: { payload: { ...valid.resultData.payload, execution: { status: "retry_required" } } },
}), "TEXT_REVIEW_FAILED", "payload 的失败不能被顶层 ready 掩盖");
assert.equal(generationAttemptReviewRecoveryFailure({ ...valid, reviewArtifact: null }), "TEXT_REVIEW_EVIDENCE_MISSING");
assert.equal(generationAttemptReviewRecoveryFailure({ ...valid, adoptedCandidate: `${validText}\n新增未经审查内容` }), "TEXT_REVIEW_EVIDENCE_MISSING");
assert.equal(generationAttemptReviewRecoveryFailure({ ...valid, adoptedCandidate: "<tool_call>planning</tool_call>" }), "TEXT_REVIEW_RESULT_INVALID");
assert.equal(generationAttemptReviewRecoveryFailure({ ...valid, adoptedCandidate: "", candidates: [] }), "TEXT_REVIEW_RESULT_INVALID");
assert.equal(generationAttemptReviewRecoveryFailure({ ...legacy, status: "running", executionStatus: "running" }), "", "用户明确重试中的任务不能被上次终态提前结束");

for (const targetDocumentId of ["report-script", "report-adaptation"]) {
  assert.equal(publicGenerationAttempt({ ...legacy, targetDocumentId }).landingEligible, false);
}
for (const targetDocumentId of ["chapter-1", "card-image-1", "card-video-1"]) {
  const other = publicGenerationAttempt({ ...legacy, targetDocumentId });
  assert.equal(other.candidate, failureText, "迁移仅限固定文字审查报告，不能更改正文草稿或媒体恢复策略");
  assert.equal(other.landingEligible, true);
  assert.equal(other.recoveryEvidence, undefined);
}
const committed = publicGenerationAttempt({ ...legacy, landingStatus: "committed", commitReceipt: { status: "committed" } });
assert.equal(committed.landingStatus, "committed", "不能把历史已经落盘伪称为未发生");
assert.equal(committed.landingEligible, false);
assert.equal(committed.commitReceipt.status, "committed");

assert.equal(resolveGenerationAttemptReviewGate({
  selfCheckRequested: true,
  hasPersistedCandidate: true,
  requestedLandingEligible: true,
  requestedValidationStatus: "passed",
  requestedLandingStatus: "committed",
}).landingEligible, true, "本次只读迁移不改变普通正文现有审查与提交策略");

console.log("Generation attempt review recovery checks passed");
