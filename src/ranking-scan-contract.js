const SCAN_TYPES = new Set(["long", "short", "cross_platform"]);
const CHANNELS = new Set(["male", "female", "all"]);
const ACQUISITION_MODES = new Set(["direct", "controlled_browser", "user_supplied"]);

const clean = (value, maximum = 160) => String(value ?? "").trim().slice(0, maximum);
const cleanList = (value, maximum = 20) => [...new Set((Array.isArray(value) ? value : [value])
  .map((item) => clean(item))
  .filter(Boolean))].slice(0, maximum);
const stableHash = (value = "") => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};
const defaultId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export const rankingScanIdempotencyKey = (value = {}) => {
  const requestedAt = clean(value.requestedAt || new Date().toISOString(), 80);
  const identity = [
    clean(value.workspaceId),
    clean(value.scanType || "long"),
    cleanList(value.platforms).sort().join(","),
    cleanList(value.rankings).sort().join(","),
    clean(value.channel || "all"),
    clean(value.genre),
    Math.max(1, Math.min(100, Number(value.topN) || 30)),
    requestedAt.slice(0, 10),
  ].join("|");
  return `ranking-scan:${stableHash(identity)}:${requestedAt.slice(0, 10)}`;
};

export const createRankingScanContract = (value = {}, { now = () => new Date(), idFactory = defaultId } = {}) => {
  const requestedAt = clean(value.requestedAt || now().toISOString(), 80);
  const contract = {
    id: clean(value.id) || idFactory("ranking-task"),
    operationId: clean(value.operationId) || idFactory("ranking-operation"),
    workspaceId: clean(value.workspaceId),
    sourceMessageId: clean(value.sourceMessageId),
    scanType: SCAN_TYPES.has(value.scanType) ? value.scanType : "long",
    platforms: cleanList(value.platforms),
    rankings: cleanList(value.rankings),
    channel: CHANNELS.has(value.channel) ? value.channel : "all",
    genre: clean(value.genre),
    topN: Math.max(1, Math.min(100, Number(value.topN) || 30)),
    acquisitionMode: ACQUISITION_MODES.has(value.acquisitionMode) ? value.acquisitionMode : "direct",
    requestedAt,
    status: "pending",
    taskContractType: "read_only_market_research",
    authorizationState: "candidate_only",
    requiredSkillId: "official:bestseller-ranking-scan",
    allowWorkspaceMutation: false,
    allowModelConfigurationMutation: false,
    allowBrowserAccess: value.allowBrowserAccess === true,
    allowAuthenticatedPageAccess: value.allowAuthenticatedPageAccess === true,
    allowSnapshotWrite: value.allowSnapshotWrite === true,
    allowReportLanding: value.allowReportLanding === true,
    targetModuleId: clean(value.targetModuleId),
    targetDocumentId: clean(value.targetDocumentId),
    requestedAgentProfileId: clean(value.requestedAgentProfileId, 240),
    requestedAgentEngine: clean(value.requestedAgentEngine, 80),
    userSuppliedItems: Array.isArray(value.userSuppliedItems)
      ? structuredClone(value.userSuppliedItems.slice(0, Math.max(1, Math.min(100, Number(value.topN) || 30))))
      : [],
    idempotencyKey: "",
  };
  contract.idempotencyKey = clean(value.idempotencyKey, 240) || rankingScanIdempotencyKey(contract);
  return Object.freeze(contract);
};

const KNOWLEDGE_PATTERN = /(?:扫榜|爆款扫榜).{0,20}(?:是什么|什么意思|有什么用|作用|用途|介绍|解释)|(?:是什么|什么意思|介绍一下).{0,20}(?:扫榜|爆款扫榜)|有哪些小说平台/u;
const SCAN_ACTION_PATTERN = /(?:爆款扫榜|长篇扫榜|短篇扫榜|跨平台榜单比较|最近什么题材火|网文市场趋势|扫一下.{0,20}(?:榜|排行)|(?:起点|番茄|晋江|七猫|刺猬猫|点众|黑岩).{0,16}(?:榜|排行|趋势))/u;
const PLATFORM_PATTERNS = Object.freeze({
  qidian: /起点/u,
  fanqie: /番茄/u,
  jjwxc: /晋江/u,
  qimao: /七猫/u,
  ciweimao: /刺猬猫/u,
  dianzhong: /点众/u,
  heiyan: /黑岩/u,
});

export const rankingScanIntent = (text = "", { skillEnabled = true } = {}) => {
  const source = clean(text, 4_000);
  if (!source) return { kind: "none" };
  if (KNOWLEDGE_PATTERN.test(source)) return { kind: "knowledge" };
  const explicit = /@(?:爆款扫榜|bestseller-ranking-scan)/iu.test(source);
  if ((!skillEnabled && !explicit) || (!explicit && !SCAN_ACTION_PATTERN.test(source))) return { kind: "none" };
  const platforms = Object.entries(PLATFORM_PATTERNS).filter(([, pattern]) => pattern.test(source)).map(([id]) => id);
  const scanType = /跨平台/u.test(source) || platforms.length > 1 ? "cross_platform" : /短篇/u.test(source) ? "short" : "long";
  const channel = /男频/u.test(source) ? "male" : /女频/u.test(source) ? "female" : "all";
  const ranking = /新书榜/u.test(source) ? "new-book" : /月票榜/u.test(source) ? "monthly" : /金榜/u.test(source) ? "gold" : /热榜/u.test(source) ? "hot" : "";
  return {
    kind: "scan",
    explicit,
    scanType,
    platforms,
    rankings: ranking ? [ranking] : [],
    channel,
    complete: platforms.length > 0 && Boolean(ranking || /排行|榜单|热榜|金榜/u.test(source)),
  };
};

export const rankingScanCompletionStatus = ({ snapshotSaved = false, reportReturned = false, skillLoaded = true, sourceValidated = true, coverageValidated = true, failedPlatforms = [] } = {}) => {
  if (snapshotSaved && reportReturned && skillLoaded && sourceValidated && coverageValidated && !(failedPlatforms || []).length) return "completed";
  if (snapshotSaved || reportReturned) return "partial";
  return "failed";
};

export const rankingScanWriteBoundary = Object.freeze({
  deliverableType: "market_scan_report",
  authorizationState: "candidate_only",
  allowBodyMutation: false,
  allowTitleMutation: false,
  allowCanonMutation: false,
  allowHistoryMutation: false,
  allowAutomaticLanding: false,
  allowWorkspaceMutation: false,
  allowConfigurationMutation: false,
});
