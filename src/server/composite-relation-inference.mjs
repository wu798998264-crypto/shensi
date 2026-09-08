import { createHash } from "node:crypto";

export const COMPOSITE_RELATION_SCHEMA_VERSION = 2;
export const COMPOSITE_RELATION_INFERENCE_VERSION = "2.0.0";

const RELATION_TYPES = new Set(["parallel", "primary-secondary", "organization"]);
const ROLE_TYPES = new Set(["peer", "primary", "secondary", "upper", "lower"]);
const list = (value) => Array.isArray(value) ? value : [];
const clean = (value) => String(value ?? "").trim();
const unique = (values) => [...new Set(list(values).map(clean).filter(Boolean))];
const sha256 = (value) => createHash("sha256").update(String(value), "utf8").digest("hex");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const relationSettings = (manifest = {}) => manifest.composite || manifest.compositeSkill || manifest.capabilityStructure || {};
const manifestRelations = (manifest = {}) => {
  const settings = relationSettings(manifest);
  if (settings.relations && typeof settings.relations === "object") return settings.relations;
  return manifest.relations && typeof manifest.relations === "object" ? manifest.relations : {};
};

const roleForIndex = (relationType, index) => {
  if (relationType === "primary-secondary") return index === 0 ? "primary" : "secondary";
  if (relationType === "organization") return index === 0 ? "upper" : "lower";
  return "peer";
};

const relationForRole = (role) => {
  if (["primary", "secondary"].includes(role)) return "primary-secondary";
  if (["upper", "lower"].includes(role)) return "organization";
  if (role === "peer") return "parallel";
  return "";
};

const SIGNALS = Object.freeze({
  organization: /组织关系|组织结构|上位|下位|层级|总领|统领|upper|lower|hierarch|leader|member/i,
  "primary-secondary": /主次关系|主次结构|主要|次要|主笔|副笔|默认|备选|备用|primary|secondary|fallback|main/i,
  parallel: /并行关系|并行结构|并行|同级|平级|peer|parallel/i,
});

const LEADER_SIGNALS = Object.freeze({
  organization: /上位|总领|统领|通用|核心|upper|leader|general|core/i,
  "primary-secondary": /主要|主笔|默认|首选|primary|main|default/i,
});

const relationSignals = (text) => Object.entries(SIGNALS)
  .filter(([, pattern]) => pattern.test(clean(text)))
  .map(([type]) => type);

const relationEntryForScope = (manifest, scope) => {
  const relations = manifestRelations(manifest);
  const keys = unique([scope.scopeId, scope.scopePath, scope.scopePath || "root", scope.scopeId?.replace(/^(?:group|module):/, "")]);
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(relations, key)) return { key, value: relations[key] };
  }
  const settings = relationSettings(manifest);
  if (scope.scopePath === "root" && (settings.relationType || settings.relation)) {
    return { key: "root", value: settings.relationType || settings.relation };
  }
  return null;
};

const memberReferenceMap = (members) => {
  const map = new Map();
  for (const member of members) {
    for (const ref of unique([member.ref, ...list(member.aliases)])) {
      if (!map.has(ref)) map.set(ref, member.ref);
    }
  }
  return map;
};

const normalizedConfirmedRelation = (scope, confirmed) => {
  if (!confirmed) return null;
  const relationType = RELATION_TYPES.has(clean(confirmed.relationType)) ? clean(confirmed.relationType) : "";
  const orderedMembers = unique(confirmed.orderedMembers);
  const expected = unique(scope.members.map((member) => member.ref));
  if (!relationType) throw new Error(`关系“${scope.label || scope.scopePath}”缺少有效类型`);
  if (orderedMembers.length !== expected.length || expected.some((ref) => !orderedMembers.includes(ref))) {
    throw new Error(`关系“${scope.label || scope.scopePath}”确认的节点与包内结构不一致`);
  }
  return { relationType, orderedMembers };
};

const explicitManifestDecision = ({ scope, entry }) => {
  const members = scope.members;
  const refMap = memberReferenceMap(members);
  const conflicts = [];
  if (typeof entry.value === "string") {
    const relationType = RELATION_TYPES.has(clean(entry.value)) ? clean(entry.value) : "parallel";
    if (!RELATION_TYPES.has(clean(entry.value))) conflicts.push(`Manifest 的关系类型无效：${clean(entry.value) || "空"}`);
    return {
      relationType,
      orderedMembers: members.map((member) => member.ref),
      source: "legacy-manifest",
      confidence: RELATION_TYPES.has(clean(entry.value)) ? 0.6 : 0,
      evidence: [{ kind: "explicit-type", value: `${entry.key} = ${clean(entry.value) || "parallel"}` }],
      conflicts,
      requiresConfirmation: true,
    };
  }
  const declaration = entry.value && typeof entry.value === "object" ? entry.value : {};
  const relationType = RELATION_TYPES.has(clean(declaration.type || declaration.relationType))
    ? clean(declaration.type || declaration.relationType) : "parallel";
  if (!RELATION_TYPES.has(clean(declaration.type || declaration.relationType))) conflicts.push(`Manifest 的关系类型无效：${clean(declaration.type || declaration.relationType) || "空"}`);
  const declaredMembers = list(declaration.members);
  const resolved = [];
  const roles = [];
  for (const declared of declaredMembers) {
    const declaredRef = clean(declared?.ref);
    const ref = refMap.get(declaredRef);
    const role = clean(declared?.role);
    if (!ref) conflicts.push(`Manifest 引用了不存在的节点：${declaredRef || "空引用"}`);
    if (!ROLE_TYPES.has(role)) conflicts.push(`节点“${declaredRef || "空引用"}”的角色无效：${role || "空"}`);
    if (ref && ROLE_TYPES.has(role)) {
      resolved.push(ref);
      roles.push({ ref, role });
    }
  }
  const expectedRefs = members.map((member) => member.ref);
  if (unique(resolved).length !== resolved.length) conflicts.push("Manifest 的关系成员存在重复引用");
  if (expectedRefs.some((ref) => !resolved.includes(ref)) || resolved.some((ref) => !expectedRefs.includes(ref))) {
    conflicts.push("Manifest 的关系成员没有完整覆盖当前层级");
  }
  if (relationType === "parallel" && roles.some(({ role }) => role !== "peer")) conflicts.push("并行关系只能使用 peer 角色");
  if (relationType === "primary-secondary") {
    if (roles.filter(({ role }) => role === "primary").length !== 1) conflicts.push("主次关系必须且只能声明一个 primary");
    if (roles.some(({ role }) => !["primary", "secondary"].includes(role))) conflicts.push("主次关系只能使用 primary/secondary 角色");
  }
  if (relationType === "organization") {
    if (roles.filter(({ role }) => role === "upper").length !== 1) conflicts.push("组织关系必须且只能声明一个 upper");
    if (roles.some(({ role }) => !["upper", "lower"].includes(role))) conflicts.push("组织关系只能使用 upper/lower 角色");
  }
  const rank = (role) => role === "primary" || role === "upper" ? 0 : 1;
  const orderedMembers = roles.length === expectedRefs.length
    ? [...roles].sort((left, right) => rank(left.role) - rank(right.role)).map(({ ref }) => ref)
    : expectedRefs;
  return {
    relationType,
    orderedMembers,
    source: "manifest",
    confidence: conflicts.length ? 0 : 1,
    evidence: roles.map(({ ref, role }) => ({ kind: "explicit-role", value: `${ref} = ${role}` })),
    conflicts,
    requiresConfirmation: conflicts.length > 0,
  };
};

const childMetadataDecision = (scope) => {
  const declarations = scope.members
    .map((member) => ({ ref: member.ref, role: clean(member.compositeRole) }))
    .filter(({ role }) => role);
  if (!declarations.length) return null;
  const conflicts = [];
  const relationTypes = unique(declarations.map(({ role }) => relationForRole(role)).filter(Boolean));
  if (declarations.some(({ role }) => !ROLE_TYPES.has(role))) conflicts.push("子 Skill 的 composite_role 包含无效角色");
  if (relationTypes.length !== 1) conflicts.push("子 Skill 的 composite_role 同时声明了不同关系类型");
  const relationType = relationTypes[0] || "parallel";
  if (declarations.length !== scope.members.length) conflicts.push("只有部分子 Skill 声明了 composite_role");
  if (relationType === "parallel" && declarations.some(({ role }) => role !== "peer")) conflicts.push("并行关系只能使用 peer 角色");
  if (relationType === "primary-secondary" && declarations.filter(({ role }) => role === "primary").length !== 1) conflicts.push("主次关系必须且只能有一个 primary");
  if (relationType === "organization" && declarations.filter(({ role }) => role === "upper").length !== 1) conflicts.push("组织关系必须且只能有一个 upper");
  const primaryRole = relationType === "organization" ? "upper" : relationType === "primary-secondary" ? "primary" : "peer";
  const declaredRole = new Map(declarations.map(({ ref, role }) => [ref, role]));
  const orderedMembers = [...scope.members]
    .sort((left, right) => Number(declaredRole.get(right.ref) === primaryRole) - Number(declaredRole.get(left.ref) === primaryRole))
    .map((member) => member.ref);
  return {
    relationType,
    orderedMembers,
    source: "child-metadata",
    confidence: conflicts.length ? 0 : 0.9,
    evidence: declarations.map(({ ref, role }) => ({ kind: "composite-role", value: `${ref} = ${role}` })),
    conflicts,
    requiresConfirmation: conflicts.length > 0,
  };
};

const heuristicDecision = (scope) => {
  const evidenceLevels = [
    { kind: "directory", confidence: 0.6, value: [scope.scopePath, ...scope.members.map((member) => member.path)].join("\n") },
    { kind: "name-description", confidence: 0.3, value: scope.members.map((member) => `${member.name}\n${member.description}`).join("\n") },
    { kind: "body", confidence: 0.1, value: scope.members.map((member) => clean(member.body).slice(0, 1_000)).join("\n") },
  ];
  let selected = null;
  const conflicts = [];
  for (const level of evidenceLevels) {
    const signals = relationSignals(level.value);
    if (!signals.length) continue;
    if (signals.length > 1) {
      conflicts.push(`${level.kind} 同时出现${signals.join("、")}关系证据`);
      selected = { ...level, relationType: "parallel" };
    } else {
      selected = { ...level, relationType: signals[0] };
    }
    break;
  }
  const relationType = selected?.relationType || "parallel";
  let orderedMembers = scope.members.map((member) => member.ref);
  if (relationType !== "parallel") {
    const roleCandidates = [];
    for (const level of evidenceLevels) {
      const pattern = LEADER_SIGNALS[relationType];
      const matches = scope.members.filter((member) => {
        const text = level.kind === "directory" ? member.path
          : level.kind === "name-description" ? `${member.name}\n${member.description}` : clean(member.body).slice(0, 1_000);
        return pattern.test(text);
      });
      if (matches.length) {
        roleCandidates.push(...matches.map((member) => ({ ref: member.ref, confidence: level.confidence, kind: level.kind })));
        break;
      }
    }
    const leaderRefs = unique(roleCandidates.map(({ ref }) => ref));
    if (leaderRefs.length > 1) conflicts.push(`识别出多个${relationType === "organization" ? "上位" : "主要"}节点`);
    if (leaderRefs.length === 1) orderedMembers = [leaderRefs[0], ...orderedMembers.filter((ref) => ref !== leaderRefs[0])];
    if (!leaderRefs.length) conflicts.push(`没有可靠识别出${relationType === "organization" ? "上位" : "主要"}节点`);
  }
  const confidence = selected?.confidence || 0;
  return {
    relationType,
    orderedMembers,
    source: selected?.kind || "default",
    confidence: conflicts.length ? Math.min(confidence, 0.59) : confidence,
    evidence: selected ? [{ kind: selected.kind, value: `${relationType}（${Math.round(selected.confidence * 100)}%）` }] : [{ kind: "default", value: "没有关系证据，默认建议并行" }],
    conflicts,
    requiresConfirmation: confidence < 0.9 || conflicts.length > 0,
  };
};

export const analyzeCompositeRelationScope = ({ manifest = {}, scope = {}, confirmedRelations = [] } = {}) => {
  const normalizedScope = {
    scopeId: clean(scope.scopeId),
    scopePath: clean(scope.scopePath) || "root",
    scopeKind: clean(scope.scopeKind) || "module",
    label: clean(scope.label) || clean(scope.scopePath) || "root",
    members: list(scope.members).map((member, index) => ({
      ref: clean(member?.ref) || `member:${index + 1}`,
      aliases: unique(member?.aliases),
      name: clean(member?.name) || `节点 ${index + 1}`,
      description: clean(member?.description),
      body: clean(member?.body),
      path: clean(member?.path),
      compositeRole: clean(member?.compositeRole || member?.composite_role),
    })),
  };
  const confirmed = list(confirmedRelations).find((item) => clean(item?.scopeId) === normalizedScope.scopeId);
  const confirmedDecision = normalizedConfirmedRelation(normalizedScope, confirmed);
  let decision;
  if (confirmedDecision) {
    decision = {
      ...confirmedDecision,
      source: "author-confirmed",
      confidence: 1,
      evidence: [{ kind: "author-confirmation", value: "用户在导入预览中确认" }],
      conflicts: [],
      requiresConfirmation: false,
    };
  } else {
    const manifestEntry = relationEntryForScope(manifest, normalizedScope);
    decision = manifestEntry ? explicitManifestDecision({ scope: normalizedScope, entry: manifestEntry })
      : childMetadataDecision(normalizedScope) || heuristicDecision(normalizedScope);
  }
  const orderedMembers = unique(decision.orderedMembers);
  const memberByRef = new Map(normalizedScope.members.map((member) => [member.ref, member]));
  return {
    scopeId: normalizedScope.scopeId,
    scopePath: normalizedScope.scopePath,
    scopeKind: normalizedScope.scopeKind,
    label: normalizedScope.label,
    relationType: decision.relationType,
    orderedMembers,
    members: orderedMembers.map((ref, index) => ({
      ref,
      name: memberByRef.get(ref)?.name || ref,
      role: roleForIndex(decision.relationType, index),
    })),
    source: decision.source,
    confidence: decision.confidence,
    evidence: decision.evidence,
    conflicts: decision.conflicts,
    requiresConfirmation: decision.requiresConfirmation,
  };
};

export const compositeTopologyHash = ({ topology = {}, relationDecisions = [] } = {}) => sha256(canonicalJson({
  topology,
  relations: list(relationDecisions).map((decision) => ({
    scopeId: decision.scopeId,
    relationType: decision.relationType,
    orderedMembers: decision.orderedMembers,
  })),
}));

export const compositeManifestRelations = (relationDecisions = []) => Object.fromEntries(list(relationDecisions).map((decision) => [
  decision.scopeId,
  {
    type: decision.relationType,
    members: list(decision.members).map((member) => ({ ref: member.ref, role: member.role })),
  },
]));

export const compositeRelationAnalysisSummary = (relationDecisions = []) => {
  const decisions = list(relationDecisions);
  const conflicts = decisions.flatMap((decision) => list(decision.conflicts).map((message) => ({
    scopeId: decision.scopeId,
    scopePath: decision.scopePath,
    message,
  })));
  return {
    conflicts,
    requiresConfirmation: decisions.some((decision) => decision.requiresConfirmation || decision.conflicts.length),
    minimumConfidence: decisions.length ? Math.min(...decisions.map((decision) => Number(decision.confidence) || 0)) : 1,
  };
};
