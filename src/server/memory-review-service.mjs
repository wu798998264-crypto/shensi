import {
  memoryBackfillCandidateId,
  memoryBackfillSourceHash,
  memoryBackfillSourceText,
} from "../memory-backfill.js";
import { memorySourceRevision } from "../memory-source.js";
import { verifyMemoryUpdateEvidence } from "../memory-evidence.js";
import { normalizeLedgerEntries } from "../information-ledger.js";
import { normalizeStateEntries } from "../memory-compiler.js";

const clone = (value) => structuredClone(value);

export class MemoryBackfillReviewError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "MemoryBackfillReviewError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

const assertCandidateEnvelope = (candidate = {}) => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new MemoryBackfillReviewError("INVALID_CANDIDATE", "缺少记忆回填候选");
  }
  if (candidate.status !== "proposal" || !String(candidate.documentId ?? "").trim()) {
    throw new MemoryBackfillReviewError("INVALID_CANDIDATE", "只能采用带文档归属的候选提案");
  }
  if (candidate.schemaVersion !== 2 || !candidate.memoryUpdate || typeof candidate.memoryUpdate !== "object") {
    throw new MemoryBackfillReviewError("INVALID_CANDIDATE", "候选协议版本不受支持");
  }
  if (!String(candidate.candidateId ?? "").trim() || !/^[a-f0-9]{64}$/.test(String(candidate.sourceHash ?? ""))) {
    throw new MemoryBackfillReviewError("INVALID_CANDIDATE", "候选缺少稳定标识或正文哈希");
  }
  if (JSON.stringify(candidate).length > 256 * 1024) {
    throw new MemoryBackfillReviewError("INVALID_CANDIDATE", "候选体积超过采用上限", 413);
  }
};

const assertExplicitApproval = (review = {}) => {
  if (review?.decision !== "approve") {
    throw new MemoryBackfillReviewError("REVIEW_REQUIRED", "候选必须经过明确采用后才能写入", 409);
  }
};

const verifyCandidateAgainstDocument = ({ candidate, documentState }) => {
  const currentSourceHash = memoryBackfillSourceHash(documentState);
  if (currentSourceHash !== candidate.sourceHash) {
    throw new MemoryBackfillReviewError("STALE_SOURCE", "正文已变化，请重新生成记忆候选", 409);
  }
  const verification = verifyMemoryUpdateEvidence({
    memoryUpdate: candidate.memoryUpdate,
    candidate: memoryBackfillSourceText(documentState),
  });
  if (!verification.ok) {
    throw new MemoryBackfillReviewError("INVALID_EVIDENCE", verification.reason || "候选证据验证失败", 422);
  }
  const expectedCandidateId = memoryBackfillCandidateId(candidate);
  if (expectedCandidateId !== candidate.candidateId) {
    throw new MemoryBackfillReviewError("CANDIDATE_TAMPERED", "候选内容与稳定标识不一致", 422);
  }
  return verification;
};

const reviewedAtValue = (reviewedAt) => {
  const value = String(reviewedAt ?? "").trim();
  if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
};

const textList = (value, maxItems = 12, maxCharacters = 1_200) => (Array.isArray(value) ? value : [])
  .map((item) => String(item ?? "").trim().slice(0, maxCharacters))
  .filter(Boolean)
  .slice(0, maxItems);

const reviewedContinuityDelta = ({ candidate, verification, review, reviewedAt }) => ({
  summary: String(candidate.memoryUpdate.chapterSummary ?? "").trim().slice(0, 1_200),
  nextCarryover: Array.isArray(candidate.memoryUpdate.nextContext)
    ? textList(candidate.memoryUpdate.nextContext)
    : [],
  stateChanges: normalizeStateEntries(candidate.memoryUpdate.stateChanges).slice(0, 24),
  foreshadowing: normalizeLedgerEntries(candidate.memoryUpdate.foreshadowing, { kind: "foreshadow" }),
  firstAppearances: normalizeLedgerEntries(candidate.memoryUpdate.firstAppearances, { kind: "information" }),
  informationRelease: normalizeLedgerEntries(candidate.memoryUpdate.informationRelease, { kind: "information" }),
  readerKnowledge: normalizeLedgerEntries(candidate.memoryUpdate.readerKnowledge, { kind: "information" }),
  // These facts remain pending inside the unit delta. This service never writes
  // canon, global ledgers, or the pending-canon index.
  pendingCanon: textList(candidate.memoryUpdate.pendingCanon),
  evidence: clone(verification.evidence.slice(0, 64)),
  evidenceVerified: true,
  sourceHash: candidate.sourceHash,
  candidateId: candidate.candidateId,
  source: String(candidate.generatedBy || "deterministic-evidence-backfill").slice(0, 120),
  review: {
    status: "approved",
    reviewer: String(review?.reviewer ?? "local-user").trim().slice(0, 120) || "local-user",
    reviewedAt,
  },
  updatedAt: reviewedAt,
});

const alreadyCommitted = (documentState, candidate) => (
  documentState?.continuityDelta?.candidateId === candidate.candidateId
  && documentState?.continuityDelta?.sourceHash === candidate.sourceHash
  && documentState?.continuityDelta?.evidenceVerified === true
  && documentState?.memorySyncStatus === "synced"
);

export const applyReviewedMemoryBackfillCandidate = ({
  candidate,
  documentState,
  review,
  reviewedAt,
} = {}) => {
  assertCandidateEnvelope(candidate);
  assertExplicitApproval(review);
  if (!documentState || typeof documentState !== "object" || Array.isArray(documentState)) {
    throw new MemoryBackfillReviewError("DOCUMENT_NOT_FOUND", "候选对应的正文不存在", 404);
  }
  const verification = verifyCandidateAgainstDocument({ candidate, documentState });
  if (alreadyCommitted(documentState, candidate)) {
    return { status: "already_committed", changed: false, documentState };
  }
  const committedAt = reviewedAtValue(reviewedAt);
  return {
    status: "committed",
    changed: true,
    documentState: {
      ...documentState,
      continuityDelta: reviewedContinuityDelta({ candidate, verification, review, reviewedAt: committedAt }),
      memorySyncStatus: "synced",
      memorySyncedAt: committedAt,
    },
  };
};

const reviewReason = (review = {}) => String(review.reason || review.note || "").trim().slice(0, 240);

export const applyMemoryBackfillDisposition = ({
  candidate,
  documentId,
  documentState,
  review,
  reviewedAt,
} = {}) => {
  if (!documentState || typeof documentState !== "object" || Array.isArray(documentState)) {
    throw new MemoryBackfillReviewError("DOCUMENT_NOT_FOUND", "待审阅的正文不存在", 404);
  }
  const decision = String(review?.decision || "");
  const at = reviewedAtValue(reviewedAt);
  const reviewer = String(review?.reviewer || "local-user").trim().slice(0, 120) || "local-user";
  if (decision === "ignore") {
    assertCandidateEnvelope(candidate);
    if (candidate.documentId !== documentId) throw new MemoryBackfillReviewError("INVALID_CANDIDATE", "候选与正文归属不一致");
    verifyCandidateAgainstDocument({ candidate, documentState });
    return {
      changed: true,
      documentState: {
        ...documentState,
        memoryBackfillReview: {
          schemaVersion: 1,
          decision: "ignored",
          candidateId: candidate.candidateId,
          sourceHash: candidate.sourceHash,
          sourceRevision: memorySourceRevision(documentState),
          reasonCode: String(review.reasonCode || "other").slice(0, 80),
          reason: reviewReason(review) || "作者已忽略当前版本",
          reviewer,
          reviewedAt: at,
        },
      },
    };
  }
  if (decision === "exclude") {
    return {
      changed: true,
      documentState: {
        ...documentState,
        memoryBackfillPolicy: {
          excluded: true,
          reasonCode: String(review.reasonCode || "non_story_document").slice(0, 80),
          reason: reviewReason(review) || "作者设置为不参与记忆扫描",
          reviewer,
          updatedAt: at,
        },
      },
    };
  }
  if (decision === "include") {
    const next = { ...documentState };
    delete next.memoryBackfillPolicy;
    return { changed: Boolean(documentState.memoryBackfillPolicy), documentState: next };
  }
  if (decision === "reconsider") {
    const next = { ...documentState };
    delete next.memoryBackfillReview;
    return { changed: Boolean(documentState.memoryBackfillReview), documentState: next };
  }
  throw new MemoryBackfillReviewError("REVIEW_REQUIRED", "不支持的记忆审阅决定", 409);
};

// Storage is injected so the HTTP layer can use the workspace store without this
// module depending on server.mjs. The second read closes the common review/edit
// race; saveCurrentDocument must also enforce expectedSourceHash atomically.
export const commitReviewedMemoryBackfillCandidate = async ({
  candidate,
  review,
  reviewedAt,
  loadCurrentDocument,
  saveCurrentDocument,
} = {}) => {
  assertCandidateEnvelope(candidate);
  assertExplicitApproval(review);
  if (typeof loadCurrentDocument !== "function" || typeof saveCurrentDocument !== "function") {
    throw new MemoryBackfillReviewError("INVALID_STORAGE", "记忆采用缺少工作区读写接口", 500);
  }
  const firstRead = await loadCurrentDocument(candidate.documentId);
  const prepared = applyReviewedMemoryBackfillCandidate({ candidate, documentState: firstRead, review, reviewedAt });
  if (!prepared.changed) return prepared;

  const latest = await loadCurrentDocument(candidate.documentId);
  const latestPrepared = applyReviewedMemoryBackfillCandidate({ candidate, documentState: latest, review, reviewedAt });
  if (!latestPrepared.changed) return latestPrepared;
  const saved = await saveCurrentDocument({
    documentId: candidate.documentId,
    expectedSourceHash: candidate.sourceHash,
    documentState: latestPrepared.documentState,
  });
  return {
    ...latestPrepared,
    documentState: saved?.documentState ?? latestPrepared.documentState,
  };
};
