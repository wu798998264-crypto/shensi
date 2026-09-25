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

const relationInstruction = (value) => ({
  parallel: "同层成员按任务语义分别启用，可独立处理，也可组合协作；普通排序不会改变关系类型。",
  "primary-secondary": "第一位成员承担默认主责；其余成员只在任务需要替代、协作或多候选比较时启用，不因排列顺序自动成为第二主笔。",
  organization: "第一位成员是通用上位能力；命中下位成员时默认共同参与，只有任务已经提供上位所需信息、当前环节不需要上位能力或用户明确限定下位时才记录理由后跳过。",
}[value] || "按当前层真实结构和任务完整语义决定成员。");

const routeMemberTarget = (child = {}) => child.kind === "skill"
  ? `Skill=${limited(child.skillName || child.skillId)}`
  : `${child.kind === "group" ? "模组" : "模块"}=${limited(child.name || child.nodeId)}`;

const routeMemberDetail = (child = {}) => {
  const details = [
    `[${roleLabel(child.parentRole)}] ${routeMemberTarget(child)}`,
    `placementId=${child.placementId}`,
    `状态=${child.enabled ? "启用" : "禁用"}`,
  ];
  if (child.kind === "skill") {
    details.push(`能力=${list(child.capabilities).length ? list(child.capabilities).map((capability) => limited(capability, 120)).join("、") : "未声明"}`);
    details.push(`触发条件=${list(child.triggerConditions).length ? list(child.triggerConditions).map((condition) => limited(condition, 180)).join("；") : "由本层任务语义判断"}`);
    if (child.organizationUpperPlacementIds?.length) details.push(`默认上位=${child.organizationUpperPlacementIds.join("、")}`);
  } else {
    details.push(`下级数量=${list(child.childPlacementIds).length}`);
    details.push(`下一层路由=${scopedRouteTitle(child.kind)}（${child.placementId}）`);
  }
  if (child.guidance) details.push(`用途=${limited(child.guidance, 500)}`);
  return `- ${details.join("；")}`;
};

const deliverableRouteLine = (children = [], deliverableType = "", label = "") => {
  const matches = children.filter((child) => child.enabled !== false && list(child.node?.deliverableTypes).includes(deliverableType));
  if (matches.length === 1) return `- ${label}：选择“${limited(matches[0].name, 100)}”（placementId=${matches[0].placementId}）。`;
  if (matches.length > 1) return `- ${label}：当前有 ${matches.length} 个直接成员声明此交付类型；先按用户明确指向、成员触发条件与用途消歧，只能选出一个主分支，无法确定时只询问一个会改变成品类型的问题。`;
  return `- ${label}：当前面板没有声明对应直接成员，不得借用相似模组；按通用 Agent 处理或明确告知能力缺口。`;
};

const groupStageDecisionLines = (children = []) => {
  const stagePatterns = [
    ["创作引导", /guidance|创作引导/u, "只在方向、受众、关键约束或会改变成品的取舍尚未确定时进入；用户已给出可执行要求或明确要求直接生成时跳过。"],
    ["规划", /planning|规划|大纲|设定/u, "用于大纲、结构、人物、世界观、信息释放或阶段设计；已有可执行规划且用户只要成稿时不重复调用。"],
    ["主笔", /writer|主笔/u, "用于生成、续写、改写或完成正式成品；不能因为存在引导或规划成员就先输出另一套平行结果。"],
    ["自检", /review|自检|质检|审稿/u, "用于检查既有候选或用户明确要求的质检；只要求诊断时不擅自重写正文。"],
    ["理论", /theory|理论/u, "用于解释方法、题材规律或为创作提供必要理论约束；普通成稿任务不默认调用全部理论。"],
    ["记忆", /memory|记忆/u, "只在跨章节、连续状态、伏笔或长期一致性确实需要时调用；独立短内容不强制进入。"],
  ];
  return stagePatterns.flatMap(([stage, pattern, rule]) => {
    const matches = children.filter((child) => child.enabled !== false && pattern.test(`${child.nodeId}\n${child.name}`));
    return matches.length ? [`- ${stage}：${matches.map((child) => `“${limited(child.name, 80)}”`).join("、")}。${rule}`] : [];
  });
};

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

const routeUpdateRuleLines = (entry = {}) => {
  const scopeLabel = entry.kind === "template" ? "面板" : entry.kind === "group" ? "模组" : "模块";
  return [
    "",
    "## 更新规则",
    "",
    `- 本${scopeLabel}路由由可信编译器依据当前真实结构自动创建和更新，不接受脱离结构的自由改写。`,
    "- 微调必须保持最小差异：只更新发生变化的元数据、成员条目、数量和确实受影响的派生规则；未受影响章节的标题、顺序和原文保持不变，不得因一次局部调整整体重写或扩写路由。",
    "- 影响只沿必要路径传播：模块微调只更新该模块及直接祖先中的必要摘要，模组微调只更新该模组及直接祖先中的必要摘要，面板微调不改写下级路由。只有名称导致路径变化、成员增删或移动、关系调整、排序变化、启用状态变化时，才更新真实受影响的祖先、子树路径或协作规则。",
    "- 路由版本和拓扑哈希可以随联合版本更新，仅用于追踪；它们的变化不代表未受影响的语义章节需要重写。",
  ];
};

const scopedRouteText = ({ entry, children = [], revision = 0, topologyHash = "" } = {}) => {
  const node = entry.node || {};
  const childCount = children.length;
  const enabledChildCount = children.filter((child) => child.enabled !== false).length;
  const scopeDescription = entry.kind === "template"
    ? "面板是唯一生效的能力版图，只负责选择本轮需要进入的顶层模组或模块，不直接执行深层 Skill。"
    : entry.kind === "group"
      ? "模组负责组织内部模组与模块，先按本层关系缩小分支，再读取命中成员的下一层路由。"
      : "模块负责组织真实 Skill 插槽；只有模块路由选中的插槽才进入 Skill 读取和执行阶段。";
  const lines = [
    `# ${scopedRouteTitle(entry.kind)} · ${limited(entry.name || entry.nodeId)}`,
    "",
    "## 路由元数据",
    "",
    `路由版本：${Math.max(0, Number(revision) || 0)}；拓扑哈希：${clean(topologyHash) || "未生成"}`,
    `位置：${entry.pathNames.map((part) => limited(part, 100)).join(" / ")}`,
    `自身关系：${relationLabel(entry.relationType)}；状态=${entry.enabled ? "启用" : "禁用"}`,
    `节点职责：${limited(node.description || "按当前节点所含能力处理任务", 600)}`,
    "",
    "## 本层职责与决策",
    "",
    `- ${scopeDescription}`,
    `- 当前关系规则：${relationInstruction(entry.relationType)}`,
    `- 当前层成员：共 ${childCount} 个，其中启用 ${enabledChildCount} 个；只读取本轮命中的分支，不预读无关分支。`,
    "",
    "## 当前层成员",
    "",
  ];
  for (const child of children) {
    lines.push(routeMemberDetail(child));
  }
  lines.push(...routeUpdateRuleLines(entry));
  if (entry.kind === "template") {
    lines.push(
      "",
      "## 任务语义分流",
      "",
      deliverableRouteLine(children, "novel", "长篇小说、章节续写、卷纲、章纲、全书或连续写作"),
      deliverableRouteLine(children, "short_fiction", "短篇小说、短篇故事、微小说、小小说或明确短篇篇幅的独立故事"),
      deliverableRouteLine(children, "public_account", "公众号文章、公众号长文或微信推文"),
      deliverableRouteLine(children, "short_drama_script", "短剧、漫剧、微短剧或小说改短剧"),
      deliverableRouteLine(children, "short_video_script", "剧情类短视频脚本"),
      deliverableRouteLine(children, "visual_prompt", "图片提示词、视频提示词、分镜、人物或场景视觉资产"),
      "- 不属于以上创作资产的普通问题：不强行选择创作模组，使用通用 Agent 问答。",
      "- 当前文档、作品类型和历史对话只能作为缺少明确产物时的辅助证据，不能覆盖用户本轮明确指定的文体和成品类型。",
      "",
      "## 统一语义优先级",
      "",
      "按以下顺序只确定一个主要交付分支：本轮明确指定的模组/模块/Skill或@引用 → 明确的转换目标与成品类型 → 明确篇幅和文体 → 本轮已确认选择 → 目标文档 → 当前工作区上下文。低优先级不得覆盖高优先级。",
      "短篇与长篇、短剧与短视频脚本、短视频脚本与视频提示词必须互斥判断；不能因为词语相似、当前文档属于 novel/manuscript，或某个成员排在前面，就把同一任务随机分给不同模组。",
      "多个成员都声明同一交付类型时，继续比较成员用途、触发条件和用户要求；仍会改变最终成品时只问一个问题，不并行启动多个主分支。",
      "自定义模组或模块保存后，本路由会根据其真实名称、具体作用、成员、关系和启用状态自动重新编译。未声明标准交付类型时，先依据这些真实信息判断；只有多个自定义位置仍同样适用且会产生不同结果时才询问用户，不能借用数组中的第一个位置。",
      "",
      "## 复合任务协作",
      "",
      "复合任务按依赖顺序执行：必要引导 → 必要规划 → 主笔生成 → 按需自检 → 可信写入。上一步已由用户资料或既有文档充分提供时直接跳过；不得因面板存在某成员就全量调用，也不得并行输出互相冲突的规划、正文与审稿结果。结构清单、物理路径、原子落盘、历史和磁盘复核由 documents 工具与可信写入层负责，不需要工程化管理 Skill。",
      "",
      "## 读取顺序",
      "",
      "先根据用户任务完整语义选择一个主要顶层模组/模块；复合任务只按实际依赖增加必要协作分支。随后使用返回的 placementId 读取对应模组路由或模块路由，再读取实际 Skill。面板路由不展开深层成员，也不把面板外 Skill 当作自动候选。",
      "",
      "## 无匹配任务",
      "",
      "如果当前任务与面板内任何分支都不匹配，或用户只要求事实解释、普通问答、澄清和不涉及面板能力的讨论，直接由 Agent 通用回答，不强行调用 Skill。",
      "",
      "## 事实边界",
      "",
      "面板结构中的成员、顺序、角色和启用状态是唯一事实来源；本文件中的文字只解释用途，不能改变面板结构。",
    );
  } else if (entry.kind === "group") {
    const stageLines = groupStageDecisionLines(children);
    if (stageLines.length) lines.push("", "## 阶段选择规则", "", ...stageLines, "- 一个任务需要多个阶段时按前后依赖顺序串联，把上一步结果交给下一步；除非任务本身要求多个独立候选，不并行输出互相竞争的最终成果。");
    lines.push("", "## 读取顺序", "", "先依据本模组的关系和成员用途确定唯一主分支；复合任务再按依赖顺序增加必要协作成员。随后读取命中模组或模块的路由文档；不得因成员存在就读取整个模组的所有深层 Skill。", "", "## 事实边界", "", "模组只负责内部组织和分支选择，不改变下级模块的插槽能力；下级模块的具体 Skill 角色以模块路由为准。");
  } else if (entry.relationType === "organization" || children.some((child) => child.organizationUpperPlacementIds?.length)) {
    lines.push("", "## 读取顺序", "", "先按本模块关系确定主要/次要、上位/下位或并行插槽，再使用具体 placementId 读取 Skill。每个 Skill 的能力边界、触发说明和启用状态必须同时纳入执行计划。", "", "## 上位协作", "", "组织关系默认加载上位；只有 Agent 明确判断当前输入已具备下位所需信息、当前环节不需要上位能力或用户明确限定下位时，才可携带语义理由跳过上位。", "", "## 事实边界", "", "模块路由只描述当前模块的真实插槽，不自动调用面板外 Skill；未出现在当前面板插槽中的 Skill 只有用户明确点名或 @ 引用时才能调用。");
  } else {
    lines.push("", "## 读取顺序", "", "先按本模块关系确定主要/次要或并行插槽，再使用具体 placementId 读取 Skill。每个 Skill 的能力边界、触发说明和启用状态必须同时纳入执行计划。", "", "## 事实边界", "", "模块路由只描述当前模块的真实插槽，不自动调用面板外 Skill；未出现在当前面板插槽中的 Skill 只有用户明确点名或 @ 引用时才能调用。");
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
      guidance: node.description || "",
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
          guidance: child.description || skill?.description || "",
          triggerConditions: [...new Set([...list(child.triggerConditions), ...list(skill?.triggerConditions)])],
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
