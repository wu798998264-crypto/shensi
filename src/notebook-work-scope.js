import { chapterNumberValue } from "./chapter-target.js";

const clean = (value = "") => String(value ?? "").trim();

const itemOptionsFor = (moduleItems = {}, documentId = "") => {
  for (const items of Object.values(moduleItems ?? {})) {
    const item = (items ?? []).find((entry) => String(entry?.[0] || "") === String(documentId || ""));
    if (item) return item?.[2] && typeof item[2] === "object" ? item[2] : {};
  }
  return {};
};

const itemRecordFor = (moduleItems = {}, documentId = "") => {
  for (const [moduleId, items] of Object.entries(moduleItems ?? {})) {
    const item = (items ?? []).find((entry) => String(entry?.[0] || "") === String(documentId || ""));
    if (item) return { moduleId, item, options: item?.[2] && typeof item[2] === "object" ? item[2] : {} };
  }
  return { moduleId: "", item: null, options: {} };
};

const firstIdentity = (...values) => values.map(clean).find(Boolean) || "";

const titleWorkIdentity = (title = "") => clean(title).match(/^[《〈]\s*([^》〉]{1,80})\s*[》〉]/u)?.[1]?.trim() || "";

export const notebookNarrativeSequenceNumber = (documentId = "", document = {}, moduleItems = {}) => {
  const options = itemOptionsFor(moduleItems, documentId);
  const storedNumber = Number(document?.sequenceNumber || options.sequenceNumber || 0);
  if (Number.isInteger(storedNumber) && storedNumber > 0) return storedNumber;
  const idNumber = Number(clean(documentId).match(/(?:chapter|episode|script-episode)[-_]?(\d+)/iu)?.[1] || 0);
  if (idNumber > 0) return idNumber;
  const token = clean(document?.title || options.title || options.name).match(/第\s*(\d+|[零〇一二两三四五六七八九十百千万]+)\s*(?:章|集)/u)?.[1];
  const parsed = chapterNumberValue(token || "");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
};

const notebookNarrativeSequenceType = (documentId = "", document = {}, moduleItems = {}) => {
  const options = itemOptionsFor(moduleItems, documentId);
  const explicit = clean(document?.sequenceType || options.sequenceType).toLocaleLowerCase();
  if (["chapter", "episode"].includes(explicit)) return explicit;
  if (/^script-episode-\d+$/u.test(clean(documentId))) return "episode";
  if (/^chapter-\d+$/u.test(clean(documentId))) return "chapter";
  const title = clean(document?.title || options.title || options.name);
  const unit = title.match(/^第\s*(?:\d+|[零〇一二两三四五六七八九十百千万]+)\s*(章|集)/u)?.[1];
  if (unit) return unit === "集" ? "episode" : "chapter";
  return clean(document?.contextDomain || options.contextDomain) === "script"
    || clean(document?.workspaceView || options.workspaceView) === "script"
    ? "episode"
    : "chapter";
};

const currentVersionDocument = (documentId = "", document = {}) => {
  const status = clean(document?.contextStatus || document?.context_status).toLocaleLowerCase();
  if (["deprecated", "retired", "history", "deleted", "trash"].includes(status)) return false;
  return !/(?:^|[-_:])(?:trash|retired|deleted|history)(?:$|[-_:])/iu.test(clean(documentId));
};

// Notebook files are independent by default.  They may only be grouped into a
// creative work when the user-visible metadata or their structural folder says
// that they belong to the same work.  Titles and prose are deliberately not
// guessed: doing so previously mixed unrelated novels merely because both were
// classified as "novel".
export const notebookDocumentWorkIdentity = ({ documentId = "", document = {}, moduleItems = {} } = {}) => {
  const options = itemOptionsFor(moduleItems, documentId);
  const explicit = firstIdentity(
    document.workId,
    options.workId,
    document.workGroupId,
    options.workGroupId,
    document.workTag,
    options.workTag,
    document.workName,
    options.workName,
    document.seriesId,
    options.seriesId,
    document.seriesName,
    options.seriesName,
    document.creativeWorkId,
    options.creativeWorkId,
    titleWorkIdentity(document.title),
    titleWorkIdentity(options.title),
  );
  if (explicit) return `work:${explicit.toLocaleLowerCase()}`;

  const folder = firstIdentity(
    options.customFolderId,
    document.customFolderId,
    options.folderId,
    document.folderId,
    options.volumeFolder,
    document.volumeFolder,
  );
  return folder ? `folder:${folder.toLocaleLowerCase()}` : "";
};

export const notebookSameWorkDocumentIds = ({
  currentDocumentId = "",
  targetDocumentId = "",
  referenceIds = [],
  documents = {},
  moduleItems = {},
  allowedModuleIds = ["canon", "outline", "manuscript", "memory", "library"],
  allowExplicitOutsideWork = false,
  maxPreviousUnits = 4,
} = {}) => {
  const existing = new Set(Object.keys(documents ?? {}));
  const result = [];
  const add = (documentId) => {
    const id = clean(documentId);
    if (!id || result.includes(id) || !existing.has(id) || !currentVersionDocument(id, documents?.[id])) return;
    result.push(id);
  };
  add(currentDocumentId);
  add(targetDocumentId);

  const anchorDocumentId = clean(targetDocumentId) || clean(currentDocumentId);
  const anchor = documents?.[anchorDocumentId];
  const identity = notebookDocumentWorkIdentity({ documentId: anchorDocumentId, document: anchor, moduleItems })
    || notebookDocumentWorkIdentity({ documentId: currentDocumentId, document: documents?.[currentDocumentId], moduleItems });
  for (const referenceId of referenceIds) {
    const referenceIdentity = notebookDocumentWorkIdentity({
      documentId: referenceId,
      document: documents?.[referenceId],
      moduleItems,
    });
    if (allowExplicitOutsideWork || (identity && referenceIdentity === identity)) add(referenceId);
  }
  const allowed = new Set(allowedModuleIds.map(clean));
  const currentSequence = notebookNarrativeSequenceNumber(anchorDocumentId, anchor, moduleItems);
  const matching = [];
  for (const [documentId, document] of Object.entries(documents ?? {})) {
    const options = itemOptionsFor(moduleItems, documentId);
    const moduleId = clean(document?.moduleId || options.moduleId || Object.entries(moduleItems ?? {})
      .find(([, items]) => (items ?? []).some((entry) => String(entry?.[0] || "") === documentId))?.[0]);
    if (!allowed.has(moduleId)) continue;
    if (identity && notebookDocumentWorkIdentity({ documentId, document, moduleItems }) === identity) {
      matching.push({ documentId, document, moduleId, sequence: notebookNarrativeSequenceNumber(documentId, document, moduleItems) });
    }
  }
  const explicitSet = new Set(referenceIds.map(clean));
  const narrative = matching
    .filter((item) => item.moduleId === "manuscript" && item.documentId !== currentDocumentId)
    .filter((item) => !currentSequence || !item.sequence || item.sequence < currentSequence)
    .sort((left, right) => right.sequence - left.sequence)
    .slice(0, Math.max(1, Number(maxPreviousUnits) || 4))
    .sort((left, right) => left.sequence - right.sequence);
  const support = matching
    .filter((item) => item.moduleId !== "manuscript" || explicitSet.has(item.documentId))
    .sort((left, right) => Number(explicitSet.has(right.documentId)) - Number(explicitSet.has(left.documentId)))
    .slice(0, 16);
  [...support, ...narrative].forEach((item) => add(item.documentId));

  // A notebook often starts as loose notes and gains canonical chapter IDs
  // only after the first few chapters. When no explicit work name exists,
  // follow only unique, consecutive manuscript sequence numbers behind the
  // requested target. Ambiguous duplicates are deliberately excluded.
  if (currentSequence > 1) {
    const manuscriptBySequence = new Map();
    for (const [documentId, document] of Object.entries(documents ?? {})) {
      const record = itemRecordFor(moduleItems, documentId);
      const moduleId = clean(document?.moduleId || record.options.moduleId || record.moduleId);
      if (moduleId !== "manuscript" || !currentVersionDocument(documentId, document)) continue;
      const sequence = notebookNarrativeSequenceNumber(documentId, document, moduleItems);
      if (!sequence) continue;
      if (!manuscriptBySequence.has(sequence)) manuscriptBySequence.set(sequence, []);
      manuscriptBySequence.get(sequence).push({ documentId, document });
    }
    for (let sequence = Math.max(1, currentSequence - Math.max(1, Number(maxPreviousUnits) || 4)); sequence < currentSequence; sequence += 1) {
      const candidates = manuscriptBySequence.get(sequence) ?? [];
      const matchingIdentity = identity
        ? candidates.filter((candidate) => notebookDocumentWorkIdentity({ ...candidate, moduleItems }) === identity)
        : [];
      const resolved = matchingIdentity.length === 1
        ? matchingIdentity[0]
        : matchingIdentity.length === 0 && candidates.length === 1 ? candidates[0] : null;
      if (resolved) add(resolved.documentId);
    }
  }
  return result;
};

const freeNarrativeTitle = (title = "") => clean(title)
  .replace(/^第\s*(?:\d+|[零〇一二两三四五六七八九十百千万]+)\s*(?:章|集)(?:[\t \u00a0　:：·—|｜-]+)?/u, "")
  .trim();

// Adds durable relationships to unambiguously sequenced notebook chapters.
// Internal document IDs stay untouched so history and conversation bindings
// remain valid; sequence metadata becomes the stable identity layer.
export const normalizeNotebookNarrativeRelationships = ({ documents = {}, moduleItems = {} } = {}) => {
  const buckets = new Map();
  for (const [documentId, document] of Object.entries(documents ?? {})) {
    const record = itemRecordFor(moduleItems, documentId);
    const moduleId = clean(document?.moduleId || record.options.moduleId || record.moduleId);
    if (moduleId !== "manuscript" || document?.documentKind === "whiteboard" || !currentVersionDocument(documentId, document)) continue;
    const sequenceNumber = notebookNarrativeSequenceNumber(documentId, document, moduleItems);
    if (!sequenceNumber) continue;
    const sequenceType = notebookNarrativeSequenceType(documentId, document, moduleItems);
    const bucketKey = `${sequenceType}:${sequenceNumber}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push({ documentId, document, record, sequenceNumber, sequenceType });
  }
  const groups = [];
  for (const sequenceType of ["chapter", "episode"]) {
    const unique = [...buckets.values()]
      .filter((records) => records.length === 1 && records[0].sequenceType === sequenceType)
      .map((records) => records[0])
      .sort((left, right) => left.sequenceNumber - right.sequenceNumber);
    for (const record of unique) {
      const group = groups.at(-1);
      if (group?.[0]?.sequenceType === sequenceType && group.at(-1).sequenceNumber + 1 === record.sequenceNumber) group.push(record);
      else groups.push([record]);
    }
  }
  let changed = false;
  for (const group of groups.filter((records) => records.length >= 2 && records.some(({ documentId }) => /^(?:chapter|script-episode)-\d+$/u.test(documentId)))) {
    const sequenceType = group[0].sequenceType;
    const existingGroupId = group.map(({ document, record }) => clean(document.workGroupId || record.options.workGroupId)).find(Boolean);
    const structuralIdentity = group.map(({ documentId, document }) => notebookDocumentWorkIdentity({ documentId, document, moduleItems })).find(Boolean);
    const workGroupId = existingGroupId || `notebook-narrative:${structuralIdentity || group[0].documentId}`.toLocaleLowerCase();
    group.forEach((entry, index) => {
      const { documentId, document, record, sequenceNumber } = entry;
      const title = freeNarrativeTitle(document.title) || document.title;
      const previousDocumentId = group[index - 1]?.documentId || "";
      const nextDocumentId = group[index + 1]?.documentId || "";
      const nextDocumentValues = {
        title,
        workGroupId,
        sequenceType,
        sequenceNumber,
        canonicalSequenceKey: `${sequenceType}:${sequenceNumber}`,
        previousDocumentId,
        nextDocumentId,
        contextDomain: sequenceType === "chapter" ? "novel" : "script",
        customSequenceTitle: false,
      };
      for (const [key, value] of Object.entries(nextDocumentValues)) {
        if (document[key] !== value) {
          document[key] = value;
          changed = true;
        }
      }
      if (record.item) {
        record.item[2] = record.options;
        Object.assign(record.options, nextDocumentValues);
        const label = sequenceType === "chapter" ? `第${sequenceNumber}章　${title}` : `第${sequenceNumber}集　${title}`;
        if (record.item[1] !== label) {
          record.item[1] = label;
          changed = true;
        }
      }
    });
  }
  return changed;
};
