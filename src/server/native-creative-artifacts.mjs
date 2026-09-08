import { createHash } from "node:crypto";

export const NATIVE_CREATIVE_ARTIFACT_SCHEMA_VERSION = 1;

const text = (value, maximum = 1_200) => String(value ?? "").trim().slice(0, maximum);
const list = (value, maximum = 40) => (Array.isArray(value) ? value : []).slice(0, maximum);
const sha256 = (value) => createHash("sha256").update(String(value ?? "")).digest("hex");
const jsonHash = (value) => sha256(JSON.stringify(value ?? null));
const portableReference = (value) => {
  const normalized = text(value, 300);
  if (/^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(normalized)) return `source-${sha256(normalized).slice(0, 24)}`;
  return normalized;
};
const timestamp = (value) => {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
};

export const nativeReviewMatchesCandidate = (reviewArtifact, candidate) => (
  reviewArtifact?.type === "shensi_native_review"
  && reviewArtifact.candidateHash === sha256(String(candidate ?? "").trim())
);

const severity = (value, blocking = false) => {
  if (blocking) return "blocking";
  const normalized = String(value ?? "").toLowerCase();
  if (["critical", "blocker", "blocking"].includes(normalized)) return "blocking";
  if (["high", "major"].includes(normalized)) return "major";
  if (["medium", "minor"].includes(normalized)) return "minor";
  return "info";
};

const findingFingerprint = (finding) => sha256([
  finding.dimension,
  finding.location,
  finding.evidence,
  finding.diagnosis,
].join("\u001f"));

const normalizedFinding = (value = {}, defaults = {}) => {
  const blocking = value.blocking === true || defaults.blocking === true;
  const finding = {
    code: text(value.code || defaults.code || "REVIEW_FINDING", 100),
    severity: severity(value.severity || defaults.severity, blocking),
    dimension: text(value.dimension || value.category || defaults.dimension || "other", 100),
    location: portableReference(value.location || defaults.location),
    evidence: text(value.evidence || defaults.evidence, 1_600),
    diagnosis: text(value.diagnosis || value.description || defaults.diagnosis, 1_600),
    repairInstruction: text(value.repairInstruction || value.fix_hint || defaults.repairInstruction, 1_600),
    blocking,
    source: text(value.source || defaults.source || "shensi_native", 80),
    status: ["open", "resolved", "accepted"].includes(value.status) ? value.status : "open",
  };
  return { ...finding, fingerprint: findingFingerprint(finding) };
};

const deduplicatedFindings = (findings) => {
  const seen = new Set();
  return findings.filter((finding) => {
    if (!finding.diagnosis && !finding.evidence) return false;
    if (seen.has(finding.fingerprint)) return false;
    seen.add(finding.fingerprint);
    return true;
  }).slice(0, 120);
};

const issueText = (value) => text(value?.message || value?.description || value?.id || value, 1_200);

export const buildNativeReviewArtifact = ({
  attemptId = "",
  runId = "",
  targetDocumentId = "",
  candidate = "",
  sourceRevision = "",
  strength = "standard",
  verdict = {},
  evaluation = {},
  memoryCheck = {},
  unitMemoryHardConflicts = [],
  formatCheck = { pass: true, issues: [] },
  artifactCheck = { pass: true, violations: [] },
  languageScan = { absoluteViolations: [] },
  memoryStatus = "",
  createdAt = new Date().toISOString(),
} = {}) => {
  const candidateHash = sha256(candidate);
  const findings = list(evaluation.findings, 80).map((finding) => normalizedFinding(finding));
  for (const problem of list(memoryCheck.hardConflicts, 20)) findings.push(normalizedFinding({}, {
    code: "CONTINUITY_HARD_CONFLICT",
    severity: "blocking",
    dimension: "continuity",
    diagnosis: problem,
    blocking: true,
  }));
  for (const problem of list(unitMemoryHardConflicts, 20)) findings.push(normalizedFinding({}, {
    code: "UNIT_CONTINUITY_HARD_CONFLICT",
    severity: "blocking",
    dimension: "continuity",
    diagnosis: problem,
    blocking: true,
  }));
  for (const problem of list(memoryCheck.softRisks, 20)) findings.push(normalizedFinding({}, {
    code: "CONTINUITY_SOFT_RISK",
    severity: "minor",
    dimension: "continuity",
    diagnosis: problem,
  }));
  for (const issue of list(formatCheck.issues, 20)) findings.push(normalizedFinding({}, {
    code: text(issue?.code || "FORMAT_GATE", 100),
    severity: formatCheck.pass === false ? "blocking" : "minor",
    dimension: "format",
    diagnosis: issueText(issue),
    blocking: formatCheck.pass === false,
  }));
  for (const issue of list(artifactCheck.violations, 20)) findings.push(normalizedFinding({}, {
    code: text(issue?.id || "ARTIFACT_ISOLATION", 100),
    severity: "blocking",
    dimension: "artifact_isolation",
    diagnosis: issueText(issue),
    blocking: true,
  }));
  for (const issue of list(languageScan.absoluteViolations, 20)) findings.push(normalizedFinding({}, {
    code: "LANGUAGE_ABSOLUTE_VIOLATION",
    severity: "blocking",
    dimension: "language",
    evidence: text(issue?.term, 200),
    diagnosis: `${text(issue?.label || "绝对禁用项", 120)}“${text(issue?.term, 200)}”`,
    blocking: true,
  }));
  for (const warning of list(verdict.warnings, 20)) findings.push(normalizedFinding({}, {
    code: "FINAL_WARNING",
    severity: "minor",
    dimension: "effect",
    diagnosis: warning,
  }));
  for (const reason of list(verdict.hardReasons, 20)) findings.push(normalizedFinding({}, {
    code: "FINAL_HARD_BLOCK",
    severity: "blocking",
    dimension: "trusted_gate",
    diagnosis: reason,
    blocking: true,
  }));
  const normalized = deduplicatedFindings(findings);
  const outcome = verdict.outcome === "hard_blocked" ? "blocked"
    : verdict.outcome === "soft_warning" ? "warning"
      : verdict.outcome === "ready_to_land" ? "passed" : "pending";
  const reviewIdentity = `${attemptId || runId}:${targetDocumentId}:${candidateHash}`;
  return {
    schemaVersion: NATIVE_CREATIVE_ARTIFACT_SCHEMA_VERSION,
    type: "shensi_native_review",
    reviewId: `review-${sha256(reviewIdentity).slice(0, 32)}`,
    attemptId: text(attemptId || runId, 100),
    targetDocumentId: text(targetDocumentId, 180),
    candidateHash,
    sourceRevision: text(sourceRevision, 160),
    reviewerProfile: text(strength, 40) || "standard",
    authority: "trusted_core_review",
    templateIndependent: true,
    verdict: outcome,
    blockingCount: normalized.filter((finding) => finding.blocking).length,
    findings: normalized,
    coverage: {
      read: list(evaluation?.coverage?.read, 80).map(portableReference).filter(Boolean),
      missing: list(evaluation?.coverage?.missing, 40).map(portableReference).filter(Boolean),
      truncated: list(evaluation?.coverage?.truncated, 40).map(portableReference).filter(Boolean),
    },
    gates: {
      effect: evaluation.pass === true ? "passed" : outcome === "pending" ? "pending" : "warning",
      continuity: memoryCheck.hardConflict === true || unitMemoryHardConflicts.length ? "blocked" : "passed",
      format: formatCheck.pass === false ? "blocked" : "passed",
      artifactIsolation: artifactCheck.pass === false ? "blocked" : "passed",
      language: list(languageScan.absoluteViolations, 1).length ? "blocked" : "passed",
      memoryEvidence: text(memoryStatus, 40) || "not_required",
    },
    createdAt: timestamp(createdAt),
  };
};

const sanitizedLandingTargets = (manifest = {}) => list(manifest?.segments, 1_000).map((segment) => ({
  documentId: text(segment?.documentId, 180),
  title: text(segment?.title, 180),
  kind: text(segment?.kind, 80),
  chapterNumber: Number(segment?.chapterNumber) || null,
  characters: Math.max(0, Number(segment?.characters) || 0),
  hash: text(segment?.hash, 160),
})).filter((segment) => segment.documentId);

export const buildNativeCommitReceipt = ({
  attempt = {},
  landingManifest = null,
  failed = false,
  message = "",
  committedAt = new Date().toISOString(),
} = {}) => {
  const candidate = text(attempt.adoptedCandidate || attempt.candidates?.at(-1)?.text, 2_000_000);
  const candidateHash = sha256(candidate);
  const targets = sanitizedLandingTargets(landingManifest);
  const commitIdentity = `${attempt.requestId}:${candidateHash}:${jsonHash(targets)}`;
  return {
    schemaVersion: NATIVE_CREATIVE_ARTIFACT_SCHEMA_VERSION,
    type: "shensi_native_chapter_commit",
    commitId: `commit-${sha256(commitIdentity).slice(0, 32)}`,
    idempotencyKey: sha256(commitIdentity),
    attemptId: text(attempt.requestId, 100),
    targetDocumentId: text(attempt.targetDocumentId, 180),
    candidateHash,
    outputManifestHash: jsonHash(targets),
    baseRevisionHash: jsonHash(attempt.requestSnapshot?.candidateBasisSeed ?? null),
    memoryDeltaHash: jsonHash({ memoryUpdate: attempt.memoryUpdate ?? null, memoryUpdates: attempt.memoryUpdates ?? {} }),
    reviewArtifactId: text(attempt.reviewArtifact?.reviewId, 100),
    gateResults: attempt.reviewArtifact?.gates ?? null,
    authority: "workspace_commit",
    templateIndependent: true,
    authorDecision: failed ? "not_committed" : "adopted",
    status: failed ? "failed" : "committed",
    failureReason: failed ? text(message || "客户端落盘事务失败", 1_000) : "",
    targets,
    externalRunCommitRef: text(attempt.externalRuntimeEvidence?.commitRef, 160),
    committedAt: timestamp(committedAt),
  };
};

const memoryUpdatesForTargets = (attempt = {}, commitReceipt = {}) => {
  const byDocument = attempt.memoryUpdates && typeof attempt.memoryUpdates === "object" ? attempt.memoryUpdates : {};
  if (Object.keys(byDocument).length) return byDocument;
  const onlyTarget = commitReceipt.targets?.length === 1 ? commitReceipt.targets[0].documentId : attempt.targetDocumentId;
  return attempt.memoryUpdate && onlyTarget ? { [onlyTarget]: attempt.memoryUpdate } : {};
};

const projectionTarget = ({ kind, critical, hasData, commitFailed, report = {} }) => {
  const reported = ["done", "pending", "failed", "skipped"].includes(report.status) ? report.status : "";
  const status = commitFailed ? "not_started" : reported || (hasData ? "done" : "skipped");
  return {
    kind,
    critical,
    status,
    itemCount: Math.max(0, Number(report.itemCount) || 0),
    error: status === "failed" ? text(report.error || "投影写入失败", 1_000) : "",
  };
};

export const buildNativeProjectionManifest = ({
  attempt = {},
  commitReceipt = {},
  projectionReport = {},
  createdAt = new Date().toISOString(),
} = {}) => {
  const updates = Object.values(memoryUpdatesForTargets(attempt, commitReceipt)).filter((value) => value && typeof value === "object");
  const has = (field) => updates.some((update) => Array.isArray(update[field]) ? update[field].length : Boolean(update[field]));
  const count = (field) => updates.reduce((total, update) => total + (Array.isArray(update[field]) ? update[field].length : update[field] ? 1 : 0), 0);
  const reports = projectionReport && typeof projectionReport === "object" ? projectionReport : {};
  const commitFailed = commitReceipt.status !== "committed";
  const definitions = [
    ["chapter_continuity", true, has("chapterSummary") || has("nextContext"), count("nextContext") + count("chapterSummary")],
    ["current_state", true, has("stateChanges"), count("stateChanges")],
    ["foreshadowing", true, has("foreshadowing"), count("foreshadowing")],
    ["information_release", true, has("informationRelease") || has("firstAppearances"), count("informationRelease") + count("firstAppearances")],
    ["reader_knowledge", true, has("readerKnowledge"), count("readerKnowledge")],
  ];
  const targets = definitions.map(([kind, critical, hasData, itemCount]) => projectionTarget({
    kind,
    critical,
    hasData,
    commitFailed,
    report: { itemCount, ...(reports[kind] ?? {}) },
  }));
  targets.push(projectionTarget({
    kind: "search_index",
    critical: false,
    hasData: false,
    commitFailed,
    report: reports.search_index ?? { status: commitFailed ? "not_started" : "pending" },
  }));
  const criticalTargets = targets.filter((target) => target.critical);
  const aggregateStatus = commitFailed ? "not_started"
    : criticalTargets.some((target) => target.status === "failed") ? "critical_failed"
      : criticalTargets.some((target) => ["pending", "not_started"].includes(target.status)) ? "critical_pending"
        : targets.some((target) => target.status === "failed") ? "noncritical_failed"
          : targets.some((target) => target.status === "pending") ? "critical_complete"
            : "complete";
  return {
    schemaVersion: NATIVE_CREATIVE_ARTIFACT_SCHEMA_VERSION,
    type: "shensi_native_projection_manifest",
    projectionId: `projection-${sha256(`${commitReceipt.commitId}:${jsonHash(targets)}`).slice(0, 32)}`,
    sourceCommitId: text(commitReceipt.commitId, 100),
    authority: "derived_read_model",
    templateIndependent: true,
    rebuildable: true,
    aggregateStatus,
    targets,
    retryableTargets: targets.filter((target) => ["pending", "failed"].includes(target.status)).map((target) => target.kind),
    externalProjectionRef: text(attempt.externalRuntimeEvidence?.projectionRef, 160),
    createdAt: timestamp(createdAt),
  };
};

export const buildCommittedNativeArtifacts = ({ attempt, landingManifest, projectionReport, failed = false, message = "" } = {}) => {
  const commitReceipt = buildNativeCommitReceipt({ attempt, landingManifest, failed, message });
  return {
    commitReceipt,
    projectionManifest: buildNativeProjectionManifest({ attempt, commitReceipt, projectionReport }),
  };
};

export const normalizeExternalRuntimeEvidence = ({
  runtimeId = "webnovel-writer",
  chapterId = "",
  review = null,
  commit = null,
  projection = null,
  createdAt = new Date().toISOString(),
} = {}) => ({
  schemaVersion: NATIVE_CREATIVE_ARTIFACT_SCHEMA_VERSION,
  type: "shensi_external_runtime_evidence",
  runtimeId: text(runtimeId, 120),
  chapterId: text(chapterId, 180),
  authority: "evidence_only",
  templateSlot: false,
  mayWriteCanon: false,
  mayCommitWorkspace: false,
  reviewRef: review ? `external-review-${jsonHash(review).slice(0, 24)}` : "",
  commitRef: commit ? `external-commit-${jsonHash(commit).slice(0, 24)}` : "",
  projectionRef: projection ? `external-projection-${jsonHash(projection).slice(0, 24)}` : "",
  statuses: {
    review: text(review?.status || review?.verdict || (review ? "received" : "missing"), 40),
    commit: text(commit?.status || (commit ? "received" : "missing"), 40),
    projection: text(projection?.aggregateStatus || projection?.status || (projection ? "received" : "missing"), 40),
  },
  createdAt: timestamp(createdAt),
});

export const summarizeNativeCreativeArtifacts = ({ reviewArtifact, commitReceipt, projectionManifest, externalRuntimeEvidence } = {}) => ({
  review: reviewArtifact?.verdict || "not_created",
  blockingIssues: Math.max(0, Number(reviewArtifact?.blockingCount) || 0),
  commit: commitReceipt?.status || "not_committed",
  projection: projectionManifest?.aggregateStatus || "not_started",
  externalRuntime: externalRuntimeEvidence?.runtimeId || "not_enabled",
  externalAuthority: externalRuntimeEvidence?.authority || "none",
});
