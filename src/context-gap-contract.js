export const CONTEXT_GAP_SCHEMA_VERSION = 1;

const SOURCE_KIND_ALLOWLIST = new Set(["chapter", "outline", "canon", "state", "ledger", "reference"]);
const CONFIDENCE_ALLOWLIST = new Set(["low", "medium", "high"]);
const STABLE_ID = /^[\p{L}\p{N}][\p{L}\p{N}:._-]{0,159}$/u;
const FORBIDDEN_REQUEST = /(?:\b[a-z]:[\\/]|(?:^|[\s"'])\.{1,2}[\\/]|https?:\/\/|file:\/\/|\\\\|\*\*|[?*][\\/]|\.shensi\b|(?:历史版本|回收站|备份|backup|trash|history)(?:[\\/\s]|$)|(?:api[ _-]?key|access[ _-]?token|refresh[ _-]?token|credential|password|密码|凭据|密钥)|(?:powershell|cmd(?:\.exe)?|bash|sh\s+-c|exec(?:ute)?|运行命令|get-childitem|remove-item|rm\s+-rf))/iu;

const cleanText = (value, limit) => String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
const safeIdList = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => cleanText(item, 160))
  .filter((item) => STABLE_ID.test(item) && !FORBIDDEN_REQUEST.test(item)))];

export const normalizeContextNeed = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const need = cleanText(value.need, 320);
  const query = cleanText(value.query, 500);
  const sourceKinds = [...new Set((Array.isArray(value.sourceKinds) ? value.sourceKinds : [])
    .map((item) => cleanText(item, 32).toLowerCase())
    .filter((item) => SOURCE_KIND_ALLOWLIST.has(item)))]
    .slice(0, SOURCE_KIND_ALLOWLIST.size);
  if (!need || !query || !sourceKinds.length || FORBIDDEN_REQUEST.test(`${need}\n${query}`)) return null;
  const id = cleanText(value.id ?? value.needId, 96);
  return {
    id: STABLE_ID.test(id) ? id : `need-${Math.abs([...`${need}\n${query}`].reduce((hash, character) => ((hash * 31) + character.codePointAt(0)) | 0, 7)).toString(36)}`,
    need,
    sourceKinds,
    query,
    preferredDocumentIds: safeIdList(value.preferredDocumentIds),
    entityIds: safeIdList(value.entityIds),
    blocking: value.blocking === true,
    reason: cleanText(value.reason, 320),
  };
};

const needIdentity = (need) => [
  need.need.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, ""),
  need.query.toLocaleLowerCase("zh-CN").replace(/[\s\p{P}\p{S}]+/gu, ""),
].join("|");

export const normalizeContextGapAssessment = (value) => {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const sufficient = source.sufficient === true;
  const confidenceValue = cleanText(source.confidence, 16).toLowerCase();
  const confidence = CONFIDENCE_ALLOWLIST.has(confidenceValue) ? confidenceValue : "medium";
  const needs = [];
  const identities = new Set();
  if (!sufficient) {
    for (const candidate of Array.isArray(source.needs) ? source.needs : []) {
      const normalized = normalizeContextNeed(candidate);
      if (!normalized) continue;
      const identity = needIdentity(normalized);
      if (identities.has(identity)) continue;
      identities.add(identity);
      needs.push(normalized);
    }
  }
  return { schemaVersion: CONTEXT_GAP_SCHEMA_VERSION, sufficient, confidence, needs };
};

export const contextGapBudget = (profile = "regular") => {
  const source = profile && typeof profile === "object" ? profile : {};
  const highImpact = profile === "high-impact" || profile === "high" || source.highImpact === true || source.profile === "high-impact";
  const round = highImpact && Number(source.round) >= 2 ? 2 : 1;
  return highImpact
    ? { profile: "high-impact", maxDocuments: Number.POSITIVE_INFINITY, maxCharacters: Number.POSITIVE_INFINITY, maxRounds: 2, round }
    : { profile: "regular", maxDocuments: Number.POSITIVE_INFINITY, maxCharacters: Number.POSITIVE_INFINITY, maxRounds: 1, round: 1 };
};

export const contextAssessmentRequiresBroker = (value) => {
  const normalized = normalizeContextGapAssessment(value);
  return normalized.sufficient === false && normalized.needs.length > 0;
};
