const unique = (values) => [...new Set(values.filter(Boolean))];

export const memoryDocumentIds = (scriptDomain = false) => scriptDomain ? {
  snapshot: "script-memory-snapshot",
  foreshadowing: "script-memory-foreshadowing",
  firstAppearance: "script-memory-first-appearance",
  release: "script-memory-release",
  audience: "script-memory-audience",
} : {
  snapshot: "memory-snapshot",
  foreshadowing: "memory-foreshadowing",
  firstAppearance: "memory-first-appearance",
  release: "memory-release",
  audience: "memory-reader",
};

export const buildMemoryReadPlan = ({
  targetDocumentId = "",
  scriptDomain = false,
  outlineDocumentId = "",
  explicitIds = [],
  availableIds = [],
  substantiveIds = [],
  unitMemoryIds = [],
} = {}) => {
  const available = new Set(availableIds);
  const substantive = new Set(substantiveIds);
  const unitMemory = new Set(unitMemoryIds);
  const ids = memoryDocumentIds(scriptDomain);
  const unitMatch = String(targetDocumentId).match(scriptDomain ? /^script-episode-(\d+)$/ : /^chapter-(\d+)$/);
  const unitNumber = Number(unitMatch?.[1] ?? 0);
  const outlineId = String(outlineDocumentId || "").trim()
    || (unitNumber ? (scriptDomain ? `script-outline-episode-${unitNumber}` : `outline-chapter-${unitNumber}`) : "");
  const seriesId = scriptDomain ? "script-outline-series" : "outline-series";
  const previousIds = unitNumber > 1
    ? Array.from({ length: Math.min(2, unitNumber - 1) }, (_, index) => scriptDomain
      ? `script-episode-${unitNumber - index - 1}`
      : `chapter-${unitNumber - index - 1}`)
    : [];
  const availablePreviousIds = previousIds.filter((id) => available.has(id) && substantive.has(id));
  const availablePreviousMemoryIds = previousIds.filter((id) => available.has(id) && unitMemory.has(id));
  const needsUnitMemoryFallback = unitNumber > 1
    && availablePreviousIds.length < previousIds.length
    && availablePreviousMemoryIds.length > 0;
  const requiredIds = unique([
    ...(available.has(targetDocumentId) ? [targetDocumentId] : []),
    ...explicitIds,
    outlineId,
    ...previousIds,
    // Current state is the authoritative current memory. Historical unit deltas
    // stay attached to their prose documents and are consumed through those same
    // document IDs when prose is unavailable.
    ...(unitNumber > 1 && substantive.has(ids.snapshot) ? [ids.snapshot] : []),
  ]);
  const priorityIds = unique([
    ...requiredIds,
    seriesId,
    "canon-characters",
    "canon-relations",
    ids.snapshot,
    ids.foreshadowing,
    ids.firstAppearance,
    ids.release,
    ids.audience,
  ]).filter((id) => available.has(id) && (requiredIds.includes(id) || substantive.has(id) || id === ids.snapshot));
  const reasonLists = Object.fromEntries(priorityIds.map((id) => {
    const reasons = [];
    if (id === targetDocumentId) reasons.push("本轮目标文档");
    if (explicitIds.includes(id)) reasons.push("用户明确引用");
    if (id === outlineId) reasons.push("当前单元规划");
    if (previousIds.includes(id)) {
      reasons.push(substantive.has(id) ? "直接承接的最近正文" : unitMemory.has(id) ? "正文不可用时的后台单元增量" : "直接承接单元");
    }
    if (id === seriesId) reasons.push("全局剧情与阶段约束");
    if (id === ids.snapshot) reasons.push("人物与世界当前状态");
    if (id === ids.foreshadowing) reasons.push("未兑现伏笔与承诺");
    if ([ids.firstAppearance, ids.release, ids.audience].includes(id)) reasons.push("人物与读者的信息权限");
    if (!reasons.length) reasons.push("核心设定与关系约束");
    return [id, unique(reasons)];
  }));
  const reasons = Object.fromEntries(Object.entries(reasonLists).map(([id, values]) => [id, values.join(" + ")]));
  return {
    unitNumber,
    outlineId,
    previousIds,
    availablePreviousIds,
    availablePreviousMemoryIds,
    needsUnitMemoryFallback,
    requiredIds,
    priorityIds,
    reasons,
    reasonLists,
  };
};

export const memoryQuestionDocumentIds = ({ text = "", scriptDomain = false } = {}) => {
  const ids = memoryDocumentIds(scriptDomain);
  const result = [];
  if (/记忆|事实|正史|确认|设定|连续性|经历|已经发生|冷启动|长篇/.test(text)) result.push(ids.snapshot, ids.firstAppearance, ids.release, ids.audience);
  if (/现在|当前|状态|在哪|位置|伤势|持有|关系|情绪|还活|死亡/.test(text)) result.push(ids.snapshot);
  if (/伏笔|承诺|悬念|回收|未兑现|暗线/.test(text)) result.push(ids.foreshadowing);
  if (/知道|知情|信息|真相|误判|读者|观众|首次|暴露|揭示/.test(text)) result.push(ids.firstAppearance, ids.release, ids.audience);
  return unique(result);
};

const stateKey = (value) => String(value ?? "").trim().split(/[：:，,。；;]/)[0].trim();
const MAX_STATE_ID_LENGTH = 54;

const stableHash = (value = "") => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

export const stableStateEntryId = (value, index = 0) => {
  const source = typeof value === "object" ? value.id || value.name || value.detail : stateKey(value);
  const normalized = String(source ?? "").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, "-").replace(/^-|-$/g, "");
  return normalized ? (normalized.startsWith("state-") ? normalized.slice(0, MAX_STATE_ID_LENGTH) : `state-${normalized.slice(0, 48)}`) : `state-item-${index + 1}`;
};

const normalizedStateEntry = (item, index) => {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const name = String(item.name ?? "").trim();
    const state = String(item.state ?? "").trim();
    const detail = String(item.detail ?? "").trim();
    if (!name && !state && !detail) return null;
    return {
      id: stableStateEntryId(item, index),
      name: name || stateKey(detail) || `状态项${index + 1}`,
      state,
      detail,
      ...(item.operation === "delete" ? { operation: "delete" } : {}),
    };
  }
  const detail = String(item ?? "").trim();
  if (!detail) return null;
  const name = stateKey(detail) || `状态项${index + 1}`;
  return { id: stableStateEntryId(detail, index), name, state: detail.slice(name.length).replace(/^[：:\s]+/, ""), detail };
};

export const normalizeStateEntries = (value) => {
  const entries = (Array.isArray(value) ? value : []).map(normalizedStateEntry).filter(Boolean);
  const usedIds = new Set();
  const exactEntries = new Set();
  const result = [];
  for (const entry of entries) {
    const exactKey = `${entry.id}\u0000${entry.name}\u0000${entry.state}\u0000${entry.detail}\u0000${entry.operation}`;
    if (exactEntries.has(exactKey)) continue;
    exactEntries.add(exactKey);
    let id = entry.id;
    if (usedIds.has(id)) {
      const suffix = stableHash(`${entry.name}|${entry.state}|${entry.detail}`).slice(0, 8);
      id = `${id.slice(0, Math.max(1, MAX_STATE_ID_LENGTH - suffix.length - 1))}-${suffix}`;
      let sequence = 2;
      while (usedIds.has(id)) {
        const tail = `-${sequence}`;
        id = `${entry.id.slice(0, Math.max(1, MAX_STATE_ID_LENGTH - tail.length))}${tail}`;
        sequence += 1;
      }
    }
    usedIds.add(id);
    result.push({ ...entry, id });
  }
  return result;
};

export const mergeStateEntries = ({ current = [], changes = [] } = {}) => {
  const existing = normalizeStateEntries(current);
  const incoming = normalizeStateEntries(changes);
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  const idsByName = new Map();
  for (const entry of existing) {
    const key = entry.name.trim().toLowerCase();
    if (!key) continue;
    const ids = idsByName.get(key) ?? [];
    ids.push(entry.id);
    idsByName.set(key, ids);
  }
  for (const change of incoming) {
    const nameMatches = idsByName.get(change.name.trim().toLowerCase()) ?? [];
    const resolvedId = byId.has(change.id)
      ? change.id
      : nameMatches.length === 1 ? nameMatches[0] : change.id;
    if (change.operation === "delete") {
      byId.delete(resolvedId);
      continue;
    }
    const { operation: _operation, ...upserted } = change;
    byId.set(resolvedId, { ...upserted, id: resolvedId });
  }
  return normalizeStateEntries([...byId.values()]).map(({ operation: _operation, ...entry }) => entry);
};
