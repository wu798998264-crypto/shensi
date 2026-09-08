const clean = (value = "") => String(value ?? "").trim();
const unique = (items = []) => [...new Set(items.map(clean).filter(Boolean))];

const DEPENDENCY_CLAUSE = /@|根据|依据|基于|结合|读取|查看|分析|比较|对比|总结|上面|上述|前文|这篇|该文档|指定资料/u;
const INDEPENDENT_ACTION = /另(?:外|写)|同时(?:写|生成|创作)|并(?:写|生成|创作)|独立(?:写|生成|创作)|回答|解释|建议|讨论|脑暴/u;

export const inferContextSubtasks = ({
  instruction = "",
  missingDependencyIds = [],
  explicitDependencyIds = missingDependencyIds,
  targetDependencyId = "",
  targetMissing = false,
} = {}) => {
  const source = clean(instruction);
  const missing = unique(missingDependencyIds);
  const explicit = new Set(unique(explicitDependencyIds));
  const clauses = source.split(/(?:[。！？；\n]+|，?(?:另外|同时|并且|然后|再者)\s*)/u).map(clean).filter(Boolean);
  const effectiveClauses = clauses.length ? clauses : [source || "current_request"];
  const subtasks = effectiveClauses.map((clause, index) => {
    const dependencyBound = DEPENDENCY_CLAUSE.test(clause)
      || (effectiveClauses.length === 1 && missing.some((id) => explicit.has(id)));
    const mutation = /修改|改写|重写|替换|写入|落盘|更新|删除|补写|续写/u.test(clause);
    const dependencyIds = [
      ...(dependencyBound ? missing.filter((id) => explicit.has(id)) : []),
      ...(targetMissing && mutation && targetDependencyId ? [targetDependencyId] : []),
    ];
    return {
      id: `subtask-${index + 1}`,
      description: clause,
      dependencyIds: unique(dependencyIds),
      required: true,
      nativeFallbackAllowed: !mutation,
      assumptions: [],
    };
  });
  if (subtasks.length > 1 && !subtasks.some((item) => item.dependencyIds.length === 0) && INDEPENDENT_ACTION.test(source)) {
    subtasks.at(-1).dependencyIds = [];
  }
  return subtasks;
};

export const planContextDependencies = ({ dependencies = [], subtasks = [], userInsists = false } = {}) => {
  const normalizedDependencies = dependencies.map((item) => ({
    id: clean(item?.id),
    status: clean(item?.status || (item?.available ? "available" : "missing")),
    explicit: item?.explicit === true,
    source: clean(item?.source),
    reason: clean(item?.reason),
  })).filter((item) => item.id);
  const available = new Set(normalizedDependencies.filter((item) => ["available", "recovered"].includes(item.status)).map((item) => item.id));
  const unavailable = new Map(normalizedDependencies.filter((item) => !available.has(item.id)).map((item) => [item.id, item]));
  const recovered = normalizedDependencies.filter((item) => item.status === "recovered").map((item) => ({ id: item.id, source: item.source }));
  const warnings = normalizedDependencies
    .filter((item) => unavailable.has(item.id) && !item.explicit)
    .map((item) => ({ id: item.id, reason: item.reason || item.status, kind: "discovered_dependency_unavailable" }));
  const blockedSubtasks = [];
  const runnableSubtasks = [];

  for (const item of subtasks) {
    const id = clean(item?.id) || `subtask-${runnableSubtasks.length + blockedSubtasks.length + 1}`;
    const missingDependencies = unique(item?.dependencyIds).filter((dependencyId) => unavailable.has(dependencyId));
    if (!missingDependencies.length) {
      runnableSubtasks.push({ id, assumptions: unique(item?.assumptions), description: clean(item?.description) });
      continue;
    }
    if (userInsists && item?.nativeFallbackAllowed === true) {
      runnableSubtasks.push({
        id,
        assumptions: unique([...(item?.assumptions || []), ...missingDependencies.map((dependencyId) => `未读取资料 ${dependencyId}；不得引用或假称已读`)]),
        description: clean(item?.description),
        nativeFallback: true,
      });
      warnings.push(...missingDependencies.map((dependencyId) => ({ id: dependencyId, kind: "native_fallback_without_read", reason: unavailable.get(dependencyId)?.reason || "unavailable" })));
      continue;
    }
    blockedSubtasks.push({ id, missingDependencies, description: clean(item?.description) });
  }

  return {
    recovered,
    warnings,
    blockedSubtasks,
    runnableSubtasks,
    terminal: blockedSubtasks.length > 0 && runnableSubtasks.length === 0,
  };
};

export const recoverContextDependency = async ({ dependency = {}, resolvers = {} } = {}) => {
  const attempts = [
    ["resolved_reference", resolvers.resolveReference],
    ["current_revision", resolvers.readCurrentRevision],
    ["authorized_path", resolvers.readAuthorizedPath],
    ["current_replacement", resolvers.findCurrentReplacement],
  ];
  for (const [source, resolver] of attempts) {
    if (typeof resolver !== "function") continue;
    const result = await resolver(dependency);
    if (result?.available === true || clean(result?.text)) return { ...dependency, status: "recovered", source, result };
  }
  return { ...dependency, status: clean(dependency?.status) || "missing", source: "", result: null };
};
