const list = (value) => Array.isArray(value) ? value : [];
const clean = (value) => String(value ?? "").replace(/[\r\n#]+/gu, " ").replace(/\s+/gu, " ").trim();
const limited = (value, maximum = 240) => clean(value).slice(0, maximum);

const relationLabel = (value) => ({
  parallel: "并行",
  "primary-secondary": "主次",
  organization: "组织",
}[value] || "并行");

const relationRole = (relationType, role, index = 0) => {
  if (role) return role;
  if (relationType === "primary-secondary") return index === 0 ? "primary" : "secondary";
  if (relationType === "organization") return index === 0 ? "upper" : "lower";
  return "peer";
};

const roleLabel = (value) => ({
  peer: "并行",
  primary: "主要",
  secondary: "次要",
  upper: "上位",
  lower: "下位",
}[value] || "并行");

const identityVariants = (value) => {
  const id = clean(value);
  if (!id) return [];
  const plain = id.replace(/^user:/u, "");
  return [...new Set([id, plain, `user:${plain}`])];
};

const skillIdentity = (skill = {}) => clean(skill.id || skill.skillId);

const skillIndex = (skills = []) => {
  const result = new Map();
  for (const skill of list(skills)) {
    for (const id of identityVariants(skillIdentity(skill))) if (!result.has(id)) result.set(id, skill);
  }
  return result;
};

const topologyBundle = (topology = {}) => topology.capabilityTemplate?.template
  ? topology.capabilityTemplate
  : topology.template ? topology : null;

const topologyMaps = (bundle = {}) => ({
  groups: new Map(list(bundle.groups).map((group) => [group.id, group])),
  modules: new Map(list(bundle.modules).map((module) => [module.id, module])),
});

const boundSkillId = (slot = {}) => clean(slot.skillId || slot.fixedSlotId);

const reachablePlacements = (topology = {}, { includeDisabled = true } = {}) => {
  const bundle = topologyBundle(topology);
  if (!bundle?.template) return [];
  const maps = topologyMaps(bundle);
  const placements = [];
  const visit = (nodeType, node, path, parentEnabled, ancestors) => {
    if (!node || ancestors.has(`${nodeType}:${node.id}`)) return;
    const enabled = parentEnabled && node.disabled !== true;
    if (!includeDisabled && !enabled) return;
    const nextAncestors = new Set(ancestors).add(`${nodeType}:${node.id}`);
    if (nodeType === "module") {
      list(node.slots).forEach((slot, index) => placements.push({
        kind: "slot",
        node: slot,
        module: node,
        path,
        enabled: enabled && slot.disabled !== true,
        role: relationRole(node.relationType, slot.role, index),
        relationType: node.relationType || "parallel",
      }));
      return;
    }
    list(node.items).forEach((item, index) => {
      const childType = item.targetType === "group" ? "group" : "module";
      const child = childType === "group" ? maps.groups.get(item.targetId) : maps.modules.get(item.targetId);
      if (!child) return;
      const placement = {
        kind: childType,
        node: child,
        item,
        path,
        enabled: enabled && child.disabled !== true,
        role: relationRole(node.relationType, item.role, index),
        relationType: node.relationType || "parallel",
      };
      placements.push(placement);
      visit(childType, child, [...path, child.name || child.id], placement.enabled, nextAncestors);
    });
  };
  visit("template", bundle.template, [bundle.template.name || bundle.template.id], true, new Set());
  return placements;
};

export const managedPanelSkillIds = (topology = {}) => {
  const identities = new Set();
  for (const placement of reachablePlacements(topology, { includeDisabled: false })) {
    if (placement.kind !== "slot") continue;
    for (const id of identityVariants(boundSkillId(placement.node))) identities.add(id);
  }
  return identities;
};

const messageText = (message = {}) => {
  if (typeof message.content === "string") return message.content;
  return list(message.content).map((part) => typeof part === "string" ? part : part?.text || "").join("\n");
};

const lastUserInstruction = (request = {}) => {
  const messages = list(request.messages);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messageText(messages[index]);
  }
  return clean(request.instruction || request.prompt);
};

const explicitReferences = (request = {}) => list(request.selectedSkills).flatMap((selection) => {
  if (typeof selection === "string") return [selection];
  return [selection?.id, selection?.skillId, selection?.skill_id, selection?.name, selection?.referenceKey];
}).map(clean).filter(Boolean);

const escapeExpression = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const explicitlyNamesSkill = (source, skill = {}) => {
  const names = [skill.name, skill.id, clean(skill.id).replace(/^(?:builtin|official|user):/u, "")]
    .map(clean).filter((value) => value.length >= 2);
  return names.some((name) => {
    const escaped = escapeExpression(name);
    return new RegExp(`@\\s*${escaped}(?![\\p{L}\\p{N}_.:-])`, "iu").test(source)
      || new RegExp(`[“\"']${escaped}[”\"']`, "iu").test(source)
      || new RegExp(`(?:使用|调用|启用|指定|选择|切换到|让)\\s*(?:名为|叫做)?\\s*${escaped}`, "iu").test(source);
  });
};

export const filterAgentSkillCatalog = ({ catalog = [], routeTopology = null, request = {} } = {}) => {
  const panelIds = managedPanelSkillIds(routeTopology || {});
  const references = new Set(explicitReferences(request).flatMap(identityVariants));
  const instruction = lastUserInstruction(request);
  return list(catalog).filter((skill) => {
    const ids = identityVariants(skillIdentity(skill));
    if (ids.some((id) => panelIds.has(id) || references.has(id))) return true;
    if (explicitReferences(request).some((reference) => clean(skill.name) === reference)) return true;
    return explicitlyNamesSkill(instruction, skill);
  });
};

const field = (label, value) => value ? `${label}=${limited(value)}` : "";
const joined = (values, empty = "未声明") => list(values).map((value) => limited(value, 100)).filter(Boolean).join("、") || empty;

export const buildManagedRouteDocument = ({ topology = {}, skills = [] } = {}) => {
  const bundle = topologyBundle(topology);
  if (!bundle?.template) return "# 当前 Skill 面板任务路由\n\n当前没有可用的面板拓扑；面板外 Skill 仅可由用户明确点名或 @ 引用。";
  const indexedSkills = skillIndex(skills);
  const lines = [
    "# 当前 Skill 面板任务路由",
    "",
    `路由版本：${Math.max(0, Number(topology.revision) || 0)}；拓扑哈希：${clean(topology.hash) || "未生成"}`,
    "",
    "此文档由可信内核根据当前 Skill 面板确定性编译。面板的真实层级、位置、顺序、关系角色、启用状态和 Skill 绑定是自动路由的唯一事实来源；旧路由文字、文件名和单个关键词不能覆盖本快照。",
    "",
    "- 并行：同级能力可按完整任务语义独立或同时调用。",
    "- 主次：第一项为主要，其余为次要；任务明确命中次要时由次要精确替代主要，不自动叠加。",
    "- 组织：第一项为上位，其余为下位；命中下位时同时加载完成该任务所必需的上位能力。",
    "- 面板内且启用的 Skill 才进入自动路由候选。面板外 Skill 只有本轮被用户明确点名或 @ 引用时才临时开放，不能通过普通语义检索自动导航。",
    "- 禁用、失效、未绑定或不在当前拓扑可达路径上的 Skill 不得自动调用。",
    "",
    "## 面板总览",
    "",
    `模板：${limited(bundle.template.name || bundle.template.id)} [${relationLabel(bundle.template.relationType)}]；${field("用途", bundle.template.description) || "用途=统筹当前面板能力"}；${field("适用场景", bundle.template.triggerRules) || "适用场景=按本轮任务完整语义判断"}`,
    "",
    "## 当前位置、能力与适用场景",
    "",
  ];
  const placements = reachablePlacements(topology, { includeDisabled: true });
  const representedSlotIds = new Set(placements
    .filter((placement) => placement.kind === "slot")
    .flatMap((placement) => [clean(placement.node.id), clean(placement.node.id).replace(/^slot:/u, "")].filter(Boolean)));
  let ordinal = 0;
  for (const placement of placements) {
    if (placement.kind === "group") {
      ordinal += 1;
      lines.push(`### ${ordinal}. 模组：${limited(placement.node.name || placement.node.id)}`);
      lines.push("");
      lines.push(`- 位置：${placement.path.map((part) => limited(part, 100)).join(" / ")}；父容器关系=${relationLabel(placement.relationType)}；角色=${roleLabel(placement.role)}；状态=${placement.enabled ? "启用" : "禁用"}`);
      lines.push(`- 自身关系：${relationLabel(placement.node.relationType)}；${field("用途", placement.node.description) || "用途=组织下级能力"}；${field("适用场景", placement.node.triggerRules) || "适用场景=继承模板与下级能力声明"}`);
      lines.push("");
      continue;
    }
    if (placement.kind === "module") {
      ordinal += 1;
      lines.push(`### ${ordinal}. 模块：${limited(placement.node.name || placement.node.id)}`);
      lines.push("");
      lines.push(`- 位置：${placement.path.map((part) => limited(part, 100)).join(" / ")}；父容器关系=${relationLabel(placement.relationType)}；角色=${roleLabel(placement.role)}；状态=${placement.enabled ? "启用" : "禁用"}`);
      lines.push(`- 自身关系：${relationLabel(placement.node.relationType)}；${field("用途", placement.node.description) || "用途=承载具体 Skill 插槽"}；${field("适用场景", placement.node.triggerRules) || "适用场景=由插槽能力和任务交付物共同判断"}`);
      lines.push("");
      continue;
    }
    const slot = placement.node;
    const id = boundSkillId(slot);
    const skill = identityVariants(id).map((variant) => indexedSkills.get(variant)).find(Boolean);
    const capabilities = list(slot.capabilities).length ? slot.capabilities : skill?.capabilities;
    const purpose = slot.description || skill?.description || placement.module.description;
    const scenario = slot.triggerRules || placement.module.triggerRules;
    const routeFields = [
      field("能力", joined(capabilities, "模型基础能力")),
      field("用途", purpose || "按 Skill 自身说明执行"),
      field("适用场景", scenario || "按交付物、阶段和完整语义判断"),
      list(slot.phases).length ? field("阶段", joined(slot.phases)) : "",
      list(slot.stages).length ? field("运行阶段", joined(slot.stages)) : "",
    ].filter(Boolean).join("；");
    lines.push(`- 插槽 [${roleLabel(placement.role)}] ${limited(slot.name || slot.id)} → ${limited(skill?.name || id || "未绑定 Skill")}（${limited(id || "无ID")}）；状态=${placement.enabled && id ? "启用" : "不参与自动路由"}；${routeFields}`);
  }
  const unexpandedSlots = list(topology.slots).filter((slot) => {
    const id = clean(slot.id);
    const alreadyNamed = clean(slot.name) && lines.some((line) => line.includes(clean(slot.name)));
    return id && (!representedSlotIds.has(id) && !representedSlotIds.has(id.replace(/^slot:/u, "")) || !alreadyNamed);
  });
  if (unexpandedSlots.length) {
    lines.push("", "## 面板注册槽位（模板树未重复展开）", "");
    const groupsById = new Map(list(topology.groups).map((group) => [group.id, group]));
    for (const slot of unexpandedSlots) {
      const id = boundSkillId(slot) || clean(slot.id);
      const skill = identityVariants(id).map((variant) => indexedSkills.get(variant)).find(Boolean);
      const group = groupsById.get(slot.parentGroupId);
      const capabilities = list(slot.capabilities).length ? slot.capabilities : skill?.capabilities;
      lines.push(`- 注册槽位 ${limited(slot.name || slot.id)} → ${limited(skill?.name || id || "未绑定 Skill")}（${limited(id || "无ID")}）；位置=${limited(group?.name || "面板")}; 关系=${relationLabel(group?.groupType)}；状态=${slot.enabled === false ? "不参与自动路由" : "可参与自动路由"}；能力=${joined(capabilities, "模型基础能力")}；用途=${limited(slot.description || skill?.description || "按任务语义调用")}`);
    }
  }
  lines.push("", "## 更新绑定", "", "保存面板、模组、模块、插槽或 Skill 状态后，可信内核递增路由版本、重算拓扑哈希、重新编译本全文，并把面板快照、位置变化、启用 Skill、路由差异和审计结果写入同一条任务路由历史。下一轮任务只读取最新通过校验的版本。", "");
  return lines.join("\n");
};
