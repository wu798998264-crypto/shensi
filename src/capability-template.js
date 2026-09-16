import {
  CAPABILITY_EXECUTION_BUDGET,
  CAPABILITY_DESCRIPTOR_REGISTRY,
  CAPABILITY_PHASES,
  TRUSTED_CORE_CAPABILITY_IDS,
  capabilityBudgetClass,
  capabilityDescriptor,
  deepFreezeCapabilityValue,
  normalizeCapabilityTask,
  stableCapabilityHash,
  trustedActionsForCapability,
} from "./capability-registry.js";
import { matchSkillTrigger } from "./skill-trigger.js";
import {
  IMAGE_ASSET_SOURCE_EXTRACTION_PATTERN,
  isImageAssetSourceExtractionRequest,
} from "./image-asset-routing.js";

export const CAPABILITY_TEMPLATE_SCHEMA_VERSION = 30;
export const CAPABILITY_TEMPLATE_ROUTE_SELECTION_LIMIT = 24;

export const CAPABILITY_KERNEL_NODE_IDS = Object.freeze([
  "module:novel-engineering",
]);

const CAPABILITY_KERNEL_WRAPPER_GROUP_IDS = new Set([
  "group:long-form-memory",
  "group:novel-engineering",
]);
const CAPABILITY_VISIBLE_GROUP_DESCRIPTIONS = Object.freeze({
  "group:novel": "长篇小说的引导、规划、主笔、自检、理论与创作经验能力版图。",
  "group:short-drama": "同时覆盖原创短剧与小说改短剧；当前不预留独立规划模块。",
});

const CAPABILITY_KERNEL_NODE_ID_SET = new Set(CAPABILITY_KERNEL_NODE_IDS);
export const isKernelManagedCapabilityNode = (nodeType = "", id = "") => nodeType === "module"
  && CAPABILITY_KERNEL_NODE_ID_SET.has(String(id || ""));

export const CAPABILITY_RELATION_TYPES = Object.freeze([
  Object.freeze({ id: "parallel", label: "并行" }),
  Object.freeze({ id: "primary-secondary", label: "主次" }),
  Object.freeze({ id: "organization", label: "组织" }),
]);

const RELATION_IDS = new Set(CAPABILITY_RELATION_TYPES.map((item) => item.id));
const NODE_TYPES = new Set(["module", "group"]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const list = (value) => Array.isArray(value) ? value : [];
const unique = (value) => [...new Set(list(value).map((item) => String(item || "").trim()).filter(Boolean))];
const cleanId = (value, fallback) => {
  const normalized = String(value || "").trim();
  return /^[a-z0-9][a-z0-9._:-]{2,159}$/i.test(normalized) ? normalized : fallback;
};
const cleanText = (value, max = 500) => String(value || "").trim().slice(0, max);
const cleanRouteDocument = (value) => String(value || "").trim().slice(0, 50_000);
const withoutGeneratedRouteDocuments = (value) => {
  if (Array.isArray(value)) return value.map(withoutGeneratedRouteDocuments);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "routeDocument")
    .map(([key, child]) => [key, withoutGeneratedRouteDocuments(child)]));
};
const stableStructureHash = (value) => stableCapabilityHash(withoutGeneratedRouteDocuments(value));
const relationType = (value) => RELATION_IDS.has(value) ? value : "parallel";
const generatedId = (prefix = "node") => `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
const own = (value, key) => Boolean(value && Object.prototype.hasOwnProperty.call(value, key));
const CREATIVE_WORKSPACE_MODES = Object.freeze(["project", "notebook"]);

const OFFICIAL_POLICY_DEFAULTS = Object.freeze({
  "group:novel": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"] },
  "group:novel-guidance": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: ["prewrite"] },
  "group:novel-planning": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: ["prewrite"] },
  "group:novel-writer": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: ["produce"] },
  "group:novel-review": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: ["postwrite"] },
  "group:novel-theory": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel", "short_drama_script"] },
  "group:long-form-memory": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel", "short_drama_script"], phases: ["postwrite"] },
  "group:novel-engineering": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: ["prewrite", "postwrite"] },
  "module:creation-experience": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: ["prewrite", "postwrite"] },
  "group:short-drama": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_drama_script"], contextDomains: ["script", "script-adaptation"] },
  "group:short-drama-guidance": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_drama_script"], phases: ["prewrite"] },
  "group:short-drama-writers": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_drama_script"], phases: ["produce"] },
  "group:short-drama-review": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_drama_script"], phases: ["postwrite"] },
  "group:short-fiction": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_fiction"], contextDomains: ["novel"] },
  "group:public-account": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["public_account"] },
  "group:short-video": { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_video_script"] },
  "group:prompt-writers": { workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"] },
  "group:prompt-engineering": { workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"] },
});

const policyDefaultsForNode = (id = "") => {
  if (OFFICIAL_POLICY_DEFAULTS[id]) return OFFICIAL_POLICY_DEFAULTS[id];
  if (/^module:novel-(?:guidance|planning|writer|review|engineering)$/.test(id)) {
    const phase = id.endsWith("guidance") || id.endsWith("planning") || id.endsWith("engineering") ? "prewrite"
      : id.endsWith("writer") ? "produce" : "postwrite";
    return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: [phase] };
  }
  if (["module:shared-memory"].includes(id)) return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel", "short_drama_script"], phases: ["postwrite"] };
  if (id === "module:creation-experience") return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel"], phases: ["prewrite", "postwrite"] };
  if (/^module:(?:novel-theory-advisor|science-fiction-theory|male-web-theory|female-web-theory|other-novel-script-theory)$/.test(id)) return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["novel", "short_drama_script"] };
  if (/^module:(?:short-drama-guidance|original-drama-writer|adapted-drama-writer|short-drama-review)$/.test(id)) {
    const phase = id.endsWith("guidance") ? "prewrite" : id.endsWith("review") ? "postwrite" : "produce";
    return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_drama_script"], contextDomains: ["script", "script-adaptation"], phases: [phase] };
  }
  if (/^module:short-fiction-/.test(id)) {
    const phase = id.endsWith("guidance") ? "prewrite" : id.endsWith("writer") ? "produce" : id.endsWith("review") ? "postwrite" : undefined;
    return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_fiction"], contextDomains: ["novel"], ...(phase ? { phases: [phase] } : {}) };
  }
  if (/^module:public-account-/.test(id)) {
    const phase = id.endsWith("guidance") ? "prewrite" : id.endsWith("writer") ? "produce" : id.endsWith("illustration") ? "postwrite" : undefined;
    return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["public_account"], ...(phase ? { phases: [phase] } : {}) };
  }
  if (/^module:short-video-/.test(id)) {
    const phase = id.endsWith("guidance") ? "prewrite" : id.endsWith("writer") ? "produce" : id.endsWith("review") ? "postwrite" : undefined;
    return { workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_video_script"], ...(phase ? { phases: [phase] } : {}) };
  }
  if (/^module:(?:prompt-|video-prompt-writer(?:s)?$)/.test(id)) return { workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"], phases: [id.endsWith("guidance") ? "prewrite" : "produce"] };
  return {};
};

const normalizedPolicyFields = (source = {}, defaults = {}) => {
  const sourceDeliverables = own(source, "deliverableTypes") ? source.deliverableTypes
    : own(source, "artifactTypes") ? source.artifactTypes : defaults.deliverableTypes;
  return {
    workspaceModes: unique(own(source, "workspaceModes") ? source.workspaceModes : defaults.workspaceModes)
      .filter((mode) => ["project", "notebook", "general"].includes(mode)),
    contextDomains: unique(own(source, "contextDomains") ? source.contextDomains : defaults.contextDomains).slice(0, 24),
    deliverableTypes: unique(sourceDeliverables).slice(0, 24),
    artifactTypes: unique(sourceDeliverables).slice(0, 24),
    phases: unique(own(source, "phases") ? source.phases : defaults.phases).filter((phase) => CAPABILITY_PHASES.includes(phase)),
    stages: unique(own(source, "stages") ? source.stages : defaults.stages).slice(0, 32),
    triggerKeywords: unique(own(source, "triggerKeywords") ? source.triggerKeywords : defaults.triggerKeywords).slice(0, 32),
    triggerConditions: unique(own(source, "triggerConditions") ? source.triggerConditions : defaults.triggerConditions).slice(0, 32),
  };
};

export const capabilityRoleForIndex = (relation = "parallel", index = 0) => {
  if (relation === "primary-secondary") return index === 0 ? "primary" : "secondary";
  if (relation === "organization") return index === 0 ? "upper" : "lower";
  return "peer";
};

export const capabilityRoleLabel = (role = "peer") => ({
  peer: "并行",
  primary: "主要",
  secondary: "次要",
  upper: "上位",
  lower: "下位",
}[role] || "并行");

export const validateCapabilityRelationMembers = ({ relationType: requestedRelation = "parallel", members = [], label = "关系" } = {}) => {
  const relation = relationType(requestedRelation);
  const values = list(members);
  const errors = [];
  if (relation !== "parallel" && !values.length) errors.push(`${label}必须包含一个主要或上位节点`);
  const roles = values.map((member, index) => member?.role || capabilityRoleForIndex(relation, index));
  if (relation === "parallel" && roles.some((role) => role !== "peer")) errors.push(`${label}的并行节点只能使用 peer 角色`);
  if (relation === "primary-secondary") {
    if (roles.filter((role) => role === "primary").length !== 1) errors.push(`${label}必须且只能包含一个 primary`);
    if (roles.some((role) => !["primary", "secondary"].includes(role))) errors.push(`${label}只能使用 primary/secondary 角色`);
  }
  if (relation === "organization") {
    if (roles.filter((role) => role === "upper").length !== 1) errors.push(`${label}必须且只能包含一个 upper`);
    if (roles.some((role) => !["upper", "lower"].includes(role))) errors.push(`${label}只能使用 upper/lower 角色`);
  }
  return { valid: errors.length === 0, errors };
};

const placement = (id, targetType, targetId) => ({ id, targetType, targetId, role: "peer" });
const skillSlot = ({
  id,
  name,
  skillId = "",
  fixedSlotId = "",
  description = "",
  triggerRules = "",
  triggerKeywords = [],
  triggerConditions = [],
  capabilities = [],
  workspaceModes = [],
  contextDomains = [],
  deliverableTypes = [],
  sourceLegacySlotId = "",
  legacyBindingAllowed = true,
  allowOfficialFallback = false,
  disabled = false,
  official = true,
  kernelManaged = false,
} = {}) => ({
  id,
  name,
  skillId,
  fixedSlotId,
  description,
  triggerRules,
  triggerKeywords,
  triggerConditions,
  capabilities,
  workspaceModes,
  contextDomains,
  deliverableTypes,
  sourceLegacySlotId,
  legacyBindingAllowed,
    allowOfficialFallback,
    disabled,
  role: "peer",
  official,
  kernelManaged,
});

const capabilityModule = ({ id, name, description, triggerRules, relation = "parallel", slots = [], official = true, affectsStructure = false, protectedReason = "", kernelManaged = false }) => ({
  id,
  nodeType: "module",
  name,
  description,
  triggerRules,
  relationType: relation,
  slots,
  official,
  affectsStructure,
  protectedReason,
  kernelManaged,
  version: 1,
});

const capabilityGroup = ({ id, name, description, triggerRules, relation = "parallel", items = [], official = true }) => ({
  id,
  nodeType: "group",
  name,
  description,
  triggerRules,
  relationType: relation,
  items,
  official,
  version: 1,
});

const fixedSlot = (id, name, extras = {}) => skillSlot({ id: `slot:${id.replace(/^builtin:/, "")}`, name, skillId: id, fixedSlotId: id, allowOfficialFallback: true, ...extras });
// Prompt-writer slots are removable bindings. They ship in the initial panel,
// but removing one must remove the slot rather than leave an empty cell; users
// can add it back through the normal slot picker.
const optionalPromptWriterSlot = (id, name, extras = {}) => skillSlot({
  id: `slot:${id.replace(/^builtin:/, "")}`,
  name,
  skillId: id,
  fixedSlotId: "",
  allowOfficialFallback: false,
  official: true,
  legacyBindingAllowed: false,
  ...extras,
});
const VIDEO_PROMPT_TRIGGER_KEYWORDS = Object.freeze([
  "视频提示词",
  "分镜提示词",
  "镜头提示词",
  "漫剧提示词",
  "运镜提示词",
  "剧本视觉提示词",
  "视频分镜",
  "剧本转AI",
  "短视频剧本转AI",
  "短视频转AI",
  "剧本转视频",
  "首尾帧",
  "改编为视频提示词",
  "转化为视频提示词",
  "转换为视频提示词",
]);
const IMAGE_ASSET_CHARACTER_TASK_PATTERN = /(?:人物|角色|定妆|三视图|四视图).{0,24}(?:提示词|设定图|反推|建模|设计|资产)|(?:提示词|设定图|反推|建模|设计|资产).{0,24}(?:人物|角色|定妆|三视图|四视图)|(?:提取|抽取|识别).{0,18}(?:人物|角色)/iu;
const IMAGE_ASSET_SCENE_TASK_PATTERN = /(?:场景|环境|地点|空间|建筑).{0,24}(?:提示词|设定图|建模|设计|资产)|(?:提示词|设定图|建模|设计|资产).{0,24}(?:场景|环境|地点|空间|建筑)|(?:提取|抽取|识别).{0,18}(?:场景|环境|地点|空间|建筑)/iu;
const IMAGE_ASSET_GENERAL_TASK_PATTERN = /视觉资产|图片资产|图像资产|资产总表/iu;
const IMAGE_ASSET_LOWER_SKILL_IDS = Object.freeze([
  "builtin:industrial-character-prompt-writer",
  "builtin:guoman-scene-prompt-writer",
]);
const novelCoverSkillSlot = () => skillSlot({
  id: "slot:novel-cover-design",
  name: "小说封面设计",
  skillId: "user:shensi.novel-cover-design",
  description: "建立封面设计合同、文字安全区、标题与作者名排版验证、三个成品方向和封面资产标注。",
  triggerRules: "小说、网文或书籍封面的规划、生成和验收任务按语义自动启用；普通插画不启用。",
  triggerKeywords: ["小说封面", "网文封面", "书封", "封面设计", "设计封面", "制作封面", "生成封面", "检查封面"],
  triggerConditions: ["text_any: 小说|网文|书籍|书名|作品|作者|出版|番茄|起点|晋江|七猫|阅文|书封"],
  capabilities: ["novel_cover_designer"],
  workspaceModes: ["project", "notebook", "general"],
  official: true,
});
const publicAccountIllustrationModule = () => singleFixedModule({
  id: "module:public-account-illustration",
  name: "公众号正文配图模块",
  description: "从已完成的公众号正文提取认知锚点，规划 Ian 小黑怪诞手绘配图。",
  triggerRules: "仅在公众号任务明确要求正文配图、自动配图、插图规划、shot list 或小黑风格时，于正文验收后启用。",
  fixedId: "builtin:ian-xiaohei-illustrations",
  skillName: "Ian 小黑正文配图",
  extras: {
    id: "slot:ian-xiaohei-illustrations",
    description: "只提交正文锚点、用途、提示词与替代文本计划；图片模型调用、预算校验、保存和正文插入由可信内核执行。",
    triggerRules: "公众号正文完成且本轮明确要求配图时启用；普通公众号写作不自动增加图片成本。",
    triggerKeywords: ["正文配图", "自动配图", "文章配图", "公众号配图", "插图规划", "shot list", "小黑配图", "小黑风格"],
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    deliverableTypes: ["public_account"],
  },
});
const singleFixedModule = ({ id, name, description, triggerRules, relation = "primary-secondary", fixedId, skillName, extras = {}, official = true }) => capabilityModule({
  id,
  name,
  description,
  triggerRules,
  relation,
  official,
  slots: [fixedSlot(fixedId, skillName, extras)],
});

const creationExperienceModule = () => capabilityModule({
  id: "module:creation-experience",
  name: "创作经验模块",
  description: "写作前召回同作品或同题材的有效经验，作者采用成品后再提炼新经验；经验始终是数据，不自动变成 Skill。",
  triggerRules: "长篇小说创作任务按模板确定性启用；召回、反馈和入库由可信内核执行。",
  relation: "parallel",
  slots: [
    fixedSlot("builtin:experience-advisor", "创作经验顾问", {
      capabilities: ["experience_advisor"],
      workspaceModes: CREATIVE_WORKSPACE_MODES,
      deliverableTypes: ["novel"],
      phases: ["prewrite"],
    }),
    fixedSlot("builtin:experience-observer", "创作经验观察", {
      capabilities: ["experience_observer"],
      workspaceModes: CREATIVE_WORKSPACE_MODES,
      deliverableTypes: ["novel"],
      phases: ["postwrite"],
    }),
  ],
});

const kernelMemoryModule = () => capabilityModule({
  id: "module:shared-memory",
  name: "记忆模块",
  description: "为小说和连续短剧提供状态、信息台阶与伏笔记忆；可修改、替换或禁用。禁用后由神思原生记忆与按需文档读取继续提供长记忆。",
  triggerRules: "长篇小说或连续短剧任务按需启用；禁用时自动回退到神思原生记忆。",
  relation: "primary-secondary",
  fixedId: "builtin:memory-steps",
  kernelManaged: false,
  protectedReason: "",
  slots: [fixedSlot("builtin:memory-steps", "记忆与信息台阶", { kernelManaged: false })],
});

const kernelEngineeringModule = () => capabilityModule({
  id: "module:novel-engineering",
  name: "工程化管理机制",
  description: "由可信内核维护长篇作品目录、结构化落盘与跨章工程状态；不属于可配置模板内容。",
  triggerRules: "长篇小说工程建立、目录调整、结构化落盘或跨章管理时由可信内核按需启用。",
  relation: "primary-secondary",
  affectsStructure: true,
  kernelManaged: true,
  protectedReason: "神思内置工程化管理运行机制，不可编辑、替换、拔出或删除。",
  slots: [skillSlot({
    id: "slot:novel-engineering",
    name: "工程化管理",
    skillId: "builtin:structure-engineering",
    fixedSlotId: "builtin:structure-engineering",
      capabilities: ["auxiliary_advisor"],
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    deliverableTypes: ["novel"],
    triggerKeywords: ["工程化管理", "结构化管理", "目录调整", "结构化落盘", "跨章管理"],
    description: "由可信内核执行结构与目录管理，不向 Skill 开放文件写入权限。",
    allowOfficialFallback: true,
    kernelManaged: true,
  })],
});

export const createInitialCapabilityTemplate = () => {
  const modules = [
    singleFixedModule({ id: "module:novel-guidance", name: "小说创作引导模块", description: "确认题材、读者、目标效果与关键取舍。", triggerRules: "创作目标尚未形成完整创作合同时启用。", fixedId: "builtin:creative-guidance", skillName: "小说创作引导" }),
    capabilityModule({
      id: "module:novel-planning",
      name: "小说规划模块",
      description: "并行处理故事大纲与受正史约束的设定规划。",
      triggerRules: "规划大纲、卷纲、章纲、人物、世界观或其他正史设定时启用对应插槽。",
      relation: "parallel",
      slots: [
        fixedSlot("builtin:story-planner", "故事与大纲规划主笔"),
        fixedSlot("builtin:setting-planner", "小说设定规划主笔"),
      ],
    }),
    capabilityModule({
      id: "module:novel-writer",
      name: "小说主笔模块",
      description: "生成小说正文；主要 Skill 负责常规任务，次要 Skill 只接受明确点名或候选任务调度。",
      triggerRules: "小说正文、续写、改写与章节交付。",
      relation: "primary-secondary",
      slots: [
        fixedSlot("builtin:novel-writer", "小说正文主笔"),
        fixedSlot("builtin:chinese-novelist-skill", "备用主笔 · chinese-novelist-skill", {
          description: "备用主笔只参与用户明确选择的多主笔候选或明确点名任务，不改变默认正文主笔。",
        }),
      ],
    }),
    capabilityModule({
      id: "module:novel-review",
      name: "小说自检模块",
      description: "按章节任务在强剧情与常规推进两类专项自检之间路由；满血审计可同时启用。",
      triggerRules: "小说候选生成后或用户明确要求审稿时，按任务语义选择专项自检。",
      relation: "parallel",
      slots: [
        fixedSlot("builtin:strong-story-review", "强剧情自检", {
          capabilities: ["strong_story_reviewer"],
          workspaceModes: CREATIVE_WORKSPACE_MODES,
          deliverableTypes: ["novel"],
        }),
        fixedSlot("builtin:effect-review", "常规推进自检", {
          capabilities: ["regular_progress_reviewer", "effect_reviewer"],
          workspaceModes: CREATIVE_WORKSPACE_MODES,
          deliverableTypes: ["novel", "short_fiction"],
          sourceLegacySlotId: "builtin:effect-review",
        }),
      ],
    }),
    kernelMemoryModule(),
    kernelEngineeringModule(),
    creationExperienceModule(),
    singleFixedModule({
      id: "module:novel-theory-advisor",
      name: "小说理论顾问",
      description: "作为小说理论顾问模组的上位路由，先识别题材与理论边界，再协调下位题材模块；不替代正文、规划或自检主笔。",
      triggerRules: "小说或剧本任务明确命中题材理论时，与命中的下位题材模块共同启用。",
      relation: "parallel",
      fixedId: "builtin:novel-theory-advisor",
      skillName: "小说理论顾问",
    }),
    capabilityModule({
      id: "module:science-fiction-theory",
      name: "科幻题材理论模块",
      description: "不同科幻方向以并行关系按题材命中。",
      triggerRules: "用户题材、设定或正文明确包含对应科幻方向时启用。",
      relation: "parallel",
      slots: [
        fixedSlot("builtin:hybrid-science-fiction-theory", "融合型科幻"),
        fixedSlot("builtin:short-science-fiction-theory", "短篇科幻"),
        fixedSlot("builtin:traditional-science-fiction-theory", "传统科幻"),
        fixedSlot("builtin:web-novel-science-fiction-theory", "网文科幻"),
      ],
    }),
    capabilityModule({
      id: "module:male-web-theory",
      name: "男频爽文理论模块",
      description: "男频爽文为上位原理，细分题材作为下位专精。",
      triggerRules: "男频、升级流、玄幻、仙侠或图录妖系题材。",
      relation: "organization",
      slots: [
        fixedSlot("builtin:male-web-theory", "男频爽文"),
        fixedSlot("builtin:catalog-power-drama-theory", "图录式爽剧与妖系升级流"),
      ],
    }),
    capabilityModule({
      id: "module:female-web-theory",
      name: "女频小说理论模块",
      description: "女频通用理论为上位，现有女频爽文与真假千金理论作为下位专精。",
      triggerRules: "女频题材先启用通用理论，再按任务语义选择已有下位理论；没有实际 Skill 的类型只使用上位通用理论。",
      relation: "organization",
      slots: [
        fixedSlot("builtin:female-general-theory", "女频通用理论"),
        fixedSlot("builtin:female-web-theory", "女频爽文"),
        fixedSlot("builtin:true-false-heiress-theory", "真假千金"),
      ],
    }),
    capabilityModule({
      id: "module:other-novel-script-theory",
      name: "其他小说与剧本理论模块",
      description: "暂未形成独立题材模组的理论以并行关系调用。",
      triggerRules: "明确命中相应题材关键词时启用。",
      relation: "parallel",
      slots: [
        fixedSlot("builtin:green-hat-emotion-theory", "极致情绪拉扯"),
        fixedSlot("builtin:revenge-drama-theory", "复仇爽剧"),
        fixedSlot("builtin:otome-content-theory", "乙女向内容"),
      ],
    }),
    singleFixedModule({ id: "module:short-drama-guidance", name: "短剧创作引导模块", description: "确认来源模式、平台、集数、核心冲突与制作约束。", triggerRules: "原创短剧或小说改短剧的创作合同尚未完整时启用。", fixedId: "builtin:short-drama-guidance", skillName: "短剧剧本创作引导" }),
    singleFixedModule({ id: "module:original-drama-writer", name: "原创短剧主笔模块", description: "完成原创短剧大纲和正式剧本。", triggerRules: "来源模式为原创短剧时启用。", fixedId: "builtin:original-script-writer", skillName: "短剧原创剧本主笔" }),
    singleFixedModule({ id: "module:adapted-drama-writer", name: "小说改短剧主笔模块", description: "先抽取人物关系功能、冲突链、信息差、情绪曲线、爽点与集尾钩子，再完成原创化剧情功能对位改编。", triggerRules: "来源模式为小说、原作或章节改编时启用；必须区分结构迁移与逐句改写。", fixedId: "builtin:adapted-script-writer", skillName: "小说改短剧剧本主笔" }),
    singleFixedModule({ id: "module:short-drama-review", name: "短剧自检模块", description: "以 Essence Lock 精髓锁为核心，检查保真、冲突升级、爽点因果、节奏、对白、集尾钩子与制作可执行性。", triggerRules: "正式短剧候选生成后启用；先建立精髓锁，再分层审稿和增强。", fixedId: "builtin:short-drama-review", skillName: "短剧剧本自检" }),
    singleFixedModule({ id: "module:short-fiction-guidance", name: "短篇小说创作引导模块", description: "确认篇幅、核心冲突、叙事方式与结尾效果。", triggerRules: "短篇小说创作合同尚未完整时启用。", fixedId: "builtin:short-fiction-guidance", skillName: "短篇小说创作引导" }),
    singleFixedModule({ id: "module:short-fiction-writer", name: "短篇小说主笔模块", description: "完成单篇场景、人物、冲突、叙事与收束。", triggerRules: "短篇小说正文生成、续写或改写。", fixedId: "builtin:short-fiction-writer", skillName: "短篇小说主笔" }),
    singleFixedModule({
      id: "module:short-fiction-review",
      name: "短篇小说自检模块",
      description: "复核单篇效果、节奏、语言与结尾收束。",
      triggerRules: "短篇小说候选生成后启用。",
      fixedId: "builtin:effect-review",
      skillName: "常规推进自检",
      extras: {
        id: "slot:short-fiction-review",
        capabilities: ["regular_progress_reviewer", "effect_reviewer"],
        workspaceModes: CREATIVE_WORKSPACE_MODES,
        deliverableTypes: ["short_fiction"],
      },
    }),
    capabilityModule({
      id: "module:short-fiction-theory",
      name: "短篇小说理论模块",
      description: "短篇通用理论作为上位；后续细分理论可逐个增加为下位插槽。",
      triggerRules: "短篇小说理论校正。",
      relation: "organization",
      slots: [
        fixedSlot("builtin:short-fiction-general-theory", "短篇小说通用理论"),
        fixedSlot("builtin:short-science-fiction-theory", "短篇科幻", {
          id: "slot:short-fiction-science-theory",
          deliverableTypes: ["short_fiction"],
          triggerKeywords: ["短篇科幻", "科幻短篇", "科幻小说"],
        }),
      ],
    }),
    singleFixedModule({ id: "module:public-account-guidance", name: "公众号创作引导模块", description: "确认受众、选题、传播目标、观点、风格和结构。", triggerRules: "公众号文章创作合同尚未完整时启用。", fixedId: "builtin:public-account-guidance", skillName: "公众号文章创作引导" }),
    singleFixedModule({ id: "module:public-account-writer", name: "公众号主笔模块", description: "完成公众号文章正文。", triggerRules: "公众号文章正式写作、续写或改写。", fixedId: "builtin:public-account-writer", skillName: "公众号文章主笔" }),
    publicAccountIllustrationModule(),
    capabilityModule({
      id: "module:public-account-theory",
      name: "公众号理论模块",
      description: "公众号通用理论为上位，品类理论为下位。",
      triggerRules: "公众号文章需要品类方法校正时启用。",
      relation: "organization",
      slots: [
        fixedSlot("builtin:public-account-theory", "公众号文章通用理论"),
        fixedSlot("builtin:alternative-popular-science-theory", "另类科普"),
      ],
    }),
    singleFixedModule({ id: "module:short-video-guidance", name: "短视频创作引导模块", description: "确认时长、平台、形式、钩子、节奏和结尾动作。", triggerRules: "剧情短视频创作合同尚未完整时启用。", fixedId: "builtin:short-video-guidance", skillName: "短视频剧本创作引导" }),
    singleFixedModule({ id: "module:short-video-writer", name: "短视频主笔模块", description: "完成适配时长、平台与共性节奏的剧情脚本。", triggerRules: "剧情短视频脚本正式写作。", fixedId: "builtin:short-video-writer", skillName: "短视频剧本主笔" }),
    singleFixedModule({ id: "module:short-video-review", name: "短视频自检模块", description: "复核观看问题、状态变化、情绪兑现、反转与制作压缩。", triggerRules: "短视频脚本候选生成后启用。", fixedId: "builtin:short-video-review", skillName: "短视频剧本自检" }),
    capabilityModule({
      id: "module:short-video-theory",
      name: "短视频理论模块",
      description: "通用短视频理论作为上位，后续赛道经验可逐个增加为下位。",
      triggerRules: "剧情短视频脚本需要赛道或通用方法校正时启用。",
      relation: "organization",
      slots: [fixedSlot("builtin:short-video-general-theory", "短视频通用理论")],
    }),
    singleFixedModule({ id: "module:prompt-guidance", name: "提示词创作引导模块", description: "确认媒介、模型、质感、构图、光线、表演、运镜与画幅。", triggerRules: "提示词目标或约束尚不完整时启用。", fixedId: "builtin:prompt-guidance", skillName: "提示词创作引导" }),
    capabilityModule({
      id: "module:prompt-writer",
      name: "AI 漫剧图片资产提示词模块",
      description: "AI 漫剧图片资产提示词为上位提取 Skill，工业角色与国漫场景提示词为下位输出 Skill；没有对应下位的资产仍由上位直接完成。",
      triggerRules: "从小说、剧本或文本整理图片资产时由上位提取并交给对应下位输出；用户直接要求角色或场景提示词时只调用对应下位。",
      relation: "organization",
      slots: [
        fixedSlot("builtin:visual-asset-prompt-writer", "图片资产提示词生成", {
          triggerConditions: ["document_prefix:prompt-visual-"],
          triggerKeywords: ["视觉资产", "图片资产", "图像资产", "人物资产", "角色资产", "场景资产", "道具资产", "服装资产", "载具资产", "主体资产", "物品图片", "物件图片", "道具图片", "具体图片", "设定图", "定妆图", "三视图"],
        }),
        fixedSlot("builtin:industrial-character-prompt-writer", "工业角色提示词", {
          description: "下位角色资产主笔；按工业四视图规范输出人物与角色提示词。",
          triggerKeywords: ["工业角色提示词", "角色提示词", "人物提示词", "角色设计", "人物设计", "角色资产", "人物资产", "角色设定图", "人物设定图", "角色三视图", "人物三视图", "角色四视图", "人物四视图", "角色反推", "人物反推", "定妆图"],
        }),
        fixedSlot("builtin:guoman-scene-prompt-writer", "国漫场景提示词", {
          description: "下位场景资产主笔；按十六比九无人三维国漫建模规范输出场景提示词。",
          triggerKeywords: ["国漫场景提示词", "场景提示词", "环境提示词", "场景设计", "环境设计", "场景资产", "环境资产", "场景设定图", "环境设定图", "场景建模", "环境建模", "无人场景", "纯场景"],
        }),
      ],
    }),
    singleFixedModule({
      id: "module:prompt-panorama-writer",
      name: "辅助功能提示词模块",
      description: "以并行关系收纳图片提示词辅助能力；当前只包含多人物场景站位线稿图，可按需继续添加其他 Skill。",
      triggerRules: "明确要求多人站位、站位线稿、全景调度或空间调度时启用。",
      relation: "parallel",
      fixedId: "builtin:panorama-prompt-writer",
      skillName: "多人物场景站位线稿图",
      extras: {
        triggerConditions: ["document_prefix:prompt-panorama-"],
        triggerKeywords: ["多人站位", "站位线稿", "站位图", "全景调度", "空间调度", "人物站位"],
      },
    }),
    capabilityModule({
      id: "module:video-prompt-writer",
      name: "视频提示词主笔模块",
      description: "集中管理视频提示词、分镜和运镜提示词主笔；AI 视频导演（二）是唯一的视频提示词主笔 Skill。",
      triggerRules: "用户要求改编、转化、转换或生成视频提示词、分镜提示词、镜头提示词时统一启用 AI 视频导演（二）。",
      relation: "parallel",
      slots: [
        optionalPromptWriterSlot("builtin:video-prompt-writer", "AI 视频导演（二）", {
          id: "slot:video-prompt-writer",
          description: "按 30 秒视频导演规范完成紧凑、连续且台词时长合理的视频分镜提示词；所有视频提示词任务统一使用。",
          triggerRules: "视频提示词、分镜或运镜转换任务统一启用；旧名称只作为兼容别名映射到本 Skill。",
          triggerConditions: ["document_prefix:prompt-video-"],
          triggerKeywords: [...VIDEO_PROMPT_TRIGGER_KEYWORDS, "AI 视频导演（二）", "AI视频导演二", "AI 视频导演 2", "ai导演（二）", "AI导演二", "视频导演二", "视频导演二（30秒）", "AI视频导演", "AI 视频导演", "视频导演", "Seedance", "Seedance 2.5", "镜头导演", "分镜导演"],
        }),
      ],
    }),
    capabilityModule({
      id: "module:auxiliary-skills",
      name: "辅助能力模块",
      description: "收纳不适合单独建立模组的按需 Skill。",
      triggerRules: "仅在用户明确 @ 或满足 Skill 自身受控触发规则时启用。",
      relation: "parallel",
      slots: [
        skillSlot({ id: "slot:bestseller-ranking-scan", name: "爆款扫榜", skillId: "user:shensi.bestseller-ranking-scan", sourceLegacySlotId: "bestseller-ranking-scan", capabilities: ["market_research", "ranking_scan", "knowledge_reference"], workspaceModes: ["general"], triggerRules: "由 Agent 结合任务路由、用户目标和本 Skill 能力边界自主判断是否需要公开榜单研究；普通提及不自动启动采集。", official: true }),
        skillSlot({ id: "slot:book-deconstruction", name: "爆款拆书", skillId: "user:shensi.book-deconstruction", sourceLegacySlotId: "book-deconstruction", capabilities: ["knowledge_reference"], workspaceModes: ["general"], triggerKeywords: ["拆书", "拆文", "爆款拆书", "逆向分析作品"], official: true }),
        skillSlot({ id: "slot:style-distillation", name: "文风蒸馏", skillId: "user:shensi.style-distillation", capabilities: ["style_reference"], workspaceModes: ["general"], triggerKeywords: ["@文风蒸馏"], triggerRules: "只接受用户明确 @文风蒸馏。", official: true }),
        fixedSlot("builtin:short-drama-script-reconstructor", "短剧视频逆推剧本", {
          description: "只根据用户明确提供的短剧视频、链接或附件进行证据约束的剧本重构；不声称恢复未拍摄的原始剧本。",
          triggerRules: "用户明确要求短剧逆推、视频逆推剧本、重构剧本或还原短剧时启用。",
          triggerKeywords: ["短剧逆推", "视频逆推剧本", "逆推剧本", "重构剧本", "还原短剧", "短剧视频分析"],
          capabilities: ["auxiliary_advisor"],
          workspaceModes: CREATIVE_WORKSPACE_MODES,
          contextDomains: ["script", "script-adaptation"],
          deliverableTypes: ["short_drama_script"],
        }),
        novelCoverSkillSlot(),
      ],
    }),
  ];

  const groups = [
    capabilityGroup({
      id: "group:novel-guidance",
      name: "小说创作引导模组",
      description: "集中管理长篇小说创作合同与关键取舍的引导能力。",
      triggerRules: "长篇小说目标、读者、题材或关键效果尚未确认时启用。",
      relation: "parallel",
      items: [placement("place:novel-guidance:module", "module", "module:novel-guidance")],
    }),
    capabilityGroup({
      id: "group:novel-planning",
      name: "小说规划模组",
      description: "集中管理大纲规划与受正史约束的设定规划能力。",
      triggerRules: "规划大纲、卷纲、章纲、人物、世界观或其他正史设定时启用。",
      relation: "parallel",
      items: [placement("place:novel-planning:module", "module", "module:novel-planning")],
    }),
    capabilityGroup({
      id: "group:novel-writer",
      name: "小说主笔模组",
      description: "管理小说正文主笔模块；主要与备选主笔的替换关系在模块内部生效。",
      triggerRules: "小说正文、续写、改写与章节交付。",
      relation: "parallel",
      items: [placement("place:novel-writer:module", "module", "module:novel-writer")],
    }),
    capabilityGroup({
      id: "group:novel-review",
      name: "小说自检模组",
      description: "集中管理小说候选的效果复核能力。",
      triggerRules: "小说候选生成后或用户明确要求审稿时启用。",
      relation: "parallel",
      items: [placement("place:novel-review:module", "module", "module:novel-review")],
    }),
    capabilityGroup({
      id: "group:long-form-memory",
      name: "长文记忆模组",
      description: "由长篇小说与连续短剧共享，提供状态、信息台阶与伏笔建议。",
      triggerRules: "长篇小说或连续短剧交付后启用；最终写入仍由可信内核执行。",
      relation: "parallel",
      items: [placement("place:long-form-memory:module", "module", "module:shared-memory")],
    }),
    capabilityGroup({
      id: "group:novel-engineering",
      name: "工程化管理模组",
      description: "管理长篇作品目录、结构化落盘与跨章工程建议。",
      triggerRules: "长篇小说工程建立、目录调整、结构化落盘或跨章管理时启用。",
      relation: "parallel",
      items: [placement("place:novel-engineering:module", "module", "module:novel-engineering")],
    }),
    capabilityGroup({
      id: "group:novel-theory",
      name: "小说理论顾问模组",
      description: "小说理论顾问为上位路由，科幻、男频、女频和其他题材理论模块为下位专精。",
      triggerRules: "小说或剧本任务明确命中题材理论时，上位顾问与命中的下位模块共同启用。",
      relation: "organization",
      items: [
        placement("place:novel-theory:advisor", "module", "module:novel-theory-advisor"),
        placement("place:novel-theory:science-fiction", "module", "module:science-fiction-theory"),
        placement("place:novel-theory:male-web", "module", "module:male-web-theory"),
        placement("place:novel-theory:female-web", "module", "module:female-web-theory"),
        placement("place:novel-theory:other", "module", "module:other-novel-script-theory"),
      ],
    }),
    capabilityGroup({
      id: "group:novel",
      name: "长篇小说模组",
      description: CAPABILITY_VISIBLE_GROUP_DESCRIPTIONS["group:novel"],
      triggerRules: "长篇小说任务按文体启用；作品提供完整索引管理，笔记提供智能文件夹与文档组织。各模块由任务路由按需协作。",
      relation: "parallel",
      items: [
        placement("place:novel:guidance", "group", "group:novel-guidance"),
        placement("place:novel:planning", "group", "group:novel-planning"),
        placement("place:novel:writer", "group", "group:novel-writer"),
        placement("place:novel:review", "group", "group:novel-review"),
        placement("place:novel:theory", "group", "group:novel-theory"),
        placement("place:novel:memory", "group", "group:long-form-memory"),
        placement("place:novel:engineering", "group", "group:novel-engineering"),
        placement("place:novel:experience", "module", "module:creation-experience"),
      ],
    }),
    capabilityGroup({
      id: "group:short-drama-guidance",
      name: "短剧创作引导模组",
      description: "集中管理原创短剧与小说改短剧共用的创作引导。",
      triggerRules: "短剧来源模式、平台、集数、冲突或制作约束尚未确认时启用。",
      relation: "parallel",
      items: [placement("place:short-drama-guidance:module", "module", "module:short-drama-guidance")],
    }),
    capabilityGroup({
      id: "group:short-drama-writers",
      name: "短剧主笔模组",
      description: "原创链路与小说改编链路并行，任务路由只选择符合来源模式的主笔模块。",
      triggerRules: "短剧主笔任务；根据原创或改编来源模式选择。",
      relation: "parallel",
      items: [
        placement("place:drama-writers:original", "module", "module:original-drama-writer"),
        placement("place:drama-writers:adapted", "module", "module:adapted-drama-writer"),
      ],
    }),
    capabilityGroup({
      id: "group:short-drama-review",
      name: "短剧自检模组",
      description: "集中管理原创与改编短剧共用的成稿自检能力。",
      triggerRules: "正式短剧候选生成后启用。",
      relation: "parallel",
      items: [placement("place:short-drama-review:module", "module", "module:short-drama-review")],
    }),
    capabilityGroup({
      id: "group:short-drama",
      name: "短剧剧本模组",
      description: CAPABILITY_VISIBLE_GROUP_DESCRIPTIONS["group:short-drama"],
      triggerRules: "短剧、漫剧或小说改短剧任务。各模块非线性按需协作。",
      relation: "parallel",
      items: [
        placement("place:short-drama:guidance", "group", "group:short-drama-guidance"),
        placement("place:short-drama:writers", "group", "group:short-drama-writers"),
        placement("place:short-drama:review", "group", "group:short-drama-review"),
        placement("place:short-drama:theory", "group", "group:novel-theory"),
        placement("place:short-drama:memory", "group", "group:long-form-memory"),
      ],
    }),
    capabilityGroup({
      id: "group:short-fiction",
      name: "短篇小说模组",
      description: "短篇小说的引导、主笔、自检与理论能力；不预留规划或长文记忆占位。",
      triggerRules: "短篇小说任务按文体启用；作品与笔记都可使用。",
      relation: "parallel",
      items: [
        placement("place:short-fiction:guidance", "module", "module:short-fiction-guidance"),
        placement("place:short-fiction:writer", "module", "module:short-fiction-writer"),
        placement("place:short-fiction:review", "module", "module:short-fiction-review"),
        placement("place:short-fiction:theory", "module", "module:short-fiction-theory"),
      ],
    }),
    capabilityGroup({
      id: "group:public-account",
      name: "公众号文章模组",
      description: "公众号文章的引导、主笔、品类理论与写后正文配图；不预留规划、自检或长文记忆占位。",
      triggerRules: "公众号文章任务按文体启用；作品与笔记都可使用。",
      relation: "parallel",
      items: [
        placement("place:public-account:guidance", "module", "module:public-account-guidance"),
        placement("place:public-account:writer", "module", "module:public-account-writer"),
        placement("place:public-account:theory", "module", "module:public-account-theory"),
        placement("place:public-account:illustration", "module", "module:public-account-illustration"),
      ],
    }),
    capabilityGroup({
      id: "group:short-video",
      name: "短视频剧本模组",
      description: "剧情短视频的引导、主笔、自检与理论；不预留规划、经验或长记忆占位。",
      triggerRules: "剧情短视频脚本任务按文体启用；作品与笔记都可使用。",
      relation: "parallel",
      items: [
        placement("place:short-video:guidance", "module", "module:short-video-guidance"),
        placement("place:short-video:writer", "module", "module:short-video-writer"),
        placement("place:short-video:review", "module", "module:short-video-review"),
        placement("place:short-video:theory", "module", "module:short-video-theory"),
      ],
    }),
    capabilityGroup({
      id: "group:prompt-writers",
      name: "提示词主笔模组",
      description: "图片资产组织模块与辅助功能提示词模块并行；二者按任务语义独立启用。",
      triggerRules: "图片资产、人物、场景、道具、多人站位或空间调度提示词任务。",
      relation: "parallel",
      items: [
        placement("place:prompt-writers:visual-assets", "module", "module:prompt-writer"),
        placement("place:prompt-writers:auxiliary", "module", "module:prompt-panorama-writer"),
      ],
    }),
    capabilityGroup({
      id: "group:prompt-engineering",
      name: "提示词工程模组",
      description: "图片资产组织、多人站位与视频提示词能力并行；视频提示词统一由 AI 视频导演（二）负责。",
      triggerRules: "视觉提示词、分镜提示词、视频提示词或图片资产提示词任务。",
      relation: "parallel",
      items: [
        placement("place:prompt:guidance", "module", "module:prompt-guidance"),
        placement("place:prompt:writers", "group", "group:prompt-writers"),
        placement("place:prompt:video-writer", "module", "module:video-prompt-writer"),
      ],
    }),
    capabilityGroup({
      id: "group:auxiliary",
      name: "辅助能力模组",
      description: "以并行为主收纳按需能力和不好归类的 Skill。",
      triggerRules: "明确 @Skill 或满足具体 Skill 的受控触发规则。",
      relation: "parallel",
      items: [placement("place:auxiliary:skills", "module", "module:auxiliary-skills")],
    }),
  ];

  const noOpWrapperTargets = new Map([
    ["group:novel-guidance", "module:novel-guidance"],
    ["group:novel-planning", "module:novel-planning"],
    ["group:novel-writer", "module:novel-writer"],
    ["group:novel-review", "module:novel-review"],
    ["group:long-form-memory", "module:shared-memory"],
    ["group:novel-engineering", "module:novel-engineering"],
    ["group:short-drama-guidance", "module:short-drama-guidance"],
    ["group:short-drama-review", "module:short-drama-review"],
    ["group:auxiliary", "module:auxiliary-skills"],
  ]);
  for (const group of groups) {
    group.items = group.items.map((item) => noOpWrapperTargets.has(item.targetId)
      ? { ...item, targetType: "module", targetId: noOpWrapperTargets.get(item.targetId) }
      : item);
  }

  const bundle = {
    schemaVersion: CAPABILITY_TEMPLATE_SCHEMA_VERSION,
    template: {
      id: "template:shensi",
      nodeType: "template",
      name: "Skill 面板",
      description: "神思的能力结构版图，决定可被任务路由调动的能力上限和边界。",
      triggerRules: "可信任务路由读取完整模板，根据任务意图、文体、上下文与明确点名实时选择能力；不是线性工作流。",
      relationType: "parallel",
      items: [
        placement("place:template:novel", "group", "group:novel"),
        placement("place:template:short-drama", "group", "group:short-drama"),
        placement("place:template:short-fiction", "group", "group:short-fiction"),
        placement("place:template:public-account", "group", "group:public-account"),
        placement("place:template:short-video", "group", "group:short-video"),
        placement("place:template:prompt", "group", "group:prompt-engineering"),
        placement("place:template:auxiliary", "module", "module:auxiliary-skills"),
      ],
      official: true,
      version: 1,
    },
    groups: groups.filter((group) => !noOpWrapperTargets.has(group.id)),
    modules,
  };
  return normalizeCapabilityTemplate(bundle);
};

const normalizePlacement = (item, index, relation, prefix) => ({
  id: cleanId(item?.id, `${prefix}:placement:${index + 1}`),
  targetType: NODE_TYPES.has(item?.targetType) ? item.targetType : "module",
  targetId: cleanId(item?.targetId, `${prefix}:missing:${index + 1}`),
  role: capabilityRoleForIndex(relation, index),
});

const normalizeSlot = (slot, index, relation, moduleId) => {
  const policy = normalizedPolicyFields(slot);
  return {
    id: cleanId(slot?.id, `${moduleId}:slot:${index + 1}`),
    name: cleanText(slot?.name || `能力插槽 ${index + 1}`, 100),
    description: cleanText(slot?.description, 500),
    triggerRules: cleanText(slot?.triggerRules, 800),
    ...policy,
    skillId: cleanText(slot?.skillId, 160),
    compositeChildId: cleanText(slot?.compositeChildId, 180),
    fixedSlotId: cleanText(slot?.fixedSlotId, 160),
    capabilities: unique(slot?.capabilities).slice(0, 24),
    sourceLegacySlotId: cleanText(slot?.sourceLegacySlotId, 160),
    legacyBindingAllowed: slot?.legacyBindingAllowed !== false,
    allowOfficialFallback: own(slot, "allowOfficialFallback")
      ? slot.allowOfficialFallback === true
      : Boolean(slot?.fixedSlotId && slot?.official === true),
    disabled: slot?.disabled === true,
    role: capabilityRoleForIndex(relation, index),
    official: slot?.official === true,
    kernelManaged: slot?.kernelManaged === true || isKernelManagedCapabilityNode("module", moduleId),
  };
};

const normalizeNode = (node, nodeType, index) => {
  const id = cleanId(node?.id, `${nodeType}:custom:${index + 1}`);
  const relation = relationType(node?.relationType);
  const policy = normalizedPolicyFields(node, policyDefaultsForNode(id));
  const base = {
    id,
    nodeType,
    name: cleanText(node?.name || (nodeType === "module" ? "未命名模块" : "未命名模组"), 100),
    description: cleanText(node?.description, 500),
    triggerRules: cleanText(node?.triggerRules, 800),
    routeDocument: cleanRouteDocument(node?.routeDocument),
    ...policy,
    relationType: relation,
    official: node?.official === true,
    disabled: node?.disabled === true,
    kernelManaged: node?.kernelManaged === true || isKernelManagedCapabilityNode(nodeType, id),
    version: Math.max(1, Number(node?.version) || 1),
    createdAt: Number(node?.createdAt) || 0,
    updatedAt: Number(node?.updatedAt) || 0,
    libraryAssetId: cleanText(node?.libraryAssetId, 180),
    marketplaceId: cleanText(node?.marketplaceId, 180),
    origin: cleanText(node?.origin, 40),
    sourceLabel: cleanText(node?.sourceLabel, 160),
    trustLevel: cleanText(node?.trustLevel, 40),
    author: cleanText(node?.author, 120),
    prototypeId: cleanText(node?.prototypeId, 180),
    prototypeName: cleanText(node?.prototypeName, 160),
    prototypeFingerprint: cleanText(node?.prototypeFingerprint, 128),
    derivativeCopy: node?.derivativeCopy === true,
    changeSummary: cleanText(node?.changeSummary, 2_000),
  };
  if (nodeType === "module") return {
    ...base,
    affectsStructure: node?.affectsStructure === true,
    protectedReason: cleanText(node?.protectedReason, 500),
    slots: list(node?.slots).map((slot, slotIndex) => normalizeSlot(slot, slotIndex, relation, id)),
  };
  return {
    ...base,
    items: list(node?.items).map((item, itemIndex) => normalizePlacement(item, itemIndex, relation, id)),
  };
};

const V2_WRAPPER_GROUPS = Object.freeze([
  { id: "group:novel-guidance", name: "小说创作引导模组", description: "集中管理长篇小说创作合同与关键取舍的引导能力。", triggerRules: "长篇小说目标、读者、题材或关键效果尚未确认时启用。", moduleId: "module:novel-guidance" },
  { id: "group:novel-planning", name: "小说规划模组", description: "集中管理大纲规划与受正史约束的设定规划能力。", triggerRules: "规划大纲、卷纲、章纲、人物、世界观或其他正史设定时启用。", moduleId: "module:novel-planning" },
  { id: "group:novel-writer", name: "小说主笔模组", description: "管理小说正文主笔模块；主要与备选主笔的替换关系在模块内部生效。", triggerRules: "小说正文、续写、改写与章节交付。", moduleId: "module:novel-writer" },
  { id: "group:novel-review", name: "小说自检模组", description: "集中管理小说候选的效果复核能力。", triggerRules: "小说候选生成后或用户明确要求审稿时启用。", moduleId: "module:novel-review" },
  { id: "group:long-form-memory", name: "长文记忆模组", description: "由长篇小说与连续短剧共享，提供状态、信息台阶与伏笔建议。", triggerRules: "长篇小说或连续短剧交付后启用；最终写入仍由可信内核执行。", moduleId: "module:shared-memory" },
  { id: "group:novel-engineering", name: "工程化管理模组", description: "管理长篇作品目录、结构化落盘与跨章工程建议。", triggerRules: "长篇小说工程建立、目录调整、结构化落盘或跨章管理时启用。", moduleId: "module:novel-engineering" },
  { id: "group:short-drama-guidance", name: "短剧创作引导模组", description: "集中管理原创短剧与小说改短剧共用的创作引导。", triggerRules: "短剧来源模式、平台、集数、冲突或制作约束尚未确认时启用。", moduleId: "module:short-drama-guidance" },
  { id: "group:short-drama-review", name: "短剧自检模组", description: "集中管理原创与改编短剧共用的成稿自检能力。", triggerRules: "正式短剧候选生成后启用。", moduleId: "module:short-drama-review" },
]);

const V3_NO_OP_WRAPPER_GROUPS = Object.freeze([
  ...V2_WRAPPER_GROUPS,
  {
    id: "group:auxiliary",
    name: "辅助能力模组",
    description: "以并行为主收纳按需能力和不好归类的 Skill。",
    triggerRules: "明确 @Skill 或满足具体 Skill 的受控触发规则。",
    moduleId: "module:auxiliary-skills",
  },
]);

const stockWrapperIsUnchanged = (group, definition) => Boolean(
  group
  && group.official === true
  && group.relationType === "parallel"
  && group.name === definition.name
  && group.description === definition.description
  && group.triggerRules === definition.triggerRules
  && group.items.length === 1
  && group.items[0].targetType === "module"
  && group.items[0].targetId === definition.moduleId,
);

const flattenStockNoOpWrapperGroups = (bundle) => {
  const removable = new Map(V3_NO_OP_WRAPPER_GROUPS
    .filter((definition) => stockWrapperIsUnchanged(bundle.groups.find((group) => group.id === definition.id), definition))
    .map((definition) => [definition.id, definition.moduleId]));
  if (!removable.size) return bundle;
  const containers = [bundle.template, ...bundle.groups];
  for (const container of containers) {
    const seen = new Set();
    container.items = container.items.flatMap((item) => {
      const next = item.targetType === "group" && removable.has(item.targetId)
        ? { ...item, targetType: "module", targetId: removable.get(item.targetId) }
        : item;
      const key = `${next.targetType}:${next.targetId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [next];
    });
  }
  bundle.groups = bundle.groups.filter((group) => !removable.has(group.id));
  return bundle;
};

const upgradeCapabilityTemplate = (bundle, sourceVersion) => {
  if (sourceVersion < 2) {
    const groupIds = new Set(bundle.groups.map((group) => group.id));
    for (const definition of V2_WRAPPER_GROUPS) {
      if (groupIds.has(definition.id)) continue;
      bundle.groups.push(normalizeNode({
        id: definition.id,
        nodeType: "group",
        name: definition.name,
        description: definition.description,
        triggerRules: definition.triggerRules,
        relationType: "parallel",
        official: true,
        items: [{ id: `${definition.id}:module`, targetType: "module", targetId: definition.moduleId }],
      }, "group", bundle.groups.length));
      groupIds.add(definition.id);
    }
    const replacementByContainer = new Map([
      ["group:novel", new Map([
        ["module:novel-guidance", "group:novel-guidance"],
        ["module:novel-planning", "group:novel-planning"],
        ["module:novel-writer", "group:novel-writer"],
        ["module:novel-review", "group:novel-review"],
        ["module:shared-memory", "group:long-form-memory"],
        ["module:novel-engineering", "group:novel-engineering"],
      ])],
      ["group:short-drama", new Map([
        ["module:short-drama-guidance", "group:short-drama-guidance"],
        ["module:short-drama-review", "group:short-drama-review"],
        ["module:shared-memory", "group:long-form-memory"],
      ])],
    ]);
    for (const [containerId, replacements] of replacementByContainer) {
      const container = bundle.groups.find((group) => group.id === containerId);
      if (!container) continue;
      container.items = container.items.map((item) => item.targetType === "module" && replacements.has(item.targetId)
        ? { ...item, targetType: "group", targetId: replacements.get(item.targetId) }
        : item);
    }
  }
  if (sourceVersion < 3) flattenStockNoOpWrapperGroups(bundle);
  if (sourceVersion < 4) {
    const engineeringModule = bundle.modules.find((module) => module.id === "module:novel-engineering");
    const engineeringSlot = engineeringModule?.slots?.find((slot) => slot.id === "slot:novel-engineering");
    if (engineeringModule?.official === true && engineeringModule.version === 1 && engineeringSlot?.official === true && !engineeringSlot.triggerKeywords.length) {
      engineeringSlot.deliverableTypes = ["novel"];
      engineeringSlot.artifactTypes = ["novel"];
      engineeringSlot.triggerKeywords = ["工程化管理", "结构化管理", "目录调整", "结构化落盘", "跨章管理"];
    }
    const shortFictionTheory = bundle.modules.find((module) => module.id === "module:short-fiction-theory");
    const legacyStockSlot = shortFictionTheory?.slots?.length === 1
      && shortFictionTheory.official === true
      && shortFictionTheory.version === 1
      && shortFictionTheory.slots[0].id === "slot:short-fiction-general-theory"
      && shortFictionTheory.slots[0].fixedSlotId === "builtin:short-fiction-general-theory"
      && !shortFictionTheory.slots[0].skillId;
    if (legacyStockSlot) {
      shortFictionTheory.slots[0].skillId = "builtin:short-fiction-general-theory";
      shortFictionTheory.slots[0].allowOfficialFallback = true;
      shortFictionTheory.slots.push(normalizeSlot({
        id: "slot:short-fiction-science-theory",
        name: "短篇科幻",
        skillId: "builtin:short-science-fiction-theory",
        fixedSlotId: "builtin:short-science-fiction-theory",
        deliverableTypes: ["short_fiction"],
        triggerKeywords: ["短篇科幻", "科幻短篇", "科幻小说"],
        allowOfficialFallback: true,
        official: true,
      }, 1, shortFictionTheory.relationType, shortFictionTheory.id));
      shortFictionTheory.slots = shortFictionTheory.slots.map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex(shortFictionTheory.relationType, index),
      }));
    }
  }
  if (sourceVersion < 5) {
    const canonicalModules = [kernelMemoryModule(), kernelEngineeringModule()];
    for (const canonical of canonicalModules) {
      const index = bundle.modules.findIndex((module) => module.id === canonical.id);
      const normalized = normalizeNode(canonical, "module", Math.max(0, index));
      if (index < 0) bundle.modules.push(normalized);
      else bundle.modules[index] = normalized;
    }
  }
  if (sourceVersion < 7) {
    const experienceModule = normalizeNode(creationExperienceModule(), "module", bundle.modules.length);
    if (!bundle.modules.some((module) => module.id === experienceModule.id)) bundle.modules.push(experienceModule);
    const novelGroup = bundle.template.id === "template:shensi"
      ? bundle.groups.find((group) => group.id === "group:novel")
      : null;
    if (novelGroup && !novelGroup.items.some((item) => item.targetType === "module" && item.targetId === experienceModule.id)) {
      novelGroup.items.push({
        id: "place:novel:experience",
        targetType: "module",
        targetId: experienceModule.id,
        role: capabilityRoleForIndex(novelGroup.relationType, novelGroup.items.length),
      });
    }
  }
  if (sourceVersion < 8) {
    const auxiliaryModule = bundle.modules.find((module) => module.id === "module:auxiliary-skills");
    if (auxiliaryModule && !auxiliaryModule.slots.some((slot) => slot.id === "slot:novel-cover-design" || slot.skillId === "user:shensi.novel-cover-design")) {
      const next = normalizeSlot(novelCoverSkillSlot(), auxiliaryModule.slots.length, auxiliaryModule.relationType, auxiliaryModule.id);
      auxiliaryModule.slots.push({ ...next, role: capabilityRoleForIndex(auxiliaryModule.relationType, auxiliaryModule.slots.length) });
    }
  }
  if (sourceVersion < 9) {
    const publicAccountGroup = bundle.groups.find((group) => group.id === "group:public-account" && group.official === true);
    if (publicAccountGroup) {
      const illustrationModule = normalizeNode(publicAccountIllustrationModule(), "module", bundle.modules.length);
      if (!bundle.modules.some((module) => module.id === illustrationModule.id)) bundle.modules.push(illustrationModule);
      if (!publicAccountGroup.items.some((item) => item.targetType === "module" && item.targetId === illustrationModule.id)) {
        publicAccountGroup.items.push({
          id: "place:public-account:illustration",
          targetType: "module",
          targetId: illustrationModule.id,
          role: capabilityRoleForIndex(publicAccountGroup.relationType, publicAccountGroup.items.length),
        });
      }
    }
  }
  if (sourceVersion < 15) {
    const writerModule = bundle.modules.find((module) => module.id === "module:novel-writer" && module.official === true);
    if (writerModule && !writerModule.slots.some((slot) => slot.skillId === "builtin:chinese-novelist-skill")) {
      writerModule.relationType = "primary-secondary";
      writerModule.slots.push(normalizeSlot({
        id: "slot:chinese-novelist-skill",
        name: "备用主笔 · chinese-novelist-skill",
        skillId: "builtin:chinese-novelist-skill",
        fixedSlotId: "builtin:chinese-novelist-skill",
        description: "备用主笔只参与用户明确选择的多主笔候选或明确点名任务，不改变默认正文主笔。",
        allowOfficialFallback: true,
        official: true,
      }, writerModule.slots.length, writerModule.relationType, writerModule.id));
      writerModule.slots = writerModule.slots.map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex(writerModule.relationType, index),
      }));
    }
  }
  if (sourceVersion < 16) {
    // 将用户提供的短剧视频逆推 Skill 接入辅助能力模块。已有模板只补
    // 缺失插槽，保留作者对其他辅助能力和模块关系的现有配置。
    const auxiliaryModule = bundle.modules.find((module) => module.id === "module:auxiliary-skills" && module.official === true);
    if (auxiliaryModule && !auxiliaryModule.slots.some((slot) => slot.fixedSlotId === "builtin:short-drama-script-reconstructor" || slot.skillId === "builtin:short-drama-script-reconstructor")) {
      const next = normalizeSlot(fixedSlot("builtin:short-drama-script-reconstructor", "短剧视频逆推剧本", {
        description: "只根据用户明确提供的短剧视频、链接或附件进行证据约束的剧本重构；不声称恢复未拍摄的原始剧本。",
        triggerRules: "用户明确要求短剧逆推、视频逆推剧本、重构剧本或还原短剧时启用。",
        triggerKeywords: ["短剧逆推", "视频逆推剧本", "逆推剧本", "重构剧本", "还原短剧", "短剧视频分析"],
        capabilities: ["auxiliary_advisor"],
        workspaceModes: CREATIVE_WORKSPACE_MODES,
        contextDomains: ["script", "script-adaptation"],
        deliverableTypes: ["short_drama_script"],
      }), auxiliaryModule.slots.length, auxiliaryModule.relationType, auxiliaryModule.id);
      auxiliaryModule.slots.push({ ...next, role: capabilityRoleForIndex(auxiliaryModule.relationType, auxiliaryModule.slots.length) });
    }
    const adaptedWriter = bundle.modules.find((module) => module.id === "module:adapted-drama-writer" && module.official === true);
    if (adaptedWriter) {
      adaptedWriter.description = "先抽取人物关系功能、冲突链、信息差、情绪曲线、爽点与集尾钩子，再完成原创化剧情功能对位改编。";
      adaptedWriter.triggerRules = "来源模式为小说、原作或章节改编时启用；必须区分结构迁移与逐句改写。";
    }
    const shortDramaReview = bundle.modules.find((module) => module.id === "module:short-drama-review" && module.official === true);
    if (shortDramaReview) {
      shortDramaReview.description = "以 Essence Lock 精髓锁为核心，检查保真、冲突升级、爽点因果、节奏、对白、集尾钩子与制作可执行性。";
      shortDramaReview.triggerRules = "正式短剧候选生成后启用；先建立精髓锁，再分层审稿和增强。";
    }
  }
  if (sourceVersion < 17) {
    // 合并旧版“目标文档 / 语义”重复插槽；视频主笔仍归属于
    // 提示词主笔模块，旧绑定、触发词和禁用状态均保留。
    const canonical = createInitialCapabilityTemplate();
    const canonicalPrompt = canonical.modules.find((module) => module.id === "module:prompt-writer");
    const prompt = bundle.modules.find((module) => module.id === "module:prompt-writer");
    const slotMatchesSkill = (slot, skillId) => slot?.fixedSlotId === skillId || slot?.skillId === skillId;
    const mergedSlot = (skillId, canonicalSlot, sources = []) => {
      const candidates = sources.filter((slot) => slot && (slot.id === canonicalSlot.id || slotMatchesSkill(slot, skillId)));
      const preferred = candidates.find((slot) => slot.skillId && !String(slot.skillId).startsWith("builtin:")) || candidates[0];
      return normalizeSlot({
        ...canonicalSlot,
        ...(preferred || {}),
        id: canonicalSlot.id,
        name: canonicalSlot.name,
        fixedSlotId: canonicalSlot.fixedSlotId || "",
        skillId: preferred?.skillId || skillId,
        triggerKeywords: unique([...canonicalSlot.triggerKeywords, ...candidates.flatMap((slot) => slot.triggerKeywords || [])]),
        triggerConditions: unique([...canonicalSlot.triggerConditions, ...candidates.flatMap((slot) => slot.triggerConditions || [])]),
        disabled: candidates.some((slot) => slot.disabled === true),
      }, 0, "parallel", "module:migration");
    };
    if (prompt && canonicalPrompt) {
      const promptSlots = prompt.slots || [];
      for (const canonicalSlot of canonicalPrompt.slots.filter((slot) => [
        "builtin:visual-asset-prompt-writer",
        "builtin:video-prompt-writer",
        "builtin:panorama-prompt-writer",
      ].includes(slot.skillId))) {
        const merged = mergedSlot(canonicalSlot.skillId, canonicalSlot, promptSlots);
        prompt.slots = prompt.slots.filter((slot) => !slotMatchesSkill(slot, canonicalSlot.skillId));
        prompt.slots.push(merged);
      }
    }
  }
  if (sourceVersion < 18) {
    // 兼容曾短暂生成过的独立视频模块：三类视频主笔回收到提示词主笔
    // 模块，避免用户面板出现额外的“视频模块”宫格。
    const canonical = createInitialCapabilityTemplate();
    const canonicalPrompt = canonical.modules.find((module) => module.id === "module:prompt-writer");
    const prompt = bundle.modules.find((module) => module.id === "module:prompt-writer");
    const previousVideo = bundle.modules.find((module) => module.id === "module:video-prompt-writers");
    const matches = (slot, skillId) => slot?.fixedSlotId === skillId || slot?.skillId === skillId;
    const merge = (skillId, canonicalSlot, sources) => {
      const candidates = sources.filter((slot) => slot && (slot.id === canonicalSlot.id || matches(slot, skillId)));
      const preferred = candidates.find((slot) => slot.skillId && !String(slot.skillId).startsWith("builtin:")) || candidates[0];
      return normalizeSlot({
        ...canonicalSlot,
        ...(preferred || {}),
        id: canonicalSlot.id,
        name: canonicalSlot.name,
        fixedSlotId: canonicalSlot.fixedSlotId || "",
        skillId: preferred?.skillId || skillId,
        triggerKeywords: unique([...canonicalSlot.triggerKeywords, ...candidates.flatMap((slot) => slot.triggerKeywords || [])]),
        triggerConditions: unique([...canonicalSlot.triggerConditions, ...candidates.flatMap((slot) => slot.triggerConditions || [])]),
        disabled: candidates.some((slot) => slot.disabled === true),
      }, 0, "parallel", "module:migration");
    };
    if (prompt && canonicalPrompt) {
      const sources = [...(prompt.slots || []), ...(previousVideo?.slots || [])];
      for (const canonicalSlot of canonicalPrompt.slots.filter((slot) => [
        "builtin:visual-asset-prompt-writer",
        "builtin:video-prompt-writer",
        "builtin:panorama-prompt-writer",
      ].includes(slot.skillId))) {
        const next = merge(canonicalSlot.skillId, canonicalSlot, sources);
        prompt.slots = prompt.slots.filter((slot) => !matches(slot, canonicalSlot.skillId));
        prompt.slots.push(next);
      }
    }
    bundle.modules = bundle.modules.filter((module) => module.id !== "module:video-prompt-writers");
    for (const group of bundle.groups) group.items = group.items.filter((item) => item.targetId !== "module:video-prompt-writers");
  }
  if (sourceVersion < 19) {
    // 旧面板可能由用户删掉或从早期版本迁移时遗漏短剧生产链 Skill。
    // 只补缺失插槽，不覆盖用户现有绑定、顺序或禁用状态。
    const canonical = createInitialCapabilityTemplate();
    const ensureSlot = (moduleId, skillId) => {
      const target = bundle.modules.find((module) => module.id === moduleId && module.official === true);
      const source = canonical.modules.find((module) => module.id === moduleId)?.slots.find((slot) => slot.skillId === skillId);
      if (!target || !source || target.slots.some((slot) => slot.skillId === skillId || slot.fixedSlotId === skillId)) return;
      const next = normalizeSlot(source, target.slots.length, target.relationType, target.id);
      target.slots.push({ ...next, role: capabilityRoleForIndex(target.relationType, target.slots.length) });
    };
    ensureSlot("module:auxiliary-skills", "builtin:short-drama-script-reconstructor");
    ensureSlot("module:adapted-drama-writer", "builtin:adapted-script-writer");
    ensureSlot("module:short-drama-review", "builtin:short-drama-review");
  }
  if (sourceVersion < 20) {
    // 4.1.3 could retain the reverse-engineering Skill while losing the two
    // short-drama production-chain bindings. Restore those official module
    // slots on upgrade, then convert the three prompt writers to removable
    // optional peers.
    const canonical = createInitialCapabilityTemplate();
    const ensureOfficialSlot = (moduleId, skillId) => {
      const target = bundle.modules.find((module) => module.id === moduleId && module.official === true);
      const source = canonical.modules.find((module) => module.id === moduleId)?.slots.find((slot) => slot.skillId === skillId);
      if (!target || !source || target.slots.some((slot) => slot.skillId === skillId || slot.fixedSlotId === skillId)) return;
      const next = normalizeSlot(source, target.slots.length, target.relationType, target.id);
      target.slots.push({ ...next, role: capabilityRoleForIndex(target.relationType, target.slots.length) });
    };
    ensureOfficialSlot("module:adapted-drama-writer", "builtin:adapted-script-writer");
    ensureOfficialSlot("module:short-drama-review", "builtin:short-drama-review");
    ensureOfficialSlot("module:auxiliary-skills", "builtin:short-drama-script-reconstructor");
    const promptWriter = bundle.modules.find((module) => module.id === "module:prompt-writer" && module.official === true);
    if (promptWriter) {
      for (const slot of promptWriter.slots) {
        if (["builtin:prompt-writer", "builtin:video-prompt-writer"].includes(slot.skillId)) {
          slot.fixedSlotId = "";
          slot.allowOfficialFallback = false;
          slot.legacyBindingAllowed = false;
        }
      }
    }
  }
  if (sourceVersion < 21) {
    // 视频提示词从提示词主笔模块的并行插槽迁移为独立主次模块。
    // 保留旧绑定、触发词、禁用状态和用户自定义 Skill；只改变归属与关系。
    const canonical = createInitialCapabilityTemplate();
    const canonicalVideo = canonical.modules.find((module) => module.id === "module:video-prompt-writer");
    const promptWriter = bundle.modules.find((module) => module.id === "module:prompt-writer");
    const legacyVideo = bundle.modules.find((module) => module.id === "module:video-prompt-writers");
    let videoWriter = bundle.modules.find((module) => module.id === "module:video-prompt-writer");
    if (!videoWriter && canonicalVideo) {
      videoWriter = clone(canonicalVideo);
      bundle.modules.push(videoWriter);
    }
    if (videoWriter && canonicalVideo) {
      const existingVideoSlots = list(videoWriter.slots);
      const sourceSlots = [
        ...list(promptWriter?.slots),
        ...list(legacyVideo?.slots),
        ...existingVideoSlots,
      ];
      const matchesSkill = (slot, skillId, canonicalSlot) => (
        slot?.skillId === skillId
        || slot?.fixedSlotId === skillId
        || slot?.id === canonicalSlot.id
      );
      const mergeVideoSlot = (canonicalSlot, index) => {
        const candidates = sourceSlots.filter((slot) => matchesSkill(slot, canonicalSlot.skillId, canonicalSlot));
        const preferred = candidates.find((slot) => slot?.skillId && !String(slot.skillId).startsWith("builtin:"))
          || candidates.find((slot) => slot?.id === canonicalSlot.id)
          || candidates[0];
        return normalizeSlot({
          ...canonicalSlot,
          ...(preferred || {}),
          id: canonicalSlot.id,
          name: canonicalSlot.name,
          skillId: preferred?.skillId || canonicalSlot.skillId,
          fixedSlotId: canonicalSlot.fixedSlotId || "",
          triggerKeywords: unique([...canonicalSlot.triggerKeywords, ...candidates.flatMap((slot) => slot.triggerKeywords || [])]),
          triggerConditions: unique([...canonicalSlot.triggerConditions, ...candidates.flatMap((slot) => slot.triggerConditions || [])]),
          disabled: candidates.some((slot) => slot.disabled === true),
          official: preferred?.official ?? canonicalSlot.official,
        }, index, canonicalVideo.relationType, videoWriter.id);
      };
      videoWriter.name = canonicalVideo.name;
      videoWriter.description = canonicalVideo.description;
      videoWriter.triggerRules = canonicalVideo.triggerRules;
      videoWriter.relationType = canonicalVideo.relationType;
      videoWriter.official = videoWriter.official !== false;
      videoWriter.slots = canonicalVideo.slots.map(mergeVideoSlot);
      const builtInVideoSkills = new Set(canonicalVideo.slots.map((slot) => slot.skillId));
      const extras = existingVideoSlots
        .filter((slot) => !builtInVideoSkills.has(slot?.skillId) && !builtInVideoSkills.has(slot?.fixedSlotId))
        .map((slot, index) => normalizeSlot(slot, videoWriter.slots.length + index, videoWriter.relationType, videoWriter.id));
      videoWriter.slots.push(...extras);
    }
    if (promptWriter) {
      promptWriter.slots = promptWriter.slots.filter((slot) => ![
        "builtin:video-prompt-writer",
      ].includes(slot.skillId) && ![
        "builtin:video-prompt-writer",
      ].includes(slot.fixedSlotId));
    }
    bundle.modules = bundle.modules.filter((module) => module.id !== "module:video-prompt-writers");
    for (const group of bundle.groups) group.items = group.items.filter((item) => item.targetId !== "module:video-prompt-writers");
    const promptGroup = bundle.groups.find((group) => group.id === "group:prompt-engineering");
    const placementParent = promptGroup || bundle.template;
    if (videoWriter && placementParent && !placementParent.items.some((item) => item.targetType === "module" && item.targetId === videoWriter.id)) {
      placementParent.items.push(placement(`${placementParent.id}:video-prompt-writer`, "module", videoWriter.id));
    }
  }
  if (sourceVersion < 22) {
    // 通用“提示词主笔”已经退出提示词主笔与视频提示词主笔模块；
    // 原 2.5 视频提示词保留稳定 ID，原位升级为官方 ai导演（二）。
    // 迁移只删除这两个官方模块里的指定绑定，不碰用户新增的其他插槽。
    const canonical = createInitialCapabilityTemplate();
    const promptWriter = bundle.modules.find((module) => module.id === "module:prompt-writer");
    const videoWriter = bundle.modules.find((module) => module.id === "module:video-prompt-writer");
    if (promptWriter) {
      promptWriter.slots = list(promptWriter.slots).filter((slot) => (
        slot.skillId !== "builtin:prompt-writer" && slot.fixedSlotId !== "builtin:prompt-writer"
      ));
    }
    if (videoWriter) {
      const canonicalVideo = canonical.modules.find((module) => module.id === "module:video-prompt-writer");
      const canonicalDirectorTwo = canonicalVideo?.slots.find((slot) => slot.skillId === "builtin:video-prompt-writer");
      videoWriter.slots = list(videoWriter.slots).filter((slot) => (
        slot.skillId !== "builtin:prompt-writer" && slot.fixedSlotId !== "builtin:prompt-writer"
      ));
      const existingDirectorTwo = videoWriter.slots.find((slot) => (
        slot.id === canonicalDirectorTwo?.id
        || slot.skillId === "builtin:video-prompt-writer"
        || slot.fixedSlotId === "builtin:video-prompt-writer"
      ));
      if (existingDirectorTwo && canonicalDirectorTwo) {
        Object.assign(existingDirectorTwo, {
          ...canonicalDirectorTwo,
          disabled: existingDirectorTwo.disabled === true,
          role: existingDirectorTwo.role,
        });
      }
      videoWriter.slots = videoWriter.slots.map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex(videoWriter.relationType, index),
      }));
      videoWriter.description = canonicalVideo?.description || videoWriter.description;
      videoWriter.triggerRules = canonicalVideo?.triggerRules || videoWriter.triggerRules;
    }
  }
  if (sourceVersion < 23) {
    // 只刷新稳定官方 Skill ID 对应的显示语义；保留用户的插槽顺序、
    // 启停状态和自定义绑定，并继续接受旧名称作为兼容触发词。
    const canonical = createInitialCapabilityTemplate();
    const canonicalVideo = canonical.modules.find((module) => module.id === "module:video-prompt-writer");
    const canonicalDirectorTwo = canonicalVideo?.slots.find((slot) => slot.skillId === "builtin:video-prompt-writer");
    const videoWriter = bundle.modules.find((module) => module.id === "module:video-prompt-writer");
    const existingDirectorTwo = videoWriter?.slots.find((slot) => slot.skillId === "builtin:video-prompt-writer");
    if (videoWriter && canonicalVideo) {
      videoWriter.description = canonicalVideo.description;
      videoWriter.triggerRules = canonicalVideo.triggerRules;
    }
    if (existingDirectorTwo && canonicalDirectorTwo) {
      existingDirectorTwo.name = canonicalDirectorTwo.name;
      existingDirectorTwo.description = canonicalDirectorTwo.description;
      existingDirectorTwo.triggerRules = canonicalDirectorTwo.triggerRules;
      existingDirectorTwo.triggerConditions = [...canonicalDirectorTwo.triggerConditions];
      existingDirectorTwo.triggerKeywords = [...canonicalDirectorTwo.triggerKeywords];
    }
  }
  if (sourceVersion < 24) {
    // AI 视频导演（二）成为唯一的视频提示词主 Skill。
    // 保留用户自定义绑定、禁用状态和其他自定义插槽。
    const canonical = createInitialCapabilityTemplate();
    const canonicalVideo = canonical.modules.find((module) => module.id === "module:video-prompt-writer");
    const videoWriter = bundle.modules.find((module) => module.id === "module:video-prompt-writer");
    if (videoWriter && canonicalVideo) {
      const existingSlots = list(videoWriter.slots);
      const builtInIds = new Set(canonicalVideo.slots.map((slot) => slot.skillId));
      const findExisting = (canonicalSlot) => existingSlots.find((slot) => (
        slot?.id === canonicalSlot.id
        || slot?.skillId === canonicalSlot.skillId
        || slot?.fixedSlotId === canonicalSlot.skillId
      ));
      const orderedOfficial = canonicalVideo.slots.map((canonicalSlot, index) => {
        const existing = findExisting(canonicalSlot);
        return normalizeSlot({
          ...canonicalSlot,
          ...(existing || {}),
          id: canonicalSlot.id,
          name: canonicalSlot.name,
          skillId: existing?.skillId || canonicalSlot.skillId,
          fixedSlotId: "",
          disabled: existing?.disabled === true,
          official: existing?.official ?? canonicalSlot.official,
        }, index, canonicalVideo.relationType, videoWriter.id);
      });
      const extras = existingSlots
        .filter((slot) => !builtInIds.has(slot?.skillId) && !builtInIds.has(slot?.fixedSlotId))
        .map((slot, index) => normalizeSlot(slot, orderedOfficial.length + index, canonicalVideo.relationType, videoWriter.id));
      videoWriter.name = canonicalVideo.name;
      videoWriter.description = canonicalVideo.description;
      videoWriter.triggerRules = canonicalVideo.triggerRules;
      videoWriter.relationType = canonicalVideo.relationType;
      videoWriter.slots = [...orderedOfficial, ...extras].map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex(canonicalVideo.relationType, index),
      }));
    }
  }
  if (sourceVersion < 25) {
    // 移除已废弃的 AI 视频导演 Skill。旧插槽/绑定统一迁移到
    // AI 视频导演（二），保留禁用状态和用户自定义插槽，避免历史配置失效。
    const canonical = createInitialCapabilityTemplate();
    const canonicalVideo = canonical.modules.find((module) => module.id === "module:video-prompt-writer");
    const canonicalSlot = canonicalVideo?.slots.find((slot) => slot.skillId === "builtin:video-prompt-writer");
    const isLegacyDirector = (slot) => slot?.skillId === "builtin:ai-video-director"
      || slot?.fixedSlotId === "builtin:ai-video-director";
    const isPrimaryDirector = (slot) => slot?.skillId === "builtin:video-prompt-writer"
      || slot?.fixedSlotId === "builtin:video-prompt-writer"
      || slot?.id === "slot:video-prompt-writer";
    const promptWriter = bundle.modules.find((module) => module.id === "module:prompt-writer");
    const videoWriter = bundle.modules.find((module) => module.id === "module:video-prompt-writer");
    const legacySlots = [
      ...list(promptWriter?.slots).filter(isLegacyDirector),
      ...list(videoWriter?.slots).filter(isLegacyDirector),
    ];
    if (promptWriter) promptWriter.slots = list(promptWriter.slots).filter((slot) => !isLegacyDirector(slot));
    if (videoWriter && canonicalSlot) {
      const existingSlots = list(videoWriter.slots);
      const existingPrimary = existingSlots.find(isPrimaryDirector);
      const source = existingPrimary || legacySlots[0];
      const migrated = normalizeSlot({
        ...canonicalSlot,
        ...(source || {}),
        id: canonicalSlot.id,
        name: canonicalSlot.name,
        skillId: "builtin:video-prompt-writer",
        fixedSlotId: "",
        disabled: source?.disabled === true || existingPrimary?.disabled === true,
        triggerKeywords: unique([...canonicalSlot.triggerKeywords, ...legacySlots.flatMap((slot) => slot.triggerKeywords || [])]),
        triggerConditions: unique([...canonicalSlot.triggerConditions, ...legacySlots.flatMap((slot) => slot.triggerConditions || [])]),
      }, 0, "parallel", videoWriter.id);
      const extras = existingSlots
        .filter((slot) => !isPrimaryDirector(slot) && !isLegacyDirector(slot))
        .map((slot, index) => normalizeSlot(slot, index + 1, "parallel", videoWriter.id));
      videoWriter.name = canonicalVideo.name;
      videoWriter.description = canonicalVideo.description;
      videoWriter.triggerRules = canonicalVideo.triggerRules;
      videoWriter.relationType = "parallel";
      videoWriter.slots = [migrated, ...extras].map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex("parallel", index),
      }));
    }
  }
  if (sourceVersion < 26) {
    // 图片资产提示词升级为上位提取 + 角色/场景下位输出的组织模块。
    // 只重排官方图片资产插槽；用户自定义插槽、绑定与禁用状态均保留。
    const canonical = createInitialCapabilityTemplate();
    const canonicalPrompt = canonical.modules.find((module) => module.id === "module:prompt-writer");
    const canonicalPanorama = canonical.modules.find((module) => module.id === "module:prompt-panorama-writer");
    const canonicalPromptWriters = canonical.groups.find((group) => group.id === "group:prompt-writers");
    const managedPromptTarget = (item) => item?.targetType === "module"
      && ["module:prompt-writer", "module:prompt-panorama-writer"].includes(item.targetId);
    const prompt = bundle.modules.find((module) => module.id === "module:prompt-writer");
    const promptGroup = bundle.groups.find((group) => group.id === "group:prompt-engineering");
    const officialPromptSkillIds = new Set([
      "builtin:visual-asset-prompt-writer",
      "builtin:industrial-character-prompt-writer",
      "builtin:guoman-scene-prompt-writer",
    ]);
    const matchesSkill = (slot, skillId, canonicalSlot = null) => slot?.skillId === skillId
      || slot?.fixedSlotId === skillId
      || (canonicalSlot && slot?.id === canonicalSlot.id);
    let legacyPanoramaSlot = null;
    if (prompt && canonicalPrompt) {
      const existingSlots = list(prompt.slots);
      legacyPanoramaSlot = existingSlots.find((slot) => matchesSkill(slot, "builtin:panorama-prompt-writer")) || null;
      const orderedOfficial = canonicalPrompt.slots.map((canonicalSlot, index) => {
        const existing = existingSlots.find((slot) => matchesSkill(slot, canonicalSlot.skillId, canonicalSlot));
        return normalizeSlot({
          ...canonicalSlot,
          ...(existing || {}),
          id: canonicalSlot.id,
          name: canonicalSlot.name,
          skillId: existing?.skillId || canonicalSlot.skillId,
          fixedSlotId: canonicalSlot.fixedSlotId,
          disabled: existing?.disabled === true,
          official: existing?.official ?? canonicalSlot.official,
        }, index, canonicalPrompt.relationType, prompt.id);
      });
      const extras = existingSlots
        .filter((slot) => !officialPromptSkillIds.has(slot?.skillId)
          && !officialPromptSkillIds.has(slot?.fixedSlotId)
          && !matchesSkill(slot, "builtin:panorama-prompt-writer"))
        .map((slot, index) => normalizeSlot(slot, orderedOfficial.length + index, canonicalPrompt.relationType, prompt.id));
      prompt.description = canonicalPrompt.description;
      prompt.triggerRules = canonicalPrompt.triggerRules;
      prompt.relationType = canonicalPrompt.relationType;
      prompt.slots = [...orderedOfficial, ...extras].map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex(canonicalPrompt.relationType, index),
      }));
    }
    let panorama = bundle.modules.find((module) => module.id === "module:prompt-panorama-writer");
    if (!panorama && canonicalPanorama) {
      panorama = clone(canonicalPanorama);
      if (legacyPanoramaSlot && panorama.slots[0]) panorama.slots[0] = normalizeSlot({
        ...panorama.slots[0],
        ...legacyPanoramaSlot,
        id: panorama.slots[0].id,
        name: panorama.slots[0].name,
        skillId: legacyPanoramaSlot.skillId || panorama.slots[0].skillId,
        fixedSlotId: panorama.slots[0].fixedSlotId,
        disabled: legacyPanoramaSlot.disabled === true,
      }, 0, panorama.relationType, panorama.id);
      bundle.modules.push(panorama);
    }
    let promptWriters = bundle.groups.find((group) => group.id === "group:prompt-writers");
    if (!promptWriters && canonicalPromptWriters) {
      promptWriters = clone(canonicalPromptWriters);
      bundle.groups.push(promptWriters);
    }
    if (promptWriters && canonicalPromptWriters) {
      promptWriters.name = canonicalPromptWriters.name;
      promptWriters.description = canonicalPromptWriters.description;
      promptWriters.triggerRules = canonicalPromptWriters.triggerRules;
      promptWriters.relationType = "parallel";
      const managedTargets = new Set(["module:prompt-writer", "module:prompt-panorama-writer"]);
      const extras = list(promptWriters.items).filter((item) => !managedTargets.has(item.targetId));
      promptWriters.items = [...canonicalPromptWriters.items, ...extras].map((item, index) => ({
        ...item,
        role: capabilityRoleForIndex("parallel", index),
      }));
    }
    if (promptGroup && promptWriters) {
      const directIndexes = promptGroup.items
        .map((item, index) => managedPromptTarget(item) ? index : -1)
        .filter((index) => index >= 0);
      const insertionIndex = directIndexes.length ? Math.min(...directIndexes) : promptGroup.items.length;
      promptGroup.items = promptGroup.items.filter((item) => !managedPromptTarget(item) && item.targetId !== promptWriters.id);
      promptGroup.items.splice(insertionIndex, 0, placement("place:prompt:writers", "group", promptWriters.id));
      promptGroup.items = promptGroup.items.map((item, index) => ({ ...item, role: capabilityRoleForIndex(promptGroup.relationType, index) }));
    }
  }
  if (sourceVersion < 27) {
    // 小说理论改为两级组织：小说理论顾问负责上位路由，题材模块负责
    // 下位专精；女频模块再以通用理论统领现有的爽文和真假千金 Skill。
    // 只管理新增或既有的官方节点，保留用户绑定、禁用状态和自定义插槽。
    const canonical = createInitialCapabilityTemplate();
    const canonicalAdvisor = canonical.modules.find((module) => module.id === "module:novel-theory-advisor");
    const existingAdvisor = bundle.modules.find((module) => module.id === "module:novel-theory-advisor");
    if (!existingAdvisor && canonicalAdvisor) bundle.modules.push(clone(canonicalAdvisor));

    const canonicalFemale = canonical.modules.find((module) => module.id === "module:female-web-theory");
    const female = bundle.modules.find((module) => module.id === "module:female-web-theory" && module.official === true);
    if (female && canonicalFemale) {
      const managedIds = new Set(canonicalFemale.slots.flatMap((slot) => [slot.id, slot.skillId, slot.fixedSlotId]).filter(Boolean));
      const existingSlots = list(female.slots);
      const matchesCanonical = (slot, canonicalSlot) => slot?.id === canonicalSlot.id
        || slot?.skillId === canonicalSlot.skillId
        || slot?.fixedSlotId === canonicalSlot.fixedSlotId;
      const officialSlots = canonicalFemale.slots.map((canonicalSlot, index) => {
        const existing = existingSlots.find((slot) => matchesCanonical(slot, canonicalSlot));
        return normalizeSlot({
          ...canonicalSlot,
          ...(existing || {}),
          id: canonicalSlot.id,
          name: canonicalSlot.name,
          skillId: existing?.skillId || canonicalSlot.skillId,
          fixedSlotId: canonicalSlot.fixedSlotId,
          disabled: existing?.disabled === true,
          official: existing?.official ?? canonicalSlot.official,
        }, index, canonicalFemale.relationType, female.id);
      });
      const customSlots = existingSlots
        .filter((slot) => ![slot.id, slot.skillId, slot.fixedSlotId].some((id) => managedIds.has(id)))
        .map((slot, index) => normalizeSlot(slot, officialSlots.length + index, canonicalFemale.relationType, female.id));
      female.name = canonicalFemale.name;
      female.description = canonicalFemale.description;
      female.triggerRules = canonicalFemale.triggerRules;
      female.relationType = canonicalFemale.relationType;
      female.slots = [...officialSlots, ...customSlots].map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex(canonicalFemale.relationType, index),
      }));
    }

    const canonicalTheory = canonical.groups.find((group) => group.id === "group:novel-theory");
    const theory = bundle.groups.find((group) => group.id === "group:novel-theory" && group.official === true);
    if (theory && canonicalTheory) {
      const existingItems = list(theory.items);
      const advisorItem = existingItems.find((item) => item.targetId === "module:novel-theory-advisor")
        || canonicalTheory.items[0];
      const remaining = existingItems.filter((item) => item.targetId !== "module:novel-theory-advisor");
      const missingOfficial = canonicalTheory.items.slice(1).filter((item) => !remaining.some((existing) => existing.targetId === item.targetId));
      theory.name = canonicalTheory.name;
      theory.description = canonicalTheory.description;
      theory.triggerRules = canonicalTheory.triggerRules;
      theory.relationType = canonicalTheory.relationType;
      theory.items = [advisorItem, ...remaining, ...missingOfficial].map((item, index) => ({
        ...item,
        role: capabilityRoleForIndex(canonicalTheory.relationType, index),
      }));
    }
  }
  if (sourceVersion < 29) {
    // 创作能力由文体和交付物决定，不再由“作品 / 笔记”模式决定。
    // 作品与笔记的区别只保留在可信内核的索引和结构化管理深度；
    // 已保存的官方面板需要同步解除旧的单模式限制，用户自建节点不改。
    const canonical = createInitialCapabilityTemplate();
    for (const nodeType of ["groups", "modules"]) {
      const canonicalById = new Map(canonical[nodeType].map((node) => [node.id, node]));
      for (const node of bundle[nodeType]) {
        const canonicalNode = canonicalById.get(node.id);
        if (node.official !== true || !canonicalNode) continue;
        const canonicalNodeIsCrossWorkspace = canonicalNode.workspaceModes?.includes("project")
          && canonicalNode.workspaceModes.includes("notebook");
        if (canonicalNodeIsCrossWorkspace) node.workspaceModes = [...CREATIVE_WORKSPACE_MODES];
        if (nodeType !== "modules") continue;
        const canonicalSlots = new Map(canonicalNode.slots.map((slot) => [slot.id, slot]));
        for (const slot of node.slots) {
          const canonicalSlot = canonicalSlots.get(slot.id);
          if (slot.official !== true || !canonicalSlot) continue;
          const canonicalIsCrossWorkspace = canonicalSlot.workspaceModes.includes("project") && canonicalSlot.workspaceModes.includes("notebook");
          const oldSingleCreativeMode = slot.workspaceModes.length === 1
            && ["project", "notebook"].includes(slot.workspaceModes[0]);
          if (canonicalIsCrossWorkspace || (canonicalNodeIsCrossWorkspace && oldSingleCreativeMode)) {
            slot.workspaceModes = [...CREATIVE_WORKSPACE_MODES];
          }
        }
      }
    }
  }
  if (sourceVersion < 30) {
    // 小说自检从单一 effect_reviewer 拆为强剧情与常规推进两个可路由
    // 插槽。旧 effect-review 插槽保留稳定 ID 并承接到常规推进，避免
    // 已保存的用户绑定、禁用状态和历史引用失效。
    const canonical = createInitialCapabilityTemplate();
    const canonicalReview = canonical.modules.find((module) => module.id === "module:novel-review");
    const review = bundle.modules.find((module) => module.id === "module:novel-review" && module.official === true);
    if (canonicalReview && review) {
      const existingSlots = list(review.slots);
      const findExisting = (canonicalSlot) => existingSlots.find((slot) => (
        slot?.id === canonicalSlot.id
        || slot?.skillId === canonicalSlot.skillId
        || slot?.fixedSlotId === canonicalSlot.fixedSlotId
        || (canonicalSlot.skillId === "builtin:effect-review" && slot?.skillId === "builtin:novel-review")
      ));
      const canonicalSlots = canonicalReview.slots.map((canonicalSlot, index) => {
        const existing = findExisting(canonicalSlot);
        return normalizeSlot({
          ...canonicalSlot,
          ...(existing || {}),
          id: canonicalSlot.id,
          name: canonicalSlot.name,
          skillId: existing?.skillId || canonicalSlot.skillId,
          fixedSlotId: canonicalSlot.fixedSlotId,
          capabilities: unique([...canonicalSlot.capabilities, ...list(existing?.capabilities)]),
          triggerKeywords: unique([...canonicalSlot.triggerKeywords, ...list(existing?.triggerKeywords)]),
          triggerConditions: unique([...canonicalSlot.triggerConditions, ...list(existing?.triggerConditions)]),
          disabled: existing?.disabled === true,
          official: existing?.official ?? canonicalSlot.official,
        }, index, canonicalReview.relationType, review.id);
      });
      const managedIds = new Set(canonicalReview.slots.flatMap((slot) => [slot.id, slot.skillId, slot.fixedSlotId]));
      managedIds.add("builtin:novel-review");
      const extras = existingSlots
        .filter((slot) => ![slot?.id, slot?.skillId, slot?.fixedSlotId].some((id) => managedIds.has(id)))
        .map((slot, index) => normalizeSlot(slot, canonicalSlots.length + index, canonicalReview.relationType, review.id));
      review.name = canonicalReview.name;
      review.description = canonicalReview.description;
      review.triggerRules = canonicalReview.triggerRules;
      review.relationType = canonicalReview.relationType;
      review.slots = [...canonicalSlots, ...extras].map((slot, index) => ({
        ...slot,
        role: capabilityRoleForIndex(canonicalReview.relationType, index),
      }));
    }

    const canonicalShortFiction = canonical.modules.find((module) => module.id === "module:short-fiction-review");
    const shortFiction = bundle.modules.find((module) => module.id === "module:short-fiction-review" && module.official === true);
    const shortFictionSlot = shortFiction?.slots.find((slot) => slot.fixedSlotId === "builtin:effect-review" || slot.skillId === "builtin:effect-review");
    const canonicalShortFictionSlot = canonicalShortFiction?.slots.find((slot) => slot.fixedSlotId === "builtin:effect-review" || slot.skillId === "builtin:effect-review");
    if (shortFictionSlot && canonicalShortFictionSlot) {
      shortFictionSlot.capabilities = unique([...canonicalShortFictionSlot.capabilities, ...shortFictionSlot.capabilities]);
      shortFictionSlot.name = canonicalShortFictionSlot.name;
    }

    // 修复已知的官方提示词模块名称漂移，不改用户自建同名模块。
    const canonicalPrompt = canonical.modules.find((module) => module.id === "module:prompt-writer");
    const prompt = bundle.modules.find((module) => module.id === "module:prompt-writer" && module.official === true);
    if (canonicalPrompt && prompt && ["提示词主笔模块", "提示词模块"].includes(prompt.name)) prompt.name = canonicalPrompt.name;
  }
  if (sourceVersion < 10) {
    const legacyDescriptions = new Map([
      ["group:novel", new Set([
        "长篇小说的引导、规划、主笔、自检、理论、记忆与工程化能力版图。",
        "长篇小说的引导、规划、主笔、自检、理论、记忆、经验与工程化能力版图。",
        "长篇小说的引导、规划、主笔、自检、理论与创作经验能力版图。记忆和结构化落盘由模板外的可信内核负责。",
      ])],
      ["group:short-drama", new Set([
        "同时覆盖原创短剧与小说改短剧；当前不预留独立规划模块。连续性记忆与结构化落盘由模板外的可信内核负责。",
      ])],
    ]);
    for (const [groupId, descriptions] of legacyDescriptions) {
      const group = bundle.groups.find((item) => item.id === groupId && item.official === true);
      if (group && descriptions.has(group.description)) group.description = CAPABILITY_VISIBLE_GROUP_DESCRIPTIONS[groupId];
    }
  }
  if (sourceVersion < 13) {
    // Official prompt-specialist slots are routing contracts, not genre
    // fences.  Refresh their semantic triggers so existing saved templates
    // can compose source-domain modules with the requested output writer.
    const canonical = createInitialCapabilityTemplate();
    const canonicalPromptWriter = canonical.modules.find((module) => module.id === "module:prompt-writer");
    const promptWriter = bundle.modules.find((module) => module.id === "module:prompt-writer");
    if (canonicalPromptWriter && promptWriter) {
      for (const canonicalSlot of canonicalPromptWriter.slots) {
        const slot = promptWriter.slots.find((candidate) => candidate.id === canonicalSlot.id);
        if (!slot || slot.official !== true) continue;
        slot.triggerKeywords = [...canonicalSlot.triggerKeywords];
        slot.triggerConditions = [...canonicalSlot.triggerConditions];
        slot.deliverableTypes = [...canonicalSlot.deliverableTypes];
        slot.workspaceModes = [...canonicalSlot.workspaceModes];
      }
    }
  }
  if (sourceVersion < 14) {
    // 记忆模块从只读内核展示升级为可配置能力对象。它可以被修改、
    // 替换或禁用；原生记忆与文档读取仍作为运行时兜底，不依赖该节点。
    const canonicalMemory = normalizeNode(kernelMemoryModule(), "module", 0);
    const memoryIndex = bundle.modules.findIndex((module) => module.id === canonicalMemory.id);
    if (memoryIndex < 0) bundle.modules.push(canonicalMemory);
    else bundle.modules[memoryIndex] = canonicalMemory;
  }
  bundle.schemaVersion = CAPABILITY_TEMPLATE_SCHEMA_VERSION;
  return bundle;
};

export const normalizeCapabilityTemplate = (input = {}) => {
  const sourceVersion = Math.max(1, Number(input?.schemaVersion) || 1);
  const templateRelation = relationType(input?.template?.relationType);
  const templateId = cleanId(input?.template?.id, "template:shensi");
  const templatePolicy = normalizedPolicyFields(input?.template, policyDefaultsForNode(templateId));
  const storedTemplateName = cleanText(input?.template?.name || "Skill 面板", 100);
  const legacyDefaultTemplate = ["神思能力模板", "神思能力面板"].includes(storedTemplateName);
  const normalizeTemplateCopy = (value, maximum) => cleanText(value, maximum)
    .replaceAll("神思能力模板", "Skill 面板")
    .replaceAll("当前模板", "当前面板")
    .replaceAll("完整模板", "完整面板");
  const bundle = {
    schemaVersion: CAPABILITY_TEMPLATE_SCHEMA_VERSION,
    template: {
      id: templateId,
      nodeType: "template",
      name: legacyDefaultTemplate ? "Skill 面板" : storedTemplateName,
      description: normalizeTemplateCopy(input?.template?.description, 500),
      triggerRules: normalizeTemplateCopy(input?.template?.triggerRules, 800),
      ...templatePolicy,
      relationType: templateRelation,
      items: list(input?.template?.items).map((item, index) => normalizePlacement(item, index, templateRelation, templateId)),
      official: input?.template?.official !== false,
      disabled: input?.template?.disabled === true,
      version: Math.max(1, Number(input?.template?.version) || 1),
      createdAt: Number(input?.template?.createdAt) || 0,
      updatedAt: Number(input?.template?.updatedAt) || 0,
      libraryAssetId: cleanText(input?.template?.libraryAssetId, 180),
      marketplaceId: cleanText(input?.template?.marketplaceId, 180),
      origin: cleanText(input?.template?.origin, 40),
      sourceLabel: cleanText(input?.template?.sourceLabel, 160),
      trustLevel: cleanText(input?.template?.trustLevel, 40),
      author: cleanText(input?.template?.author, 120),
      prototypeId: cleanText(input?.template?.prototypeId, 180),
      prototypeName: cleanText(input?.template?.prototypeName, 160),
      prototypeFingerprint: cleanText(input?.template?.prototypeFingerprint, 128),
      derivativeCopy: input?.template?.derivativeCopy === true,
      changeSummary: cleanText(input?.template?.changeSummary, 2_000),
    },
    groups: list(input?.groups).map((node, index) => normalizeNode(node, "group", index)),
    modules: list(input?.modules).map((node, index) => normalizeNode(node, "module", index)),
  };
  return upgradeCapabilityTemplate(bundle, sourceVersion);
};

const canonicalKernelModules = () => [kernelEngineeringModule()]
  .map((module, index) => normalizeNode(module, "module", index));

const placementTargets = (container = {}, targetId = "") => list(container.items)
  .some((item) => item.targetType === "module" && item.targetId === targetId);

const reachableCapabilityGroupIds = (bundle = {}) => {
  const byId = new Map(list(bundle.groups).map((group) => [group.id, group]));
  const reachable = new Set();
  const stack = list(bundle.template?.items).filter((item) => item.targetType === "group").map((item) => item.targetId);
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const item of list(byId.get(id)?.items)) if (item.targetType === "group") stack.push(item.targetId);
  }
  return reachable;
};

const ensureKernelPlacement = (bundle, targetId, preferredGroupIds = []) => {
  const reachableGroups = reachableCapabilityGroupIds(bundle);
  const preferredGroups = preferredGroupIds.map((id) => bundle.groups.find((group) => group.id === id))
    .filter((group) => group && reachableGroups.has(group.id));
  const targets = preferredGroups.length ? preferredGroups : [bundle.template];
  for (const target of targets) {
    if (placementTargets(target, targetId)) continue;
    target.items.push({
      id: `${target.id}:kernel:${targetId.replace(/^module:/, "")}`,
      targetType: "module",
      targetId,
      role: capabilityRoleForIndex(target.relationType, target.items.length),
    });
  }
};

export const applyCapabilityKernelMechanisms = (input = {}) => {
  const sourceVersion = Math.max(1, Number(input?.schemaVersion) || 1);
  const bundle = normalizeCapabilityTemplate(input);
  for (const canonical of canonicalKernelModules()) {
    const index = bundle.modules.findIndex((module) => module.id === canonical.id);
    if (index < 0) bundle.modules.push(canonical);
    else bundle.modules[index] = canonical;
  }
  ensureKernelPlacement(bundle, "module:novel-engineering", ["group:novel"]);
  if (sourceVersion < 12) {
    const canonical = createInitialCapabilityTemplate();
    const canonicalPromptWriter = canonical.modules.find((module) => module.id === "module:prompt-writer");
    const promptWriter = bundle.modules.find((module) => module.id === "module:prompt-writer");
    const promptGroup = bundle.groups.find((group) => group.id === "group:prompt-engineering");
    bundle.modules = bundle.modules.filter((module) => module.id !== "module:prompt-specialized-writers");
    if (promptGroup) promptGroup.items = promptGroup.items.filter((item) => item.targetId !== "module:prompt-specialized-writers");
    if (!promptWriter && canonicalPromptWriter) bundle.modules.push(canonicalPromptWriter);
    else if (promptWriter && canonicalPromptWriter) {
      promptWriter.relationType = canonicalPromptWriter.relationType;
      promptWriter.description = canonicalPromptWriter.description;
      promptWriter.triggerRules = canonicalPromptWriter.triggerRules;
      for (const canonicalSlot of canonicalPromptWriter.slots) {
        if (!promptWriter.slots.some((slot) => slot.id === canonicalSlot.id)) promptWriter.slots.push(canonicalSlot);
      }
    }
  }
  return normalizeCapabilityTemplate(bundle);
};

export const capabilityKernelMutationErrors = (input = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  const errors = [];
  for (const canonical of canonicalKernelModules()) {
    const actual = bundle.modules.find((module) => module.id === canonical.id);
    if (!actual) {
      errors.push(`内置运行机制不可移除：${canonical.name}`);
      continue;
    }
    if (stableStructureHash(actual) !== stableStructureHash(canonical)) errors.push(`内置运行机制不可修改：${canonical.name}`);
  }
  const reachableGroups = reachableCapabilityGroupIds(bundle);
  const memoryParents = ["group:novel", "group:short-drama"].map((id) => bundle.groups.find((group) => group.id === id)).filter((group) => group && reachableGroups.has(group.id));
  const engineeringParents = ["group:novel"].map((id) => bundle.groups.find((group) => group.id === id)).filter((group) => group && reachableGroups.has(group.id));
  if (!(memoryParents.length ? memoryParents.every((group) => placementTargets(group, "module:shared-memory")) : placementTargets(bundle.template, "module:shared-memory"))) {
    errors.push("内置长文记忆机制必须保留在作品能力范围内");
  }
  if (!(engineeringParents.length ? engineeringParents.every((group) => placementTargets(group, "module:novel-engineering")) : placementTargets(bundle.template, "module:novel-engineering"))) {
    errors.push("内置工程化管理机制必须保留在作品能力范围内");
  }
  return errors;
};

const legacyModuleId = (slotId) => `module:legacy:${String(slotId).replace(/[^a-z0-9._:-]/gi, "-")}`;
const legacyGroupId = (groupId) => `group:legacy:${String(groupId).replace(/[^a-z0-9._:-]/gi, "-")}`;

export const migrateLegacySlotsIntoCapabilityTemplate = (inputBundle, { customSlots = [], customSlotGroups = [] } = {}) => {
  const bundle = normalizeCapabilityTemplate(inputBundle || createInitialCapabilityTemplate());
  const referencedLegacySlotIds = new Set(bundle.modules.flatMap((module) => module.slots.map((slot) => slot.sourceLegacySlotId)).filter(Boolean));
  const groupIds = new Set(bundle.groups.map((group) => group.id));
  const moduleIds = new Set(bundle.modules.map((module) => module.id));
  const auxiliary = bundle.groups.find((group) => group.id === "group:auxiliary") || bundle.template;

  const legacyGroups = list(customSlotGroups).filter((group) => group?.id).map((group) => {
    const id = legacyGroupId(group.id);
    return capabilityGroup({
      id,
      name: cleanText(group.name || "迁移模组", 100),
      description: cleanText(group.description || "由旧版自定义插槽组无损迁移。", 500),
      triggerRules: "沿用组内各插槽的受控触发规则。",
      relation: group.groupType === "organization" ? "organization" : "parallel",
      items: [],
      official: false,
    });
  });
  for (const group of legacyGroups) {
    if (!groupIds.has(group.id)) {
      bundle.groups.push(group);
      groupIds.add(group.id);
    }
  }

  const groupByLegacyId = new Map(list(customSlotGroups).map((group) => [String(group.id), bundle.groups.find((item) => item.id === legacyGroupId(group.id))]));
  for (const source of list(customSlotGroups)) {
    const group = groupByLegacyId.get(String(source.id));
    if (!group) continue;
    const parent = groupByLegacyId.get(String(source.parentGroupId));
    const container = parent || auxiliary;
    if (!container.items.some((item) => item.targetType === "group" && item.targetId === group.id)) {
      container.items.push(placement(`${container.id}:place:${group.id}`, "group", group.id));
    }
  }

  for (const source of list(customSlots)) {
    if (!source?.id || referencedLegacySlotIds.has(String(source.id))) continue;
    const moduleId = legacyModuleId(source.id);
    if (moduleIds.has(moduleId)) continue;
    const primarySkillId = source.skillId ? `user:${String(source.skillId).replace(/^user:/, "")}` : source.developerSkillId || "";
    const slots = [skillSlot({
      id: `${moduleId}:primary`,
      name: cleanText(source.name || "主要插槽", 100),
      skillId: primarySkillId,
      description: cleanText(source.description, 500),
      triggerRules: [...list(source.triggerKeywords), ...list(source.triggerConditions)].join("；"),
      triggerKeywords: list(source.triggerKeywords),
      capabilities: list(source.capabilities),
      workspaceModes: list(source.workspaceModes),
      sourceLegacySlotId: String(source.id),
      official: false,
    })];
    if (source.slotType === "multi") {
      list(source.secondarySkillIds).filter(Boolean).forEach((skillId, index) => slots.push(skillSlot({
        id: `${moduleId}:secondary:${index + 1}`,
        name: `次要插槽 ${index + 1}`,
        skillId: `user:${String(skillId).replace(/^user:/, "")}`,
        capabilities: list(source.capabilities),
        workspaceModes: list(source.workspaceModes),
        sourceLegacySlotId: String(source.id),
        official: false,
      })));
    }
    const module = capabilityModule({
      id: moduleId,
      name: cleanText(source.name || "迁移模块", 100),
      description: cleanText(source.description || "由旧版自定义插槽无损迁移。", 500),
      triggerRules: [...list(source.triggerKeywords), ...list(source.triggerConditions)].join("；"),
      relation: source.slotType === "multi" ? "primary-secondary" : "parallel",
      slots,
      official: false,
    });
    bundle.modules.push(module);
    moduleIds.add(moduleId);
    const parent = groupByLegacyId.get(String(source.parentGroupId)) || auxiliary;
    parent.items.push(placement(`${parent.id}:place:${moduleId}`, "module", moduleId));
  }
  return normalizeCapabilityTemplate(bundle);
};

export const validateCapabilityTemplate = (input = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  const errors = [];
  const allIds = new Set();
  const register = (id, label) => {
    if (allIds.has(id)) errors.push(`${label} ID 重复：${id}`);
    allIds.add(id);
  };
  register(bundle.template.id, "面板");
  bundle.groups.forEach((node) => register(node.id, "模组"));
  bundle.modules.forEach((node) => register(node.id, "模块"));
  const slotIds = new Set();
  for (const module of bundle.modules) {
    for (const slot of module.slots) {
      if (slotIds.has(slot.id)) errors.push(`插槽 ID 重复：${slot.id}`);
      slotIds.add(slot.id);
    }
  }
  const groupMap = new Map(bundle.groups.map((group) => [group.id, group]));
  const moduleMap = new Map(bundle.modules.map((module) => [module.id, module]));
  for (const module of bundle.modules) {
    // A user may remove every slot from a configurable module. The module
    // remains an editable container and can receive a new slot from its
    // trailing add action, so an empty module is valid structure.
    if (module.slots.length) {
      errors.push(...validateCapabilityRelationMembers({ relationType: module.relationType, members: module.slots, label: `模块“${module.name}”` }).errors);
    }
  }
  const containerEntries = [[bundle.template.id, bundle.template], ...bundle.groups.map((group) => [group.id, group])];
  for (const [containerId, container] of containerEntries) {
    errors.push(...validateCapabilityRelationMembers({ relationType: container.relationType, members: container.items, label: `${container.nodeType === "template" ? "面板" : "模组"}“${container.name}”` }).errors);
    const placementIds = new Set();
    for (const item of container.items) {
      if (placementIds.has(item.id)) errors.push(`${container.name}中的位置 ID 重复：${item.id}`);
      placementIds.add(item.id);
      const exists = item.targetType === "group" ? groupMap.has(item.targetId) : moduleMap.has(item.targetId);
      if (!exists) errors.push(`${container.name}引用了不存在的${item.targetType === "group" ? "模组" : "模块"}：${item.targetId}`);
    }
  }

  const visitState = new Map();
  for (const startId of groupMap.keys()) {
    if (visitState.get(startId) === 2) continue;
    const stack = [{ id: startId, childIndex: 0 }];
    const stackIndex = new Map([[startId, 0]]);
    visitState.set(startId, 1);
    while (stack.length) {
      const frame = stack.at(-1);
      const children = (groupMap.get(frame.id)?.items ?? []).filter((item) => item.targetType === "group" && groupMap.has(item.targetId));
      if (frame.childIndex >= children.length) {
        visitState.set(frame.id, 2);
        stackIndex.delete(frame.id);
        stack.pop();
        continue;
      }
      const childId = children[frame.childIndex++].targetId;
      if (visitState.get(childId) === 2) continue;
      if (visitState.get(childId) === 1) {
        const cycleStart = stackIndex.get(childId) ?? 0;
        errors.push(`模组嵌套形成循环：${[...stack.slice(cycleStart).map((item) => item.id), childId].join(" -> ")}`);
        continue;
      }
      visitState.set(childId, 1);
      stackIndex.set(childId, stack.length);
      stack.push({ id: childId, childIndex: 0 });
    }
  }
  return { valid: errors.length === 0, errors, bundle };
};

export const capabilityTemplateNode = (bundle, nodeType, id) => {
  if (nodeType === "template") return bundle?.template?.id === id ? bundle.template : null;
  if (nodeType === "group") return list(bundle?.groups).find((node) => node.id === id) || null;
  if (nodeType === "module") return list(bundle?.modules).find((node) => node.id === id) || null;
  return null;
};

export const capabilityTemplateNodeIsVisible = (bundle, nodeType, id, visiting = new Set()) => {
  const node = capabilityTemplateNode(bundle, nodeType, id);
  if (!node) return false;
  if (nodeType === "module" && (node.kernelManaged === true || isKernelManagedCapabilityNode(nodeType, id))) return false;
  if (nodeType !== "group" || !CAPABILITY_KERNEL_WRAPPER_GROUP_IDS.has(id)) return true;
  if (visiting.has(id)) return false;
  const nextVisiting = new Set(visiting);
  nextVisiting.add(id);
  return list(node.items).some((item) => capabilityTemplateNodeIsVisible(bundle, item.targetType, item.targetId, nextVisiting));
};

export const capabilityTemplateVisibleItems = (bundle, container = {}) => list(container.items)
  .filter((item) => capabilityTemplateNodeIsVisible(bundle, item.targetType, item.targetId));

const capabilityTemplateScopeMembers = (bundle, scopeType = "template", scopeId = "") => {
  if (!["template", "group", "module"].includes(scopeType)) throw new Error("面板拖拽范围不存在");
  const effectiveScopeId = scopeType === "template" ? bundle.template.id : String(scopeId || "");
  const scope = capabilityTemplateNode(bundle, scopeType, effectiveScopeId);
  if (!scope) throw new Error("面板拖拽范围不存在");
  if (scope.kernelManaged === true || isKernelManagedCapabilityNode(scopeType, scope.id)) {
    throw new Error("内置运行机制不可调整位置");
  }
  return {
    scope,
    members: scopeType === "module" ? scope.slots : scope.items,
  };
};

const capabilityTemplateMemberIsKernelManaged = (bundle, scopeType, member) => {
  if (!member) return false;
  if (member.kernelManaged === true) return true;
  if (scopeType === "module") return false;
  const target = capabilityTemplateNode(bundle, member.targetType, member.targetId);
  return isKernelManagedCapabilityNode(member.targetType, member.targetId) || target?.kernelManaged === true;
};

const assertCapabilityTemplateMemberMovable = (bundle, scopeType, member) => {
  if (capabilityTemplateMemberIsKernelManaged(bundle, scopeType, member)) {
    throw new Error("内置运行机制不可调整位置");
  }
};

export const reorderCapabilityTemplateMember = (input, {
  scopeType = "template",
  scopeId = "",
  memberId = "",
  targetMemberId = "",
  placement: requestedPlacement = "before",
} = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  const { members } = capabilityTemplateScopeMembers(bundle, scopeType, scopeId);
  const sourceIndex = members.findIndex((member) => member.id === String(memberId || ""));
  const initialTargetIndex = members.findIndex((member) => member.id === String(targetMemberId || ""));
  if (sourceIndex < 0 || initialTargetIndex < 0) throw new Error("找不到要调整的插槽或目标位置");
  if (sourceIndex === initialTargetIndex) return bundle;
  const source = members[sourceIndex];
  const target = members[initialTargetIndex];
  assertCapabilityTemplateMemberMovable(bundle, scopeType, source);
  assertCapabilityTemplateMemberMovable(bundle, scopeType, target);
  const dropPlacement = requestedPlacement === "after" ? "after" : "before";
  members.splice(sourceIndex, 1);
  const targetIndex = members.findIndex((member) => member.id === String(targetMemberId || ""));
  members.splice(targetIndex + (dropPlacement === "after" ? 1 : 0), 0, source);
  const validation = validateCapabilityTemplate(bundle);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  return validation.bundle;
};

export const swapCapabilityTemplateMembers = (input, {
  scopeType = "template",
  scopeId = "",
  memberId = "",
  targetMemberId = "",
} = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  const { members } = capabilityTemplateScopeMembers(bundle, scopeType, scopeId);
  const sourceIndex = members.findIndex((member) => member.id === String(memberId || ""));
  const targetIndex = members.findIndex((member) => member.id === String(targetMemberId || ""));
  if (sourceIndex < 0 || targetIndex < 0) throw new Error("找不到要交换的插槽或目标位置");
  if (sourceIndex === targetIndex) return bundle;
  assertCapabilityTemplateMemberMovable(bundle, scopeType, members[sourceIndex]);
  assertCapabilityTemplateMemberMovable(bundle, scopeType, members[targetIndex]);
  // Swap complete member objects so roles, bindings, policies, and identity
  // remain attached to the same slot or placement while normalization
  // recomputes the role for the new index.
  [members[sourceIndex], members[targetIndex]] = [members[targetIndex], members[sourceIndex]];
  const validation = validateCapabilityTemplate(bundle);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  return validation.bundle;
};

export const addCapabilityTemplateNode = (input, { nodeType = "module", parentType = "template", parentId = "", relation = "parallel" } = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  const id = generatedId(nodeType);
  const node = nodeType === "group"
    ? capabilityGroup({ id, name: "未命名模组", description: "请说明模组作用。", triggerRules: "", relation, items: [], official: false })
    : capabilityModule({ id, name: "未命名模块", description: "请说明模块作用。", triggerRules: "", relation, slots: [], official: false });
  if (nodeType === "group") bundle.groups.push(node);
  else bundle.modules.push(node);
  const parent = parentType === "template" ? bundle.template : bundle.groups.find((group) => group.id === parentId);
  if (!parent) throw new Error("父级面板或模组不存在");
  parent.items.push(placement(generatedId("placement"), nodeType, id));
  return { bundle: normalizeCapabilityTemplate(bundle), nodeId: id };
};

export const removeCapabilityTemplateNode = (input, { nodeType, nodeId } = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  if (!NODE_TYPES.has(nodeType)) throw new Error("只能删除模块或模组");
  if (nodeType === "group") bundle.groups = bundle.groups.filter((node) => node.id !== nodeId);
  else bundle.modules = bundle.modules.filter((node) => node.id !== nodeId);
  bundle.template.items = bundle.template.items.filter((item) => !(item.targetType === nodeType && item.targetId === nodeId));
  for (const group of bundle.groups) group.items = group.items.filter((item) => !(item.targetType === nodeType && item.targetId === nodeId));
  const validation = validateCapabilityTemplate(bundle);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  return validation.bundle;
};

// Empty capability slots are not durable structure. They may exist briefly
// while the picker is open, but an explicit removal must delete the slot so
// the next render and save cannot recreate a fixed placeholder.
export const removeCapabilityTemplateSlot = (input, { moduleId = "", slotId = "" } = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  const module = bundle.modules.find((candidate) => candidate.id === String(moduleId || ""));
  if (!module) throw new Error("模块不存在");
  if (module.kernelManaged === true || isKernelManagedCapabilityNode("module", module.id)) {
    throw new Error("内置运行机制的 Skill 不可拔出");
  }
  const before = module.slots.length;
  module.slots = module.slots.filter((slot) => slot.id !== String(slotId || ""));
  if (module.slots.length === before) return bundle;
  const validation = validateCapabilityTemplate(bundle);
  if (!validation.valid) throw new Error(validation.errors.join("；"));
  return validation.bundle;
};

export const pruneCapabilityTemplateEmptySlots = (input = {}) => {
  const bundle = normalizeCapabilityTemplate(input);
  for (const module of bundle.modules) {
    if (module.kernelManaged === true || isKernelManagedCapabilityNode("module", module.id)) continue;
    module.slots = module.slots.filter((slot) => Boolean(slot.skillId));
  }
  return normalizeCapabilityTemplate(bundle);
};

const normalizedLookupText = (value) => String(value || "").toLocaleLowerCase("zh-CN").replace(/\s+/g, "");
const explicitlyNames = (text, names = []) => {
  const source = normalizedLookupText(text);
  return unique(names).some((name) => {
    const token = normalizedLookupText(name);
    return token.length >= 2 && source.includes(token);
  });
};

const metadataMatchesTask = (metadata = {}, task = {}, { requireTrigger = false } = {}) => {
  const workspaceModes = list(metadata.workspaceModes);
  if (workspaceModes.length && !workspaceModes.includes("general") && !workspaceModes.includes(task.workspaceMode)) return false;
  const contextDomains = list(metadata.contextDomains);
  const deliverableTypes = list(metadata.deliverableTypes);
  if (deliverableTypes.length) {
    if (!task.deliverableType || !deliverableTypes.includes(task.deliverableType)) return false;
  }
  if (contextDomains.length && !contextDomains.includes("general") && task.contextDomain && !contextDomains.includes(task.contextDomain)) return false;
  const conditions = task.semanticCapabilitiesAuthoritative === true ? [] : unique(metadata.triggerConditions);
  const keywords = task.semanticCapabilitiesAuthoritative === true ? [] : unique(metadata.triggerKeywords);
  const keywordMatch = keywords.some((keyword) => normalizedLookupText(task.text).includes(normalizedLookupText(keyword)));
  const conditionMatch = conditions.length
    ? matchSkillTrigger({ triggerKeywords: [], triggerConditions: conditions }, task).matched
    : false;
  // A slot may declare a document scope and/or semantic trigger. They are
  // alternative entry points: a matching target document or a matching user
  // phrase is sufficient. This also lets an explicitly named Skill run when
  // the current task has no target document ID yet.
  if (conditions.length && keywords.length && !conditionMatch && !keywordMatch) return false;
  if (conditions.length && !keywords.length && !conditionMatch) return false;
  if (requireTrigger) return keywords.length || conditions.length ? keywordMatch || conditionMatch : false;
  return true;
};

const taskScopedSkillMetadataForSlot = (slot, maps, task) => {
  const configured = skillMetadataForSlot(slot, maps);
  if (!configured.ready || metadataMatchesTask(configured, task)) return configured;
  const fixed = maps.fixedSlotMap.get(slot.fixedSlotId);
  const canUseOfficialFallback = slot.allowOfficialFallback === true
    && Boolean(slot.fixedSlotId)
    && fixed?.developerDefault !== false
    && configured.skillId !== slot.fixedSlotId;
  if (!canUseOfficialFallback) return configured;
  const official = skillMetadataForSlot({
    ...slot,
    skillId: slot.fixedSlotId,
    legacyBindingAllowed: false,
    allowOfficialFallback: false,
  }, { ...maps, legacyBindings: new Map() });
  if (!official.ready || !metadataMatchesTask(official, task)) return configured;
  return {
    ...official,
    configuredSkillId: configured.configuredSkillId || configured.skillId,
    implementationState: "scope_mismatch",
    fallbackReady: true,
    fallbackReason: `插槽绑定的 Skill“${configured.name || configured.skillId}”与当前任务范围不匹配，按插槽策略回退官方实现`,
  };
};

const metadataTriggerMatch = (metadata = {}, task = {}) => {
  const keywords = unique(metadata.triggerKeywords);
  const conditions = unique(metadata.triggerConditions);
  if (!keywords.length && !conditions.length) return { matched: false, score: 0, reasons: [] };
  return matchSkillTrigger({ triggerKeywords: keywords, triggerConditions: conditions }, task);
};

const nodePolicyMatchesTask = (node = {}, task = {}) => metadataMatchesTask(node, task);

const selectedSkillForTemplateSlot = (slot, legacyBindings = new Map()) => {
  const legacy = slot.fixedSlotId ? legacyBindings.get(slot.fixedSlotId) : null;
  if (slot.legacyBindingAllowed !== false && legacy?.skillId && String(legacy.skillId).startsWith("user:")) return legacy.skillId;
  return slot.skillId;
};

const skillMetadataForSlot = (slot, { fixedSlotMap, userSkillMap, legacyBindings }) => {
  const skillId = selectedSkillForTemplateSlot(slot, legacyBindings);
  const fixed = fixedSlotMap.get(slot.fixedSlotId || skillId);
  const user = userSkillMap.get(String(skillId).replace(/^user:/, "")) || userSkillMap.get(skillId);
  const builtin = String(skillId).startsWith("builtin:");
  const official = String(skillId).startsWith("official:");
  const implementationState = !skillId ? "unbound"
    : builtin || official ? fixed && fixed.developerDefault !== false ? "ready" : "invalid"
      : user?.testStatus === "passed" ? "ready" : "invalid";
  const fallbackReady = implementationState === "invalid"
    && slot.allowOfficialFallback === true
    && Boolean(slot.fixedSlotId)
    && Boolean(fixedSlotMap.get(slot.fixedSlotId)?.developerDefault !== false);
  const effectiveFixed = fallbackReady ? fixedSlotMap.get(slot.fixedSlotId) : fixed;
  const effectiveSkillId = fallbackReady ? slot.fixedSlotId : skillId;
  const userDeliverableTypes = unique(user?.artifactTypes).filter((type) => type !== "text");
  return {
    skillId: effectiveSkillId,
    configuredSkillId: skillId,
    name: fallbackReady ? effectiveFixed?.name || slot.name : user?.name || effectiveFixed?.name || slot.name,
    capabilities: slot.capabilities.length ? slot.capabilities : user?.capabilities || effectiveFixed?.replacementCapabilities || [],
    workspaceModes: slot.workspaceModes.length ? slot.workspaceModes : user?.workspaceModes || effectiveFixed?.workspaceModes || [],
    contextDomains: slot.contextDomains.length ? slot.contextDomains : effectiveFixed?.contextDomains || [],
    deliverableTypes: slot.deliverableTypes.length ? slot.deliverableTypes : userDeliverableTypes.length ? userDeliverableTypes : effectiveFixed?.deliverableTypes || [],
    artifactTypes: slot.artifactTypes.length ? slot.artifactTypes : user?.artifactTypes || effectiveFixed?.deliverableTypes || [],
    phases: slot.phases.length ? slot.phases : [],
    stages: slot.stages.length ? slot.stages : user?.stages || [],
    triggerKeywords: slot.triggerKeywords.length ? slot.triggerKeywords : user?.triggerKeywords || effectiveFixed?.triggerKeywords || [],
    triggerConditions: slot.triggerConditions.length ? slot.triggerConditions : user?.triggerConditions || [],
    ready: implementationState === "ready" || fallbackReady,
    implementationState,
    fallbackReady,
    fallbackReason: fallbackReady ? `插槽绑定的 Skill“${user?.name || skillId}”不可用，按插槽策略回退官方实现` : "",
    fixed: effectiveFixed,
    user,
  };
};

const boundedMessages = (...groups) => unique(groups.flat()).slice(0, 100);

const intersectPolicyConstraint = (layers, key, wildcard = "") => {
  const constraints = layers
    .map((layer) => unique(layer?.[key]).filter((value) => value !== wildcard))
    .filter((values) => values.length);
  if (!constraints.length) return { values: [], impossible: false };
  const values = constraints.slice(1).reduce(
    (current, next) => current.filter((value) => next.includes(value)),
    constraints[0],
  );
  return { values, impossible: values.length === 0 };
};

const compileActivationPolicy = ({ layers = [], metadata = {}, capabilities = [] } = {}) => {
  const combinedLayers = [...layers, metadata];
  const workspaces = intersectPolicyConstraint(combinedLayers, "workspaceModes", "general");
  const domains = intersectPolicyConstraint(combinedLayers, "contextDomains", "general");
  const deliverables = intersectPolicyConstraint(combinedLayers, "deliverableTypes");
  const descriptorPhases = unique(capabilities.flatMap((capability) => capabilityDescriptor(capability).phases));
  const phases = intersectPolicyConstraint([...combinedLayers, { phases: descriptorPhases }], "phases");
  const declaredStages = intersectPolicyConstraint(combinedLayers, "stages");
  const descriptorStages = unique(capabilities.flatMap((capability) => capabilityDescriptor(capability).stages));
  const stages = declaredStages.values.length
    ? declaredStages.values.filter((stage) => descriptorStages.includes("*") || descriptorStages.includes(stage))
    : descriptorStages;
  const triggerKeywordGroups = combinedLayers
    .map((layer) => unique(layer?.triggerKeywords))
    .filter((group) => group.length);
  return deepFreezeCapabilityValue({
    workspaceModes: workspaces.values,
    contextDomains: domains.values,
    deliverableTypes: deliverables.values,
    artifactTypes: deliverables.values,
    phases: phases.values,
    stages,
    triggerConditions: unique(combinedLayers.flatMap((layer) => layer?.triggerConditions ?? [])),
    triggerKeywordGroups,
    impossible: workspaces.impossible || domains.impossible || deliverables.impossible || phases.impossible || (declaredStages.values.length > 0 && stages.length === 0),
    inheritedFrom: layers.map((layer) => layer?.id).filter(Boolean),
  });
};

const relationMetadata = ({ relationScopes = [], capabilities = [], task = {} } = {}) => {
  const organization = [...relationScopes].reverse().find((scope) => scope.relationType === "organization");
  const rootOrganization = relationScopes.find((scope) => scope.relationType === "organization");
  const secondary = [...relationScopes].reverse().find((scope) => scope.relationType === "primary-secondary" && scope.relationRole === "secondary");
  const nonParallel = organization || secondary || [...relationScopes].reverse().find((scope) => scope.relationType !== "parallel");
  const governing = nonParallel || relationScopes.at(-1) || { relationScopeId: "", relationType: "parallel", relationRole: "peer" };
  const descriptors = capabilities.map(capabilityDescriptor);
  const descriptorExclusiveKey = descriptors.map((item) => item.exclusiveKey).find(Boolean) || "";
  const descriptorStackKey = descriptors.map((item) => item.stackKey).find(Boolean) || "";
  const taskSuffix = task.deliverableType || task.activeModule || "general";
  return {
    relationScopeId: governing.relationScopeId,
    relationType: governing.relationType,
    relationRole: governing.relationRole,
    relationScopes,
    // An organization is an intentional upper/lower composition. Its members
    // must survive the writer exclusivity pass so extraction can feed the
    // specialized lower writer in the same compiled plan.
    exclusiveKey: !organization && descriptorExclusiveKey ? `${descriptorExclusiveKey}:${taskSuffix}`
      : governing.relationType === "primary-secondary" ? `relation:${governing.relationScopeId}` : "",
    stackKey: descriptorStackKey || (governing.relationType === "parallel" || governing.relationType === "organization"
      ? `relation:${governing.relationScopeId}` : ""),
    // Nested organizations share the outermost organization's budget and
    // execution order. Inner upper/lower roles remain available in
    // relationScopes for topology inspection and local module composition.
    organizationGroupId: rootOrganization?.relationScopeId || "",
    organizationRole: rootOrganization ? rootOrganization.relationRole === "upper" ? "leader" : "member" : "",
  };
};

const routeSelectionPriority = (selection = {}) => {
  const explicit = selection.explicitlyActivated ? 100_000 : 0;
  const primary = selection.relationRole === "primary" || selection.relationRole === "upper" ? 10_000 : 0;
  const triggerSpecificity = Math.max(0, Number(selection.triggerMatch?.score) || 0) * 1_000;
  const fallbackPenalty = selection.implementationStatus === "official_fallback" ? -1_000 : 0;
  return explicit + primary + triggerSpecificity + fallbackPenalty + (Number(selection.routePriority) || 0);
};

const applyCapabilityBudgets = (selections = []) => {
  const selected = [];
  const dropped = [];
  const counts = new Map();
  const countedOrganizationBudgets = new Set();
  const ordered = [...selections].sort((left, right) => routeSelectionPriority(right) - routeSelectionPriority(left));
  const exclusive = new Set();
  for (const selection of ordered) {
    if (selection.exclusiveKey && exclusive.has(selection.exclusiveKey)) {
      dropped.push({ selection, reason: `独占能力 ${selection.exclusiveKey} 已由更高优先级实现占用` });
      continue;
    }
    const budgetClasses = unique(selection.authorizedCapabilities.map(capabilityBudgetClass));
    const consumesBudget = (budgetClass) => !selection.organizationGroupId
      || !countedOrganizationBudgets.has(`${selection.organizationGroupId}:${budgetClass}`);
    const blockedClass = budgetClasses.find((budgetClass) => consumesBudget(budgetClass)
      && (counts.get(budgetClass) || 0) >= (CAPABILITY_EXECUTION_BUDGET[budgetClass] ?? CAPABILITY_EXECUTION_BUDGET.advisor));
    if (blockedClass) {
      dropped.push({ selection, reason: `${blockedClass} 分类预算已用尽` });
      continue;
    }
    if (selected.length >= CAPABILITY_EXECUTION_BUDGET.total) {
      dropped.push({ selection, reason: `单轮能力总预算 ${CAPABILITY_EXECUTION_BUDGET.total} 已用尽` });
      continue;
    }
    selected.push(selection);
    if (selection.exclusiveKey) exclusive.add(selection.exclusiveKey);
    for (const budgetClass of budgetClasses) {
      if (!consumesBudget(budgetClass)) continue;
      counts.set(budgetClass, (counts.get(budgetClass) || 0) + 1);
      if (selection.organizationGroupId) countedOrganizationBudgets.add(`${selection.organizationGroupId}:${budgetClass}`);
    }
  }
  const priorityOrder = new Map(ordered.map((selection, index) => [selection, index]));
  const hierarchyOrder = (left, right) => {
    for (const leftScope of left.relationScopes || []) {
      if (leftScope.relationType !== "organization") continue;
      const rightScope = (right.relationScopes || []).find((scope) => scope.relationScopeId === leftScope.relationScopeId);
      if (!rightScope || rightScope.relationRole === leftScope.relationRole) continue;
      if (leftScope.relationRole === "upper") return -1;
      if (rightScope.relationRole === "upper") return 1;
    }
    return (priorityOrder.get(left) ?? 0) - (priorityOrder.get(right) ?? 0);
  };
  const prioritySelected = [...selected].sort((left, right) => (priorityOrder.get(left) ?? 0) - (priorityOrder.get(right) ?? 0));
  const orderedSelected = [];
  const emittedOrganizations = new Set();
  for (const selection of prioritySelected) {
    if (!selection.organizationGroupId) {
      orderedSelected.push(selection);
      continue;
    }
    if (emittedOrganizations.has(selection.organizationGroupId)) continue;
    emittedOrganizations.add(selection.organizationGroupId);
    const organizationSelections = prioritySelected
      .filter((candidate) => candidate.organizationGroupId === selection.organizationGroupId)
      .sort(hierarchyOrder);
    orderedSelected.push(...organizationSelections);
  }
  selected.splice(0, selected.length, ...orderedSelected);
  return { selected, dropped, counts: Object.fromEntries(counts) };
};

const reachableTemplateDeclarations = (bundle, task, maps) => {
  const declarations = [];
  const stack = [{ nodeType: "template", node: bundle.template, layers: [] }];
  let expanded = 0;
  while (stack.length && expanded < 100_000) {
    const current = stack.pop();
    expanded += 1;
    if (!nodePolicyMatchesTask(current.node, task)) continue;
    const nextLayers = [...current.layers, current.node];
    if (current.nodeType === "module") {
      for (const slot of current.node.slots) {
        const metadata = taskScopedSkillMetadataForSlot(slot, maps, task);
        const policy = compileActivationPolicy({ layers: [...nextLayers, slot], metadata, capabilities: metadata.capabilities });
        if (policy.impossible) continue;
        declarations.push({ module: current.node, slot, metadata, activationPolicy: policy });
      }
      continue;
    }
    for (const item of [...current.node.items].reverse()) {
      const node = item.targetType === "group" ? maps.groupMap.get(item.targetId) : maps.moduleMap.get(item.targetId);
      if (node) stack.push({ nodeType: item.targetType, node, layers: nextLayers });
    }
  }
  return declarations;
};

const groupEvaluationOrder = (groups = []) => {
  const groupIds = new Set(groups.map((group) => group.id));
  const dependencyCount = new Map();
  const parentsByChild = new Map();
  for (const group of groups) {
    const dependencies = new Set(group.items.filter((item) => item.targetType === "group" && groupIds.has(item.targetId)).map((item) => item.targetId));
    dependencyCount.set(group.id, dependencies.size);
    for (const childId of dependencies) {
      const parents = parentsByChild.get(childId) ?? [];
      parents.push(group.id);
      parentsByChild.set(childId, parents);
    }
  }
  const queue = groups.filter((group) => dependencyCount.get(group.id) === 0).map((group) => group.id);
  const order = [];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const groupId = queue[cursor];
    order.push(groupId);
    for (const parentId of parentsByChild.get(groupId) ?? []) {
      const remaining = (dependencyCount.get(parentId) ?? 0) - 1;
      dependencyCount.set(parentId, remaining);
      if (remaining === 0) queue.push(parentId);
    }
  }
  return order;
};

export const resolveCapabilityTemplateRouting = (inputBundle, {
  text = "",
  workspaceMode = "project",
  activeModule = "manuscript",
  contextDomain = "novel",
  deliverableType = "",
  targetDocumentId = "",
  sourceMode = "",
  requestMode = "creative",
  requiredCapabilities = [],
  semanticCapabilities = [],
  semanticCapabilitiesAuthoritative = false,
  fixedSlots = [],
  userSkills = [],
  legacyConfiguredSelections = [],
  templateRevision = 0,
  templateHash = "",
} = {}) => {
  const validation = validateCapabilityTemplate(inputBundle);
  if (!validation.valid) return { selections: [], diagnostics: { valid: false, errors: validation.errors, visited: [] } };
  const bundle = validation.bundle;
  const fixedSlotMap = new Map(list(fixedSlots).map((slot) => [slot.id, slot]));
  const userSkillMap = new Map(list(userSkills).flatMap((skill) => [[skill.id, skill], [String(skill.id).replace(/^user:/, ""), skill]]));
  const legacyBindings = new Map(list(legacyConfiguredSelections).map((selection) => [selection.slotId, { skillId: selection.id }]));
  const task = normalizeCapabilityTask({
    text,
    workspaceMode,
    activeModule,
    contextDomain,
    deliverableType,
    targetDocumentId,
    sourceMode,
    requestMode,
    requiredCapabilities,
    semanticCapabilities,
    semanticCapabilitiesAuthoritative,
  });
  const requiredCapabilitySet = new Set(task.requiredCapabilities);
  const semanticAuthority = task.semanticCapabilitiesAuthoritative === true;
  // When semantic routing is authoritative, requiredCapabilities has already
  // been compiled from the Agent's structured decision (mode, deliverable and
  // explicit capability IDs). Use that compiled set for activation as well;
  // otherwise a natural-language-only `skillQueries` result can produce a
  // correct requirement list but still activate zero template slots.
  const semanticCapabilitySet = new Set([
    ...task.semanticCapabilities,
    ...(semanticAuthority ? task.requiredCapabilities : []),
  ]);
  const groupMap = new Map(bundle.groups.map((group) => [group.id, group]));
  const moduleMap = new Map(bundle.modules.map((module) => [module.id, module]));
  const moduleEvaluations = new Map();
  const groupEvaluations = new Map();
  const explicitNameMatch = (value, names) => semanticAuthority ? false : explicitlyNames(value, names);

  const evaluateModule = (module, forced = false) => {
    if (module.disabled === true) return {
      active: false,
      explicitRequested: explicitNameMatch(text, [module.name]),
      specific: false,
      disabled: true,
      blocked: [`模块“${module.name}”已禁用；本轮使用模型基础能力回退`],
      chosen: [],
    };
    if (module.id === "module:video-prompt-writer" && isImageAssetSourceExtractionRequest(task.text)) {
      return {
        active: false,
        explicitRequested: false,
        specific: false,
        blocked: [],
        chosen: [],
      };
    }
    const candidates = module.slots.map((slot, index) => {
      const metadata = taskScopedSkillMetadataForSlot(slot, { fixedSlotMap, userSkillMap, legacyBindings }, task);
      const compatibilityNames = metadata.skillId === "builtin:video-prompt-writer"
        ? metadata.triggerKeywords.filter((keyword) => /导演|Seedance/iu.test(keyword))
        : [];
      const names = [slot.name, metadata.name, ...compatibilityNames, `次要插槽${index}`, `副插槽${index}`, `备用插槽${index}`];
      const explicit = !semanticAuthority && explicitlyNames(text, names);
      const disabled = slot.disabled === true;
      const requiredMatch = metadata.capabilities.some((capability) => requiredCapabilitySet.has(capability)
        || (capability === "memory_advisor" && requiredCapabilitySet.has("memory_update")));
      const autoEligible = metadata.capabilities.some((capability) => capabilityDescriptor(capability).autoEligible);
      const triggerMatch = semanticAuthority
        ? { matched: false, score: 0, reasons: [] }
        : metadataTriggerMatch(metadata, task);
      const requiresKeyword = !semanticAuthority && (requiredCapabilitySet.size === 0
        || (metadata.triggerKeywords.length > 0 && metadata.capabilities.some((capability) => ["theory_advisor", "visual_prompt_writer", "prompt_writer"].includes(capability))));
      const semanticMatch = semanticAuthority && metadata.capabilities.some((capability) => semanticCapabilitySet.has(capability));
      const scopeCompatible = metadataMatchesTask(metadata, task);
      // 禁用只阻止自动路由；用户明确点名时允许临时调用该主笔。
      const compatible = Boolean(metadata.skillId && metadata.ready && scopeCompatible && (!disabled || explicit));
      const keywordMatched = compatible && triggerMatch.matched;
      const matched = compatible && (semanticAuthority
        ? semanticMatch
        : requiredMatch
          ? metadataMatchesTask(metadata, task, { requireTrigger: requiresKeyword })
          : autoEligible && triggerMatch.matched
      );
      return {
        slot,
        metadata,
        disabled,
        compatible,
        scopeCompatible,
        requiredMatch,
        autoEligible,
        triggerMatch,
        keywordMatched,
        matched,
        specificMatched: compatible && (semanticAuthority ? semanticMatch : (keywordMatched || (matched && (metadata.contextDomains.length > 0 || metadata.deliverableTypes.length > 0 || metadata.triggerConditions.length > 0)))),
        explicit,
        names,
        index,
      };
    });
    if (!nodePolicyMatchesTask(module, task)) {
      const explicitCandidates = candidates.filter((candidate) => candidate.explicit);
      return {
        active: false,
        explicitRequested: explicitNameMatch(text, [module.name]) || explicitCandidates.length > 0,
        specific: false,
        blocked: [
          `模块“${module.name}”被结构化激活策略阻止`,
          ...explicitCandidates.map((candidate) => `明确点名的 Skill 不可用于当前任务：${candidate.metadata.name || candidate.slot.name}`),
        ],
        chosen: [],
      };
    }
    let chosen = [];
    let blocked = [];
    if (module.relationType === "primary-secondary") {
      const explicitSecondary = candidates.slice(1).find((candidate) => candidate.explicit);
      if (explicitSecondary) {
        if (explicitSecondary.compatible) chosen = [explicitSecondary];
        else blocked = [`明确点名的次要 Skill 不可用于当前任务：${explicitSecondary.metadata.name || explicitSecondary.slot.name}`];
      } else {
        const primary = candidates[0];
        if (primary?.compatible && (forced || primary.matched || primary.explicit)) chosen = [primary];
      }
    } else if (module.relationType === "organization") {
      const upper = candidates[0];
      const explicitLowers = candidates.slice(1).filter((candidate) => candidate.explicit);
      const unavailableExplicit = explicitLowers.filter((candidate) => !candidate.compatible);
      if (unavailableExplicit.length) {
        blocked = unavailableExplicit.map((candidate) => `明确点名的下位 Skill 不可用于当前任务：${candidate.metadata.name || candidate.slot.name}`);
      } else {
        const sourceExtraction = !semanticAuthority && module.id === "module:prompt-writer" && IMAGE_ASSET_SOURCE_EXTRACTION_PATTERN.test(task.text);
        const requestedLowerIds = new Set();
        if (!semanticAuthority && module.id === "module:prompt-writer") {
          if (IMAGE_ASSET_CHARACTER_TASK_PATTERN.test(task.text)) requestedLowerIds.add("builtin:industrial-character-prompt-writer");
          if (IMAGE_ASSET_SCENE_TASK_PATTERN.test(task.text)) requestedLowerIds.add("builtin:guoman-scene-prompt-writer");
          if (sourceExtraction && IMAGE_ASSET_GENERAL_TASK_PATTERN.test(task.text) && !requestedLowerIds.size) {
            IMAGE_ASSET_LOWER_SKILL_IDS.forEach((id) => requestedLowerIds.add(id));
          }
        }
        const lowers = candidates.slice(1).filter((candidate) => candidate.compatible && (
          candidate.explicit
          || candidate.specificMatched
          || requestedLowerIds.has(candidate.slot.fixedSlotId || candidate.metadata.skillId)
        ));
        if (lowers.length) {
          if (module.id === "module:prompt-writer" && !sourceExtraction) chosen = lowers;
          else if (upper?.compatible) chosen = [upper, ...lowers];
          else blocked = [`下位 Skill 已命中，但上位 Skill 不可用：${upper?.metadata.name || upper?.slot.name || module.name}`];
        } else if (upper?.compatible && (forced || upper.matched || upper.explicit)) chosen = [upper];
      }
    } else {
      chosen = candidates.filter((candidate) => candidate.compatible && (forced || candidate.matched || candidate.explicit));
    }
    return {
      active: chosen.length > 0,
      explicitRequested: candidates.some((candidate) => candidate.explicit),
      specific: chosen.some((candidate) => candidate.specificMatched),
      blocked,
      chosen,
    };
  };

  for (const module of bundle.modules) moduleEvaluations.set(module.id, {
    normal: evaluateModule(module, false),
    forced: evaluateModule(module, true),
  });

  const childEvaluation = (item, forced = false) => {
    const evaluations = item.targetType === "group" ? groupEvaluations.get(item.targetId) : moduleEvaluations.get(item.targetId);
    return forced ? evaluations?.forced : evaluations?.normal;
  };

  const evaluateContainer = (container, forced = false) => {
    const explicitDescendants = container.items.flatMap((item) => {
      const node = item.targetType === "group" ? groupMap.get(item.targetId) : moduleMap.get(item.targetId);
      const evaluation = childEvaluation(item, false);
      return evaluation?.explicitRequested || (node && explicitNameMatch(text, [node.name]))
        ? [node?.name || item.targetId]
        : [];
    });
    if (container.disabled === true) return {
      active: false,
      explicitRequested: explicitNameMatch(text, [container.name]) || explicitDescendants.length > 0,
      specific: false,
      disabled: true,
      blocked: [`${container.nodeType === "template" ? "面板" : "模组"}“${container.name}”已禁用；本轮使用模型基础能力回退`],
      choices: [],
    };
    if (!nodePolicyMatchesTask(container, task)) return {
      active: false,
      explicitRequested: explicitNameMatch(text, [container.name]) || explicitDescendants.length > 0,
      specific: false,
      blocked: [
        `${container.nodeType === "template" ? "面板" : "模组"}“${container.name}”被结构化激活策略阻止`,
        ...explicitDescendants.map((name) => `明确点名的后代节点不可用于当前任务：${name}`),
      ],
      choices: [],
    };
    const candidates = container.items.map((item) => {
      const node = item.targetType === "group" ? groupMap.get(item.targetId) : moduleMap.get(item.targetId);
      const normal = childEvaluation(item, false) ?? { active: false, explicitRequested: false, specific: false, blocked: [] };
      const forcedResult = childEvaluation(item, true) ?? normal;
      const nodeExplicit = Boolean(node && explicitNameMatch(text, [node.name]));
      return {
        item,
        node,
        normal,
        forced: forcedResult,
        nodeExplicit,
        explicitRequested: nodeExplicit || normal.explicitRequested,
      };
    });
    const choices = [];
    let blocked = [];
    const choose = (candidate, useForced = false) => {
      if (!candidate?.node) return null;
      const forcedChoice = useForced || candidate.nodeExplicit;
      const result = forcedChoice ? candidate.forced : candidate.normal;
      return { candidate, result, forced: forcedChoice };
    };
    if (container.relationType === "primary-secondary") {
      const explicitSecondary = candidates.slice(1).find((candidate) => candidate.explicitRequested);
      const selected = explicitSecondary ? choose(explicitSecondary) : choose(candidates[0], forced);
      if (selected?.result.active) choices.push(selected);
      else if (explicitSecondary) blocked.push(`明确点名的次要节点不可用于当前任务：${explicitSecondary.node?.name || explicitSecondary.item.targetId}`);
      if (selected) blocked.push(...selected.result.blocked);
    } else if (container.relationType === "organization") {
      const explicitLowers = candidates.slice(1).filter((candidate) => candidate.explicitRequested);
        const lowerCandidates = semanticAuthority
        ? candidates.slice(1).filter((candidate) => candidate.normal.active && candidate.normal.specific)
        : explicitLowers.length
        ? explicitLowers
        : candidates.slice(1).filter((candidate) => candidate.normal.active && candidate.normal.specific);
      const lowerChoices = lowerCandidates.map((candidate) => choose(candidate)).filter(Boolean);
      const unavailableExplicit = explicitLowers.length && lowerChoices.some((choice) => !choice.result.active);
      if (unavailableExplicit) {
        blocked.push(...lowerChoices.filter((choice) => !choice.result.active).map((choice) => `明确点名的下位节点不可用于当前任务：${choice.candidate.node?.name || choice.candidate.item.targetId}`));
      } else if (lowerChoices.some((choice) => choice.result.active)) {
        const upper = choose(candidates[0], true);
        if (upper?.result.active) {
          choices.push(upper, ...lowerChoices.filter((choice) => choice.result.active));
        } else {
          blocked.push(`下位节点已命中，但上位节点不可用：${candidates[0]?.node?.name || container.name}`);
        }
        if (upper) blocked.push(...upper.result.blocked);
      } else {
        const upper = choose(candidates[0], forced);
        if (upper?.result.active) choices.push(upper);
        if (upper) blocked.push(...upper.result.blocked);
      }
    } else {
      for (const candidate of candidates) {
        const selected = choose(candidate, forced);
        if (selected?.result.active) choices.push(selected);
        if (candidate.explicitRequested && selected) blocked.push(...selected.result.blocked);
      }
    }
    return {
      active: choices.length > 0,
      explicitRequested: candidates.some((candidate) => candidate.explicitRequested),
      specific: choices.some((choice) => choice.result.specific),
      blocked: boundedMessages(blocked, ...choices.map((choice) => choice.result.blocked)),
      choices: choices.map((choice) => ({ item: choice.candidate.item, forced: choice.forced })),
    };
  };

  const evaluationOrder = groupEvaluationOrder(bundle.groups);
  for (const groupId of evaluationOrder) {
    const group = groupMap.get(groupId);
    groupEvaluations.set(groupId, {
      normal: evaluateContainer(group, false),
      forced: evaluateContainer(group, true),
    });
  }
  const templateEvaluation = evaluateContainer(bundle.template, false);
  const activated = [];
  const visited = [];
  const materializePath = (link, leafId) => {
    const path = [leafId];
    for (let current = link; current; current = current.parent) path.push(current.id);
    return path.reverse();
  };
  const materializeLayers = (link, leaf) => {
    const layers = [leaf];
    for (let current = link; current; current = current.parent) layers.push(current.node);
    return layers.reverse();
  };
  const materializeRelations = (link, leaf = null) => {
    const relations = leaf ? [leaf] : [];
    for (let current = link; current; current = current.parent) relations.push(current.scope);
    return relations.reverse();
  };
  const stack = [{ nodeType: "template", node: bundle.template, evaluation: templateEvaluation, path: null, policyPath: null, relationPath: null }];
  while (stack.length) {
    const current = stack.pop();
    visited.push(current.node.id);
    if (current.nodeType === "module") {
      const layers = materializeLayers(current.policyPath, current.node);
      for (const candidate of current.evaluation.chosen) {
        const relationScopes = materializeRelations(current.relationPath, {
          relationScopeId: current.node.id,
          relationType: current.node.relationType,
          relationRole: candidate.slot.role,
        });
        const capabilities = candidate.metadata.capabilities;
        const relation = relationMetadata({ relationScopes, capabilities, task });
        const activationPolicy = compileActivationPolicy({ layers: [...layers, candidate.slot], metadata: candidate.metadata, capabilities });
        activated.push({
          id: candidate.metadata.skillId,
          name: candidate.metadata.name,
          requestedRole: "auto",
          source: "capability_template",
          slotId: candidate.slot.id,
          slotName: candidate.slot.name,
          templateModuleId: current.node.id,
          templatePath: materializePath(current.path, current.node.id),
          bindingRole: candidate.slot.role,
          explicitlyActivated: candidate.explicit,
          authorizedCapabilities: capabilities,
          capabilityBoundary: candidate.slot.description || current.node.description,
          activationPolicy,
          implementationStatus: candidate.metadata.fallbackReady ? "official_fallback" : "template_implementation",
          configuredSkillId: candidate.metadata.configuredSkillId,
          fallbackReason: candidate.metadata.fallbackReason,
          triggerMatch: candidate.triggerMatch,
          capabilityDescriptors: capabilities.map((capability) => capabilityDescriptor(capability)),
          ...relation,
        });
      }
      continue;
    }
    const nextPath = { id: current.node.id, parent: current.path };
    const nextPolicyPath = { node: current.node, parent: current.policyPath };
    for (const choice of [...current.evaluation.choices].reverse()) {
      const node = choice.item.targetType === "group" ? groupMap.get(choice.item.targetId) : moduleMap.get(choice.item.targetId);
      const evaluations = choice.item.targetType === "group" ? groupEvaluations.get(choice.item.targetId) : moduleEvaluations.get(choice.item.targetId);
      const evaluation = choice.forced ? evaluations?.forced : evaluations?.normal;
      const nextRelationPath = {
        scope: {
          relationScopeId: current.node.id,
          relationType: current.node.relationType,
          relationRole: choice.item.role,
        },
        parent: current.relationPath,
      };
      if (node && evaluation?.active) stack.push({
        nodeType: choice.item.targetType,
        node,
        evaluation,
        path: nextPath,
        policyPath: nextPolicyPath,
        relationPath: nextRelationPath,
      });
    }
  }
  const dedupedActivated = activated.filter((selection, index, values) => values.findIndex((item) => `${item.slotId}:${item.id}` === `${selection.slotId}:${selection.id}`) === index);
  const budgeted = applyCapabilityBudgets(dedupedActivated);
  const budgetedActivated = budgeted.selected;
  const routedUserSelections = budgetedActivated.filter((selection) => String(selection.id).startsWith("user:"));
  const deduped = routedUserSelections;
  const truncatedSelectionCount = budgeted.dropped.filter(({ selection }) => String(selection.id).startsWith("user:")).length;
  const declarationMaps = { fixedSlotMap, userSkillMap, legacyBindings, groupMap, moduleMap };
  const declarations = reachableTemplateDeclarations(bundle, task, declarationMaps);
  const trustedCoreCapabilities = task.requiredCapabilities
    .filter((capability) => TRUSTED_CORE_CAPABILITY_IDS.includes(capability))
    .map((capabilityId) => ({ capabilityId, status: "trusted_core_required", descriptor: capabilityDescriptor(capabilityId) }));
  const replaceableRequired = task.requiredCapabilities.filter((capability) => !TRUSTED_CORE_CAPABILITY_IDS.includes(capability));
  const capabilityStatus = replaceableRequired.map((capabilityId) => {
    const matchingDeclarations = declarations.filter(({ metadata }) => metadata.capabilities.includes(capabilityId));
    const active = budgetedActivated.find((selection) => selection.authorizedCapabilities.includes(capabilityId));
    const invalid = matchingDeclarations.find(({ metadata }) => metadata.implementationState === "invalid");
    const unbound = matchingDeclarations.find(({ metadata }) => metadata.implementationState === "unbound");
    const status = active?.implementationStatus === "official_fallback" ? "slot_implementation_invalid_official_fallback"
      : active ? "template_declared_active"
        : invalid ? "slot_implementation_invalid"
          : unbound ? "template_declared_unbound"
            : matchingDeclarations.length ? "template_declared_not_activated"
              : "template_capability_missing";
    return {
      capabilityId,
      status,
      slotIds: matchingDeclarations.map(({ slot }) => slot.id),
      activeSlotId: active?.slotId || "",
      fallbackReason: active?.fallbackReason || "",
    };
  });
  const planSelections = budgetedActivated.map((selection) => ({ ...selection }));
  const trustedActions = planSelections.flatMap((selection) => selection.authorizedCapabilities
    .flatMap((capability) => trustedActionsForCapability(capability, `${selection.slotId}:${selection.id}`)));
  const phases = Object.fromEntries(CAPABILITY_PHASES.map((phase) => [phase, planSelections
    .filter((selection) => selection.activationPolicy.phases.includes(phase))
    .map((selection) => `${selection.slotId}:${selection.id}`)]));
  const stageIndex = {};
  for (const selection of planSelections) {
    for (const stage of selection.activationPolicy.stages) {
      if (!stageIndex[stage]) stageIndex[stage] = [];
      stageIndex[stage].push(`${selection.slotId}:${selection.id}`);
    }
  }
  const trace = [
    ...planSelections.map((selection) => ({
      decision: "selected",
      capabilityIds: selection.authorizedCapabilities,
      slotId: selection.slotId,
      skillId: selection.id,
      path: selection.templatePath,
      reason: selection.fallbackReason || selection.triggerMatch?.reasons?.join("；") || "面板能力、祖先策略与任务需求匹配",
      relation: { scopeId: selection.relationScopeId, type: selection.relationType, role: selection.relationRole, exclusiveKey: selection.exclusiveKey, stackKey: selection.stackKey },
    })),
    ...budgeted.dropped.map(({ selection, reason }) => ({ decision: "dropped", capabilityIds: selection.authorizedCapabilities, slotId: selection.slotId, skillId: selection.id, reason })),
    ...capabilityStatus.filter((item) => !["template_declared_active", "slot_implementation_invalid_official_fallback"].includes(item.status))
      .map((item) => ({ decision: "unresolved", capabilityIds: [item.capabilityId], slotId: item.slotIds[0] || "", reason: item.status })),
  ].slice(0, 200);
  const snapshotHash = templateHash || stableStructureHash(bundle);
  const planSeed = {
    template: { schemaVersion: bundle.schemaVersion, revision: Number(templateRevision) || 0, hash: snapshotHash },
    task,
    selections: planSelections.map((selection) => ({ slotId: selection.slotId, skillId: selection.id, capabilities: selection.authorizedCapabilities, relationScopeId: selection.relationScopeId })),
  };
  const compiledCapabilityPlan = deepFreezeCapabilityValue({
    schemaVersion: 1,
    kind: "CompiledCapabilityPlan",
    id: `capplan:${stableStructureHash(planSeed)}`,
    templateSnapshot: { schemaVersion: bundle.schemaVersion, revision: Number(templateRevision) || 0, hash: snapshotHash, immutable: true },
    task,
    trustedCoreCapabilities,
    capabilityStatus,
    selections: planSelections,
    phases,
    stageIndex,
    trustedActions,
    budgets: { limit: CAPABILITY_EXECUTION_BUDGET, used: budgeted.counts, dropped: budgeted.dropped.length },
    trace,
  });
  return {
    selections: deduped,
    activatedSelections: budgetedActivated,
    compiledCapabilityPlan,
    diagnostics: {
      valid: true,
      errors: [],
      visited,
      evaluatedNodeCount: bundle.groups.length + bundle.modules.length + 1,
      activatedSlotIds: budgetedActivated.map((selection) => selection.slotId),
      selectedSlotIds: deduped.map((selection) => selection.slotId),
      disabledNodeIds: [bundle.template, ...bundle.groups, ...bundle.modules].filter((node) => node.disabled === true).map((node) => node.id),
      relationDecisions: budgetedActivated.map((selection) => ({
        slotId: selection.slotId,
        role: selection.bindingRole,
        path: selection.templatePath,
        relationScopeId: selection.relationScopeId,
        relationType: selection.relationType,
        relationRole: selection.relationRole,
        exclusiveKey: selection.exclusiveKey,
        stackKey: selection.stackKey,
      })),
      blocked: boundedMessages(
        templateEvaluation.blocked,
        ...budgeted.dropped.map(({ reason }) => reason),
        truncatedSelectionCount ? [`同时命中的用户 Skill 超过分类预算，已暂缓 ${truncatedSelectionCount} 个`] : [],
      ),
      selectionLimit: CAPABILITY_TEMPLATE_ROUTE_SELECTION_LIMIT,
      truncatedSelectionCount,
      capabilityStatus,
      planId: compiledCapabilityPlan.id,
    },
  };
};

export const capabilityTemplateTopology = (inputBundle) => {
  const validation = validateCapabilityTemplate(inputBundle);
  const bundle = validation.bundle;
  const withoutRouteDocument = (node = {}) => {
    const { routeDocument: _routeDocument, ...rest } = node;
    return rest;
  };
  return {
    schemaVersion: CAPABILITY_TEMPLATE_SCHEMA_VERSION,
    valid: validation.valid,
    errors: validation.errors,
    // routeDocument is a generated projection, not part of the topology
    // identity. Excluding it keeps the topology hash stable and prevents a
    // generated document from recursively changing its own metadata.
    template: withoutRouteDocument(bundle.template),
    groups: bundle.groups.map(withoutRouteDocument),
    modules: bundle.modules.map(withoutRouteDocument),
    fixedSlotIds: unique(bundle.modules.flatMap((module) => module.slots.map((slot) => slot.fixedSlotId))),
  };
};

export const lintCapabilityTemplateReachability = (inputBundle, { fixedSlots = [], userSkills = [] } = {}) => {
  const validation = validateCapabilityTemplate(inputBundle);
  if (!validation.valid) return {
    valid: false,
    errors: validation.errors,
    warnings: [],
    issues: validation.errors.map((message) => ({ severity: "error", code: "invalid_structure", message })),
    unreachableGroups: [],
    unreachableModules: [],
  };
  const bundle = validation.bundle;
  const groupMap = new Map(bundle.groups.map((group) => [group.id, group]));
  const moduleMap = new Map(bundle.modules.map((module) => [module.id, module]));
  const fixedSlotMap = new Map(list(fixedSlots).map((slot) => [slot.id, slot]));
  const userSkillMap = new Map(list(userSkills).flatMap((skill) => [[skill.id, skill], [String(skill.id).replace(/^user:/, ""), skill]]));
  const maps = { groupMap, moduleMap, fixedSlotMap, userSkillMap, legacyBindings: new Map() };
  const reachableGroups = new Set();
  const reachableModules = new Set();
  const issues = [];
  const stack = [{ nodeType: "template", node: bundle.template, layers: [] }];
  let expanded = 0;
  while (stack.length && expanded < 100_000) {
    const current = stack.pop();
    expanded += 1;
    const layers = [...current.layers, current.node];
    if (current.nodeType === "group") reachableGroups.add(current.node.id);
    if (current.nodeType === "module") {
      reachableModules.add(current.node.id);
      if (!current.node.slots.length) issues.push({ severity: "warning", code: "empty_module", nodeId: current.node.id, message: `模块“${current.node.name}”没有插槽` });
      for (const slot of current.node.slots) {
        const metadata = skillMetadataForSlot(slot, maps);
        const policy = compileActivationPolicy({ layers: [...layers, slot], metadata, capabilities: metadata.capabilities });
        if (policy.impossible) issues.push({ severity: "error", code: "unreachable_policy", nodeId: slot.id, message: `插槽“${slot.name}”与祖先激活策略的交集为空，永远不可达` });
        if (metadata.implementationState === "unbound") issues.push({ severity: "warning", code: "unbound_slot", nodeId: slot.id, message: `插槽“${slot.name}”尚未绑定 Skill` });
        if (metadata.implementationState === "invalid") issues.push({
          severity: metadata.fallbackReady ? "warning" : "error",
          code: metadata.fallbackReady ? "invalid_with_official_fallback" : "invalid_implementation",
          nodeId: slot.id,
          message: metadata.fallbackReady
            ? `插槽“${slot.name}”的当前 Skill 失效，运行时会按插槽策略回退官方实现`
            : `插槽“${slot.name}”绑定的 Skill 不存在、未通过测试或官方实现不可用`,
        });
        for (const capability of metadata.capabilities) {
          if (!CAPABILITY_DESCRIPTOR_REGISTRY[capability]) issues.push({ severity: "error", code: "unknown_capability", nodeId: slot.id, message: `插槽“${slot.name}”声明了未注册能力：${capability}` });
        }
      }
      continue;
    }
    for (const item of current.node.items) {
      const node = item.targetType === "group" ? groupMap.get(item.targetId) : moduleMap.get(item.targetId);
      if (node) stack.push({ nodeType: item.targetType, node, layers });
    }
  }
  if (expanded >= 100_000) issues.push({ severity: "error", code: "expansion_limit", message: "面板展开路径超过 100000，可能存在无效的指数级重复嵌套" });
  const unreachableGroups = bundle.groups.filter((group) => !reachableGroups.has(group.id)).map((group) => group.id);
  const unreachableModules = bundle.modules.filter((module) => !reachableModules.has(module.id)).map((module) => module.id);
  for (const id of unreachableGroups) issues.push({ severity: "warning", code: "detached_group", nodeId: id, message: `模组“${groupMap.get(id)?.name || id}”未装配到当前面板，本轮路由不会调用` });
  for (const id of unreachableModules) issues.push({ severity: "warning", code: "detached_module", nodeId: id, message: `模块“${moduleMap.get(id)?.name || id}”未装配到当前面板，本轮路由不会调用` });
  const errors = issues.filter((issue) => issue.severity === "error").map((issue) => issue.message);
  const warnings = issues.filter((issue) => issue.severity === "warning").map((issue) => issue.message);
  return { valid: errors.length === 0, errors, warnings, issues: issues.slice(0, 500), unreachableGroups, unreachableModules, expandedNodeCount: expanded };
};

export const cloneCapabilityTemplate = clone;
