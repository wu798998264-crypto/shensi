import { freeDocumentTitle, sequencedDocumentLabel } from "./document-title-policy.js";
import { stripMatchingLeadingHeadingHtml } from "./prose-format.js";

const encoder = new TextEncoder();
const CURRENT_BASIS_SCHEMA_VERSION = 2;

export const sha256Hex = async (value = "") => {
  if (!globalThis.crypto?.subtle) throw new Error("当前运行环境缺少 SHA-256 完整性能力");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoder.encode(String(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const normalizedText = (value = "") => String(value ?? "")
  .normalize("NFC")
  .replace(/\r\n?/g, "\n");

const comparableHeadingText = (value = "") => normalizedText(value)
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ")
  .trim()
  .toLocaleLowerCase();

const canonicalDocumentTitle = (documentId, documentState = {}) => freeDocumentTitle({
  documentId,
  title: documentState.title ?? "",
  language: documentState.titleLanguage || "zh-CN",
}).normalize("NFC").replace(/\s+/g, " ").trim();

const acceptedDocumentTitles = (documentId, documentState = {}) => {
  const title = canonicalDocumentTitle(documentId, documentState);
  const label = sequencedDocumentLabel({
    documentId,
    title,
    language: documentState.titleLanguage || "zh-CN",
  });
  return [...new Set([documentState.title, title, label].map((value) => String(value ?? "").trim()).filter(Boolean))];
};

const stripMatchingLeadingMarkdownHeading = (markdown = "", acceptedTitles = []) => {
  const source = normalizedText(markdown);
  const heading = source.match(/^\s*#{1,6}[ \t]+([^\n]+)(?:\n+|$)/);
  if (!heading) return source;
  const accepted = new Set(acceptedTitles.map(comparableHeadingText).filter(Boolean));
  return accepted.has(comparableHeadingText(heading[1])) ? source.slice(heading[0].length) : source;
};

const canonicalDocumentBody = (documentId, documentState = {}) => {
  const acceptedTitles = acceptedDocumentTitles(documentId, documentState);
  const html = typeof documentState.html === "string" ? documentState.html : null;
  const markdown = typeof documentState.markdown === "string" ? documentState.markdown : "";
  if (html !== null && (html.trim() || !markdown.trim())) {
    return {
      format: "html",
      value: normalizedText(stripMatchingLeadingHeadingHtml(html, acceptedTitles)).trim(),
    };
  }
  return {
    format: "markdown",
    value: stripMatchingLeadingMarkdownHeading(markdown, acceptedTitles).trim(),
  };
};

const VOLATILE_SEMANTIC_KEYS = new Set(["createdAt", "updatedAt", "syncedAt", "verifiedAt"]);

const stableSemanticValue = (value) => {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value)
    .filter((key) => !VOLATILE_SEMANTIC_KEYS.has(key))
    .sort()
    .map((key) => [key, stableSemanticValue(value[key])]));
};

const stableDocumentContentPayload = (documentId, documentState = {}) => JSON.stringify({
  title: canonicalDocumentTitle(documentId, documentState),
  body: canonicalDocumentBody(documentId, documentState),
});

const stableDocumentContextPayload = (documentId, documentState = {}) => JSON.stringify({
  title: canonicalDocumentTitle(documentId, documentState),
  body: canonicalDocumentBody(documentId, documentState),
  continuityDelta: stableSemanticValue(documentState.continuityDelta ?? null),
});

const legacyStableDocumentPayload = (documentState = {}, item, { includeItem = false } = {}) => JSON.stringify({
  title: documentState.title ?? "",
  html: documentState.html ?? "",
  markdown: documentState.markdown ?? "",
  continuityDelta: documentState.continuityDelta ?? null,
  ...(includeItem ? { item: item ?? null } : {}),
});

const documentRevisionMaps = async (documents = {}) => {
  const entries = Object.entries(documents);
  const [documentContentRevisions, documentContextRevisions] = await Promise.all([
    Promise.all(entries.map(async ([id, documentState]) => [id, await sha256Hex(stableDocumentContentPayload(id, documentState))])),
    Promise.all(entries.map(async ([id, documentState]) => [id, await sha256Hex(stableDocumentContextPayload(id, documentState))])),
  ]);
  return {
    documentContentRevisions: Object.fromEntries(documentContentRevisions),
    documentContextRevisions: Object.fromEntries(documentContextRevisions),
  };
};

export const contextDocumentIds = (context = "") => [...new Set([...String(context).matchAll(/<!--\s*shensi-context-source\s+({[^\n]*})\s*-->/g)]
  .map((match) => {
    try { return String(JSON.parse(match[1]).id ?? "").trim(); } catch { return ""; }
  }).filter(Boolean))];

export const buildCandidateBasisSeed = async ({ documents = {}, itemFor = () => null, canonDocumentIds = [], contexts = [] } = {}) => {
  const { documentContentRevisions, documentContextRevisions } = await documentRevisionMaps(documents);
  const contextIds = [...new Set(contexts.flatMap(contextDocumentIds))].sort();
  const canonIds = [...new Set(canonDocumentIds.filter(Boolean))].sort();
  return {
    schemaVersion: CURRENT_BASIS_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    documentContentRevisions,
    documentContextRevisions,
    // Keep the broad semantic map for Agent external-file reconciliation and
    // older persisted request records that still read documentRevisions.
    documentRevisions: documentContextRevisions,
    contextDocumentIds: contextIds,
    contextDocumentListHash: await sha256Hex(JSON.stringify(contextIds)),
    contextHashes: await Promise.all(contexts.map((context) => sha256Hex(context))),
    canonDocumentIds: canonIds,
    canonDocumentListHash: await sha256Hex(JSON.stringify(canonIds)),
  };
};

export const finalizeCandidateBasis = ({ seed, targetDocumentIds = [] } = {}) => {
  if (!seed) return null;
  const targetIds = [...new Set(targetDocumentIds.filter(Boolean))].sort();
  const relevantIds = [...new Set([...targetIds, ...(seed.contextDocumentIds ?? []), ...(seed.canonDocumentIds ?? [])])];
  const modern = Number(seed.schemaVersion) >= CURRENT_BASIS_SCHEMA_VERSION
    && seed.documentContentRevisions
    && seed.documentContextRevisions;
  const targetSource = modern ? seed.documentContentRevisions : seed.documentRevisions ?? {};
  const dependencySource = modern ? seed.documentContextRevisions : seed.documentRevisions ?? {};
  const dependencyIds = new Set([...(seed.contextDocumentIds ?? []), ...(seed.canonDocumentIds ?? [])]);
  return {
    schemaVersion: modern ? CURRENT_BASIS_SCHEMA_VERSION : 1,
    generatedAt: seed.generatedAt,
    targetDocumentIds: targetIds,
    targetRevisions: Object.fromEntries(targetIds.map((id) => [id, targetSource[id] ?? null])),
    contextDocumentIds: seed.contextDocumentIds ?? [],
    contextDocumentListHash: seed.contextDocumentListHash,
    contextRevisions: Object.fromEntries((seed.contextDocumentIds ?? []).map((id) => [id, dependencySource[id] ?? null])),
    contextHashes: seed.contextHashes ?? [],
    canonDocumentIds: seed.canonDocumentIds ?? [],
    canonDocumentListHash: seed.canonDocumentListHash,
    canonRevisions: Object.fromEntries((seed.canonDocumentIds ?? []).map((id) => [id, dependencySource[id] ?? null])),
    relevantDocumentRevisions: Object.fromEntries(relevantIds.map((id) => [
      id,
      (dependencyIds.has(id) ? dependencySource[id] : targetSource[id]) ?? null,
    ])),
    ...(modern ? { revisionPolicy: "write-set-v2" } : {}),
  };
};

export const rebaseCandidateBasisDocument = ({ basis, seed, documentId = "" } = {}) => {
  const id = String(documentId || "").trim();
  if (!basis || !seed || !id) return basis;
  const modern = Number(basis.schemaVersion) >= CURRENT_BASIS_SCHEMA_VERSION
    && seed.documentContentRevisions
    && seed.documentContextRevisions;
  const contentRevision = modern
    ? seed.documentContentRevisions[id] ?? null
    : seed.documentRevisions?.[id] ?? null;
  const contextRevision = modern
    ? seed.documentContextRevisions[id] ?? null
    : seed.documentRevisions?.[id] ?? null;
  const isTarget = (basis.targetDocumentIds ?? []).includes(id);
  const isContext = (basis.contextDocumentIds ?? []).includes(id);
  const isCanon = (basis.canonDocumentIds ?? []).includes(id);
  const isRelevant = isTarget || isContext || isCanon
    || Object.prototype.hasOwnProperty.call(basis.relevantDocumentRevisions ?? {}, id);
  return {
    ...basis,
    ...(isTarget ? { targetRevisions: { ...(basis.targetRevisions ?? {}), [id]: contentRevision } } : {}),
    ...(isContext ? { contextRevisions: { ...(basis.contextRevisions ?? {}), [id]: contextRevision } } : {}),
    ...(isCanon ? { canonRevisions: { ...(basis.canonRevisions ?? {}), [id]: contextRevision } } : {}),
    ...(isRelevant ? {
      relevantDocumentRevisions: {
        ...(basis.relevantDocumentRevisions ?? {}),
        [id]: isContext || isCanon ? contextRevision : contentRevision,
      },
    } : {}),
  };
};

const invalidBasis = () => ({
  ok: false,
  reason: "候选稿缺少可验证的生成版本基线，无法排除目标正文已在任务期间被人工修改（版本冲突待核对）",
  code: "CANDIDATE_BASIS_MISSING",
});

const validateBasisLists = async ({ basis, canonDocumentIds = [] } = {}) => {
  if (await sha256Hex(JSON.stringify([...(basis.contextDocumentIds ?? [])].sort())) !== basis.contextDocumentListHash) {
    return { ok: false, reason: "候选稿上下文清单完整性校验失败", code: "CANDIDATE_CONTEXT_LIST_INVALID" };
  }
  const currentCanonIds = [...new Set(canonDocumentIds.filter(Boolean))].sort();
  if (await sha256Hex(JSON.stringify(currentCanonIds)) !== basis.canonDocumentListHash) {
    return { ok: false, reason: "正史文档清单已变化", code: "CANDIDATE_CANON_LIST_CHANGED" };
  }
  return { ok: true };
};

const changedBasisResult = (documents, changes) => {
  const first = changes[0];
  return {
    ok: false,
    reason: `${documents[first.documentId]?.title ?? first.documentId} 已在候选生成后发生变化`,
    code: first.scope === "target-write-set" ? "CANDIDATE_TARGET_CHANGED" : "CANDIDATE_CONTEXT_CHANGED",
    changedDocumentIds: [...new Set(changes.map(({ documentId }) => documentId))],
    changedDocumentScopes: changes,
  };
};

const validateModernBasis = async ({ basis, documents, landingDocumentIds }) => {
  const changes = [];
  for (const documentId of landingDocumentIds) {
    const expected = basis.targetRevisions?.[documentId] ?? null;
    const current = documents[documentId]
      ? await sha256Hex(stableDocumentContentPayload(documentId, documents[documentId]))
      : null;
    if (current !== expected) changes.push({ documentId, scope: "target-write-set" });
  }
  const dependencyRevisions = new Map([
    ...Object.entries(basis.contextRevisions ?? {}),
    ...Object.entries(basis.canonRevisions ?? {}),
  ]);
  for (const [documentId, expected] of dependencyRevisions) {
    const current = documents[documentId]
      ? await sha256Hex(stableDocumentContextPayload(documentId, documents[documentId]))
      : null;
    if (current !== expected) changes.push({ documentId, scope: "generation-context" });
  }
  return changes.length ? changedBasisResult(documents, changes) : { ok: true };
};

const validateLegacyBasis = async ({ basis, documents, itemFor }) => {
  const changes = [];
  for (const [documentId, expected] of Object.entries(basis.relevantDocumentRevisions ?? {})) {
    const documentState = documents[documentId];
    if (!documentState) {
      if (expected !== null) changes.push({ documentId, scope: "legacy-document" });
      continue;
    }
    const item = itemFor(documentId);
    const currentHashes = await Promise.all([
      sha256Hex(legacyStableDocumentPayload(documentState, item)),
      sha256Hex(legacyStableDocumentPayload(documentState, item, { includeItem: true })),
    ]);
    if (!currentHashes.includes(expected)) changes.push({ documentId, scope: "legacy-document" });
  }
  return changes.length ? changedBasisResult(documents, changes) : { ok: true };
};

export const validateCandidateBasis = async ({ basis, documents = {}, itemFor = () => null, landingDocumentIds = [], canonDocumentIds = [] } = {}) => {
  if (!basis || ![1, CURRENT_BASIS_SCHEMA_VERSION].includes(Number(basis.schemaVersion))) return invalidBasis();
  const storedTargets = [...new Set(basis.targetDocumentIds ?? [])].sort();
  const targets = [...new Set(landingDocumentIds.filter(Boolean))].sort();
  if (targets.some((id) => !storedTargets.includes(id))) return { ok: false, reason: "候选稿目标不在生成时锁定的目标清单中", code: "CANDIDATE_TARGET_OUT_OF_SCOPE" };
  const listValidation = await validateBasisLists({ basis, canonDocumentIds });
  if (!listValidation.ok) return listValidation;
  return Number(basis.schemaVersion) >= CURRENT_BASIS_SCHEMA_VERSION
    ? validateModernBasis({ basis, documents, landingDocumentIds: targets })
    : validateLegacyBasis({ basis, documents, itemFor });
};

// Every formal landing needs a verified generation basis. A history snapshot
// is recovery evidence, not permission to overwrite edits made after the
// candidate was generated.
export const candidateBasisLandingDecision = (validation = {}) => {
  if (validation?.ok === true) return {
    allow: true,
    changedSinceGeneration: false,
    snapshotBeforeReplace: true,
    reason: "",
    code: "CANDIDATE_BASIS_CURRENT",
  };
  const code = String(validation?.code || "CANDIDATE_BASIS_INVALID");
  return {
    allow: false,
    changedSinceGeneration: true,
    snapshotBeforeReplace: false,
    reason: String(validation?.reason || "候选生成基线无法完整核对"),
    code,
  };
};
