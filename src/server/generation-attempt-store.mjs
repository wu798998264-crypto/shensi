import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { scanInternalArtifactLeakage } from "../content-guard.js";
import { appDataRoot } from "./app-data.mjs";
import { nativeReviewMatchesCandidate, summarizeNativeCreativeArtifacts } from "./native-creative-artifacts.mjs";

const SCHEMA_VERSION = 4;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_CANDIDATES = 8;
const MAX_CANDIDATE_CHARS = 2_000_000;
const writeQueues = new Map();
const memoryFallbackAttempts = new Map();
const RECOVERABLE_ACTIVE_STATUSES = new Set([
  "running",
  "planning",
  "generating",
  "checking",
  "repairing",
  "finalizing",
]);
const TERMINAL_ATTEMPT_STATUSES = new Set([
  "complete",
  "awaiting_action",
  "failed",
  "cancelled",
  "interrupted",
  "retry_required",
]);

const attemptRoot = () => join(appDataRoot(), "generation-attempts");
const normalizedRequestId = (value) => {
  const requestId = String(value ?? "").trim();
  if (!REQUEST_ID.test(requestId)) throw new Error("正文生成尝试标识无效");
  return requestId;
};
const attemptPath = (requestId) => join(attemptRoot(), `${normalizedRequestId(requestId)}.json`);
const text = (value, maximum = 8_192) => String(value ?? "").trim().slice(0, maximum);
const workspaceFingerprint = (workspacePath) => {
  const value = String(workspacePath ?? "").trim();
  if (!value) return "";
  const identity = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value.toLowerCase()
    : resolve(value).toLowerCase();
  return createHash("sha256").update(identity).digest("hex");
};

const withWriteLock = (path, operation) => {
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
};

const renameWithRetry = async (source, target, attempts = 6) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || attempt === attempts) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 40));
    }
  }
};

const atomicWrite = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const previous = `${path}.${process.pid}.${randomUUID()}.previous`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  let movedPrevious = false;
  try {
    await renameWithRetry(path, previous);
    movedPrevious = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  try {
    await renameWithRetry(temporary, path);
    if (movedPrevious) await rm(previous, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (movedPrevious) await renameWithRetry(previous, path).catch(() => {});
    throw error;
  }
};

const writeAttempt = async (requestId, path, value) => {
  const durable = {
    ...value,
    durabilityStatus: "durable",
    durabilityWarning: "",
    durabilityErrorCode: "",
  };
  try {
    if (process.env.SHENSI_TEST_GENERATION_ATTEMPT_WRITE_FAILURE === "1") {
      throw Object.assign(new Error("测试故障注入：正文任务日志不可写"), { code: "EACCES" });
    }
    await atomicWrite(path, durable);
    memoryFallbackAttempts.delete(requestId);
    return durable;
  } catch (error) {
    const memoryOnly = {
      ...value,
      durabilityStatus: "memory_only",
      durabilityWarning: "本次文字任务无法断电恢复；模型仍会继续运行，正式写入仍需通过原有落盘校验。",
      durabilityErrorCode: text(error?.code || "GENERATION_ATTEMPT_WRITE_FAILED", 80),
    };
    memoryFallbackAttempts.set(requestId, memoryOnly);
    return memoryOnly;
  }
};

const readAttempt = async (requestId) => {
  const id = normalizedRequestId(requestId);
  if (memoryFallbackAttempts.has(id)) return memoryFallbackAttempts.get(id);
  try {
    const parsed = JSON.parse(await readFile(attemptPath(id), "utf8"));
    return [1, 2, 3, SCHEMA_VERSION].includes(parsed?.schemaVersion) ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const normalizedCandidate = ({ text: candidateText = "", stage = "creative", index = 0, writerId = "", writerName = "" } = {}) => ({
  stage: text(stage, 80) || "creative",
  index: Math.max(0, Number(index) || 0),
  text: text(candidateText, MAX_CANDIDATE_CHARS),
  writerId: text(writerId, 160),
  writerName: text(writerName, 160),
  savedAt: new Date().toISOString(),
});

const mergeCandidates = (current = [], incoming = []) => {
  const merged = [...current];
  for (const item of incoming.map(normalizedCandidate).filter((candidate) => candidate.text)) {
    const existing = merged.findIndex((candidate) => candidate.text === item.text);
    if (existing >= 0) merged.splice(existing, 1);
    merged.push(item);
  }
  return merged.slice(-MAX_CANDIDATES);
};

export const resolveGenerationAttemptReviewGate = ({
  selfCheckRequested = false,
  hasPersistedCandidate = false,
  reviewMatchesCandidate = false,
  reviewAllowsLanding = false,
  requestedLandingEligible = false,
  requestedValidationStatus = "pending",
  requestedLandingStatus = "not_requested",
} = {}) => {
  // A requested self-check produces advisory evidence. It must never become a
  // hard commit gate once a formal candidate has been persisted.
  const reviewRequirementSatisfied = !selfCheckRequested || reviewAllowsLanding || hasPersistedCandidate;
  return {
    reviewRequirementSatisfied,
    landingEligible: requestedLandingEligible && hasPersistedCandidate && reviewRequirementSatisfied,
    validationStatus: selfCheckRequested && hasPersistedCandidate && !reviewMatchesCandidate && requestedValidationStatus !== "blocked"
      ? "warning"
      : requestedValidationStatus,
    landingStatus: requestedLandingStatus,
  };
};

const publicCandidateId = (candidateText = "") => `candidate-${createHash("sha256")
  .update(String(candidateText || ""))
  .digest("hex")
  .slice(0, 24)}`;

// Read-model quarantine only: old failed report attempts keep their original
// output/history on disk, but must not reappear as a landing-ready artifact.
export const generationAttemptReviewRecoveryFailure = (attempt = {}) => {
  if (!["report-novel", "report-script", "report-adaptation"].includes(attempt.targetDocumentId)) return "";
  if (RECOVERABLE_ACTIVE_STATUSES.has(attempt.status) && attempt.executionStatus !== "terminal") return "";
  const payload = attempt.resultData?.payload;
  const executions = [attempt.execution, payload?.execution, payload?.engineExecution].filter(Boolean);
  if ([attempt.status, ...executions.map((execution) => execution.status)]
    .some((status) => ["failed", "retry_required", "cancelled", "interrupted"].includes(status))) return "TEXT_REVIEW_FAILED";
  const candidate = text(attempt.adoptedCandidate || attempt.candidates?.at(-1)?.text, MAX_CANDIDATE_CHARS);
  if (!candidate || /<\/?(?:tool_call|arg_?key|arg_?value)\b/iu.test(candidate)
    || /^本轮质量审查未返回有效报告/u.test(candidate)
    || executions.some((execution) => (Array.isArray(execution.stages) ? execution.stages : []).some((stage) => stage?.id === "audit-invalid-output"))) {
    return "TEXT_REVIEW_RESULT_INVALID";
  }
  const reviewArtifact = attempt.reviewArtifact || payload?.reviewArtifact;
  if (!nativeReviewMatchesCandidate(reviewArtifact, candidate)
    || !["passed", "warning"].includes(reviewArtifact?.verdict)) return "TEXT_REVIEW_EVIDENCE_MISSING";
  return "";
};

export const generationAttemptCandidateVariants = (attempt = {}) => {
  if (generationAttemptReviewRecoveryFailure(attempt)) return [];
  const adoptedCandidate = text(attempt.adoptedCandidate, MAX_CANDIDATE_CHARS);
  const storedCandidates = (Array.isArray(attempt.candidates) ? attempt.candidates : [])
    .map((candidate) => ({
      ...candidate,
      text: text(candidate?.text, MAX_CANDIDATE_CHARS),
      stage: text(candidate?.stage, 80) || "creative",
      index: Math.max(0, Number(candidate?.index) || 0),
    }))
    .filter((candidate) => candidate.text);
  const parallelGroups = new Map();
  for (const candidate of storedCandidates) {
    const group = parallelGroups.get(candidate.stage) ?? [];
    group.push(candidate);
    parallelGroups.set(candidate.stage, group);
  }
  const parallelCandidates = [...parallelGroups.values()]
    .filter((items) => items.length > 1 && new Set(items.map((item) => item.index)).size > 1)
    .sort((left, right) => right.length - left.length)[0] ?? [];
  const adoptedRecord = storedCandidates.find((candidate) => candidate.text === adoptedCandidate) ?? {};
  // Candidate history contains both author-selectable alternatives and the
  // sequential draft -> review -> repair -> final chain. Only alternatives
  // produced in parallel during the same stage belong in the candidate UI.
  // Internal revisions are recovery evidence, not extra choices and must not
  // suspend an otherwise valid automatic commit.
  const source = parallelCandidates.length > 1
    ? [
      ...parallelCandidates.filter((candidate) => candidate.index !== 0),
      ...(adoptedCandidate
        ? [{ ...adoptedRecord, text: adoptedCandidate, stage: "adopted", index: 0 }]
        : parallelCandidates.filter((candidate) => candidate.index === 0)),
    ]
    : adoptedCandidate
      ? [{ ...adoptedRecord, text: adoptedCandidate, stage: "adopted", index: 0 }]
      : storedCandidates.length
        ? [storedCandidates.at(-1)]
        : [];
  const seen = new Set();
  const variants = [];
  for (const item of source) {
    const candidateText = text(item?.text, MAX_CANDIDATE_CHARS);
    if (!candidateText || seen.has(candidateText)) continue;
    seen.add(candidateText);
    if (!scanInternalArtifactLeakage(candidateText).pass) continue;
    variants.push({
      id: publicCandidateId(candidateText),
      text: candidateText,
      writerId: text(item?.writerId, 160),
      writerName: text(item?.writerName, 160),
      selected: candidateText === adoptedCandidate,
      landingEligible: candidateText === adoptedCandidate && attempt.landingEligible === true,
      selectionRequired: parallelCandidates.length > 1,
    });
  }
  return variants.slice(-MAX_CANDIDATES).map((variant, index, items) => ({
    ...variant,
    index,
    position: index + 1,
    total: items.length,
  }));
};

export const generationAttemptCandidateById = (attempt = {}, candidateId = "") => (
  generationAttemptCandidateVariants(attempt).find((candidate) => candidate.id === String(candidateId || "")) ?? null
);

const timestampMilliseconds = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const publicExecution = (execution, { startedAt = "", endedAt = "" } = {}) => execution && typeof execution === "object" ? {
  status: text(execution.status, 40),
  strength: text(execution.strength, 40),
  validationStatus: text(execution.validationStatus, 40),
  landingStatus: text(execution.landingStatus, 40),
  finalVerdict: text(execution.finalVerdict, 40),
  result: text(execution.result, 1_000),
  startedAt: timestampMilliseconds(execution.startedAt || startedAt),
  endedAt: timestampMilliseconds(execution.endedAt || endedAt),
  elapsedMs: Math.max(0, Number(execution.elapsedMs) || (
    timestampMilliseconds(execution.endedAt || endedAt) && timestampMilliseconds(execution.startedAt || startedAt)
      ? timestampMilliseconds(execution.endedAt || endedAt) - timestampMilliseconds(execution.startedAt || startedAt)
      : 0
  )),
  calls: Math.max(0, Number(execution.calls) || 0),
  candidateCount: Math.max(0, Number(execution.candidateCount) || 0),
  repairRounds: Math.max(0, Number(execution.repairRounds) || 0),
  progressPercent: Math.min(100, Math.max(0, Number(execution.progressPercent) || 0)),
  currentStage: text(execution.currentStage, 160),
  currentStageId: text(execution.currentStageId, 80),
  currentCall: Math.max(0, Number(execution.currentCall) || Number(execution.calls) || 0),
  maxCalls: Math.max(0, Number(execution.maxCalls) || 0),
  currentRepairRound: Math.max(0, Number(execution.currentRepairRound) || 0),
  maxRepairRounds: Math.max(0, Number(execution.maxRepairRounds) || 0),
  currentStep: Math.max(0, Number(execution.currentStep) || 0),
  totalSteps: Math.max(0, Number(execution.totalSteps) || 0),
  visibleCharacterCount: Math.max(0, Number(execution.visibleCharacterCount) || 0),
  stageStartedAt: text(execution.stageStartedAt, 80),
  heartbeatAt: text(execution.heartbeatAt, 80),
  slowResponse: execution.slowResponse === true,
  backgroundAvailable: execution.backgroundAvailable === true,
  taskOverBudget: execution.taskOverBudget === true,
  nextStep: text(execution.nextStep, 240),
  targetHint: text(execution.targetHint, 240),
  stages: (Array.isArray(execution.stages) ? execution.stages : []).map((stage) => ({
    id: text(stage?.id, 80),
    label: text(stage?.label, 160),
    detail: text(stage?.detail, 1_000),
    status: text(stage?.status, 40),
  })).slice(-30),
  languageGuard: safeJsonObject(execution.languageGuard, 40_000),
  formatGate: safeJsonObject(execution.formatGate, 40_000),
  artifactIsolationGate: safeJsonObject(execution.artifactIsolationGate, 40_000),
  memoryGate: safeJsonObject(execution.memoryGate, 40_000),
  reviewDelivery: safeJsonObject(execution.reviewDelivery, 40_000),
} : null;
const safeJsonObject = (value, maximum = 1_000_000) => {
  if (!value || typeof value !== "object") return null;
  const serialized = JSON.stringify(value);
  if (serialized.length > maximum) return null;
  return JSON.parse(serialized);
};

// Keep the three lifecycle fields coherent even when an older caller only
// supplies status (the long-form planning endpoints do this). A terminal
// status is authoritative: it must never retain the initial running phase.
const normalizedAttemptLifecycle = ({ current = {}, status, executionStatus, phase } = {}) => {
  const nextStatus = status ? text(status, 40) : text(current.status, 40);
  const statusIsTerminal = TERMINAL_ATTEMPT_STATUSES.has(nextStatus);
  const statusIsActive = RECOVERABLE_ACTIVE_STATUSES.has(nextStatus);
  const requestedExecutionStatus = executionStatus ? text(executionStatus, 40) : "";
  const nextExecutionStatus = statusIsTerminal
    ? "terminal"
    : requestedExecutionStatus || (statusIsActive ? "running" : text(current.executionStatus, 40));
  const terminal = nextExecutionStatus === "terminal" || statusIsTerminal;
  const requestedPhase = phase !== undefined && phase !== null
    ? text(phase, 80)
    : text(current.phase, 80) || text(current.stage, 80);
  const activePhases = new Set(["planning", "generating", "checking", "repairing", "finalizing", "started", "restarted"]);
  return {
    status: nextStatus,
    executionStatus: nextExecutionStatus || (terminal ? "terminal" : "running"),
    phase: terminal && (!requestedPhase || activePhases.has(requestedPhase))
      ? "finished"
      : requestedPhase || (terminal ? "finished" : text(current.phase, 80) || text(current.stage, 80)),
    terminal,
  };
};

const taskConflict = (message, code = "GENERATION_ATTEMPT_EXISTS") => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
};

export const beginGenerationAttempt = async ({
  requestId,
  workspacePath = "",
  targetDocumentId = "",
  taskKind = "creative",
  requestFingerprint = "",
  requestSnapshot = null,
  conversationId = "",
  sourceMessageId = "",
  allowRestart = false,
} = {}) => {
  const id = normalizedRequestId(requestId);
  const path = attemptPath(id);
  return withWriteLock(path, async () => {
    const now = new Date().toISOString();
    let current = null;
    let readError = null;
    try {
      if (process.env.SHENSI_TEST_GENERATION_ATTEMPT_READ_FAILURE === "1") {
        throw Object.assign(new Error("测试故障注入：正文任务日志不可读"), { code: "EACCES" });
      }
      current = await readAttempt(id);
    } catch (error) {
      // A storage read failure cannot prove that an attempt is duplicated.
      // Keep the new request in this process only; actual records that can be
      // read still retain the strict ID/fingerprint conflict gates below.
      readError = error;
    }
    const fingerprint = text(requestFingerprint, 128);
    if (current) {
      if (fingerprint && current.requestFingerprint && fingerprint !== current.requestFingerprint) {
        throw taskConflict("任务标识已用于另一份请求，已阻止覆盖", "GENERATION_ATTEMPT_ID_CONFLICT");
      }
      if (current.status === "complete") return { ...current, reused: true };
      if (!allowRestart || !["interrupted", "failed", "cancelled"].includes(current.status)) {
        throw taskConflict(
          current.status === "running"
            ? "相同任务仍在运行或上次退出前未确认状态，请先恢复任务记录，避免重复计费"
            : "相同任务已有未完成记录；只有用户明确重试后才能再次调用模型",
          current.status === "running" ? "GENERATION_ATTEMPT_UNCERTAIN" : "GENERATION_ATTEMPT_RESTART_REQUIRED",
        );
      }
      const restarted = {
        ...current,
        schemaVersion: SCHEMA_VERSION,
        status: "running",
        executionStatus: "running",
        phase: "checking",
        validationStatus: "pending",
        landingStatus: "not_requested",
        stage: "restarted",
        landingEligible: false,
        landingBlockReason: "任务已由用户明确续接，正在继续处理",
        requestFingerprint: fingerprint || current.requestFingerprint || "",
        requestSnapshot: safeJsonObject(requestSnapshot, 500_000) ?? current.requestSnapshot ?? null,
        conversationId: text(conversationId, 160) || current.conversationId || "",
        sourceMessageId: text(sourceMessageId, 160) || current.sourceMessageId || "",
        reviewArtifact: null,
        commitReceipt: null,
        projectionManifest: null,
        resumeCount: Math.max(0, Number(current.resumeCount) || 0) + 1,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      return writeAttempt(id, path, restarted);
    }
    const attempt = {
      schemaVersion: SCHEMA_VERSION,
      requestId: id,
      workspaceFingerprint: workspaceFingerprint(workspacePath),
      targetDocumentId: text(targetDocumentId, 160),
      taskKind: text(taskKind, 80) || "creative",
      requestFingerprint: fingerprint,
      requestSnapshot: safeJsonObject(requestSnapshot, 500_000),
      conversationId: text(conversationId, 160),
      sourceMessageId: text(sourceMessageId, 160),
      status: "running",
      executionStatus: "running",
      phase: "planning",
      validationStatus: "pending",
      landingStatus: "not_requested",
      stage: "started",
      candidates: [],
      adoptedCandidate: "",
      landingEligible: false,
      landingBlockReason: "正文仍在生成或检查",
      memoryStatus: "pending",
      memoryUpdate: null,
      memoryUpdates: {},
      execution: null,
      resultData: null,
      reviewArtifact: null,
      commitReceipt: null,
      projectionManifest: null,
      externalRuntimeEvidence: null,
      resumeCount: 0,
      startedAt: now,
      heartbeatAt: now,
      stageStartedAt: now,
      updatedAt: now,
      ...(readError ? {
        durabilityStatus: "memory_only",
        durabilityWarning: "本次文字任务无法读取持久任务日志，已在当前会话继续；关闭软件后不能恢复本次任务。",
        durabilityErrorCode: text(readError?.code || "GENERATION_ATTEMPT_READ_FAILED", 80),
      } : {}),
    };
    if (readError) {
      memoryFallbackAttempts.set(id, attempt);
      return attempt;
    }
    return writeAttempt(id, path, attempt);
  });
};

export const updateGenerationAttempt = async ({
  requestId,
  status,
  executionStatus,
  phase,
  validationStatus,
  landingStatus,
  stage,
  heartbeatAt,
  stageStartedAt,
  candidates = [],
  candidate = "",
  landingEligible,
  landingBlockReason,
  memoryStatus,
  memoryUpdate,
  memoryUpdates,
  execution,
  resultData,
  reviewArtifact,
  commitReceipt,
  projectionManifest,
  externalRuntimeEvidence,
} = {}) => {
  const id = normalizedRequestId(requestId);
  const path = attemptPath(id);
  return withWriteLock(path, async () => {
    const current = await readAttempt(id);
    if (!current) throw new Error("正文生成尝试不存在");
    const adoptedMetadata = candidate
      ? [...candidates, ...(current.candidates ?? [])].find((item) => text(item?.text, MAX_CANDIDATE_CHARS) === text(candidate, MAX_CANDIDATE_CHARS)) ?? {}
      : {};
    const incoming = [
      ...candidates,
      ...(candidate ? [{ ...adoptedMetadata, text: candidate, stage: stage || "selected", index: 0 }] : []),
    ];
    const mergedCandidates = mergeCandidates(current.candidates, incoming);
    const adoptedCandidate = text(candidate || current.adoptedCandidate || mergedCandidates.at(-1)?.text, MAX_CANDIDATE_CHARS);
    const candidateChanged = Boolean(candidate) && adoptedCandidate !== text(current.adoptedCandidate, MAX_CANDIDATE_CHARS);
    const candidateHash = createHash("sha256").update(adoptedCandidate).digest("hex");
    const storedReviewArtifact = reviewArtifact !== undefined
      ? safeJsonObject(reviewArtifact, 1_000_000)
      : candidateChanged ? null : safeJsonObject(current.reviewArtifact, 1_000_000);
    const storedCommitReceipt = commitReceipt !== undefined
      ? safeJsonObject(commitReceipt, 500_000)
      : candidateChanged ? null : safeJsonObject(current.commitReceipt, 500_000);
    const storedProjectionManifest = projectionManifest !== undefined
      ? safeJsonObject(projectionManifest, 500_000)
      : candidateChanged ? null : safeJsonObject(current.projectionManifest, 500_000);
    if (reviewArtifact !== undefined && storedReviewArtifact && !nativeReviewMatchesCandidate(storedReviewArtifact, adoptedCandidate)) {
      throw new Error("原生审查产物与当前正文候选不匹配");
    }
    if (commitReceipt !== undefined && storedCommitReceipt?.candidateHash !== candidateHash) {
      throw new Error("正文提交回执与当前正文候选不匹配");
    }
    if (projectionManifest !== undefined && storedProjectionManifest?.sourceCommitId !== storedCommitReceipt?.commitId) {
      throw new Error("记忆投影清单与正文提交回执不匹配");
    }
    const reviewMatchesCandidate = nativeReviewMatchesCandidate(storedReviewArtifact, adoptedCandidate);
    const reviewAllowsLanding = reviewMatchesCandidate && ["passed", "warning"].includes(storedReviewArtifact.verdict);
    const selfCheckRequested = current.requestSnapshot?.creativeTask?.qualityPolicy?.selfCheckRequested === true;
    const requestedLandingEligible = typeof landingEligible === "boolean" ? landingEligible : current.landingEligible === true;
    const hasPersistedCandidate = Boolean(adoptedCandidate);
    const requestedValidationStatus = validationStatus ? text(validationStatus, 40) : text(current.validationStatus, 40) || "pending";
    const requestedLandingStatus = landingStatus ? text(landingStatus, 40) : text(current.landingStatus, 40) || "not_requested";
    const reviewGate = resolveGenerationAttemptReviewGate({
      selfCheckRequested,
      hasPersistedCandidate,
      reviewMatchesCandidate,
      reviewAllowsLanding,
      requestedLandingEligible,
      requestedValidationStatus,
      requestedLandingStatus,
    });
    const effectiveLandingEligible = reviewGate.landingEligible;
    const effectiveValidationStatus = reviewGate.validationStatus;
    const effectiveLandingStatus = reviewGate.landingStatus;
    const lifecycle = normalizedAttemptLifecycle({ current, status, executionStatus, phase });
    const effectiveLandingBlockReason = requestedLandingEligible && !hasPersistedCandidate
      ? "没有可落盘的正式正文"
      : requestedLandingEligible && !reviewGate.reviewRequirementSatisfied
        ? "当前候选尚未关联通过门禁的原生审查产物"
      : landingBlockReason !== undefined
        ? text(landingBlockReason, 1_000)
        : current.landingBlockReason;
    const next = {
      ...current,
      schemaVersion: SCHEMA_VERSION,
      status: lifecycle.status,
      executionStatus: lifecycle.executionStatus,
      phase: lifecycle.phase,
      validationStatus: effectiveValidationStatus,
      landingStatus: effectiveLandingStatus,
      ...(stage ? { stage: text(stage, 80) } : {}),
      ...(heartbeatAt ? { heartbeatAt: text(heartbeatAt, 80) } : {}),
      ...(stageStartedAt ? { stageStartedAt: text(stageStartedAt, 80) } : {}),
      candidates: mergedCandidates,
      ...(candidate ? { adoptedCandidate } : {}),
      landingEligible: effectiveLandingEligible,
      landingBlockReason: effectiveLandingBlockReason,
      ...(memoryStatus ? { memoryStatus: text(memoryStatus, 80) } : {}),
      ...(memoryUpdate !== undefined ? { memoryUpdate: safeJsonObject(memoryUpdate) } : {}),
      ...(memoryUpdates !== undefined ? { memoryUpdates: safeJsonObject(memoryUpdates) ?? {} } : {}),
      ...(execution ? { execution: publicExecution(execution, {
        startedAt: current.startedAt,
        endedAt: current.completedAt,
      }) } : {}),
      ...(resultData !== undefined
        ? { resultData: safeJsonObject(resultData, 4_000_000) }
        : candidateChanged ? { resultData: null } : {}),
      reviewArtifact: storedReviewArtifact,
      commitReceipt: storedCommitReceipt,
      projectionManifest: storedProjectionManifest,
      ...(externalRuntimeEvidence !== undefined
        ? { externalRuntimeEvidence: safeJsonObject(externalRuntimeEvidence, 200_000) }
        : {}),
      ...(lifecycle.terminal
        ? { completedAt: current.completedAt || new Date().toISOString() }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    return writeAttempt(id, path, next);
  });
};

export const failGenerationAttempt = async ({ requestId, reason = "", cancelled = false } = {}) => {
  const id = normalizedRequestId(requestId);
  const path = attemptPath(id);
  return withWriteLock(path, async () => {
    const current = await readAttempt(id);
    if (!current) return null;
    const next = {
      ...current,
      status: cancelled ? "cancelled" : "failed",
      executionStatus: "terminal",
      phase: "finished",
      validationStatus: current.adoptedCandidate ? "pending" : "blocked",
      landingStatus: current.adoptedCandidate ? "not_requested" : "failed",
      stage: cancelled ? "cancelled" : "failed",
      ...(cancelled ? { candidates: [], adoptedCandidate: "" } : {}),
      ...(cancelled ? { reviewArtifact: null, commitReceipt: null, projectionManifest: null } : {}),
      landingEligible: false,
      landingBlockReason: text(reason, 1_000) || (cancelled ? "任务已由用户终止" : "正文检查未完成"),
      completedAt: current.completedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return writeAttempt(id, path, next);
  });
};

export const loadGenerationAttempt = async ({ requestId } = {}) => readAttempt(normalizedRequestId(requestId));

export const publicGenerationAttempt = (attempt) => {
  if (!attempt) return null;
  const reviewRecoveryFailure = generationAttemptReviewRecoveryFailure(attempt);
  const candidate = text(attempt.adoptedCandidate || attempt.candidates?.at(-1)?.text, MAX_CANDIDATE_CHARS);
  const candidateVariants = generationAttemptCandidateVariants(attempt);
  const selectedCandidateId = candidateVariants.find((variant) => variant.selected)?.id || "";
  const landingEligible = Boolean(candidate) && attempt.landingEligible === true;
  const lifecycle = normalizedAttemptLifecycle({ current: attempt });
  const active = RECOVERABLE_ACTIVE_STATUSES.has(lifecycle.status) && lifecycle.executionStatus !== "terminal";
  const executionStatus = active ? "running" : "terminal";
  const sourcePrompt = (Array.isArray(attempt.requestSnapshot?.messages)
    ? [...attempt.requestSnapshot.messages].reverse().find((message) => message?.role === "user")?.content
    : attempt.requestSnapshot?.userPrompt) || "";
  const validationStatus = text(attempt.validationStatus, 40)
    || (attempt.execution?.validationStatus ? text(attempt.execution.validationStatus, 40) : landingEligible ? "passed" : "pending");
  const landingStatus = text(attempt.landingStatus, 40)
    || (landingEligible ? "ready" : attempt.status === "failed" ? "failed" : "not_requested");
  return {
    requestId: text(attempt.requestId, 100),
    conversationId: text(attempt.conversationId, 160),
    sourceMessageId: text(attempt.sourceMessageId, 160),
    sourcePrompt: text(sourcePrompt, 20_000),
    targetDocumentId: text(attempt.targetDocumentId, 160),
    taskKind: text(attempt.taskKind, 80),
    status: lifecycle.status,
    executionStatus,
    phase: lifecycle.phase,
    validationStatus,
    landingStatus,
    stage: text(attempt.stage, 80),
    candidate,
    candidateVariants,
    selectedCandidateId,
    landingEligible,
    landingBlockReason: landingEligible ? text(attempt.landingBlockReason, 1_000) : text(attempt.landingBlockReason || "没有可落盘的正式正文", 1_000),
    memoryStatus: text(attempt.memoryStatus, 80),
    memoryUpdate: safeJsonObject(attempt.memoryUpdate),
    memoryUpdates: safeJsonObject(attempt.memoryUpdates) ?? {},
    execution: publicExecution(attempt.execution, {
      startedAt: attempt.startedAt,
      endedAt: attempt.completedAt,
    }),
    resultData: safeJsonObject(attempt.resultData, 4_000_000),
    reviewArtifact: safeJsonObject(attempt.reviewArtifact, 1_000_000),
    commitReceipt: safeJsonObject(attempt.commitReceipt, 500_000),
    projectionManifest: safeJsonObject(attempt.projectionManifest, 500_000),
    externalRuntimeEvidence: safeJsonObject(attempt.externalRuntimeEvidence, 200_000),
    durabilityStatus: attempt.durabilityStatus === "memory_only" ? "memory_only" : "durable",
    recoverableAfterRestart: attempt.durabilityStatus !== "memory_only",
    durabilityWarning: text(attempt.durabilityWarning, 500),
    artifactSummary: summarizeNativeCreativeArtifacts(attempt),
    candidateBasisSeed: safeJsonObject(attempt.requestSnapshot?.candidateBasisSeed, 500_000),
    resumeCount: Math.max(0, Number(attempt.resumeCount) || 0),
    reused: attempt.reused === true,
    startedAt: text(attempt.startedAt, 80),
    completedAt: text(attempt.completedAt, 80),
    heartbeatAt: text(attempt.heartbeatAt, 80) || text(attempt.updatedAt, 80),
    stageStartedAt: text(attempt.stageStartedAt, 80) || text(attempt.updatedAt, 80),
    updatedAt: text(attempt.updatedAt, 80),
    ...(reviewRecoveryFailure ? {
      status: attempt.status === "cancelled" ? "cancelled" : "failed",
      executionStatus: "terminal",
      validationStatus: "blocked",
      landingStatus: attempt.landingStatus === "committed" ? "committed" : "not_requested",
      landingEligible: false,
      recoverableAfterRestart: false,
      candidate: "",
      candidateVariants: [],
      selectedCandidateId: "",
      resultData: null,
      artifactSummary: { ...summarizeNativeCreativeArtifacts(attempt), review: "invalid" },
      landingBlockReason: "历史自检任务未取得可验证的有效报告，不能恢复为正式成果；原始输出和历史仍保留，请按原任务重新执行。",
      execution: {
        ...publicExecution(attempt.execution, { startedAt: attempt.startedAt, endedAt: attempt.completedAt }),
        status: attempt.status === "cancelled" ? "cancelled" : "retry_required",
        validationStatus: "blocked",
        landingStatus: attempt.landingStatus === "committed" ? "committed" : "not_requested",
        finalVerdict: "",
        result: "历史自检输出无效，未恢复为待落盘成果",
      },
      recoveryEvidence: {
        code: reviewRecoveryFailure,
        status: text(attempt.status, 40),
        validationStatus: text(attempt.validationStatus, 40),
        landingStatus: text(attempt.landingStatus, 40),
        candidate,
        execution: publicExecution(attempt.execution),
        resultData: safeJsonObject(attempt.resultData, 4_000_000),
      },
    } : {}),
  };
};

export const listGenerationAttempts = async ({ workspacePath = "", unfinished = false, limit = 50 } = {}) => {
  const fingerprint = workspaceFingerprint(workspacePath);
  if (!fingerprint) return [];
  const root = attemptRoot();
  await mkdir(root, { recursive: true }).catch(() => {});
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const attempts = [];
  const requestIds = new Set(entries.flatMap((entry) => {
    const requestId = entry.isFile() ? entry.name.match(/^([A-Za-z0-9_-]{8,100})\.json$/)?.[1] : "";
    return requestId ? [requestId] : [];
  }));
  for (const [requestId, attempt] of memoryFallbackAttempts) {
    if (attempt.workspaceFingerprint === fingerprint) requestIds.add(requestId);
  }
  for (const requestId of requestIds) {
    if (!requestId) continue;
    const attempt = await readAttempt(requestId);
    if (!attempt || attempt.workspaceFingerprint !== fingerprint) continue;
    const publicAttempt = publicGenerationAttempt(attempt);
    // v1/v2 did not persist a commit acknowledgement. Treat their successful,
    // landing-eligible completion as historical instead of rediscovering every
    // old chapter on each launch. Legacy blocked candidates remain recoverable.
    const legacySuccessfulCompletion = Number(attempt.schemaVersion) < 3
      && attempt.status === "complete"
      && attempt.landingEligible === true;
    const isUnfinished = !publicAttempt.recoveryEvidence && !legacySuccessfulCompletion && (
      publicAttempt.executionStatus !== "terminal"
      || (
        publicAttempt.landingStatus !== "committed"
        && publicAttempt.status !== "cancelled"
        && (Boolean(publicAttempt.candidate) || publicAttempt.status !== "complete")
      )
    );
    if (unfinished && !isUnfinished) continue;
    attempts.push(publicAttempt);
  }
  return attempts
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, Math.min(200, Math.max(1, Number(limit) || 50)));
};

export const recoverInterruptedGenerationAttempts = async () => {
  const root = attemptRoot();
  await mkdir(root, { recursive: true });
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let recovered = 0;
  for (const entry of entries) {
    const requestId = entry.isFile() ? entry.name.match(/^([A-Za-z0-9_-]{8,100})\.json$/)?.[1] : "";
    if (!requestId) continue;
    const path = attemptPath(requestId);
    await withWriteLock(path, async () => {
      const current = await readAttempt(requestId);
      if (!current || !RECOVERABLE_ACTIVE_STATUSES.has(current.status)) return;
      await writeAttempt(requestId, path, {
        ...current,
        schemaVersion: SCHEMA_VERSION,
        status: "interrupted",
        executionStatus: "terminal",
        phase: "interrupted",
        validationStatus: "pending",
        landingStatus: current.candidates?.length ? "ready" : "not_requested",
        stage: "recovery_required",
        landingEligible: false,
        landingBlockReason: current.candidates?.length
          ? "软件上次退出时任务仍在运行；安全草稿已保留，请先检查后再明确续接"
          : "软件上次退出时任务状态未确认；为避免重复计费，未自动重新提交",
        completedAt: current.completedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      recovered += 1;
    });
  }
  return { recovered };
};

export const generationAttemptStorePath = ({ requestId } = {}) => attemptPath(requestId);
