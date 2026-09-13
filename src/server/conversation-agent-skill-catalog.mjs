const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => String(value ?? "").trim();

const roleForIndex = (relationType, index) => relationType === "organization"
  ? index === 0 ? "upper" : "lower"
  : relationType === "primary-secondary"
    ? index === 0 ? "primary" : "secondary"
    : "peer";

const usableSkill = (skill = {}) => skill.disabled !== true
  && (!text(skill.id).startsWith("user:") || skill.testStatus === "passed")
  && skill.testStatus !== "failed";

const normalizedSkillId = (value = "") => {
  const id = text(value);
  if (!id || /^(?:builtin|official|user):/u.test(id)) return id;
  return `user:${id}`;
};

const flatFallbackCatalog = (catalog = {}) => {
  const merged = new Map();
  for (const skill of [...list(catalog.builtins), ...list(catalog.user)]) {
    const id = normalizedSkillId(skill?.id);
    if (!id || !usableSkill({ ...skill, id })) continue;
    merged.set(id, {
      id,
      runtimeSkillId: id,
      name: text(skill.name) || id,
      description: text(skill.description),
      capabilities: list(skill.capabilities),
      placements: [],
      requiredUpperSkillIds: [],
      relationType: "parallel",
      relationRole: "peer",
      relationshipSummary: "面板拓扑暂不可用；本轮使用可用 Skill 安全目录",
      topologyFallback: true,
    });
  }
  return [...merged.values()];
};

const relationSummary = (scopes = []) => scopes.length
  ? scopes.map((scope) => `${scope.scopeName || scope.scopeId}：${scope.relationType}/${scope.relationRole}`).join(" → ")
  : "并行/peer";

export const projectConversationAgentSkillCatalog = (catalog = {}) => {
  const bundle = catalog.capabilityTemplate?.current;
  if (!bundle?.template || !Array.isArray(bundle.template.items) || !Array.isArray(bundle.groups) || !Array.isArray(bundle.modules)) {
    return flatFallbackCatalog(catalog);
  }

  const skillById = new Map();
  for (const skill of [...list(catalog.fixedSlots), ...list(catalog.builtins), ...list(catalog.user)]) {
    const id = normalizedSkillId(skill?.id);
    if (!id) continue;
    const previous = skillById.get(id) || {};
    skillById.set(id, { ...previous, ...skill, id });
  }
  const groupById = new Map(bundle.groups.map((group) => [text(group.id), group]));
  const moduleById = new Map(bundle.modules.map((module) => [text(module.id), module]));

  const resolveSlot = (slot = {}) => {
    if (slot.disabled === true) return null;
    let runtimeSkillId = normalizedSkillId(slot.skillId || slot.fixedSlotId);
    let source = skillById.get(runtimeSkillId);
    if ((!source || !usableSkill(source)) && slot.allowOfficialFallback === true && slot.fixedSlotId) {
      runtimeSkillId = normalizedSkillId(slot.fixedSlotId);
      source = skillById.get(runtimeSkillId);
    }
    if (!runtimeSkillId || !source || !usableSkill(source)) return null;
    const id = text(slot.compositeChildId) || runtimeSkillId;
    return {
      id,
      runtimeSkillId,
      name: text(slot.name) || text(source.name) || id,
      description: text(source.description) || text(slot.description),
      capabilities: list(slot.capabilities).length ? list(slot.capabilities) : list(source.capabilities || source.replacementCapabilities),
    };
  };

  const defaultSkillsForNode = (nodeType, nodeId, ancestors = new Set()) => {
    const key = `${nodeType}:${nodeId}`;
    if (ancestors.has(key)) return [];
    const node = nodeType === "group" ? groupById.get(nodeId) : moduleById.get(nodeId);
    if (!node || node.disabled === true) return [];
    const nextAncestors = new Set(ancestors).add(key);
    if (nodeType === "module") {
      const candidates = node.relationType === "parallel" ? list(node.slots) : list(node.slots).slice(0, 1);
      return candidates.map(resolveSlot).filter(Boolean).map((skill) => skill.id);
    }
    const candidates = node.relationType === "parallel" ? list(node.items) : list(node.items).slice(0, 1);
    return candidates.flatMap((item) => defaultSkillsForNode(item.targetType, text(item.targetId), nextAncestors));
  };

  const occurrences = [];
  const visitNode = ({ nodeType, node, path, relationScopes, inheritedUpperSkillIds, ancestors }) => {
    if (!node || node.disabled === true) return;
    const nodeKey = `${nodeType}:${text(node.id)}`;
    if (ancestors.has(nodeKey)) return;
    const nextAncestors = new Set(ancestors).add(nodeKey);
    const nextPath = [...path, { id: text(node.id), name: text(node.name), nodeType }];
    if (nodeType === "module") {
      const slots = list(node.slots);
      const upperIds = node.relationType === "organization" && slots.length ? (resolveSlot(slots[0]) ? [resolveSlot(slots[0]).id] : []) : [];
      for (let index = 0; index < slots.length; index += 1) {
        const role = roleForIndex(node.relationType, index);
        const requiredUpperSkillIds = role === "lower"
          ? [...inheritedUpperSkillIds, ...upperIds]
          : [...inheritedUpperSkillIds];
        if (role === "lower" && !upperIds.length) continue;
        const resolved = resolveSlot(slots[index]);
        if (!resolved) continue;
        const leafScope = {
          scopeId: text(node.id),
          scopeName: text(node.name),
          scopeType: "module",
          relationType: text(node.relationType) || "parallel",
          relationRole: role,
        };
        const scopes = [...relationScopes, leafScope];
        const reversedScopes = [...scopes].reverse();
        const governing = reversedScopes.find((scope) => scope.relationType === "organization")
          || reversedScopes.find((scope) => scope.relationType === "primary-secondary" && scope.relationRole === "secondary")
          || reversedScopes.find((scope) => scope.relationType !== "parallel")
          || leafScope;
        occurrences.push({
          ...resolved,
          slotId: text(slots[index].id),
          moduleId: text(node.id),
          placementId: [...nextPath.map((item) => item.id), text(slots[index].id)].join(">"),
          path: [...nextPath, { id: text(slots[index].id), name: text(slots[index].name), nodeType: "skill" }],
          relationScopes: scopes,
          relationType: governing.relationType,
          relationRole: governing.relationRole,
          requiredUpperSkillIds: [...new Set(requiredUpperSkillIds)].filter((id) => id !== resolved.id),
        });
      }
      return;
    }

    const items = list(node.items);
    const upperIds = node.relationType === "organization" && items.length
      ? defaultSkillsForNode(items[0].targetType, text(items[0].targetId))
      : [];
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const role = roleForIndex(node.relationType, index);
      if (role === "lower" && !upperIds.length) continue;
      const target = item.targetType === "group" ? groupById.get(text(item.targetId)) : moduleById.get(text(item.targetId));
      const scope = {
        scopeId: text(node.id),
        scopeName: text(node.name),
        scopeType: nodeType,
        relationType: text(node.relationType) || "parallel",
        relationRole: role,
      };
      visitNode({
        nodeType: item.targetType,
        node: target,
        path: nextPath,
        relationScopes: [...relationScopes, scope],
        inheritedUpperSkillIds: role === "lower"
          ? [...inheritedUpperSkillIds, ...upperIds]
          : [...inheritedUpperSkillIds],
        ancestors: nextAncestors,
      });
    }
  };

  visitNode({
    nodeType: "template",
    node: bundle.template,
    path: [],
    relationScopes: [],
    inheritedUpperSkillIds: [],
    ancestors: new Set(),
  });

  const projected = new Map();
  for (const occurrence of occurrences) {
    const placement = {
      placementId: occurrence.placementId,
      slotId: occurrence.slotId,
      moduleId: occurrence.moduleId,
      path: occurrence.path,
      relationScopes: occurrence.relationScopes,
      relationType: occurrence.relationType,
      relationRole: occurrence.relationRole,
      requiredUpperSkillIds: occurrence.requiredUpperSkillIds,
    };
    const previous = projected.get(occurrence.id);
    if (previous) {
      previous.placements.push(placement);
      continue;
    }
    const relationshipSummary = relationSummary(occurrence.relationScopes);
    projected.set(occurrence.id, {
      id: occurrence.id,
      runtimeSkillId: occurrence.runtimeSkillId,
      name: occurrence.name,
      description: [occurrence.description, `面板关系：${relationshipSummary}`].filter(Boolean).join("\n"),
      capabilities: occurrence.capabilities,
      placements: [placement],
      requiredUpperSkillIds: [...occurrence.requiredUpperSkillIds],
      relationType: occurrence.relationType,
      relationRole: occurrence.relationRole,
      relationshipSummary,
      topologyFallback: false,
    });
  }
  return [...projected.values()].map((skill) => {
    const dependencySets = new Map(skill.placements.map((placement) => [
      placement.requiredUpperSkillIds.join("\u0000"),
      placement.requiredUpperSkillIds,
    ]));
    if (dependencySets.size <= 1) return skill;
    return {
      ...skill,
      requiredUpperSkillIds: [],
      relationType: "multiple",
      relationRole: "multiple",
      relationshipSummary: `该 Skill 位于 ${skill.placements.length} 个不同关系位置；读取时必须指定 placementId`,
      requiresPlacementSelection: true,
    };
  });
};
