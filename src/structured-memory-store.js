import { memoryProjectionDecision } from "./memory-projection-policy.js";
import { memoryRecordFactualAssertion, retainVerifiedMemoryUpdateFacts } from "./memory-evidence.js";
import { normalizeLedgerEntries, stableLedgerEntryId } from "./information-ledger.js";
import { mergeStateEntries, normalizeStateEntries } from "./memory-compiler.js";
import { validateTaskContractForExecution } from "./task-contract.js";

export const MEMORY_STORE_SCHEMA_VERSION = 1;
export const MEMORY_STORE_PROJECTION_HASH_VERSION = 2;

const text = (value = "", max = 2_000) => String(value ?? "").trim().slice(0, max);
const clone = (value) => structuredClone(value);
const unique = (values) => [...new Set(values.filter(Boolean))];
const isObject = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));

const hashText = (value = "") => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};

export const memoryStoreSourceRevision = ({ documentId = "", content = "", revision = "" } = {}) => (
  text(revision, 160) || `rev-${hashText(`${text(documentId, 160)}\u0000${String(content ?? "")}`)}`
);

export const memoryStoreContentHash = (content = "") => hashText(String(content ?? ""));

export const emptyMemoryStore = () => ({
  schemaVersion: MEMORY_STORE_SCHEMA_VERSION,
  unitDeltas: {},
  currentStates: {},
  informationEntities: {},
  foreshadowing: {},
  evidenceIndex: {},
  revisions: {},
  pendingCandidates: [],
  conflicts: [],
  migrations: { pending: [], completed: [] },
});

const normalizeSource = (source = {}) => ({
  documentId: text(source.documentId, 160),
  revision: text(source.revision, 160),
  quote: text(source.quote, 1_200),
  claim: text(source.claim, 1_200),
});

const normalizeRecord = (record = {}, fallbackId = "") => ({
  id: text(record.id || fallbackId, 160),
  name: text(record.name, 180),
  detail: text(record.detail, 2_000),
  currentValue: text(record.currentValue || record.state, 800),
  state: text(record.state, 160),
  chapter: text(record.chapter, 180),
  status: text(record.status || "active", 80) || "active",
  allowedWriting: text(record.allowedWriting, 600),
  firstAppearance: isObject(record.firstAppearance) ? clone(record.firstAppearance) : null,
  release: isObject(record.release) ? clone(record.release) : null,
  readerKnowledge: isObject(record.readerKnowledge) ? clone(record.readerKnowledge) : null,
  source: normalizeSource(record.source),
  updatedAt: text(record.updatedAt, 80),
});

// Older builds could parse the built-in empty information-ledger placeholder
// as a real legacy record. Keep that synthetic record out of the authoritative
// store when loading either an old persisted state or a legacy document.
const legacyPlaceholderInformationRecord = (record = {}) => (
  text(record.status, 80) === "legacy"
  && text(record.name, 180) === "信息账本"
  && text(record.detail, 2_000)
    .replace(/(?:<!--|&lt;!--)\s*memory-store-schema:\s*\d+\s*(?:-->|--&gt;)/giu, "")
    .trim() === "当前没有已通过正文证据验收的记录。"
  && !text(record.source?.documentId, 160)
  && !text(record.source?.revision, 160)
);

const normalizeMap = (value, normalize) => Object.fromEntries(
  Object.entries(isObject(value) ? value : {})
    .map(([id, record]) => [text(id, 160), normalize(record, id)])
    .filter(([id, record]) => id && record.id),
);

export const normalizeMemoryStore = (value = null) => {
  const base = emptyMemoryStore();
  const source = isObject(value) ? value : {};
  const result = {
    ...base,
    ...clone(source),
    schemaVersion: MEMORY_STORE_SCHEMA_VERSION,
    unitDeltas: isObject(source.unitDeltas) ? clone(source.unitDeltas) : {},
    currentStates: {},
    informationEntities: Object.fromEntries(
      Object.entries(normalizeMap(source.informationEntities, normalizeRecord))
        .filter(([, record]) => !legacyPlaceholderInformationRecord(record)),
    ),
    foreshadowing: normalizeMap(source.foreshadowing, normalizeRecord),
    evidenceIndex: isObject(source.evidenceIndex) ? clone(source.evidenceIndex) : {},
    revisions: isObject(source.revisions) ? clone(source.revisions) : {},
    pendingCandidates: Array.isArray(source.pendingCandidates) ? clone(source.pendingCandidates).slice(-200) : [],
    conflicts: Array.isArray(source.conflicts) ? clone(source.conflicts).slice(-200) : [],
    migrations: {
      pending: Array.isArray(source.migrations?.pending) ? clone(source.migrations.pending) : [],
      completed: Array.isArray(source.migrations?.completed) ? clone(source.migrations.completed) : [],
    },
  };
  for (const [domain, entries] of Object.entries(isObject(source.currentStates) ? source.currentStates : {})) {
    const normalizedEntries = isObject(entries) ? entries : {};
    result.currentStates[text(domain, 80) || "novel"] = normalizeMap(normalizedEntries, normalizeRecord);
  }
  return result;
};

const plainText = (value = "") => String(value ?? "")
  .replace(/<br\s*\/?\s*>/giu, "\n")
  .replace(/<\/(?:h[1-6]|p|div|li)>/giu, "\n")
  .replace(/<[^>]+>/gu, " ")
  .replace(/\r\n?/gu, "\n")
  .replace(/[ \t]+/gu, " ")
  .trim();

const legacySections = (documentState = {}) => {
  const markdown = String(documentState.markdown ?? "").trim();
  const source = markdown || plainText(String(documentState.html ?? "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu, (_match, level, heading) => `\n${"#".repeat(Number(level))} ${plainText(heading)}\n`)
    .replace(/<\/(?:p|div|li|blockquote)>/giu, "\n"));
  const lines = source.split("\n").map((line) => line.trim()).filter(Boolean);
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^(?:#+\s*(?:\[([A-Z]+):([^\]]+)\]\s*)?(.*)|\[([A-Z]+):([^\]]+)\]\s*(.*))$/u);
    if (heading) {
      if (current) sections.push(current);
      current = {
        marker: heading[1] || heading[4] || "",
        id: heading[2] || heading[5] || "",
        name: text(heading[3] || heading[6], 180),
        lines: [],
      };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push(current);
  return sections;
};

const legacyRecord = (section, kind) => {
  const fields = Object.fromEntries(section.lines.map((line) => {
    const match = line.match(/^(?:[-*]\s*)?(?:状态|当前状态|章节|内容|依据与细节|允许写法|最后更新)\s*[：:]\s*(.*)$/u);
    return match ? [match[0].split(/[：:]/u)[0].replace(/^[-*]\s*/u, ""), text(match[1])] : ["", ""];
  }).filter(([key]) => key));
  const detail = fields["内容"] || fields["依据与细节"] || section.lines.filter((line) => !/^(?:[-*]\s*)?(?:状态|当前状态|章节|内容|依据与细节|允许写法|最后更新)\s*[：:]/u.test(line)).join(" ");
  const id = stableLedgerEntryId({ id: section.id, name: section.name || detail, kind });
  return normalizeRecord({
    id,
    name: section.name || detail,
    detail,
    state: fields["状态"] || fields["当前状态"],
    currentValue: fields["状态"] || fields["当前状态"],
    chapter: fields["章节"],
    allowedWriting: fields["允许写法"],
    status: "legacy",
  }, id);
};

const legacySectionIsDocumentHeading = (section = {}, documentState = {}) => (
  !section.marker
  && section.lines.length === 0
  && text(section.name, 180) === text(documentState?.title, 180)
);

const legacyDocumentIsEmptyInformationProjection = (documentId = "", source = "") => (
  String(documentId).endsWith("information-ledger")
  && (() => {
    const value = String(source)
      .replace(/信息账本/gu, "")
      .replace(/\s+/gu, " ")
      .replace(/\s*([：:])\s*/gu, "$1")
      .trim();
    if (value === "当前没有已通过正文证据验收的记录。" || value === "当前没有已通过正文证据验收的记录.") return true;
    return /稳定 ID：information-e5tskz/u.test(value)
      && /当前事实：(?:<!--|&lt;!--)?\s*memory-store-schema:\s*\d+\s*(?:-->|--&gt;)?\s*当前没有已通过正文证据验收的记录/u.test(value)
      && /状态：legacy/u.test(value)
      && /证据：待确认/u.test(value)
      && /最后更新：待确认/u.test(value);
  })()
);

export const isEmptyMemoryProjectionPlaceholder = ({ documentId = "", content = "", markdown = "", html = "" } = {}) => (
  legacyDocumentIsEmptyInformationProjection(documentId, plainText(String(markdown || html || content || "")))
);

export const memoryStoreFromLegacyDocuments = ({ documents = {} } = {}) => {
  const store = emptyMemoryStore();
  for (const [documentId, documentState] of Object.entries(documents || {})) {
    const source = plainText(documentState?.markdown ?? documentState?.html ?? "");
    if (/^(?:chapter-\d+|script-episode-\d+)$/u.test(documentId) && documentState?.continuityDelta) {
      const delta = documentState.continuityDelta;
      store.unitDeltas[documentId] = {
        ...clone(delta),
        source: { documentId, revision: text(delta.sourceHash || delta.source || "legacy"), quote: text(delta.summary, 1_200) },
        status: "legacy",
      };
    }
    if (!/^memory-|^script-memory-/.test(documentId)) continue;
    // The built-in empty ledger, and its old HTML projection shape, are not
    // author-authored legacy memory. Do not turn that placeholder into a
    // synthetic "信息账本" record during compatibility migration.
    if (legacyDocumentIsEmptyInformationProjection(documentId, source)) {
      continue;
    }
    const domain = documentId.startsWith("script-") ? "script" : "novel";
    const sections = legacySections(documentState).filter((section) => !legacySectionIsDocumentHeading(section, documentState));
    if (documentId.endsWith("snapshot")) {
      const entries = sections.filter((section) => section.marker === "STATE" || section.name).map((section) => legacyRecord(section, "state"));
      store.currentStates[domain] ??= {};
      for (const entry of entries) store.currentStates[domain][entry.id] = entry;
    } else if (documentId.endsWith("foreshadowing")) {
      for (const section of sections) {
        const entry = legacyRecord(section, "foreshadow");
        store.foreshadowing[entry.id] = entry;
      }
    } else {
      for (const section of sections) {
        const entry = legacyRecord(section, "information");
        const existing = store.informationEntities[entry.id] || normalizeRecord({ id: entry.id }, entry.id);
        store.informationEntities[entry.id] = {
          ...existing,
          ...entry,
          name: entry.name || existing.name,
          detail: existing.detail || entry.detail,
          currentValue: entry.currentValue || existing.currentValue,
          state: entry.state || existing.state,
          chapter: existing.chapter || entry.chapter,
          allowedWriting: entry.allowedWriting || existing.allowedWriting,
          firstAppearance: documentId.endsWith("first-appearance") ? entry : existing.firstAppearance,
          release: documentId.endsWith("release") ? entry : existing.release,
          readerKnowledge: documentId.endsWith("reader") || documentId.endsWith("audience") ? entry : existing.readerKnowledge,
          source: entry.source?.documentId || entry.source?.quote ? entry.source : existing.source,
        };
      }
    }
    if (source && !documentState.memoryStoreProjectionHash) {
      store.migrations.pending.push({ documentId, reason: "legacy_memory_document", sourceHash: memoryStoreContentHash(source) });
    }
  }
  return store;
};

export const buildMemoryMigrationPreview = ({ documents = {} } = {}) => {
  const store = memoryStoreFromLegacyDocuments({ documents });
  const candidates = [];
  for (const migration of store.migrations.pending) {
    const documentState = documents[migration.documentId] || {};
    const source = plainText(documentState.markdown ?? documentState.html ?? "");
    const records = migration.documentId.endsWith("snapshot")
      ? Object.values(store.currentStates.novel || {}).concat(Object.values(store.currentStates.script || {}))
      : migration.documentId.endsWith("foreshadowing")
        ? Object.values(store.foreshadowing)
        : Object.values(store.informationEntities);
    candidates.push({
      documentId: migration.documentId,
      sourceHash: migration.sourceHash,
      status: "pending_confirmation",
      sourcePreview: source.slice(0, 1_200),
      records: records.filter((record) => record.source?.documentId !== migration.documentId || record.status === "legacy").map(clone),
    });
  }
  return { schemaVersion: MEMORY_STORE_SCHEMA_VERSION, status: candidates.length ? "pending_confirmation" : "clean", candidates };
};

export const ensureMemoryStore = ({ store = null, documents = {} } = {}) => {
  const normalized = normalizeMemoryStore(store);
  const hasStructuredData = Object.keys(normalized.informationEntities).length
    || Object.keys(normalized.foreshadowing).length
    || Object.keys(normalized.unitDeltas).length
    || Object.values(normalized.currentStates).some((entries) => Object.keys(entries || {}).length)
    || Object.keys(normalized.evidenceIndex).length;
  if (hasStructuredData || !documents || typeof documents !== "object") return normalized;
  const legacy = memoryStoreFromLegacyDocuments({ documents });
  return normalizeMemoryStore({
    ...normalized,
    ...legacy,
    migrations: legacy.migrations,
  });
};

const deliverableKindFor = ({ documentId, taskContract, deliverableKind = "" } = {}) => {
  const deliverable = Array.isArray(taskContract?.deliverables)
    ? taskContract.deliverables.find((item) => text(item?.targetDocumentId || item?.targetDocument) === text(documentId))
    : null;
  return text(deliverableKind || deliverable?.kind || (String(documentId).startsWith("script-") ? "script" : "prose"), 80);
};

export const memoryCandidateGate = ({
  documentId = "",
  content = "",
  memoryUpdate = null,
  taskContract = null,
  deliverableKind = "",
  sourceAccepted = false,
} = {}) => {
  if (!String(documentId).trim() || !String(content ?? "").trim()) return { eligible: false, reason: "source_empty" };
  if (!sourceAccepted) return { eligible: false, reason: "source_not_readback_accepted" };
  const decision = memoryProjectionDecision({
    documentId,
    moduleId: "manuscript",
    contextDomain: String(documentId).startsWith("script-") ? "script" : "novel",
    deliverableKind: deliverableKindFor({ documentId, taskContract, deliverableKind }),
    taskContract,
  });
  if (!decision.eligible || decision.compatibilityMode) return { eligible: false, reason: decision.compatibilityMode ? "task_contract_required" : decision.reason, decision };
  if (!memoryUpdate || memoryUpdate.evidenceVerified !== true) return { eligible: false, reason: "candidate_not_verified", decision };
  return { eligible: true, reason: "formal_prose_readback_verified", decision };
};

const evidenceFor = (entry, evidence = [], fallback = "") => {
  const assertion = memoryRecordFactualAssertion(entry);
  return evidence.find((item) => text(item?.claim, 1_200) === assertion)
    || evidence.find((item) => text(item?.claim, 1_200) === text(entry?.detail, 1_200))
    || evidence.find((item) => text(item?.quote, 1_200) === text(entry?.detail, 1_200))
    || evidence.find((item) => item?.quote)
    || (fallback ? { claim: assertion, quote: fallback } : null);
};

const sourceFor = ({ documentId, revision, entry, evidence, fallback }) => {
  const item = evidenceFor(entry, evidence, fallback);
  return normalizeSource({ documentId, revision, claim: item?.claim || memoryRecordFactualAssertion(entry), quote: item?.quote || fallback });
};

const mergeInformationEntity = ({ existing = null, entry, bucket, source, updatedAt }) => {
  const id = stableLedgerEntryId({ id: entry.id, name: entry.name || entry.detail, kind: "information" });
  const base = existing || normalizeRecord({ id, name: entry.name }, id);
  const next = {
    ...base,
    id,
    name: text(entry.name || base.name, 180) || base.name,
    detail: text(entry.detail || base.detail, 2_000) || base.detail,
    currentValue: text(entry.currentValue || entry.state || base.currentValue, 800) || base.currentValue,
    state: text(entry.state || base.state, 160) || base.state,
    chapter: text(entry.chapter || base.chapter, 180) || base.chapter,
    allowedWriting: text(entry.allowedWriting || base.allowedWriting, 600) || base.allowedWriting,
    [bucket]: {
      ...(isObject(base[bucket]) ? base[bucket] : {}),
      ...clone(entry),
      source,
      updatedAt,
    },
    source,
    updatedAt,
    status: "active",
  };
  return normalizeRecord(next, id);
};

export const mergeMemoryCandidate = ({
  store = null,
  documentId = "",
  content = "",
  memoryUpdate = null,
  taskContract = null,
  deliverableKind = "",
  sourceAccepted = false,
  revision = "",
  updatedAt = new Date().toISOString(),
} = {}) => {
  const gate = memoryCandidateGate({ documentId, content, memoryUpdate, taskContract, deliverableKind, sourceAccepted });
  if (!gate.eligible) return { ok: false, reason: gate.reason, gate, store: normalizeMemoryStore(store) };
  const sourceRevision = memoryStoreSourceRevision({ documentId, content, revision });
  const normalized = retainVerifiedMemoryUpdateFacts({ memoryUpdate, candidate: content });
  if (!normalized.ok) return { ok: false, reason: normalized.reason || "candidate_evidence_failed", gate, store: normalizeMemoryStore(store) };
  const update = normalized.memoryUpdate;
  const next = normalizeMemoryStore(store);
  const revisionId = `${documentId}:${sourceRevision}`;
  if (next.revisions[revisionId]?.status === "active") return { ok: true, changed: false, reason: "idempotent_revision", gate, store: next, revision: sourceRevision, unitDelta: next.unitDeltas[documentId] };
  for (const [key, item] of Object.entries(next.revisions)) {
    if (item?.documentId === documentId && item.status === "active") next.revisions[key] = { ...item, status: "superseded" };
  }
  const evidence = Array.isArray(update.evidence) ? update.evidence : [];
  for (const item of evidence) {
    const quote = text(item?.quote, 1_200);
    if (!quote) continue;
    const evidenceId = `evidence-${hashText(`${documentId}\u0000${sourceRevision}\u0000${quote}`)}`;
    next.evidenceIndex[evidenceId] = {
      id: evidenceId,
      documentId,
      revision: sourceRevision,
      claim: text(item.claim, 1_200),
      quote,
      status: "valid",
      recordedAt: updatedAt,
    };
  }
  const source = { documentId, revision: sourceRevision, quote: text(evidence[0]?.quote || update.chapterSummary, 1_200), claim: text(evidence[0]?.claim || update.chapterSummary, 1_200) };
  const stateChanges = normalizeStateEntries(update.stateChanges);
  const domain = String(documentId).startsWith("script-") ? "script" : "novel";
  next.currentStates[domain] ??= {};
  const stateWithSources = stateChanges.map((entry) => ({ ...entry, source: sourceFor({ documentId, revision: sourceRevision, entry, evidence, fallback: update.chapterSummary }), updatedAt }));
  const mergedStates = mergeStateEntries({ current: Object.values(next.currentStates[domain]), changes: stateWithSources });
  next.currentStates[domain] = Object.fromEntries(mergedStates.map((entry) => {
    const incoming = stateWithSources.find((item) => item.id === entry.id || item.name === entry.name);
    const previous = next.currentStates[domain][entry.id];
    return [entry.id, normalizeRecord({ ...previous, ...entry, ...(incoming || {}), currentValue: entry.state }, entry.id)];
  }));
  for (const [field, bucket] of [["firstAppearances", "firstAppearance"], ["informationRelease", "release"], ["readerKnowledge", "readerKnowledge"]]) {
    for (const raw of normalizeLedgerEntries(update[field], { kind: "information" })) {
      const entry = { ...raw, id: stableLedgerEntryId({ id: raw.id, name: raw.name, kind: "information" }) };
      next.informationEntities[entry.id] = mergeInformationEntity({
        existing: next.informationEntities[entry.id],
        entry,
        bucket,
        source: sourceFor({ documentId, revision: sourceRevision, entry, evidence, fallback: update.chapterSummary }),
        updatedAt,
      });
    }
  }
  for (const raw of normalizeLedgerEntries(update.foreshadowing, { kind: "foreshadow" })) {
    const entry = { ...raw, id: stableLedgerEntryId({ id: raw.id, name: raw.name, kind: "foreshadow" }) };
    next.foreshadowing[entry.id] = normalizeRecord({
      ...next.foreshadowing[entry.id],
      ...entry,
      source: sourceFor({ documentId, revision: sourceRevision, entry, evidence, fallback: update.chapterSummary }),
      updatedAt,
      status: "active",
    }, entry.id);
  }
  const unitDelta = {
    summary: text(update.chapterSummary, 1_200),
    nextCarryover: unique((Array.isArray(update.nextContext) ? update.nextContext : []).map((item) => text(item, 1_200))).slice(0, 8),
    source: { documentId, revision: sourceRevision, quote: text(update.chapterSummary || evidence[0]?.quote, 1_200) },
    evidence: clone(evidence).slice(0, 64),
    evidenceVerified: true,
    status: "current",
    updatedAt,
  };
  next.unitDeltas[documentId] = unitDelta;
  next.revisions[revisionId] = {
    id: revisionId,
    documentId,
    revision: sourceRevision,
    status: "active",
    sourceHash: memoryStoreContentHash(content),
    evidenceIds: Object.keys(next.evidenceIndex).filter((id) => next.evidenceIndex[id]?.documentId === documentId && next.evidenceIndex[id]?.revision === sourceRevision),
    updatedAt,
  };
  next.pendingCandidates = next.pendingCandidates.filter((item) => !(item?.documentId === documentId && item?.sourceRevision === sourceRevision));
  return {
    ok: true,
    changed: true,
    reason: "merged",
    gate,
    store: next,
    revision: sourceRevision,
    unitDelta,
    normalizedUpdate: update,
  };
};

const FORMAL_MEMORY_DELIVERY_FIELDS = Object.freeze({
  "memory-foreshadowing": "foreshadowing",
  "script-memory-foreshadowing": "foreshadowing",
  "memory-release": "informationRelease",
  "script-memory-release": "informationRelease",
});

const MEMORY_UPDATE_RECORD_FIELDS = Object.freeze([
  "stateChanges",
  "foreshadowing",
  "firstAppearances",
  "informationRelease",
  "readerKnowledge",
]);

const formalMemoryDeliveryFallback = ({ documentId = "", content = "", field = "" } = {}) => {
  const detail = text(String(content).replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " "), 1_200);
  if (!detail) return null;
  const foreshadowing = field === "foreshadowing";
  const name = foreshadowing ? "创作任务确认的伏笔规划" : "创作任务确认的信息释放规划";
  const entry = {
    id: foreshadowing ? "formal-foreshadowing-plan" : "formal-information-release-plan",
    name,
    detail,
    state: foreshadowing ? "planned" : "scheduled",
    allowedWriting: foreshadowing ? "按后续正文证据更新埋设与回收状态" : "按后续正文证据更新实际释放阶段",
  };
  return {
    stateChanges: [],
    foreshadowing: [],
    firstAppearances: [],
    informationRelease: [],
    readerKnowledge: [],
    [field]: [entry],
    evidence: [{ claim: detail, quote: detail }],
    evidenceVerified: true,
    sourceType: "formal_task_contract",
    targetDocumentId: documentId,
  };
};

export const normalizeFormalMemoryDelivery = ({
  documentId = "",
  content = "",
  memoryUpdate = null,
  taskContract = null,
} = {}) => {
  const id = text(documentId, 160);
  const field = FORMAL_MEMORY_DELIVERY_FIELDS[id] || "";
  if (!field) return { ok: false, reason: "unsupported_memory_delivery_target" };
  if (!String(content ?? "").trim()) return { ok: false, reason: "memory_delivery_empty" };
  const contract = validateTaskContractForExecution(taskContract);
  if (!contract.authoritative || !contract.valid || contract.persistence !== "commit") {
    return { ok: false, reason: "memory_delivery_requires_commit_contract" };
  }
  const deliverable = contract.deliverables.find((item) => text(item?.targetDocumentId || item?.targetDocument, 160) === id);
  if (!deliverable || text(deliverable.kind, 80).toLowerCase() !== "memory"
    || text(deliverable.target?.moduleId, 80).toLowerCase() !== "memory") {
    return { ok: false, reason: "memory_delivery_contract_target_mismatch" };
  }

  const supplied = isObject(memoryUpdate) ? memoryUpdate : null;
  const unexpectedField = supplied && MEMORY_UPDATE_RECORD_FIELDS.find((candidate) => (
    candidate !== field && Array.isArray(supplied[candidate]) && supplied[candidate].length > 0
  ));
  if (unexpectedField
    || (supplied && text(supplied.chapterSummary, 1_200))
    || (supplied && Array.isArray(supplied.nextContext) && supplied.nextContext.length)
    || (supplied && Array.isArray(supplied.pendingCanon) && supplied.pendingCanon.length)) {
    return { ok: false, reason: "memory_delivery_cross_target_update" };
  }

  const kind = field === "foreshadowing" ? "foreshadow" : "information";
  const entries = normalizeLedgerEntries(supplied?.[field], { kind });
  const fallback = entries.length ? null : formalMemoryDeliveryFallback({ documentId: id, content, field });
  const normalizedEntries = entries.length ? entries : fallback?.[field] ?? [];
  if (!normalizedEntries.length) return { ok: false, reason: "memory_delivery_has_no_records" };
  const evidence = Array.isArray(supplied?.evidence) && supplied.evidence.length
    ? supplied.evidence
    : normalizedEntries.map((entry) => {
        const assertion = memoryRecordFactualAssertion(entry);
        return { claim: assertion, quote: assertion };
      }).filter((item) => item.claim);
  const candidateUpdate = fallback || {
    stateChanges: [],
    foreshadowing: [],
    firstAppearances: [],
    informationRelease: [],
    readerKnowledge: [],
    [field]: normalizedEntries,
    evidence,
    evidenceVerified: true,
    sourceType: "formal_task_contract",
    targetDocumentId: id,
  };
  const verified = retainVerifiedMemoryUpdateFacts({ memoryUpdate: candidateUpdate, candidate: content });
  if (!verified.ok) return { ok: false, reason: verified.reason || "memory_delivery_evidence_failed" };
  if ((verified.memoryUpdate?.[field] ?? []).length !== normalizedEntries.length) {
    return { ok: false, reason: "memory_delivery_evidence_incomplete" };
  }
  return {
    ok: true,
    reason: fallback ? "normalized_plain_memory_delivery" : "validated_structured_memory_delivery",
    field,
    deliverable,
    memoryUpdate: { ...verified.memoryUpdate, evidenceVerified: true, sourceType: "formal_task_contract", targetDocumentId: id },
  };
};

export const mergeFormalMemoryDelivery = ({
  store = null,
  documentId = "",
  content = "",
  memoryUpdate = null,
  taskContract = null,
  revision = "",
  updatedAt = new Date().toISOString(),
} = {}) => {
  const normalized = normalizeFormalMemoryDelivery({ documentId, content, memoryUpdate, taskContract });
  if (!normalized.ok) return { ...normalized, changed: false, store: normalizeMemoryStore(store) };
  const sourceRevision = memoryStoreSourceRevision({ documentId, content, revision });
  const revisionId = `formal-memory:${documentId}:${sourceRevision}`;
  const next = normalizeMemoryStore(store);
  if (next.revisions[revisionId]?.status === "active") {
    return { ...normalized, changed: false, reason: "idempotent_revision", store: next, revision: sourceRevision };
  }
  for (const [key, item] of Object.entries(next.revisions)) {
    if (item?.documentId === documentId && item?.sourceType === "formal_task_contract" && item.status === "active") {
      next.revisions[key] = { ...item, status: "superseded" };
    }
  }
  const update = normalized.memoryUpdate;
  const evidence = Array.isArray(update.evidence) ? update.evidence : [];
  for (const item of evidence) {
    const quote = text(item?.quote, 1_200);
    if (!quote) continue;
    const evidenceId = `evidence-${hashText(`formal-memory\u0000${documentId}\u0000${sourceRevision}\u0000${quote}`)}`;
    next.evidenceIndex[evidenceId] = {
      id: evidenceId,
      documentId,
      revision: sourceRevision,
      claim: text(item.claim, 1_200),
      quote,
      sourceType: "formal_task_contract",
      status: "valid",
      recordedAt: updatedAt,
    };
  }
  if (normalized.field === "foreshadowing") {
    for (const raw of normalizeLedgerEntries(update.foreshadowing, { kind: "foreshadow" })) {
      const entry = { ...raw, id: stableLedgerEntryId({ id: raw.id, name: raw.name, kind: "foreshadow" }) };
      next.foreshadowing[entry.id] = normalizeRecord({
        ...next.foreshadowing[entry.id],
        ...entry,
        source: sourceFor({ documentId, revision: sourceRevision, entry, evidence, fallback: entry.detail }),
        updatedAt,
        status: "active",
      }, entry.id);
    }
  } else {
    for (const raw of normalizeLedgerEntries(update.informationRelease, { kind: "information" })) {
      const entry = { ...raw, id: stableLedgerEntryId({ id: raw.id, name: raw.name, kind: "information" }) };
      next.informationEntities[entry.id] = mergeInformationEntity({
        existing: next.informationEntities[entry.id],
        entry,
        bucket: "release",
        source: sourceFor({ documentId, revision: sourceRevision, entry, evidence, fallback: entry.detail }),
        updatedAt,
      });
    }
  }
  next.revisions[revisionId] = {
    id: revisionId,
    documentId,
    revision: sourceRevision,
    sourceType: "formal_task_contract",
    status: "active",
    sourceHash: memoryStoreContentHash(content),
    evidenceIds: Object.keys(next.evidenceIndex).filter((id) => next.evidenceIndex[id]?.documentId === documentId
      && next.evidenceIndex[id]?.revision === sourceRevision),
    updatedAt,
  };
  return {
    ...normalized,
    changed: true,
    reason: "formal_memory_delivery_merged",
    store: next,
    revision: sourceRevision,
  };
};

export const markMemorySourceStale = ({ store = null, documentId = "", currentRevision = "" } = {}) => {
  const next = normalizeMemoryStore(store);
  for (const [id, revision] of Object.entries(next.revisions)) {
    if (revision?.documentId !== documentId || revision.revision === currentRevision) continue;
    next.revisions[id] = { ...revision, status: "evidence_invalid" };
  }
  if (next.unitDeltas[documentId]) next.unitDeltas[documentId] = { ...next.unitDeltas[documentId], status: "evidence_invalid" };
  for (const [id, evidence] of Object.entries(next.evidenceIndex)) {
    if (evidence?.documentId === documentId && evidence.revision !== currentRevision) next.evidenceIndex[id] = { ...evidence, status: "invalid" };
  }
  return next;
};

const escapeHtml = (value = "") => String(value ?? "")
  .replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");

const displaySource = (record = {}) => record.source?.documentId
  ? `${record.source.documentId} · ${record.source.revision || "版本待确认"}`
  : "来源待确认";

const projectionFieldValue = (value = "", max = 2_000) => String(value ?? "")
  .replace(/\r\n?/gu, "\n")
  .replace(/[\t \u00a0]+/gu, " ")
  .replace(/\n+/gu, " ")
  .trim()
  .slice(0, max);

const recordMarkdown = (record = {}, { information = false } = {}) => {
  const id = projectionFieldValue(record.id, 160);
  const name = projectionFieldValue(record.name, 180) || "未命名信息";
  const state = projectionFieldValue(record.state || record.currentValue, 800);
  const chapter = projectionFieldValue(record.chapter, 180);
  const sourceDocumentId = projectionFieldValue(record.source?.documentId, 160) || "待确认";
  const sourceRevision = projectionFieldValue(record.source?.revision, 160) || "待确认";
  const detail = projectionFieldValue(record.detail, 2_000);
  const allowedWriting = projectionFieldValue(record.allowedWriting, 600);
  const quote = projectionFieldValue(record.source?.quote, 1_200);
  const status = projectionFieldValue(record.status, 80);
  const updatedAt = projectionFieldValue(record.updatedAt || record.source?.revision || "待确认", 80);
  const lines = [
    `## ${name}`,
    `<!-- memory-id: ${id} -->`,
    `- 稳定 ID：${id}`,
    state ? `- 当前阶段：${state}` : "",
    chapter ? `- 来源章节：${chapter}` : "",
    `- 来源正文：${sourceDocumentId}`,
    `- 来源 revision：${sourceRevision}`,
    detail ? `- 当前事实：${detail}` : "",
    allowedWriting ? `- 后续允许：${allowedWriting}` : "",
    information && status ? `- 状态：${status}` : "",
    quote ? `- 证据：${quote}` : "- 证据：待确认",
    `- 最后更新：${updatedAt}`,
  ];
  return lines.filter(Boolean).join("\n");
};

export const isStructuredMemoryDocumentId = (documentId = "") => /^(?:memory-(?:snapshot|foreshadowing|information-ledger|first-appearance|release|reader)|script-memory-(?:snapshot|foreshadowing|information-ledger|first-appearance|release|audience))$/u.test(String(documentId));

const memoryProjectionTitle = (documentId = "") => {
  const id = String(documentId || "");
  return id.endsWith("snapshot") ? "状态快照"
    : id.endsWith("foreshadowing") ? "伏笔管理"
      : id.endsWith("information-ledger") ? "信息账本"
      : id.endsWith("first-appearance") ? "重要信息登场账本"
        : id.endsWith("release") ? "信息释放表"
          : id.startsWith("script-") ? "观众当前知识库" : "读者当前知识库";
};

const decodeProjectionEntities = (value = "") => String(value)
  .replace(/&#(?:x([0-9a-f]+)|([0-9]+));?/giu, (_match, hexadecimal, decimal) => {
    const codePoint = Number.parseInt(hexadecimal || decimal, hexadecimal ? 16 : 10);
    try { return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : ""; } catch { return ""; }
  })
  .replace(/&(amp|quot|apos|lt|gt|nbsp);/giu, (_match, entity) => ({
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  })[entity.toLowerCase()]);

const projectionComparableText = ({ documentId = "", content = "", markdown = "", html = "" } = {}) => {
  const supplied = String(html || markdown || content || "").normalize("NFC").replace(/\r\n?/gu, "\n");
  const htmlLike = Boolean(html) || /<\/?(?:h[1-6]|p|div|li|ul|ol|strong|em|br)\b/iu.test(supplied);
  const title = memoryProjectionTitle(documentId);
  const headingMatch = htmlLike
    ? supplied.match(/<h1\b[^>]*>([^]*?)<\/h1>/iu)
    : supplied.match(/^\s*#\s+(.+)$/mu);
  const hasDocumentHeading = decodeProjectionEntities(String(headingMatch?.[1] || "").replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim() === title;
  let comparable = supplied
    .replace(/<!--[^]*?-->/gu, "")
    .replace(/&lt;!--[^]*?--&gt;/giu, "");
  if (htmlLike) {
    comparable = comparable
      .replace(/<br\s*\/?\s*>/giu, "\n")
      .replace(/<\/(?:h[1-6]|p|div|li|ul|ol|blockquote|tr)>/giu, "\n")
      .replace(/<[^>]+>/gu, " ");
  } else {
    comparable = comparable
      .replace(/^\s*#{1,6}\s+/gmu, "")
      .replace(/^\s*(?:[-*+]|\d+[.)、])\s+/gmu, "")
      .replace(/\*\*([^\n]*?)\*\*/gu, "$1")
      .replace(/__([^\n]*?)__/gu, "$1")
      .replace(/`([^\n]*?)`/gu, "$1");
  }
  const lines = decodeProjectionEntities(comparable)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/gu, " ").replace(/\s*([：:])\s*/gu, "$1").trim())
    .filter(Boolean);
  if (hasDocumentHeading && lines[0] === title) lines.shift();
  return lines.join("\n");
};

// Memory projections pass through the editor's HTML -> Markdown serializer and
// the workspace Markdown -> HTML hydrator. Those trusted transport steps remove
// comments and may remove a duplicate leading title, so a raw HTML hash cannot
// distinguish that round-trip from an author edit. This fingerprint hashes the
// ordered semantic fields while ignoring only those two transport-only details.
export const memoryStoreProjectionFingerprint = (options = {}) => (
  memoryStoreContentHash(projectionComparableText(options))
);

export const memoryStoreProjectionBaselineDecision = ({
  documentId = "",
  content = "",
  markdown = "",
  html = "",
  baselineHash = "",
  baselineVersion = 0,
  expectedProjection = null,
  externalContentChanged = false,
} = {}) => {
  const source = String(html || markdown || content || "");
  const currentHash = memoryStoreProjectionFingerprint({ documentId, content, markdown, html });
  const baseline = String(baselineHash || "");
  if (externalContentChanged) {
    return { matches: false, currentHash, upgradeBaseline: false, reason: "external_content_changed" };
  }
  if (!baseline) {
    return { matches: true, currentHash, upgradeBaseline: true, reason: "projection_baseline_missing" };
  }
  if (Number(baselineVersion) >= MEMORY_STORE_PROJECTION_HASH_VERSION) {
    return {
      matches: baseline === currentHash,
      currentHash,
      upgradeBaseline: false,
      reason: baseline === currentHash ? "projection_fingerprint_match" : "projection_fingerprint_mismatch",
    };
  }
  if (baseline === memoryStoreContentHash(source)) {
    return { matches: true, currentHash, upgradeBaseline: true, reason: "legacy_projection_hash_match" };
  }
  if (expectedProjection && typeof expectedProjection === "object") {
    const expectedHash = memoryStoreProjectionFingerprint({ documentId, ...expectedProjection });
    if (expectedHash === currentHash) {
      return { matches: true, currentHash, upgradeBaseline: true, reason: "trusted_projection_roundtrip_match" };
    }
  }
  return { matches: false, currentHash, upgradeBaseline: false, reason: "legacy_projection_hash_mismatch" };
};

const memoryProjectionSchemaMarker = `<!-- memory-store-schema: ${MEMORY_STORE_SCHEMA_VERSION} -->`;

export const projectMemoryStoreMarkdown = ({ store = null, documentId = "" } = {}) => {
  const normalized = normalizeMemoryStore(store);
  const script = String(documentId).startsWith("script-");
  const domain = script ? "script" : "novel";
  const title = memoryProjectionTitle(documentId);
  let records = [];
  if (documentId.endsWith("snapshot")) records = Object.values(normalized.currentStates[domain] || {});
  else if (documentId.endsWith("foreshadowing")) records = Object.values(normalized.foreshadowing);
  else if (documentId.endsWith("information-ledger")) records = Object.values(normalized.informationEntities);
  else if (documentId.endsWith("first-appearance")) records = Object.values(normalized.informationEntities).filter((item) => item.firstAppearance);
  else if (documentId.endsWith("release")) records = Object.values(normalized.informationEntities).filter((item) => item.release);
  else records = Object.values(normalized.informationEntities).filter((item) => item.readerKnowledge);
  const informationLedger = documentId.endsWith("information-ledger");
  const body = records.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN")).map((item) => {
    const rendered = recordMarkdown(item, { information: !documentId.endsWith("snapshot") });
    if (!informationLedger) return rendered;
    const aspect = (value) => {
      if (!value || typeof value !== "object") return String(value || "").trim();
      return [value.chapter, value.state, value.currentValue, value.detail, value.name].map((part) => String(part || "").trim()).find(Boolean) || "";
    };
    return [
      rendered,
      item.firstAppearance ? `- 首次出现：${projectionFieldValue(aspect(item.firstAppearance), 800)}` : "",
      item.release ? `- 信息释放：${projectionFieldValue(aspect(item.release), 800)}` : "",
      item.readerKnowledge ? `- 读者当前知识：${projectionFieldValue(aspect(item.readerKnowledge), 800)}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n\n");
  return [`# ${title}`, "", memoryProjectionSchemaMarker, body || "当前没有已通过正文证据验收的记录。"].join("\n");
};

export const projectMemoryStoreHtml = ({ store = null, documentId = "" } = {}) => {
  const markdown = projectMemoryStoreMarkdown({ store, documentId });
  const lines = markdown.split("\n");
  const html = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    if (line.startsWith("<!--")) { html.push(line); continue; }
    if (line.startsWith("# ")) html.push(`<h1>${escapeHtml(line.slice(2))}</h1>`);
    else if (line.startsWith("## ")) html.push(`<h2>${escapeHtml(line.slice(3))}</h2>`);
    else if (line.startsWith("- ")) {
      const separator = line.indexOf("：");
      if (separator > 0) html.push(`<p><strong>${escapeHtml(line.slice(2, separator + 1))}</strong>${escapeHtml(line.slice(separator + 1))}</p>`);
      else html.push(`<p>${escapeHtml(line.slice(2))}</p>`);
    } else html.push(`<p>${escapeHtml(line)}</p>`);
  }
  return html.join("");
};

// Rehydrate a persisted projection without passing it through the general
// prose Markdown renderer. Projection Markdown intentionally contains schema
// comments and record fields that must retain their exact HTML shape so the
// trusted projection fingerprint survives a save/restart round-trip.
export const memoryProjectionMarkdownToHtml = (markdown = "") => String(markdown ?? "")
  .replace(/\r\n?/gu, "\n")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    if (line.startsWith("<!--") && line.endsWith("-->")) return line;
    if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
    if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
    if (line.startsWith("- ")) {
      const separator = line.indexOf("：");
      if (separator > 0) return `<p><strong>${escapeHtml(line.slice(2, separator + 1))}</strong>${escapeHtml(line.slice(separator + 1))}</p>`;
      return `<p>${escapeHtml(line.slice(2))}</p>`;
    }
    return `<p>${escapeHtml(line)}</p>`;
  })
  .join("");

// Keep the server-facing name stable for packaged desktop startup.
export const projectMemoryStoreDocumentHtml = (options = {}) => projectMemoryStoreHtml(options);

const projectionRecordMarkdownIsValid = (segment = "") => {
  const lines = String(segment).split("\n").map((line) => line.trim()).filter(Boolean);
  if (!/^##\s+\S/u.test(lines[0] || "")) return false;
  if (!/^<!--\s*memory-id:\s*[^>]+-->$/u.test(lines[1] || "")) return false;
  const body = lines.join("\n");
  if (!/^-\s*稳定 ID：\S+/mu.test(body)) return false;
  if (!/^-\s*来源正文：\S+/mu.test(body)) return false;
  if (!/^-\s*来源 revision：\S+/mu.test(body)) return false;
  if (!/^-\s*证据：\S+/mu.test(body)) return false;
  if (!/^-\s*最后更新：\S+/mu.test(body)) return false;
  return true;
};

const projectionRecordHtmlIsValid = (segment = "") => (
  /<h2>[^<]+<\/h2>/iu.test(segment)
  && /<!--\s*memory-id:\s*[^>]+-->/u.test(segment)
  && /稳定 ID：/u.test(segment)
  && /来源正文：/u.test(segment)
  && /来源 revision：/u.test(segment)
  && /证据：/u.test(segment)
  && /最后更新：/u.test(segment)
);

const projectionHtmlToMarkdown = (html = "") => String(html)
  .replace(/<h1>([\s\S]*?)<\/h1>/iu, (_match, title) => `# ${title}\n\n`)
  .replace(/<!--\s*memory-store-schema:\s*(\d+)\s*-->/giu, (_match, version) => `<!-- memory-store-schema: ${version} -->\n`)
  .replace(/<h2>([\s\S]*?)<\/h2>/giu, (_match, title) => `## ${title}\n`)
  .replace(/<p><strong>([^<]+)<\/strong>([\s\S]*?)<\/p>/giu, (_match, label, value) => `- ${label}${value}\n`)
  .replace(/<p>([\s\S]*?)<\/p>/giu, (_match, value) => `${value}\n`)
  .replace(/<[^>]+>/gu, "")
  .replace(/\n{3,}/gu, "\n\n")
  .trim();

// The projector is the only writer allowed to create memory documents. This
// validator is intentionally structural: factual evidence is validated before
// entering MemoryStore, while this boundary prevents transport wrappers or
// hand-written prose from being mistaken for a trusted projection.
export const validateMemoryProjectionFormat = ({ documentId = "", content = "", markdown = "", html = "" } = {}) => {
  if (!isStructuredMemoryDocumentId(documentId)) return { valid: false, reason: "not_memory_document" };
  const title = memoryProjectionTitle(documentId);
  const markdownHeader = `# ${title}\n\n${memoryProjectionSchemaMarker}`;
  const suppliedContent = String(content || "").trim();
  const suppliedMarkdown = Boolean(markdown) || (!html && /^#/u.test(suppliedContent));
  if (suppliedMarkdown) {
    const source = String(markdown || content || "").replace(/\r\n?/gu, "\n").trim();
    if (!source) return { valid: false, reason: "memory_projection_empty" };
    if (/<shensi-deliverables\b|<document\b/iu.test(source)) return { valid: false, reason: "memory_projection_transport_wrapper" };
    if (!source.startsWith(markdownHeader)) return { valid: false, reason: "memory_projection_schema_header" };
    const body = source.slice(markdownHeader.length).trim();
    if (body === "当前没有已通过正文证据验收的记录。") return { valid: true, reason: "memory_projection_format_satisfied" };
    const records = body.split(/\n(?=##\s)/u).filter(Boolean);
    if (!records.length || records.some((record) => !projectionRecordMarkdownIsValid(record))) {
      return { valid: false, reason: "memory_projection_record_fields" };
    }
    return { valid: true, reason: "memory_projection_format_satisfied" };
  }
  const source = String(html || content || "").replace(/\r\n?/gu, "\n").trim();
  if (!source) return { valid: false, reason: "memory_projection_empty" };
  if (/<shensi-deliverables\b|<document\b/iu.test(source)) return { valid: false, reason: "memory_projection_transport_wrapper" };
  const htmlHeader = `<h1>${escapeHtml(title)}</h1>${memoryProjectionSchemaMarker}`;
  if (!source.startsWith(htmlHeader)) return { valid: false, reason: "memory_projection_schema_header" };
  const records = source.split(/(?=<h2>)/iu).slice(1).filter(Boolean);
  if (!records.length && /<p>当前没有已通过正文证据验收的记录。<\/p>/u.test(source)) {
    return { valid: true, reason: "memory_projection_format_satisfied" };
  }
  if (!records.length || records.some((record) => !projectionRecordHtmlIsValid(record))) {
    return { valid: false, reason: "memory_projection_record_fields" };
  }
  return { valid: true, reason: "memory_projection_format_satisfied" };
};

export const trustedMemoryProjection = ({ store = null, documentId = "" } = {}) => {
  const markdown = projectMemoryStoreMarkdown({ store, documentId });
  const html = projectMemoryStoreDocumentHtml({ store, documentId });
  const markdownCheck = validateMemoryProjectionFormat({ documentId, markdown });
  const htmlCheck = validateMemoryProjectionFormat({ documentId, html });
  const check = markdownCheck.valid && htmlCheck.valid
    ? { valid: true, reason: "memory_projection_format_satisfied" }
    : { valid: false, reason: markdownCheck.valid ? htmlCheck.reason : markdownCheck.reason };
  if (!check.valid) {
    const error = new Error(`记忆投影格式校验失败：${check.reason}`);
    error.code = "MEMORY_PROJECTION_FORMAT_INVALID";
    error.details = check;
    throw error;
  }
  return { markdown, html, check };
};

export const projectMemoryStoreDocumentText = ({ store = null, documentId = "", maxCharacters = 24_000 } = {}) => {
  const value = projectMemoryStoreMarkdown({ store, documentId });
  return value.length > maxCharacters ? `${value.slice(0, Math.max(0, maxCharacters - 24))}\n[记忆上下文已按预算截断]` : value;
};

export const memoryStoreSummary = (store = null) => {
  const normalized = normalizeMemoryStore(store);
  return {
    schemaVersion: normalized.schemaVersion,
    unitDeltas: Object.keys(normalized.unitDeltas).length,
    currentStates: Object.values(normalized.currentStates).reduce((sum, entries) => sum + Object.keys(entries || {}).length, 0),
    informationEntities: Object.keys(normalized.informationEntities).length,
    foreshadowing: Object.keys(normalized.foreshadowing).length,
    evidence: Object.keys(normalized.evidenceIndex).length,
    revisions: Object.keys(normalized.revisions).length,
    pendingCandidates: normalized.pendingCandidates.length,
    conflicts: normalized.conflicts.length,
  };
};
