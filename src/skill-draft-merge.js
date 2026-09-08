const textKey = (value = "") => String(value)
  .normalize("NFKC")
  .trim()
  .replace(/\s+/g, " ")
  .replace(/[，,。.!！?？；;：:、]+$/g, "")
  .toLocaleLowerCase();

const asList = (value, splitter = /\r?\n/) => (Array.isArray(value) ? value : String(value || "").split(splitter))
  .map((item) => String(item || "").trim())
  .filter(Boolean);

export const mergeUniqueSkillDraftItems = (existing = [], incoming = []) => {
  const result = [];
  const seen = new Set();
  for (const item of [...asList(existing), ...asList(incoming)]) {
    const key = textKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
};

export const mergeUniqueSkillDraftText = (existing = "", incoming = "", { separator = "\n" } = {}) => {
  const current = String(existing || "");
  const addition = String(incoming || "");
  if (!current.trim()) return addition;
  if (!addition.trim()) return current;
  const currentUnits = asList(current);
  const incomingUnits = asList(addition);
  const merged = mergeUniqueSkillDraftItems(currentUnits, incomingUnits);
  if (merged.length === currentUnits.length) return current;
  return merged.join(separator);
};

const preferExisting = (existing, incoming, fallback = "") => String(existing || "").trim()
  ? existing
  : (incoming ?? fallback);

export const mergeSkillDraftValues = (existing = {}, incoming = {}) => ({
  ...incoming,
  id: preferExisting(existing.id, incoming.id),
  version: preferExisting(existing.version, incoming.version, "1.0.0"),
  name: preferExisting(existing.name, incoming.name),
  author: preferExisting(existing.author, incoming.author),
  description: mergeUniqueSkillDraftText(existing.description, incoming.description, { separator: "；" }),
  prototypeId: preferExisting(existing.prototypeId, incoming.prototypeId),
  prototypeName: preferExisting(existing.prototypeName, incoming.prototypeName),
  prototypeFingerprint: preferExisting(existing.prototypeFingerprint, incoming.prototypeFingerprint),
  derivativeCopy: Boolean(existing.derivativeCopy || incoming.derivativeCopy),
  upstreamId: preferExisting(existing.upstreamId, incoming.upstreamId),
  upstreamVersion: preferExisting(existing.upstreamVersion, incoming.upstreamVersion),
  changeSummary: mergeUniqueSkillDraftText(existing.changeSummary, incoming.changeSummary),
  capabilityBoundary: mergeUniqueSkillDraftText(existing.capabilityBoundary, incoming.capabilityBoundary),
  workspaceModes: mergeUniqueSkillDraftItems(existing.workspaceModes, incoming.workspaceModes),
  capabilities: mergeUniqueSkillDraftItems(existing.capabilities, incoming.capabilities),
  triggerKeywords: mergeUniqueSkillDraftItems(existing.triggerKeywords, incoming.triggerKeywords),
  triggerConditions: mergeUniqueSkillDraftItems(existing.triggerConditions, incoming.triggerConditions),
  // AI extraction only supplies registration metadata. A user's edited Markdown body is
  // authoritative and must never be replaced by the original import content.
  body: preferExisting(existing.body, incoming.body),
});
