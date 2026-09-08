import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  EXPERIENCE_FEEDBACK_OUTCOMES,
  EXPERIENCE_MAX_RECALL_CHARACTERS,
  EXPERIENCE_MAX_RECALL_ITEMS,
  EXPERIENCE_PROMOTION_STATUSES,
  EXPERIENCE_RECORD_STATUSES,
  EXPERIENCE_STORE_SCHEMA_VERSION,
  experienceAdoptionIdempotencyKey,
  experienceFeedbackScore,
  experiencePromotionEligibility,
  experienceRecallRank,
  experienceScopeMatches,
  experienceScopeScore,
  experienceStageAllows,
  normalizeExperienceApplicability,
  normalizeExperienceFacets,
  normalizeExperienceKind,
  normalizeExperienceProvenance,
  normalizeExperienceScope,
  normalizeTaskEnvelope,
} from "../experience-policy.js";
import { appDataRoot } from "./app-data.mjs";

const MAX_RECORDS = 20_000;
const MAX_VERSIONS_PER_RECORD = 100;
const MAX_FEEDBACK_EVENTS_PER_RECORD = 500;
const MAX_RECALLED_TASK_IDS = 100;
const MAX_AUDIT_EVENTS = 20_000;
const MAX_RECALL_TRACES = 20_000;
const writeQueues = new Map();
const migrationPromises = new Map();
const indexCache = new Map();

const list = (value) => Array.isArray(value) ? value : [];
const textValue = (value, max = 1_200) => String(value ?? "").replace(/\0/g, "").trim().slice(0, max);
const digest = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
const unique = (values) => [...new Set(values.filter(Boolean))];
const nowIso = () => new Date().toISOString();
const adoptedArtifactValue = (value, max = 2 * 1024 * 1024) => String(value ?? "").replace(/\0/g, "").trim().slice(0, max);
const observerProfile = (value = {}) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.fromEntries([
    "id", "connectionId", "provider", "adapter", "protocol", "model", "baseUrl", "cliPath",
    "reasoningEffort", "serviceTier", "speedMode", "maxOutputTokens", "temperature",
  ].map((key) => [key, textValue(source[key], key === "baseUrl" || key === "cliPath" ? 2_000 : 240)]).filter(([, item]) => item));
};
const normalizedObserverRequest = (value = {}) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const artifact = adoptedArtifactValue(source.artifact);
  const profile = observerProfile(source.profile ?? source.settings);
  if (!artifact) return null;
  return {
    artifact,
    profile,
    workspacePath: textValue(source.workspacePath, 2_000),
    createdAt: textValue(source.createdAt, 80) || nowIso(),
  };
};
const publicCollectionJob = (job = {}) => {
  const { observerRequest, ...safe } = job;
  return { ...safe, retryAvailable: Boolean(observerRequest?.artifact && Object.keys(observerRequest?.profile ?? {}).length) };
};
const storeRoot = (dataRoot = appDataRoot()) => join(resolve(dataRoot), "experience-store");
const storePath = (dataRoot) => join(storeRoot(dataRoot), "experience-v3.json");
const backupPath = (dataRoot) => join(storeRoot(dataRoot), "experience-v3.backup.json");
const v2StorePath = (dataRoot) => join(storeRoot(dataRoot), "experience-v2.json");
const v2BackupPath = (dataRoot) => join(storeRoot(dataRoot), "experience-v2.backup.json");
const v1StorePath = (dataRoot) => join(storeRoot(dataRoot), "experience-v1.json");
const v1BackupPath = (dataRoot) => join(storeRoot(dataRoot), "experience-v1.backup.json");
const migrationRoot = (dataRoot) => join(storeRoot(dataRoot), "migration-snapshots");

const emptyStore = () => ({
  schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION,
  revision: 0,
  adoptionEvents: [],
  candidates: [],
  records: [],
  uses: [],
  recallTraces: [],
  feedback: [],
  clusters: [],
  promotions: [],
  collectionJobs: [],
  audit: [],
});

const atomicWrite = async (path, content, backup = "") => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const swap = `${path}.${process.pid}.${randomUUID()}.swap`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (backup) await copyFile(path, backup).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  let movedExisting = false;
  try {
    await rename(path, swap);
    movedExisting = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  try {
    await rename(temporary, path);
    if (movedExisting) await rm(swap, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (movedExisting) await rename(swap, path);
    throw error;
  }
};

const auditEvent = (action, payload = {}) => ({
  id: `audit-${randomUUID()}`,
  action: textValue(action, 120),
  at: nowIso(),
  ...payload,
});

const usageRecord = (value = {}) => ({
  recalledCount: Math.max(0, Number(value.recalledCount) || 0),
  recalledTaskCount: Math.max(0, Number(value.recalledTaskCount) || list(value.recentTaskIds).length),
  helpfulCount: Math.max(0, Number(value.helpfulCount) || 0),
  notApplicableCount: Math.max(0, Number(value.notApplicableCount) || 0),
  harmfulCount: Math.max(0, Number(value.harmfulCount) || 0),
  ignoredCount: Math.max(0, Number(value.ignoredCount) || 0),
  recentTaskIds: unique(list(value.recentTaskIds).map((item) => textValue(item, 180))).slice(-MAX_RECALLED_TASK_IDS),
  lastRecalledAt: textValue(value.lastRecalledAt, 64),
  lastOutcomeAt: textValue(value.lastOutcomeAt, 64),
  recallSuspended: Object.prototype.hasOwnProperty.call(value, "recallSuspended")
    ? value.recallSuspended === true
    : Math.max(0, Number(value.harmfulCount) || 0) > 0,
});

const promotionRecord = (value = {}) => {
  const legacy = value?.status === "promoted" ? "skill_draft" : value?.status;
  return {
    status: EXPERIENCE_PROMOTION_STATUSES.includes(legacy) ? legacy : "not_eligible",
    promotionId: textValue(value.promotionId, 180),
    clusterId: textValue(value.clusterId, 180),
    skillId: textValue(value.skillId, 180),
    skillVersion: textValue(value.skillVersion, 80),
    createdAt: textValue(value.createdAt || value.promotedAt, 64),
  };
};

const normalizeEvidence = (value) => list(value).map((item) => ({
  claim: textValue(item?.claim, 500),
  quote: textValue(item?.quote, 800),
})).filter((item) => item.claim && item.quote).slice(0, 12);

const normalizeCandidate = (candidate = {}, envelope = {}) => {
  const applicability = normalizeExperienceApplicability(candidate?.applicability, candidate);
  const facets = normalizeExperienceFacets(candidate?.facets, {
    topics: candidate?.topics ?? applicability.tags,
    stages: candidate?.stages,
    capabilities: candidate?.capabilities,
    deliverableType: candidate?.deliverableType || applicability.deliverableType,
    contextDomain: candidate?.contextDomain || applicability.contextDomain,
    taskType: candidate?.taskType || envelope?.taskType,
  });
  const conditions = unique(list(candidate?.conditions).map((item) => textValue(item, 500))).slice(0, 16);
  const exclusions = unique(list(candidate?.exclusions).map((item) => textValue(item, 500))).slice(0, 16);
  return {
    contract: candidate?.contract === "experience_candidate_v3" ? candidate.contract : "experience_candidate_v3",
    artifactHash: textValue(candidate?.artifactHash || envelope?.adoptedArtifactHash, 128),
    fingerprint: textValue(candidate?.fingerprint, 128),
    title: textValue(candidate?.title || candidate?.observation, 160),
    kind: normalizeExperienceKind(candidate?.kind),
    facets,
    lane: textValue(candidate?.lane || applicability.lane || "general", 120) || "general",
    deliverableType: textValue(candidate?.deliverableType || facets.deliverableType, 120),
    contextDomain: textValue(candidate?.contextDomain || facets.contextDomain || "general", 120) || "general",
    observation: textValue(candidate?.observation),
    recommendation: textValue(candidate?.recommendation),
    conditions,
    exclusions,
    scopeProposal: normalizeExperienceScope(candidate?.scopeProposal ?? candidate?.scope, {
      fallbackLevel: "project",
      fallbackScopeId: envelope?.projectId,
      fallbackLabel: "当前作品",
      needsReview: !envelope?.projectId,
    }),
    evidence: normalizeEvidence(candidate?.evidence),
    provenance: normalizeExperienceProvenance(candidate?.provenance, envelope),
    confidence: ["low", "medium", "high"].includes(candidate?.confidence) ? candidate.confidence : "medium",
  };
};

const normalizeStoredRecord = (record = {}) => {
  const latest = list(record.versions).at(-1) ?? {};
  const applicability = normalizeExperienceApplicability(record.applicability, record);
  const facets = normalizeExperienceFacets(record.facets ?? latest.facets, {
    topics: applicability.tags,
    stages: latest.stages,
    capabilities: latest.capabilities,
    deliverableType: record.deliverableType || applicability.deliverableType,
    contextDomain: record.contextDomain || applicability.contextDomain,
    taskType: latest.taskType,
  });
  const scope = normalizeExperienceScope(record.scope ?? latest.scopeProposal, {
    fallbackLevel: "project",
    fallbackScopeId: latest.provenance?.projectId,
    fallbackLabel: "当前作品",
    needsReview: record.scope == null,
  });
  const status = EXPERIENCE_RECORD_STATUSES.includes(record.status)
    ? record.status
    : record.status === "revoked" ? "revoked" : "validated";
  return {
    ...record,
    kind: normalizeExperienceKind(record.kind || latest.kind),
    scope,
    facets,
    applicability,
    lane: textValue(record.lane || latest.lane || applicability.lane || "general", 120),
    deliverableType: textValue(record.deliverableType || latest.deliverableType || facets.deliverableType, 120),
    contextDomain: textValue(record.contextDomain || latest.contextDomain || facets.contextDomain || "general", 120),
    status,
    usage: usageRecord(record.usage),
    feedback: list(record.feedback),
    promotion: promotionRecord(record.promotion),
    versions: list(record.versions),
    conflictsWith: unique(list(record.conflictsWith).map((item) => textValue(item, 180))),
  };
};

const normalizeStore = (store = {}) => ({
  ...emptyStore(),
  ...store,
  schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION,
  revision: Math.max(0, Number(store.revision) || 0),
  adoptionEvents: list(store.adoptionEvents),
  candidates: list(store.candidates),
  records: list(store.records).map(normalizeStoredRecord),
  uses: list(store.uses),
  recallTraces: list(store.recallTraces).slice(-MAX_RECALL_TRACES),
  feedback: list(store.feedback),
  clusters: list(store.clusters),
  promotions: list(store.promotions),
  collectionJobs: list(store.collectionJobs).map((job) => ({
    ...job,
    observerRequest: normalizedObserverRequest(job?.observerRequest),
  })),
  audit: list(store.audit).slice(-MAX_AUDIT_EVENTS),
});

const parseV3Store = (content) => {
  const parsed = JSON.parse(content);
  if (!parsed || parsed.schemaVersion !== 3 || !Array.isArray(parsed.records)) throw new Error("经验仓 v3 格式无效，拒绝覆盖原数据");
  return normalizeStore(parsed);
};

const parseLegacyStore = (content, schemaVersion) => {
  const parsed = JSON.parse(content);
  if (!parsed || Number(parsed.schemaVersion) !== schemaVersion || !Array.isArray(parsed.records)) throw new Error(`经验仓 v${schemaVersion} 格式无效`);
  return parsed;
};

const semanticKey = (candidate, scope) => digest(JSON.stringify({
  kind: candidate.kind,
  scope,
  facets: candidate.facets,
  observation: candidate.observation,
  recommendation: candidate.recommendation,
  conditions: candidate.conditions,
  exclusions: candidate.exclusions,
}));

const buildIndexes = (store) => {
  const mapList = (items, keys) => {
    const result = new Map();
    for (const item of items) for (const key of keys(item)) {
      if (!key) continue;
      const values = result.get(key) ?? [];
      values.push(item.id);
      result.set(key, values);
    }
    return result;
  };
  return {
    revision: store.revision,
    account: mapList(store.records, (item) => [item.accountId]),
    scope: mapList(store.records, (item) => [`${item.scope?.level}:${item.scope?.scopeId}`]),
    deliverableType: mapList(store.records, (item) => [item.deliverableType]),
    stage: mapList(store.records, (item) => list(item.facets?.stages)),
    capability: mapList(store.records, (item) => list(item.facets?.capabilities)),
    topic: mapList(store.records, (item) => list(item.facets?.topics)),
    status: mapList(store.records, (item) => [item.status]),
  };
};

const rememberIndexes = (dataRoot, store) => {
  const key = resolve(dataRoot || appDataRoot());
  const cached = indexCache.get(key);
  if (!cached || cached.revision !== store.revision) indexCache.set(key, buildIndexes(store));
};

const legacyRecordToV3 = (record = {}, schemaVersion = 2) => {
  const normalized = normalizeStoredRecord(record);
  const versions = list(normalized.versions).map((version) => {
    const candidate = normalizeCandidate({
      ...version,
      kind: normalized.kind,
      scopeProposal: normalized.scope,
      facets: version.facets ?? {
        topics: normalized.applicability.tags,
        stages: [],
        capabilities: [],
        deliverableType: normalized.deliverableType,
        contextDomain: normalized.contextDomain,
      },
      provenance: version.provenance ?? {},
    });
    return {
      ...candidate,
      version: Math.max(1, Number(version.version) || 1),
      sourceTaskId: textValue(version.sourceTaskId, 180),
      sourceDocumentId: textValue(version.sourceDocumentId, 180),
      submittedAt: textValue(version.submittedAt, 64),
      migratedFromSchema: schemaVersion,
      needsReview: !candidate.facets.stages.length || !candidate.facets.capabilities.length,
    };
  });
  return {
    ...normalized,
    status: normalized.status === "revoked" ? "revoked" : "active",
    facets: normalizeExperienceFacets(normalized.facets, {
      deliverableType: normalized.deliverableType,
      contextDomain: normalized.contextDomain,
    }),
    versions,
    currentVersion: Math.max(Number(normalized.currentVersion) || 0, versions.length),
    migration: { fromSchema: schemaVersion, needsReview: versions.some((item) => item.needsReview) },
  };
};

const migrateLegacyStore = async ({ legacy, schemaVersion, rawContent, dataRoot }) => {
  const sourceHash = digest(rawContent);
  const snapshotDirectory = join(migrationRoot(dataRoot), `v${schemaVersion}-to-v3-${sourceHash.slice(0, 16)}`);
  await mkdir(snapshotDirectory, { recursive: true });
  const snapshotStorePath = join(snapshotDirectory, `experience-v${schemaVersion}.json`);
  const summaryPath = join(snapshotDirectory, "summary.json");
  await writeFile(snapshotStorePath, rawContent, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  if (process.env.SHENSI_TEST_EXPERIENCE_MIGRATION_FAILURE === "after_snapshot") {
    throw new Error("测试注入：迁移快照后失败");
  }
  const migrated = emptyStore();
  migrated.revision = Math.max(0, Number(legacy.revision) || 0);
  migrated.migration = { fromSchema: schemaVersion, sourceHash, migratedAt: nowIso(), snapshotDirectory };
  migrated.records = legacy.records.map((record) => legacyRecordToV3(record, schemaVersion));
  migrated.candidates = migrated.records.flatMap((record) => record.versions.map((version) => ({
    id: `candidate-${digest(`${record.id}\u0000${version.version}\u0000${version.fingerprint}`)}`,
    recordId: record.id,
    accountId: record.accountId,
    adoptionEventId: "",
    batchId: "",
    status: "validated",
    createdAt: version.submittedAt || record.createdAt || nowIso(),
    ...version,
  })));
  migrated.feedback = migrated.records.flatMap((record) => list(record.feedback).map((event) => ({ ...event, recordId: record.id })));
  migrated.uses = migrated.records.flatMap((record) => list(record.usage?.recentTaskIds).map((taskId) => ({
    id: `use-${digest(`${record.id}\u0000${taskId}`)}`,
    recordId: record.id,
    taskId,
    runId: taskId,
    stage: "",
    matchScore: 0,
    recallReason: "由旧版使用计数迁移",
    createdAt: record.usage?.lastRecalledAt || record.updatedAt || "",
  })));
  migrated.promotions = migrated.records.filter((record) => record.promotion?.skillId).map((record) => ({
    id: record.promotion.promotionId || `promotion-${digest(record.id)}`,
    recordIds: [record.id],
    skillId: record.promotion.skillId,
    status: record.promotion.status,
    createdAt: record.promotion.createdAt,
  }));
  const before = {
    recordCount: legacy.records.length,
    recordIds: legacy.records.map((record) => record.id).sort(),
    versionCount: legacy.records.reduce((sum, record) => sum + list(record.versions).length, 0),
    feedbackCount: legacy.records.reduce((sum, record) => sum + list(record.feedback).length, 0),
  };
  const after = {
    recordCount: migrated.records.length,
    recordIds: migrated.records.map((record) => record.id).sort(),
    versionCount: migrated.records.reduce((sum, record) => sum + list(record.versions).length, 0),
    feedbackCount: migrated.feedback.length,
  };
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error("经验仓 v2→v3 迁移校验失败，已保留旧仓库");
  await writeFile(summaryPath, `${JSON.stringify({ schemaVersion: 1, sourceHash, before, after }, null, 2)}\n`, { encoding: "utf8", flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  await atomicWrite(storePath(dataRoot), JSON.stringify(migrated, null, 2), backupPath(dataRoot));
  const verified = parseV3Store(await readFile(storePath(dataRoot), "utf8"));
  if (verified.records.length !== legacy.records.length || verified.feedback.length !== migrated.feedback.length) throw new Error("经验仓 v3 落盘复核失败");
  return verified;
};

const readLegacyForMigration = async (dataRoot) => {
  for (const [path, schemaVersion] of [[v2StorePath(dataRoot), 2], [v2BackupPath(dataRoot), 2], [v1StorePath(dataRoot), 1], [v1BackupPath(dataRoot), 1]]) {
    try {
      const rawContent = await readFile(path, "utf8");
      return { legacy: parseLegacyStore(rawContent, schemaVersion), schemaVersion, rawContent };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
};

const ensureLegacyMigrated = async (dataRoot) => {
  const key = resolve(dataRoot || appDataRoot());
  if (migrationPromises.has(key)) return migrationPromises.get(key);
  const operation = (async () => {
    const source = await readLegacyForMigration(dataRoot);
    if (!source) return emptyStore();
    try {
      return await migrateLegacyStore({ ...source, dataRoot });
    } catch (error) {
      const fallback = emptyStore();
      fallback.revision = Math.max(0, Number(source.legacy.revision) || 0);
      fallback.migration = { fromSchema: source.schemaVersion, failed: true, error: textValue(error.message, 500), fallback: "legacy-read-only" };
      fallback.records = source.legacy.records.map((record) => legacyRecordToV3(record, source.schemaVersion));
      return fallback;
    }
  })().finally(() => migrationPromises.delete(key));
  migrationPromises.set(key, operation);
  return operation;
};

const readStore = async (dataRoot) => {
  let primaryError = null;
  try {
    const store = parseV3Store(await readFile(storePath(dataRoot), "utf8"));
    rememberIndexes(dataRoot, store);
    return store;
  } catch (error) {
    primaryError = error;
  }
  try {
    const store = parseV3Store(await readFile(backupPath(dataRoot), "utf8"));
    rememberIndexes(dataRoot, store);
    return store;
  } catch (backupError) {
    if (primaryError?.code !== "ENOENT" && backupError?.code === "ENOENT") throw primaryError;
    if (primaryError?.code !== "ENOENT" && backupError?.code !== "ENOENT") throw new Error(`经验仓与备份均无法读取：${primaryError.message}；${backupError.message}`);
  }
  const store = await ensureLegacyMigrated(dataRoot);
  rememberIndexes(dataRoot, store);
  return normalizeStore(store);
};

const persistStore = async (dataRoot, store) => {
  if (store?.migration?.failed === true) {
    const error = new Error("经验仓 v3 迁移失败，当前以 v2 只读回退模式运行；请修复迁移后再写入");
    error.code = "EXPERIENCE_MIGRATION_FALLBACK_READ_ONLY";
    throw error;
  }
  store.revision = Math.max(0, Number(store.revision) || 0) + 1;
  store.audit = list(store.audit).slice(-MAX_AUDIT_EVENTS);
  store.recallTraces = list(store.recallTraces).slice(-MAX_RECALL_TRACES);
  await atomicWrite(storePath(dataRoot), JSON.stringify(store, null, 2), backupPath(dataRoot));
  rememberIndexes(dataRoot, store);
};

const enqueueWrite = (dataRoot, operation) => {
  const key = resolve(dataRoot || appDataRoot());
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  const queued = next.finally(() => {
    if (writeQueues.get(key) === queued) writeQueues.delete(key);
  });
  writeQueues.set(key, queued);
  return queued;
};

const semanticTokens = (value = "") => {
  const normalized = String(value || "").toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const tokens = new Set(normalized.split(/\s+/).filter((item) => item.length >= 2));
  const chinese = [...normalized.replace(/[^\p{Script=Han}]/gu, "")];
  for (let index = 0; index < chinese.length - 1; index += 1) tokens.add(`${chinese[index]}${chinese[index + 1]}`);
  return tokens;
};

const semanticRecallScore = (record, query) => {
  const wanted = semanticTokens(query);
  if (!wanted.size) return 0;
  const latest = record.versions.at(-1) ?? {};
  const searchable = semanticTokens([
    latest.title, record.lane, record.deliverableType, record.contextDomain,
    ...list(record.facets?.topics), ...list(record.facets?.capabilities),
    latest.observation, latest.recommendation, ...list(latest.conditions),
    ...list(latest.evidence).flatMap((item) => [item.claim, item.quote]),
  ].join(" "));
  let overlap = 0;
  for (const token of wanted) if (searchable.has(token)) overlap += 1;
  return overlap / Math.sqrt(Math.max(1, wanted.size * searchable.size));
};

const publicExperienceRecord = (record, store = null) => {
  const latest = record.versions.at(-1) ?? {};
  const useItems = store ? store.uses.filter((item) => item.recordId === record.id).slice(-50) : [];
  const feedbackItems = store ? store.feedback.filter((item) => item.recordId === record.id).slice(-50) : list(record.feedback);
  return {
    id: record.id,
    accountId: record.accountId,
    kind: record.kind,
    scope: record.scope,
    facets: record.facets,
    applicability: record.applicability,
    lane: record.lane,
    deliverableType: record.deliverableType,
    contextDomain: record.contextDomain,
    status: record.status,
    version: record.currentVersion,
    updatedAt: record.updatedAt,
    revokedAt: record.revokedAt || "",
    revokeReason: record.revokeReason || "",
    mergedInto: record.mergedInto || "",
    mergedRecordIds: list(record.mergedRecordIds),
    versionHistory: list(record.versions).map((item) => ({
      version: item.version,
      title: item.title || item.observation || "",
      candidateId: item.candidateId || "",
      sourceTaskId: item.sourceTaskId || item.provenance?.taskId || "",
      submittedAt: item.submittedAt || "",
    })),
    conflictsWith: record.conflictsWith,
    usage: record.usage,
    uses: useItems,
    feedback: feedbackItems,
    promotion: { ...record.promotion, ...experiencePromotionEligibility(record) },
    ...latest,
    currentVersion: record.currentVersion,
  };
};

const taskIsCreative = (taskType = "", deliverableType = "") => {
  const value = `${taskType} ${deliverableType}`.toLocaleLowerCase("zh-CN");
  if (!value.trim()) return true;
  return !/(?:setting|diagnostic|diagnosis|general_qa|ordinary_qa|设置|诊断|普通问答)/.test(value);
};

const exclusionMatches = (record, query) => {
  const normalized = String(query || "").toLocaleLowerCase("zh-CN");
  return list(record.versions.at(-1)?.exclusions).find((item) => {
    const condition = String(item || "").toLocaleLowerCase("zh-CN");
    return condition.length >= 4 && normalized.includes(condition);
  }) || "";
};

const submitBatchInsideTransaction = async ({ accountId = "local", taskEnvelope = {}, batch = {}, dataRoot, collectionJobId = "" }) => {
  const envelope = normalizeTaskEnvelope(taskEnvelope, {
    accountId,
    adoptedArtifactHash: batch?.taskEnvelope?.adoptedArtifactHash,
    adoptedAt: nowIso(),
  });
  if (!envelope.runId || !envelope.documentRevision || !envelope.adoptedArtifactHash) throw new Error("经验采用事件缺少 runId、documentRevision 或 adoptedArtifactHash");
  const store = await readStore(dataRoot);
  const key = digest(experienceAdoptionIdempotencyKey(envelope));
  let adoption = store.adoptionEvents.find((item) => item.idempotencyKey === key);
  const now = nowIso();
  if (!adoption) {
    adoption = {
      id: `adoption-${randomUUID()}`,
      idempotencyKey: key,
      taskEnvelope: envelope,
      accountId: envelope.accountId,
      projectId: envelope.projectId,
      documentId: envelope.documentId,
      runId: envelope.runId,
      adoptedArtifactHash: envelope.adoptedArtifactHash,
      adoptedAt: envelope.adoptedAt || now,
      createdAt: now,
    };
    store.adoptionEvents.push(adoption);
  }
  const batchId = `batch-${digest(`${adoption.id}\u0000${JSON.stringify(list(batch?.candidates).map((item) => item.fingerprint))}`)}`;
  if (store.candidates.some((item) => item.batchId === batchId)) return { stored: false, duplicate: true, adoptionEvent: adoption, batchId, records: [] };
  const records = [];
  for (const sourceCandidate of list(batch?.candidates).slice(0, 12)) {
    const candidate = normalizeCandidate(sourceCandidate, envelope);
    if (!candidate.artifactHash || !candidate.fingerprint || !candidate.title || !candidate.observation || !candidate.recommendation || !candidate.evidence.length) {
      throw new Error("经验候选批次未通过可信输入契约");
    }
    const scope = normalizeExperienceScope(candidate.scopeProposal, {
      fallbackLevel: "project",
      fallbackScopeId: envelope.projectId,
      fallbackLabel: "当前作品",
      needsReview: !envelope.projectId,
    });
    if (scope.level !== "project" && sourceCandidate?.scopeConfirmed !== true) {
      scope.level = "project";
      scope.scopeId = envelope.projectId;
      scope.label = "当前作品";
      scope.needsReview = true;
    }
    const applicability = normalizeExperienceApplicability(sourceCandidate?.applicability, candidate);
    const candidateId = `candidate-${randomUUID()}`;
    const storedCandidate = {
      id: candidateId,
      batchId,
      adoptionEventId: adoption.id,
      accountId: envelope.accountId,
      status: "validated",
      createdAt: now,
      ...candidate,
      scopeProposal: scope,
      provenance: { ...candidate.provenance, adoptionEventId: adoption.id },
    };
    store.candidates.push(storedCandidate);
    const keyValue = semanticKey(candidate, scope);
    let record = store.records.find((item) => item.accountId === envelope.accountId && item.semanticKey === keyValue && item.status !== "revoked");
    if (!record) {
      if (store.records.length >= MAX_RECORDS) throw new Error("经验仓已达到安全容量上限");
      record = {
        id: `experience-${randomUUID()}`,
        accountId: envelope.accountId,
        semanticKey: keyValue,
        kind: candidate.kind,
        scope,
        facets: candidate.facets,
        applicability,
        lane: candidate.lane,
        deliverableType: candidate.deliverableType,
        contextDomain: candidate.contextDomain,
        status: "active",
        createdAt: now,
        updatedAt: now,
        currentVersion: 0,
        usage: usageRecord(),
        feedback: [],
        promotion: promotionRecord(),
        versions: [],
        conflictsWith: [],
      };
      store.records.push(record);
    }
    const latest = record.versions.at(-1);
    if (latest?.fingerprint !== candidate.fingerprint) {
      const version = record.currentVersion + 1;
      record.currentVersion = version;
      record.versions.push({
        version,
        candidateId,
        adoptionEventId: adoption.id,
        batchId,
        ...candidate,
        scopeProposal: scope,
        sourceTaskId: envelope.taskId,
        sourceDocumentId: envelope.documentId,
        submittedAt: now,
      });
      record.versions = record.versions.slice(-MAX_VERSIONS_PER_RECORD);
    }
    record.kind = candidate.kind;
    record.scope = scope;
    record.facets = candidate.facets;
    record.applicability = applicability;
    record.lane = candidate.lane;
    record.deliverableType = candidate.deliverableType;
    record.contextDomain = candidate.contextDomain;
    record.updatedAt = now;
    records.push(publicExperienceRecord(record));
  }
  const job = collectionJobId ? store.collectionJobs.find((item) => item.id === collectionJobId) : null;
  if (job) Object.assign(job, { status: "completed", completedAt: now, candidateCount: records.length, error: "", observerRequest: null });
  store.audit.push(auditEvent("adoption_batch_committed", { adoptionEventId: adoption.id, batchId, recordIds: records.map((item) => item.id) }));
  await persistStore(dataRoot, store);
  return { stored: true, duplicate: false, adoptionEvent: adoption, batchId, records, record: records[0] ?? null };
};

export const recordAdoptionEvent = async ({ taskEnvelope = {}, collectionToken = "", observerRequest = null, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const envelope = normalizeTaskEnvelope(taskEnvelope, { adoptedAt: nowIso() });
  if (!envelope.runId || !envelope.documentRevision || !envelope.adoptedArtifactHash) throw new Error("采用事件缺少不可变任务标识");
  const store = await readStore(dataRoot);
  const key = digest(experienceAdoptionIdempotencyKey(envelope));
  const existing = store.adoptionEvents.find((item) => item.idempotencyKey === key);
  if (existing) {
    const duplicateJob = store.collectionJobs.find((item) => item.adoptionEventId === existing.id) ?? null;
    return { stored: false, duplicate: true, adoptionEvent: existing, collectionJob: duplicateJob ? publicCollectionJob(duplicateJob) : null };
  }
  const adoptionEvent = {
    id: `adoption-${randomUUID()}`,
    idempotencyKey: key,
    taskEnvelope: envelope,
    accountId: envelope.accountId,
    projectId: envelope.projectId,
    documentId: envelope.documentId,
    runId: envelope.runId,
    adoptedArtifactHash: envelope.adoptedArtifactHash,
    adoptedAt: envelope.adoptedAt || nowIso(),
    createdAt: nowIso(),
  };
  const collectionJob = {
    id: `experience-job-${randomUUID()}`,
    adoptionEventId: adoptionEvent.id,
    collectionToken: textValue(collectionToken, 180),
    status: "queued",
    attempts: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    error: "",
    observerRequest: normalizedObserverRequest(observerRequest),
  };
  store.adoptionEvents.push(adoptionEvent);
  store.collectionJobs.push(collectionJob);
  store.audit.push(auditEvent("adoption_recorded", { adoptionEventId: adoptionEvent.id, collectionJobId: collectionJob.id }));
  await persistStore(dataRoot, store);
  return { stored: true, duplicate: false, adoptionEvent, collectionJob: publicCollectionJob(collectionJob) };
});

export const submitExperienceCandidateBatch = async ({ accountId = "local", taskEnvelope = {}, batch = {}, collectionJobId = "", dataRoot = appDataRoot() } = {}) => (
  enqueueWrite(dataRoot, () => submitBatchInsideTransaction({ accountId, taskEnvelope, batch, collectionJobId, dataRoot }))
);

export const submitExperienceCandidate = async ({
  accountId = "local", candidate, kind = "", scope = null, sourceTaskId = "", sourceDocumentId = "", taskEnvelope = {}, dataRoot = appDataRoot(),
} = {}) => {
  const envelope = normalizeTaskEnvelope(taskEnvelope, {
    accountId,
    projectId: scope?.level === "project" ? scope.scopeId : "",
    taskId: sourceTaskId || `legacy-task-${candidate?.fingerprint || randomUUID()}`,
    runId: sourceTaskId || `legacy-run-${candidate?.fingerprint || randomUUID()}`,
    documentId: sourceDocumentId,
    documentRevision: candidate?.fingerprint || digest(candidate?.artifactHash || JSON.stringify(candidate)),
    taskType: candidate?.facets?.taskType || "creative",
    stage: candidate?.facets?.stages?.[0] || "creative",
    deliverableType: candidate?.deliverableType,
    contextDomain: candidate?.contextDomain,
    adoptedArtifactHash: candidate?.artifactHash,
    adoptedAt: nowIso(),
  });
  const prepared = { ...candidate, kind: kind || candidate?.kind, scopeProposal: scope ?? candidate?.scopeProposal, scopeConfirmed: scope?.level !== "project" };
  return submitExperienceCandidateBatch({
    accountId,
    taskEnvelope: envelope,
    batch: { contract: "experience_candidate_batch_v3", taskEnvelope: envelope, candidates: [prepared] },
    dataRoot,
  });
};

export const markExperienceCollectionFailed = async ({ jobId, error = "", dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const store = await readStore(dataRoot);
  const job = store.collectionJobs.find((item) => item.id === textValue(jobId, 180));
  if (!job) throw new Error("经验采集任务不存在");
  Object.assign(job, { status: "failed", error: textValue(error, 800), attempts: Math.max(0, Number(job.attempts) || 0) + 1, updatedAt: nowIso() });
  store.audit.push(auditEvent("collection_failed", { collectionJobId: job.id, error: job.error }));
  await persistStore(dataRoot, store);
  return job;
});

export const listExperienceCollectionJobs = async ({ accountId = "local", status = "all", dataRoot = appDataRoot() } = {}) => {
  const store = await readStore(dataRoot);
  const adoptionIds = new Set(store.adoptionEvents.filter((item) => item.accountId === textValue(accountId, 160)).map((item) => item.id));
  return store.collectionJobs
    .filter((item) => adoptionIds.has(item.adoptionEventId) && (status === "all" || item.status === status))
    .map(publicCollectionJob);
};

export const retryExperienceCollectionJob = async ({ jobId, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const store = await readStore(dataRoot);
  const job = store.collectionJobs.find((item) => item.id === textValue(jobId, 180));
  if (!job) throw new Error("经验采集任务不存在");
  const adoptionEvent = store.adoptionEvents.find((item) => item.id === job.adoptionEventId) ?? null;
  if (job.status === "completed") return { retried: false, job, adoptionEvent };
  Object.assign(job, { status: "queued", error: "", updatedAt: nowIso() });
  store.audit.push(auditEvent("collection_retry_requested", { collectionJobId: job.id }));
  await persistStore(dataRoot, store);
  return { retried: true, job, adoptionEvent };
});

export const recallExperiencePackage = async ({
  accountId = "local", lane = "", deliverableType = "", contextDomain = "", taskType = "", stage = "", capability = "", query = "", scope = {}, taskEnvelope = {}, enabled = true, limit = EXPERIENCE_MAX_RECALL_ITEMS, characterBudget = EXPERIENCE_MAX_RECALL_CHARACTERS, dataRoot = appDataRoot(),
} = {}) => {
  const excluded = [];
  if (!enabled) return { items: [], excluded: [{ reason: "当前模板未配置 experience_advisor" }], characterCount: 0 };
  if (!String(query || "").trim()) return { items: [], excluded: [{ reason: "任务文本为空" }], characterCount: 0 };
  const envelope = normalizeTaskEnvelope(taskEnvelope, { accountId, taskType, stage, deliverableType, contextDomain });
  if (!taskIsCreative(envelope.taskType, envelope.deliverableType)) return { items: [], excluded: [{ reason: "当前任务不是创作任务" }], characterCount: 0 };
  const store = await readStore(dataRoot);
  const normalizedAccountId = textValue(accountId || envelope.accountId, 160) || "local";
  const queryScope = {
    projectId: textValue(scope?.projectId || envelope.projectId, 180),
    seriesId: textValue(scope?.seriesId || envelope.seriesId, 180),
    genreId: textValue(scope?.genreId || contextDomain || envelope.contextDomain || "general", 180),
    authorId: textValue(scope?.authorId || normalizedAccountId, 180),
    contextDomain: textValue(contextDomain || envelope.contextDomain || "general", 120),
  };
  const candidates = [];
  for (const record of store.records) {
    const reject = (reason) => excluded.push({ recordId: record.id, reason });
    if (record.accountId !== normalizedAccountId) { reject("账号不匹配"); continue; }
    if (!["validated", "active", "mature", "clustered"].includes(record.status)) { reject("经验状态不允许召回"); continue; }
    if (record.usage?.recallSuspended === true) { reject("经验已暂停召回"); continue; }
    if (!experienceScopeMatches(record.scope, queryScope)) { reject("作用域不匹配"); continue; }
    if (!experienceStageAllows(record, stage || envelope.stage)) { reject("阶段不匹配"); continue; }
    if (lane && record.lane !== lane) { reject("赛道不匹配"); continue; }
    if (deliverableType && record.deliverableType !== deliverableType) { reject("产物类型不匹配"); continue; }
    if (contextDomain && record.contextDomain !== contextDomain) { reject("内容领域不匹配"); continue; }
    if (taskType && record.facets?.taskType && record.facets.taskType !== taskType) { reject("任务类型不匹配"); continue; }
    if (capability && list(record.facets?.capabilities).length && !record.facets.capabilities.includes(capability)) { reject("能力不匹配"); continue; }
    const exclusion = exclusionMatches(record, query);
    if (exclusion) { reject(`命中禁用条件：${exclusion}`); continue; }
    if (list(record.conflictsWith).length) { reject("冲突待复核"); continue; }
    const semanticScore = semanticRecallScore(record, query);
    if (semanticScore <= 0) { reject("相关性不足"); continue; }
    const scopeScore = experienceScopeScore(record.scope, queryScope);
    const applicabilityScore = [lane, deliverableType, contextDomain, taskType, capability].filter(Boolean).length
      ? [!lane || record.lane === lane, !deliverableType || record.deliverableType === deliverableType, !contextDomain || record.contextDomain === contextDomain, !taskType || !record.facets?.taskType || record.facets.taskType === taskType, !capability || !list(record.facets?.capabilities).length || record.facets.capabilities.includes(capability)].filter(Boolean).length / 5
      : 0;
    const recallScore = experienceRecallRank({ semanticScore, scopeScore, applicabilityScore, feedbackScore: experienceFeedbackScore(record.usage), kind: record.kind });
    if (recallScore < 0.12) { reject("综合置信度低于阈值"); continue; }
    candidates.push({ record, semanticScore, scopeScore, recallScore });
  }
  const selected = [];
  let characterCount = 0;
  for (const candidate of candidates.sort((left, right) => right.recallScore - left.recallScore || String(right.record.updatedAt).localeCompare(String(left.record.updatedAt)))) {
    if (selected.length >= Math.min(EXPERIENCE_MAX_RECALL_ITEMS, Math.max(1, Number(limit) || EXPERIENCE_MAX_RECALL_ITEMS))) break;
    const record = publicExperienceRecord(candidate.record, store);
    const itemCharacters = [record.title, record.observation, record.recommendation, ...list(record.conditions), ...list(record.exclusions)].join("").length;
    if (selected.length && characterCount + itemCharacters > Math.min(EXPERIENCE_MAX_RECALL_CHARACTERS, Math.max(500, Number(characterBudget) || EXPERIENCE_MAX_RECALL_CHARACTERS))) {
      excluded.push({ recordId: record.id, reason: "超过本轮经验字符预算" });
      continue;
    }
    characterCount += itemCharacters;
    selected.push({
      ...record,
      recallScore: Number(candidate.recallScore.toFixed(4)),
      semanticScore: Number(candidate.semanticScore.toFixed(4)),
      recallReason: `${record.scope.level === "project" && candidate.scopeScore > 0 ? "同一作品；" : ""}任务文本与经验主题、建议或证据相关`,
    });
  }
  return { items: selected, excluded: excluded.slice(0, 200), characterCount };
};

export const recallExperiences = async (options = {}) => (await recallExperiencePackage(options)).items;

export const listExperiences = async ({ accountId = "local", status = "all", scopeLevel = "", kind = "", review = "", limit = 200, dataRoot = appDataRoot() } = {}) => {
  const store = await readStore(dataRoot);
  const normalizedAccountId = textValue(accountId, 160) || "local";
  return store.records
    .filter((record) => record.accountId === normalizedAccountId)
    .filter((record) => status === "all" || record.status === status)
    .filter((record) => !scopeLevel || record.scope?.level === scopeLevel)
    .filter((record) => !kind || record.kind === kind)
    .filter((record) => review !== "needs_review" || record.scope?.needsReview || record.migration?.needsReview || list(record.conflictsWith).length)
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
    .slice(0, Math.min(500, Math.max(1, Number(limit) || 200)))
    .map((record) => publicExperienceRecord(record, store));
};

export const revokeExperience = async ({ recordId, reason = "", dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const store = await readStore(dataRoot);
  const record = store.records.find((item) => item.id === textValue(recordId, 180));
  if (!record) throw new Error("经验记录不存在");
  if (record.status === "revoked") return { revoked: false, record: publicExperienceRecord(record, store) };
  record.status = "revoked";
  record.revokedAt = nowIso();
  record.revokeReason = textValue(reason, 500);
  record.updatedAt = record.revokedAt;
  store.audit.push(auditEvent("record_revoked", { recordId: record.id, reason: record.revokeReason }));
  await persistStore(dataRoot, store);
  return { revoked: true, record: publicExperienceRecord(record, store) };
});

export const restoreExperience = async ({ recordId, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const store = await readStore(dataRoot);
  const record = store.records.find((item) => item.id === textValue(recordId, 180));
  if (!record) throw new Error("经验记录不存在");
  if (record.status !== "revoked") return { restored: false, record: publicExperienceRecord(record, store) };
  record.status = "validated";
  record.updatedAt = nowIso();
  delete record.revokedAt;
  delete record.revokeReason;
  store.audit.push(auditEvent("record_restored", { recordId: record.id }));
  await persistStore(dataRoot, store);
  return { restored: true, record: publicExperienceRecord(record, store) };
});

export const resumeExperienceRecall = async ({ recordId, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const store = await readStore(dataRoot);
  const record = store.records.find((item) => item.id === textValue(recordId, 180));
  if (!record) throw new Error("经验记录不存在");
  if (record.status === "revoked") throw new Error("这条经验已停止使用，请先恢复记录");
  if (!record.usage?.recallSuspended) return { resumed: false, record: publicExperienceRecord(record, store) };
  record.usage = { ...usageRecord(record.usage), recallSuspended: false };
  record.updatedAt = nowIso();
  store.audit.push(auditEvent("recall_resumed", { recordId: record.id }));
  await persistStore(dataRoot, store);
  return { resumed: true, record: publicExperienceRecord(record, store) };
});

export const recordExperienceRecall = async ({ recordIds = [], taskId = "", runId = "", stage = "", matches = [], excluded = [], taskEnvelope = {}, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const ids = new Set(list(recordIds).map((item) => textValue(item, 180)).filter(Boolean));
  const envelope = normalizeTaskEnvelope(taskEnvelope, { taskId, runId: runId || taskId, stage });
  if (!envelope.taskId) return { changed: false, updated: 0, uses: [], trace: null };
  const store = await readStore(dataRoot);
  const now = nowIso();
  const uses = [];
  for (const record of store.records) {
    if (!ids.has(record.id)) continue;
    const useId = `use-${digest(`${record.id}\u0000${envelope.taskId}\u0000${envelope.runId}\u0000${envelope.stage}`)}`;
    let use = store.uses.find((item) => item.id === useId);
    if (!use) {
      const match = list(matches).find((item) => item.recordId === record.id || item.id === record.id) ?? {};
      use = {
        id: useId,
        recordId: record.id,
        taskId: envelope.taskId,
        runId: envelope.runId,
        stage: envelope.stage,
        taskEnvelope: envelope,
        matchScore: Number(match.recallScore) || 0,
        recallReason: textValue(match.recallReason || "经验与当前任务匹配", 500),
        createdAt: now,
      };
      store.uses.push(use);
    }
    const usage = usageRecord(record.usage);
    if (!usage.recentTaskIds.includes(envelope.taskId)) {
      usage.recalledCount += 1;
      usage.recentTaskIds = [...usage.recentTaskIds, envelope.taskId].slice(-MAX_RECALLED_TASK_IDS);
      usage.recalledTaskCount = usage.recentTaskIds.length;
    }
    usage.lastRecalledAt = now;
    record.usage = usage;
    record.updatedAt = now;
    uses.push(use);
  }
  const trace = {
    id: `recall-trace-${digest(`${envelope.taskId}\u0000${envelope.runId}\u0000${envelope.stage}`)}`,
    taskId: envelope.taskId,
    runId: envelope.runId,
    stage: envelope.stage,
    taskEnvelope: envelope,
    selected: uses.map((item) => ({
      useId: item.id,
      recordId: item.recordId,
      matchScore: item.matchScore,
      recallReason: item.recallReason,
    })),
    excluded: list(excluded).map((item) => ({
      recordId: textValue(item?.recordId, 180),
      reason: textValue(item?.reason || "未通过召回门禁", 500),
    })).filter((item) => item.recordId || item.reason).slice(0, 200),
    createdAt: now,
  };
  const traceIndex = store.recallTraces.findIndex((item) => item.id === trace.id);
  if (traceIndex >= 0) store.recallTraces[traceIndex] = trace;
  else store.recallTraces.push(trace);
  store.audit.push(auditEvent("experience_recalled", { traceId: trace.id, useIds: uses.map((item) => item.id), taskId: envelope.taskId, excludedCount: trace.excluded.length }));
  await persistStore(dataRoot, store);
  return { changed: true, updated: uses.length, uses, trace };
});

export const listExperienceRecallTraces = async ({ accountId = "local", limit = 100, dataRoot = appDataRoot() } = {}) => {
  const store = await readStore(dataRoot);
  const normalizedAccountId = textValue(accountId, 160) || "local";
  return list(store.recallTraces)
    .filter((trace) => (trace.taskEnvelope?.accountId || "local") === normalizedAccountId)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)))
    .slice(0, Math.min(500, Math.max(1, Number(limit) || 100)));
};

export const recordExperienceFeedback = async ({ useId = "", recordId = "", taskId = "", outcome = "ignored", dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  if (!EXPERIENCE_FEEDBACK_OUTCOMES.includes(outcome)) throw new Error("未知的经验反馈类型");
  const store = await readStore(dataRoot);
  const use = useId
    ? store.uses.find((item) => item.id === textValue(useId, 180))
    : [...store.uses].reverse().find((item) => item.recordId === textValue(recordId, 180) && item.taskId === textValue(taskId, 180));
  const normalizedRecordId = textValue(use?.recordId || recordId, 180);
  const normalizedTaskId = textValue(use?.taskId || taskId, 180);
  if (!normalizedRecordId || !normalizedTaskId) throw new Error("经验反馈必须绑定具体 useId 或任务使用记录");
  const record = store.records.find((item) => item.id === normalizedRecordId);
  if (!record) throw new Error("经验记录不存在");
  const previous = [...store.feedback].reverse().find((item) => item.recordId === record.id && item.useId === (use?.id || "") && item.taskId === normalizedTaskId);
  if (previous?.outcome === outcome) return { stored: false, duplicate: true, record: publicExperienceRecord(record, store), feedback: previous };
  const feedback = {
    id: `feedback-${randomUUID()}`,
    useId: use?.id || "",
    recordId: record.id,
    taskId: normalizedTaskId,
    outcome,
    at: nowIso(),
    replaces: previous?.id || "",
  };
  store.feedback.push(feedback);
  store.feedback = store.feedback.slice(-MAX_FEEDBACK_EVENTS_PER_RECORD * Math.max(1, store.records.length));
  record.feedback = [...list(record.feedback), feedback].slice(-MAX_FEEDBACK_EVENTS_PER_RECORD);
  const usage = usageRecord(record.usage);
  if (previous?.outcome === "helpful") usage.helpfulCount = Math.max(0, usage.helpfulCount - 1);
  else if (previous?.outcome === "not_applicable") usage.notApplicableCount = Math.max(0, usage.notApplicableCount - 1);
  else if (previous?.outcome === "harmful") usage.harmfulCount = Math.max(0, usage.harmfulCount - 1);
  else if (previous?.outcome === "ignored") usage.ignoredCount = Math.max(0, usage.ignoredCount - 1);
  if (outcome === "helpful") usage.helpfulCount += 1;
  else if (outcome === "not_applicable") usage.notApplicableCount += 1;
  else if (outcome === "harmful") { usage.harmfulCount += 1; usage.recallSuspended = true; }
  else usage.ignoredCount += 1;
  if (previous?.outcome === "harmful" && outcome !== "harmful" && usage.harmfulCount === 0) usage.recallSuspended = false;
  usage.lastOutcomeAt = feedback.at;
  record.usage = usage;
  const eligibility = experiencePromotionEligibility(record);
  if (record.promotion.status !== "skill_draft" && record.promotion.status !== "dismissed") record.promotion.status = eligibility.eligible ? "eligible" : "not_eligible";
    if (eligibility.eligible && ["validated", "active"].includes(record.status)) record.status = "mature";
  record.updatedAt = feedback.at;
  store.audit.push(auditEvent("experience_feedback", { recordId: record.id, useId: feedback.useId, outcome }));
  await persistStore(dataRoot, store);
  return { stored: true, duplicate: false, record: publicExperienceRecord(record, store), feedback };
});

export const updateExperienceClassification = async ({ recordId, facets = null, scope = null, confirmScopeExpansion = false, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const store = await readStore(dataRoot);
  const record = store.records.find((item) => item.id === textValue(recordId, 180));
  if (!record) throw new Error("经验记录不存在");
  const before = { facets: record.facets, scope: record.scope };
  if (facets) record.facets = normalizeExperienceFacets(facets, record.facets);
  if (scope) {
    const nextScope = normalizeExperienceScope(scope, record.scope);
    const priority = { project: 4, series: 3, genre: 2, author: 1 };
    if ((priority[nextScope.level] ?? 0) < (priority[record.scope.level] ?? 0) && confirmScopeExpansion !== true) throw new Error("扩大经验作用域需要作者明确确认");
    record.scope = nextScope;
  }
  record.updatedAt = nowIso();
  store.audit.push(auditEvent("classification_changed", { recordId: record.id, before, after: { facets: record.facets, scope: record.scope } }));
  await persistStore(dataRoot, store);
  return { updated: true, record: publicExperienceRecord(record, store) };
});

const experienceMergeCompatibilityKey = (record) => JSON.stringify({
  accountId: record.accountId,
  kind: record.kind,
  scopeLevel: record.scope?.level,
  scopeId: record.scope?.scopeId,
  deliverableType: record.deliverableType,
  contextDomain: record.contextDomain,
  stages: [...list(record.facets?.stages)].sort(),
  capabilities: [...list(record.facets?.capabilities)].sort(),
});

export const mergeExperienceRecords = async ({ recordIds = [], targetRecordId = "", confirmed = false, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  if (confirmed !== true) throw new Error("合并重复经验需要作者明确确认");
  const store = await readStore(dataRoot);
  const ids = unique(list(recordIds).map((item) => textValue(item, 180))).slice(0, 100);
  if (ids.length < 2) throw new Error("请至少选择两条重复经验");
  const records = ids.map((id) => store.records.find((item) => item.id === id)).filter(Boolean);
  if (records.length !== ids.length) throw new Error("待合并经验包含不存在的记录");
  if (new Set(records.map(experienceMergeCompatibilityKey)).size > 1) throw new Error("经验类型、作用域、阶段或能力不兼容，不能作为重复项合并");
  const target = records.find((item) => item.id === textValue(targetRecordId, 180)) ?? records[0];
  const sources = records.filter((item) => item.id !== target.id);
  if (target.status === "revoked" && !target.mergedInto) throw new Error("已停止使用的经验不能作为合并目标");
  const at = nowIso();
  target.mergedRecordIds = unique([
    ...list(target.mergedRecordIds),
    ...sources.flatMap((item) => [item.id, ...list(item.mergedRecordIds)]),
  ]);
  target.updatedAt = at;
  for (const source of sources) {
    source.statusBeforeMerge = source.status;
    source.status = "revoked";
    source.mergedInto = target.id;
    source.revokedAt = at;
    source.revokeReason = "已由作者确认为重复经验并合并；原记录及版本历史仍保留";
    source.updatedAt = at;
  }
  store.audit.push(auditEvent("records_merged", { targetRecordId: target.id, sourceRecordIds: sources.map((item) => item.id) }));
  await persistStore(dataRoot, store);
  return {
    merged: true,
    target: publicExperienceRecord(target, store),
    sources: sources.map((item) => publicExperienceRecord(item, store)),
  };
});

export const splitExperienceRecord = async ({ recordId = "", versionNumbers = [], restoreRecordIds = [], confirmed = false, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  if (confirmed !== true) throw new Error("拆分误合并经验需要作者明确确认");
  const store = await readStore(dataRoot);
  const source = store.records.find((item) => item.id === textValue(recordId, 180));
  if (!source) throw new Error("经验记录不存在");
  const restoreIds = new Set(list(restoreRecordIds).map((item) => textValue(item, 180)).filter(Boolean));
  const restored = [];
  for (const candidate of store.records) {
    if (candidate.mergedInto !== source.id || (restoreIds.size && !restoreIds.has(candidate.id))) continue;
    candidate.status = EXPERIENCE_RECORD_STATUSES.includes(candidate.statusBeforeMerge) ? candidate.statusBeforeMerge : "active";
    delete candidate.statusBeforeMerge;
    delete candidate.mergedInto;
    delete candidate.revokedAt;
    delete candidate.revokeReason;
    candidate.updatedAt = nowIso();
    restored.push(candidate);
  }
  if (restored.length) {
    const restoredIds = new Set(restored.map((item) => item.id));
    source.mergedRecordIds = list(source.mergedRecordIds).filter((id) => !restoredIds.has(id));
    source.updatedAt = nowIso();
    store.audit.push(auditEvent("records_unmerged", { targetRecordId: source.id, restoredRecordIds: [...restoredIds] }));
    await persistStore(dataRoot, store);
    return { split: true, mode: "unmerge", source: publicExperienceRecord(source, store), records: restored.map((item) => publicExperienceRecord(item, store)) };
  }
  const selectedNumbers = new Set(list(versionNumbers).map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0));
  const selectedVersions = source.versions.filter((item) => selectedNumbers.has(Number(item.version)));
  const remainingVersions = source.versions.filter((item) => !selectedNumbers.has(Number(item.version)));
  if (!selectedVersions.length) throw new Error("请选择需要拆出的历史版本");
  if (!remainingVersions.length) throw new Error("不能把原经验的全部版本拆走；至少保留一个版本");
  const selectedLatest = selectedVersions.at(-1) ?? {};
  const splitRecord = normalizeStoredRecord({
    id: `experience-${randomUUID()}`,
    accountId: source.accountId,
    semanticKey: digest(`${source.semanticKey}\u0000split\u0000${randomUUID()}`),
    kind: selectedLatest.kind || source.kind,
    scope: selectedLatest.scopeProposal || source.scope,
    facets: selectedLatest.facets || source.facets,
    applicability: source.applicability,
    lane: selectedLatest.lane || source.lane,
    deliverableType: selectedLatest.deliverableType || source.deliverableType,
    contextDomain: selectedLatest.contextDomain || source.contextDomain,
    status: "active",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    currentVersion: Number(selectedLatest.version) || selectedVersions.length,
    usage: usageRecord(),
    feedback: [],
    promotion: promotionRecord(),
    versions: selectedVersions.map((item) => ({ ...item, splitFromRecordId: source.id })),
    conflictsWith: [],
  });
  source.versions = remainingVersions;
  source.currentVersion = Math.max(...remainingVersions.map((item) => Number(item.version) || 0));
  source.updatedAt = nowIso();
  store.records.push(splitRecord);
  store.audit.push(auditEvent("record_versions_split", { sourceRecordId: source.id, splitRecordId: splitRecord.id, versionNumbers: [...selectedNumbers] }));
  await persistStore(dataRoot, store);
  return { split: true, mode: "versions", source: publicExperienceRecord(source, store), records: [publicExperienceRecord(splitRecord, store)] };
});

export const createExperienceCluster = async ({ recordIds = [], title = "", confirmed = false, dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  if (confirmed !== true) throw new Error("整理经验簇需要作者明确确认");
  const store = await readStore(dataRoot);
  const ids = unique(list(recordIds).map((item) => textValue(item, 180))).slice(0, 100);
  const records = ids.map((id) => store.records.find((item) => item.id === id)).filter(Boolean);
  if (!records.length || records.length !== ids.length) throw new Error("经验簇包含不存在的记录");
  const compatibilityKey = (record) => JSON.stringify({ kind: record.kind, scope: record.scope?.level, stages: record.facets?.stages, capabilities: record.facets?.capabilities });
  if (new Set(records.map(compatibilityKey)).size > 1) throw new Error("经验类型、阶段、能力或作用域不兼容，不能放入同一 Skill 草稿");
  const cluster = {
    id: `cluster-${randomUUID()}`,
    accountId: records[0].accountId,
    title: textValue(title || records[0].versions.at(-1)?.title || "经验簇", 160),
    recordIds: ids,
    status: "clustered",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  store.clusters.push(cluster);
  for (const record of records) { record.status = "clustered"; record.updatedAt = cluster.updatedAt; }
  store.audit.push(auditEvent("cluster_created", { clusterId: cluster.id, recordIds: ids }));
  await persistStore(dataRoot, store);
  return cluster;
});

export const prepareExperienceSkillDraft = async ({ recordId = "", clusterId = "", dataRoot = appDataRoot() } = {}) => {
  const store = await readStore(dataRoot);
  const cluster = clusterId ? store.clusters.find((item) => item.id === textValue(clusterId, 180)) : null;
  const recordIds = cluster?.recordIds ?? [textValue(recordId, 180)];
  const records = recordIds.map((id) => store.records.find((item) => item.id === id)).filter(Boolean);
  if (!records.length) throw new Error("经验记录或经验簇不存在");
  const eligibility = records.map(experiencePromotionEligibility);
  const reasons = unique(eligibility.flatMap((item) => item.reasons));
  const latest = records.map((record) => record.versions.at(-1) ?? {});
  const kind = records[0].kind;
  const capability = kind === "style_preference" ? "style_reference" : kind === "avoidance" ? "effect_reviewer" : "auxiliary_advisor";
  return {
    eligible: reasons.length === 0,
    reasons,
    records: records.map((record) => publicExperienceRecord(record, store)),
    record: publicExperienceRecord(records[0], store),
    cluster,
    draft: {
      kind,
      capability,
      title: textValue(cluster?.title || latest[0].title, 160),
      observation: latest.map((item) => item.observation).filter(Boolean).join("\n"),
      recommendation: latest.map((item) => item.recommendation).filter(Boolean).join("\n"),
      conditions: unique(latest.flatMap((item) => list(item.conditions))),
      exclusions: unique(latest.flatMap((item) => list(item.exclusions))),
      topics: unique(records.flatMap((item) => list(item.facets?.topics))),
      stages: unique(records.flatMap((item) => list(item.facets?.stages))),
      triggerKeywords: unique(records.flatMap((item) => list(item.facets?.topics))).slice(0, 12),
      triggerConditions: unique(latest.flatMap((item) => list(item.conditions))).slice(0, 12),
      workspaceModes: records.every((item) => ["project", "series"].includes(item.scope.level)) ? ["project"] : ["general"],
      deliverableType: records[0].deliverableType,
      contextDomain: records[0].contextDomain,
      sourceRecordIds: records.map((item) => item.id),
    },
  };
};

export const markExperiencePromoted = async ({ recordId = "", recordIds = [], clusterId = "", skillId = "", skillVersion = "1.0.0", dataRoot = appDataRoot() } = {}) => enqueueWrite(dataRoot, async () => {
  const store = await readStore(dataRoot);
  const cluster = clusterId ? store.clusters.find((item) => item.id === textValue(clusterId, 180)) : null;
  const ids = unique([...(cluster?.recordIds ?? []), ...list(recordIds), recordId].map((item) => textValue(item, 180))).filter(Boolean);
  const records = ids.map((id) => store.records.find((item) => item.id === id)).filter(Boolean);
  if (!records.length || records.length !== ids.length) throw new Error("经验记录不存在");
  const ineligible = records.flatMap((record) => experiencePromotionEligibility(record).reasons);
  if (ineligible.length && !records.every((record) => record.promotion.status === "skill_draft")) throw new Error(unique(ineligible).join("；") || "经验尚不具备整理条件");
  const normalizedSkillId = textValue(skillId, 180);
  if (!normalizedSkillId) throw new Error("缺少 Skill 标识");
  const promotion = {
    id: `promotion-${randomUUID()}`,
    clusterId: cluster?.id || "",
    recordIds: ids,
    skillId: normalizedSkillId,
    skillVersion: textValue(skillVersion, 80) || "1.0.0",
    status: "skill_draft",
    createdAt: nowIso(),
  };
  store.promotions.push(promotion);
  for (const record of records) {
    record.promotion = promotionRecord({ ...promotion, promotionId: promotion.id });
    record.updatedAt = promotion.createdAt;
  }
  if (cluster) { cluster.status = "skill_draft"; cluster.updatedAt = promotion.createdAt; }
  store.audit.push(auditEvent("skill_draft_created", { promotionId: promotion.id, skillId: normalizedSkillId, recordIds: ids }));
  await persistStore(dataRoot, store);
  return { promoted: true, status: "skill_draft", promotion, records: records.map((record) => publicExperienceRecord(record, store)), record: publicExperienceRecord(records[0], store) };
});

export const inspectExperienceStore = async ({ dataRoot = appDataRoot() } = {}) => readStore(dataRoot);

export const inspectExperienceIndexes = async ({ dataRoot = appDataRoot() } = {}) => {
  const store = await readStore(dataRoot);
  rememberIndexes(dataRoot, store);
  const indexes = indexCache.get(resolve(dataRoot || appDataRoot()));
  return Object.fromEntries(Object.entries(indexes).map(([key, value]) => [key, value instanceof Map ? Object.fromEntries(value) : value]));
};
