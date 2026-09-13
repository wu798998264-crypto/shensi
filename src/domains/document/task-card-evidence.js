const normalizedReadKind = (item = {}) => (item?.kind === "skill" ? "skill" : "document");
const INTERNAL_AGENT_CONTRACT_TITLES = new Set(["神思任务路由", "神思运行规范"]);

const internalAgentContractRead = (item = {}) => {
  const candidates = [item.title, item.name, item.id, item.documentId, item.skillId]
    .map((value) => String(value || "").trim().replace(/\.md$/iu, ""));
  return candidates.some((value) => INTERNAL_AGENT_CONTRACT_TITLES.has(value));
};

const visibleActualRead = (item = {}) => {
  if (!item || typeof item !== "object" || item.userVisible === false || internalAgentContractRead(item)) return false;
  const kind = normalizedReadKind(item);
  const hasReadableContent = Number(item.characters) > 0
    || Number(item.sourceCharacters) > 0
    || Number(item.chunksRead) > 0;
  const hasSkillIdentity = kind === "skill"
    && Boolean(String(item.title || item.name || item.id || "").trim());
  return hasReadableContent || hasSkillIdentity;
};

const actualReadIdentity = (item = {}) => {
  const kind = normalizedReadKind(item);
  const identity = item.id || item.documentId || item.skillId || item.title || item.name || "";
  return `${kind}:${String(identity).trim().toLowerCase()}`;
};

export const taskCardActualReadEvidence = (actualReads = []) => {
  const merged = new Map();
  for (const item of Array.isArray(actualReads) ? actualReads : []) {
    if (!visibleActualRead(item)) continue;
    const key = actualReadIdentity(item);
    if (!key.endsWith(":")) {
      const previous = merged.get(key);
      merged.set(key, previous
        ? { ...previous, ...item, fullText: previous.fullText === true || item.fullText === true }
        : { ...item });
    }
  }
  return [...merged.values()].map((item) => ({
    ...item,
    kind: normalizedReadKind(item),
    title: String(item.title || item.name || item.id || "").trim(),
    detail: item.fullText === true ? "全文" : item.readKind === "search_excerpt" ? "检索片段" : "部分内容",
  }));
};
