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

const placementIdentity = (parts = []) => list(parts).map((part) => clean(part)).filter(Boolean).join(">");

const scopedRouteTitle = (kind) => kind === "template" ? "面板路由" : kind === "group" ? "模组路由" : "模块路由";

const scopedRouteText = ({ entry, children = [], revision = 0, topologyHash = "" } = {}) => {
  const node = entry.node || {};
  const lines = [
    `# ${scopedRouteTitle(entry.kind)} · ${limited(entry.name || entry.nodeId)}`,
    "",
    `路由版本：${Math.max(0, Number(revision) || 0)}；拓扑哈希：${clean(topologyHash) || "未生成"}`,
    `位置：${entry.pathNames.map((part) => limited(part, 100)).join(" / ")}`,
    `自身关系：${relationLabel(entry.relationType)}；状态=${entry.enabled ? "启用" : "禁用"}`,
    `具体作用：${limited(node.description || "按当前节点所含能力处理任务", 600)}`,
    `${scopedRouteTitle(entry.kind)}：${limited(node.triggerRules || "根据任务完整语义选择当前层真正需要的成员", 1_200)}`,
    "",
    "## 当前层成员",
    "",
  ];
  for (const child of children) {
    const target = child.kind === "skill" ? `Skill=${limited(child.skillName || child.skillId)}` : `${child.kind === "group" ? "模组" : "模块"}=${limited(child.name || child.nodeId)}`;
    lines.push(`- [${roleLabel(child.parentRole)}] ${target}；placementId=${child.placementId}；状态=${child.enabled ? "启用" : "禁用"}${child.guidance ? `；用途=${limited(child.guidance, 500)}` : ""}`);
  }
  if (entry.kind === "template") {
    lines.push("", "只先选择本轮需要的顶层模组或模块；选中后再读取对应模组路由或模块路由。不得为了浏览完整面板而预读无关分支。");
  } else if (entry.kind === "group") {
    lines.push("", "选中内部模组或模块后继续读取该节点路由。并行成员可独立或组合；主次关系由主要承担默认主责，次要按任务完整语义替代或协作；组织成员命中下位时默认继承上位。具体上位是否参与由最终 Skill 读取计划按任务语义审计决定。");
  } else {
    lines.push("", "读取 Skill 时使用 placementId。组织关系默认加载上位；只有 Agent 明确判断当前输入已具备下位所需信息、当前环节不需要上位能力或用户明确限定下位时，才可携带理由跳过上位。");
  }
  return lines.join("\n");
};

/**
 * Compile the capability template into small, placement-aware route documents.
 * The template remains authoritative; editable prose can explain intent but
 * cannot change members, roles, order, enabled state or ancestry.
 */
export const compileManagedRouteBundle = ({ topology = {}, skills = [] } = {}) => {
  const bundle = topologyBundle(topology);
  const revision = Math.max(0, Number(topology.revision) || 0);
  const topologyHash = clean(topology.hash);
  if (!bundle?.template) return {
    schemaVersion: 1,
    revision,
    topologyHash,
    panel: { placementId: "", text: "# 面板路由\n\n当前没有可用的 Skill 面板。" },
    routes: [],
    skillPlacements: [],
  };
  const indexedSkills = skillIndex(skills);
  const maps = topologyMaps(bundle);
  const routes = [];
  const skillPlacements = [];
  const entries = new Map();
  const visit = ({ kind, node, item = null, parent = null, parentRole = "peer", pathIds = [], pathNames = [], routePlacementIds = [], enabled = true, ancestors = new Set() }) => {
    if (!node || ancestors.has(`${kind}:${node.id}`)) return null;
    const ownEnabled = enabled && node.disabled !== true;
    const segment = item?.id || node.id;
    const nextPathIds = [...pathIds, segment];
    const nextPathNames = [...pathNames, node.name || node.id];
    const placementId = placementIdentity(nextPathIds);
    const entry = {
      placementId,
      kind,
      nodeId: node.id,
      name: node.name || node.id,
      node,
      guidance: node.triggerRules || node.description || "",
      parentPlacementId: parent?.placementId || "",
      parentRole,
      parentRelationType: parent?.relationType || "parallel",
      relationType: node.relationType || "parallel",
      enabled: ownEnabled,
      pathIds: nextPathIds,
      pathNames: nextPathNames,
      childPlacementIds: [],
    };
    entries.set(placementId, entry);
    routes.push(entry);
    const nextRoutePlacementIds = [...routePlacementIds, placementId];
    const nextAncestors = new Set(ancestors).add(`${kind}:${node.id}`);
    const children = kind === "template" || kind === "group" ? list(node.items) : list(node.slots);
    children.forEach((child, index) => {
      const role = relationRole(node.relationType, child.role, index);
      if (kind === "module") {
        const skillId = boundSkillId(child);
        const skill = identityVariants(skillId).map((variant) => indexedSkills.get(variant)).find(Boolean);
        const childPlacementId = placementIdentity([...nextPathIds, child.id || skillId]);
        const skillPlacement = {
          placementId: childPlacementId,
          kind: "skill",
          slotId: clean(child.id),
          skillId,
          skillName: skill?.name || child.name || skillId,
          name: child.name || skill?.name || skillId,
          guidance: child.triggerRules || child.description || skill?.description || "",
          capabilities: list(child.capabilities).length ? [...child.capabilities] : [...list(skill?.capabilities)],
          enabled: ownEnabled && child.disabled !== true && Boolean(skillId) && Boolean(skill),
          parentPlacementId: placementId,
          parentRole: role,
          parentRelationType: node.relationType || "parallel",
          modulePlacementId: placementId,
          routePlacementIds: nextRoutePlacementIds,
          pathIds: [...nextPathIds, child.id || skillId],
          pathNames: [...nextPathNames, child.name || skill?.name || skillId],
          organizationUpperPlacementIds: [],
        };
        entries.set(childPlacementId, skillPlacement);
        skillPlacements.push(skillPlacement);
        entry.childPlacementIds.push(childPlacementId);
        return;
      }
      const childKind = child.targetType === "group" ? "group" : "module";
      const target = childKind === "group" ? maps.groups.get(child.targetId) : maps.modules.get(child.targetId);
      const childEntry = visit({
        kind: childKind,
        node: target,
        item: child,
        parent: entry,
        parentRole: role,
        pathIds: nextPathIds,
        pathNames: nextPathNames,
        routePlacementIds: nextRoutePlacementIds,
        enabled: ownEnabled,
        ancestors: nextAncestors,
      });
      if (childEntry) entry.childPlacementIds.push(childEntry.placementId);
    });
    return entry;
  };
  const panel = visit({ kind: "template", node: bundle.template });
  const defaultSkillPlacements = (placementId, visiting = new Set()) => {
    if (!placementId || visiting.has(placementId)) return [];
    const current = entries.get(placementId);
    if (!current || current.enabled === false) return [];
    if (current.kind === "skill") return [current.placementId];
    const nextVisiting = new Set(visiting).add(placementId);
    const children = current.childPlacementIds.map((id) => entries.get(id)).filter((child) => child?.enabled !== false);
    if (!children.length) return [];
    const selected = current.relationType === "parallel" ? children : children.slice(0, 1);
    return selected.flatMap((child) => defaultSkillPlacements(child.placementId, nextVisiting));
  };
  for (const skillPlacement of skillPlacements) {
    const upperLayers = [];
    let current = skillPlacement;
    while (current?.parentPlacementId) {
      const parent = entries.get(current.parentPlacementId);
      if (!parent) break;
      if (parent.relationType === "organization" && current.parentRole === "lower") {
        const upperChild = parent.childPlacementIds.map((id) => entries.get(id)).find((child) => child?.parentRole === "upper" && child.enabled !== false);
        if (upperChild) upperLayers.push(defaultSkillPlacements(upperChild.placementId));
      }
      current = parent;
    }
    skillPlacement.organizationUpperPlacementIds = [...new Set(upperLayers.reverse().flat())]
      .filter((placementId) => placementId !== skillPlacement.placementId);
  }
  const publicRoute = (entry) => {
    const children = entry.childPlacementIds.map((id) => entries.get(id)).filter(Boolean);
    return {
      placementId: entry.placementId,
      kind: entry.kind,
      nodeId: entry.nodeId,
      name: entry.name,
      parentPlacementId: entry.parentPlacementId,
      parentRole: entry.parentRole,
      relationType: entry.relationType,
      enabled: entry.enabled,
      childPlacementIds: [...entry.childPlacementIds],
      text: scopedRouteText({ entry, children, revision, topologyHash }),
    };
  };
  return {
    schemaVersion: 1,
    revision,
    topologyHash,
    panel: publicRoute(panel),
    routes: routes.filter((entry) => entry.kind !== "template").map(publicRoute),
    skillPlacements: skillPlacements.map((placement) => ({
      placementId: placement.placementId,
      slotId: placement.slotId,
      skillId: placement.skillId,
      skillName: placement.skillName,
      enabled: placement.enabled,
      parentPlacementId: placement.parentPlacementId,
      parentRole: placement.parentRole,
      parentRelationType: placement.parentRelationType,
      modulePlacementId: placement.modulePlacementId,
      routePlacementIds: [...placement.routePlacementIds],
      pathNames: [...placement.pathNames],
      capabilities: [...placement.capabilities],
      organizationUpperPlacementIds: [...placement.organizationUpperPlacementIds],
    })),
  };
};

export const catalogWithManagedPlacements = ({ catalog = [], routeBundle = null } = {}) => {
  const placementsBySkill = new Map();
  for (const placement of list(routeBundle?.skillPlacements)) {
    if (!placement.enabled || !placement.skillId) continue;
    for (const id of identityVariants(placement.skillId)) {
      const bucket = placementsBySkill.get(id) || [];
      if (!bucket.some((candidate) => candidate.placementId === placement.placementId)) bucket.push(placement);
      placementsBySkill.set(id, bucket);
    }
  }
  return list(catalog).map((skill) => ({
    ...skill,
    placements: identityVariants(skillIdentity(skill)).flatMap((id) => placementsBySkill.get(id) || [])
      .filter((placement, index, values) => values.findIndex((candidate) => candidate.placementId === placement.placementId) === index),
  }));
};
