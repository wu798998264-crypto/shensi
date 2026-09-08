import { capabilityTemplateNode, normalizeCapabilityTemplate } from "./capability-template.js";

export const CREATIVE_GUIDANCE_CAPABILITIES = Object.freeze([
  "creative_guidance",
  "novel_guidance",
  "short_drama_guidance",
  "public_account_guidance",
  "short_fiction_guidance",
  "short_video_guidance",
  "prompt_guidance",
]);

const GUIDANCE_CAPABILITY_SET = new Set(CREATIVE_GUIDANCE_CAPABILITIES);
const PRIMARY_WRITER_CAPABILITIES = new Set([
  "novel_prose_writer",
  "original_script_writer",
  "adaptation_writer",
  "visual_prompt_writer",
  "public_account_writer",
  "short_fiction_writer",
  "short_video_script_writer",
  "prompt_writer",
  "custom_writer",
]);
const STRUCTURE_TYPES = new Set(["group", "module"]);
const ROLE_PRIORITY = Object.freeze({ primary: 80, upper: 70, peer: 50, lower: 30, secondary: 10 });

const uniqueStrings = (values = []) => [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];
const selectionCapabilities = (selection = {}) => uniqueStrings(
  selection.authorizedCapabilities
  ?? selection.selectionAuthorizedCapabilities
  ?? selection.capabilities
  ?? selection.replacementCapabilities
  ?? [],
);

export const isCreativeGuidanceSelection = (selection = {}) => (
  selectionCapabilities(selection).some((capability) => GUIDANCE_CAPABILITY_SET.has(capability))
);

export const skillReferenceIdentity = (reference) => {
  if (typeof reference === "string") return reference;
  if (["group", "module"].includes(reference?.referenceType)) return String(reference.referenceKey || reference.id || "");
  return String(reference?.id || reference?.relativePath || reference?.referenceKey || "");
};

const catalogSkillMap = ({ builtins = [], fixedSlots = [], userSkills = [] } = {}) => {
  const result = new Map();
  for (const skill of [...builtins, ...fixedSlots, ...userSkills]) {
    const id = String(skill?.id || "");
    if (!id) continue;
    result.set(id, skill);
    if (id.startsWith("user:")) result.set(id.slice(5), skill);
  }
  return result;
};

const loadableSkill = (skill, id) => {
  if (!skill) return null;
  if (String(id).startsWith("builtin:") || String(id).startsWith("official:")) return skill;
  return skill.testStatus === "passed" ? skill : null;
};

const originLabel = (origin = "") => origin === "created" ? "自定义" : origin === "downloaded" ? "下载" : "导入";
const structureTypeLabel = (nodeType = "module") => nodeType === "group" ? "模组" : "模块";
const requestedRoleFor = (capabilities, role = "peer") => (
  role === "primary" || capabilities.some((capability) => PRIMARY_WRITER_CAPABILITIES.has(capability)) ? "primary" : "auxiliary"
);

const normalizedSkillSelection = ({ skill, skillId, slot = null, module = null, groupPath = [], structure = null } = {}) => {
  const capabilities = uniqueStrings(slot?.capabilities?.length ? slot.capabilities : skill?.capabilities ?? skill?.replacementCapabilities ?? []);
  const role = slot?.role || "peer";
  return {
    id: skillId,
    relativePath: skillId,
    name: skill?.name || slot?.name || skillId,
    requestedRole: requestedRoleFor(capabilities, role),
    source: "explicit",
    authorizedCapabilities: capabilities,
    ...(slot ? {
      slotId: slot.id || skillId,
      slotName: slot.name || skill?.name || skillId,
      parentGroupId: module?.id || "",
      groupPath,
      routePriority: ROLE_PRIORITY[role] || 0,
      capabilityBoundary: slot.description || module?.description || "",
      ...(module?.relationType === "organization" ? {
        organizationGroupId: module.id,
        organizationRole: role === "upper" ? "leader" : "member",
      } : {}),
    } : {}),
    ...(structure ? {
      structureReference: {
        type: structure.nodeType,
        id: structure.id,
        name: structure.name,
      },
    } : {}),
  };
};

const deduplicateSelections = (selections = [], limit = 24) => {
  const byId = new Map();
  for (const selection of selections) {
    const id = String(selection?.id || selection?.relativePath || "");
    if (!id) continue;
    const current = byId.get(id);
    if (!current || Number(selection.routePriority) > Number(current.routePriority)) byId.set(id, selection);
  }
  return [...byId.values()].slice(0, limit);
};

export const expandSkillReferenceSelections = (references = [], { source = "" } = {}) => {
  const expanded = (Array.isArray(references) ? references : []).flatMap((reference) => {
    if (typeof reference === "string") return [{ id: reference, relativePath: reference, source: source || "explicit" }];
    if (Array.isArray(reference?.skillSelections)) return reference.skillSelections.map((selection) => ({
      ...selection,
      source: source || selection.source || "explicit",
    }));
    if (!reference || typeof reference !== "object") return [];
    return [{ ...reference, source: source || reference.source || "explicit" }];
  });
  return deduplicateSelections(expanded);
};

const structureReferenceKey = (nodeType, nodeId) => `capability:${nodeType}:${nodeId}`;
const skillReferenceKey = (skillId, slotId = "") => slotId ? `slot:${slotId}:${skillId}` : `skill:${skillId}`;

export const buildSkillReferenceTree = ({
  bundle: inputBundle,
  builtins = [],
  fixedSlots = [],
  userSkills = [],
  capabilityAssets = [],
} = {}) => {
  if (!inputBundle) return [];
  const bundle = normalizeCapabilityTemplate(inputBundle);
  const skillMap = catalogSkillMap({ builtins, fixedSlots, userSkills });
  const reachableNodeIds = new Set();
  const reachableSkillIds = new Set();
  const building = new Set();

  const structureNode = (nodeType, nodeId, groupPath = []) => {
    if (!STRUCTURE_TYPES.has(nodeType)) return null;
    const source = capabilityTemplateNode(bundle, nodeType, nodeId);
    if (!source || building.has(`${nodeType}:${nodeId}`)) return null;
    building.add(`${nodeType}:${nodeId}`);
    const nextPath = [...groupPath, source.name].filter(Boolean);
    let children = [];
    if (nodeType === "module") {
      children = (source.slots ?? []).flatMap((slot) => {
        const skillId = String(slot.skillId || "");
        const skill = loadableSkill(skillMap.get(skillId) || skillMap.get(skillId.replace(/^user:/, "")), skillId);
        if (!skillId || !skill) return [];
        const selection = normalizedSkillSelection({ skill, skillId, slot, module: source, groupPath, structure: source });
        return [{
          type: "skill",
          id: skillId,
          referenceKey: skillReferenceKey(skillId, slot.id),
          relativePath: skillId,
          name: skill.name || slot.name || skillId,
          fileName: `${skill.name || skillId}.md`,
          builtIn: /^builtin:|^official:/.test(skillId),
          primaryCapable: selection.requestedRole === "primary",
          capabilities: selection.authorizedCapabilities,
          roleLabel: /^builtin:|^official:/.test(skillId) ? "内置插槽" : "插槽 Skill",
          selection,
        }];
      });
    } else {
      children = (source.items ?? []).flatMap((item) => {
        const child = structureNode(item.targetType, item.targetId, nextPath);
        return child ? [child] : [];
      });
    }
    building.delete(`${nodeType}:${nodeId}`);
    const skillSelections = deduplicateSelections(children.flatMap((child) => (
      child.type === "skill" ? [child.selection] : child.reference?.skillSelections ?? []
    ))).map((selection) => ({
      ...selection,
      structureReference: { type: nodeType, id: source.id, name: source.name },
    }));
    return {
      type: "structure",
      id: structureReferenceKey(nodeType, source.id),
      referenceKey: structureReferenceKey(nodeType, source.id),
      nodeType,
      nodeId: source.id,
      name: source.name,
      description: source.description || "",
      children,
      skillCount: skillSelections.length,
      reference: {
        id: structureReferenceKey(nodeType, source.id),
        referenceKey: structureReferenceKey(nodeType, source.id),
        referenceType: nodeType,
        referenceId: source.id,
        name: source.name,
        requestedRole: "auxiliary",
        source: "explicit",
        skillSelections,
      },
    };
  };

  const markReachable = (nodeType, nodeId) => {
    const key = `${nodeType}:${nodeId}`;
    if (reachableNodeIds.has(key)) return;
    const node = capabilityTemplateNode(bundle, nodeType, nodeId);
    if (!node) return;
    reachableNodeIds.add(key);
    if (nodeType === "module") {
      for (const slot of node.slots ?? []) if (slot.skillId) reachableSkillIds.add(String(slot.skillId));
      return;
    }
    for (const item of node.items ?? []) markReachable(item.targetType, item.targetId);
  };
  for (const item of bundle.template.items ?? []) markReachable(item.targetType, item.targetId);

  const templateChildren = (bundle.template.items ?? []).flatMap((item) => {
    const child = structureNode(item.targetType, item.targetId, [bundle.template.name]);
    return child ? [child] : [];
  });

  const unplacedKeys = new Set([
    ...bundle.groups.map((node) => `group:${node.id}`),
    ...bundle.modules.map((node) => `module:${node.id}`),
  ].filter((key) => !reachableNodeIds.has(key)));
  const nestedUnplacedKeys = new Set();
  for (const group of bundle.groups) {
    if (!unplacedKeys.has(`group:${group.id}`)) continue;
    for (const item of group.items ?? []) {
      const key = `${item.targetType}:${item.targetId}`;
      if (unplacedKeys.has(key)) nestedUnplacedKeys.add(key);
    }
  }
  const assetByRoot = new Map((capabilityAssets ?? [])
    .filter((asset) => STRUCTURE_TYPES.has(asset.assetType) && asset.localRootId)
    .map((asset) => [`${asset.assetType}:${asset.localRootId}`, asset]));
  const unplacedStructures = [...unplacedKeys]
    .filter((key) => !nestedUnplacedKeys.has(key))
    .flatMap((key) => {
      const split = key.indexOf(":");
      const nodeType = key.slice(0, split);
      const nodeId = key.slice(split + 1);
      const node = structureNode(nodeType, nodeId, ["未装配能力"]);
      if (!node) return [];
      return [{ ...node, origin: assetByRoot.has(key) ? "downloaded" : "created" }];
    });

  const unplacedSkillFolders = ["created", "imported", "downloaded"].map((origin) => ({
    type: "folder",
    id: `reference:unplaced-skills:${origin}`,
    name: `${originLabel(origin)} Skill`,
    children: userSkills.flatMap((skill) => {
      const skillId = String(skill?.id || "");
      if (!skillId || skill.origin !== origin || skill.testStatus !== "passed" || reachableSkillIds.has(skillId)) return [];
      const selection = normalizedSkillSelection({ skill, skillId });
      return [{
        type: "skill",
        id: skillId,
        referenceKey: skillReferenceKey(skillId),
        relativePath: skillId,
        name: skill.name || skillId,
        fileName: `${skill.skillId || skillId}.md`,
        builtIn: false,
        primaryCapable: selection.requestedRole === "primary",
        capabilities: selection.authorizedCapabilities,
        roleLabel: originLabel(origin),
        selection,
      }];
    }),
  })).filter((folder) => folder.children.length);

  const customStructures = unplacedStructures.filter((node) => node.origin !== "downloaded");
  const downloadedStructures = unplacedStructures.filter((node) => node.origin === "downloaded");
  const unplacedChildren = [
    ...unplacedSkillFolders,
    ...(customStructures.length ? [{ type: "folder", id: "reference:unplaced-structures:created", name: "自定义模块与模组", children: customStructures }] : []),
    ...(downloadedStructures.length ? [{ type: "folder", id: "reference:unplaced-structures:downloaded", name: "下载模块与模组", children: downloadedStructures }] : []),
  ];

  return [
    {
      type: "folder",
      id: "reference:capability-template",
      name: `当前能力模板 · ${bundle.template.name}`,
      children: templateChildren,
    },
    ...(unplacedChildren.length ? [{
      type: "folder",
      id: "reference:unplaced-capabilities",
      name: "未装配能力",
      children: unplacedChildren,
    }] : []),
  ];
};

export const findSkillReferenceTreeNode = (nodes = [], referenceKey = "") => {
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (node.referenceKey === referenceKey || node.id === referenceKey) return node;
    const nested = findSkillReferenceTreeNode(node.children ?? [], referenceKey);
    if (nested) return nested;
  }
  return null;
};

export const skillReferenceStructureSummary = (node = {}) => {
  const skillNames = (node.reference?.skillSelections ?? []).map((selection) => selection.name || selection.id).filter(Boolean);
  const lines = [
    `# ${node.name || "未命名能力结构"}`,
    "",
    `能力说明：${node.description || `该${structureTypeLabel(node.nodeType)}会按内部插槽关系提供组合能力。`}`,
    "",
    `包含 Skill：${skillNames.length ? skillNames.join("、") : "当前没有可调用且已通过测试的 Skill"}`,
  ];
  return lines.join("\n");
};
