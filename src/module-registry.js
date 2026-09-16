export const MODULE_REGISTRY_SCHEMA_VERSION = 1;

const freezeList = (values) => Object.freeze([...values]);
const CREATIVE_WORKSPACE_MODES = Object.freeze(["project", "notebook"]);

export const WORKSPACE_MODULES = Object.freeze([
  { id: "manuscript", label: "正文", icon: "\uE8A5", listTitle: "正文目录" },
  { id: "outline", label: "大纲", icon: "\uE8FD", listTitle: "小说大纲" },
  { id: "canon", label: "设定", icon: "\uE7B3", listTitle: "正史设定" },
  { id: "memory", label: "记忆", icon: "\uE950", listTitle: "小说记忆" },
  { id: "reports", label: "编译报告", icon: "\uE9D5", listTitle: "编译报告" },
  { id: "library", label: "资料库", icon: "\uE8B7", listTitle: "资料库" },
  { id: "index", label: "索引", icon: "\uECA5", listTitle: "索引" },
]);

const COMMON_PROJECT_CORE = freezeList([
  "task_routing",
  "reference_routing",
  "live_route_compilation",
  "context_compilation",
  "security_review",
  "format_validation",
  "structured_landing",
  "version_backup",
]);

const COMMON_PROJECT_ADVISORS = freezeList(["theory_advisor", "experience_advisor", "experience_observer"]);

export const MODULE_REGISTRY = Object.freeze({
  manuscript: Object.freeze({
    id: "manuscript",
    owner: "主笔模块",
    defaultTask: "write_novel_chapter",
    replaceableCapabilities: freezeList(["novel_prose_writer"]),
    trustedCapabilities: freezeList(["continuity_gate", "memory_update", "index_update"]),
    ruleSources: freezeList(["神思-正文写作规则.md"]),
  }),
  outline: Object.freeze({
    id: "outline",
    owner: "规划模块",
    defaultTask: "plan_story",
    replaceableCapabilities: freezeList(["story_planner"]),
    trustedCapabilities: freezeList([]),
    ruleSources: freezeList(["神思-大纲与章纲规则.md"]),
  }),
  canon: Object.freeze({
    id: "canon",
    owner: "规划模块",
    defaultTask: "plan_setting",
    replaceableCapabilities: freezeList(["setting_planner"]),
    trustedCapabilities: freezeList(["canon_write"]),
    ruleSources: freezeList(["神思-设定生成规则.md"]),
  }),
  memory: Object.freeze({
    id: "memory",
    owner: "记忆模块",
    defaultTask: "maintain_memory",
    replaceableCapabilities: freezeList(["memory_advisor"]),
    trustedCapabilities: freezeList(["continuity_gate", "memory_update", "index_update"]),
    ruleSources: freezeList(["神思-结构化管理规则.md"]),
  }),
  reports: Object.freeze({
    id: "reports",
    owner: "记录模块",
    defaultTask: "review_artifact",
    replaceableCapabilities: freezeList(["effect_reviewer", "strong_story_reviewer", "regular_progress_reviewer"]),
    trustedCapabilities: freezeList(["continuity_gate", "format_validation"]),
    ruleSources: freezeList(["神思-创作效果验收规则.md"]),
  }),
  library: Object.freeze({
    id: "library",
    owner: "资料模块",
    defaultTask: "manage_reference",
    replaceableCapabilities: freezeList([]),
    trustedCapabilities: freezeList([]),
    ruleSources: freezeList(["神思-结构化管理规则.md"]),
  }),
  index: Object.freeze({
    id: "index",
    owner: "索引模块",
    defaultTask: "maintain_index",
    replaceableCapabilities: freezeList([]),
    trustedCapabilities: freezeList(["index_update"]),
    ruleSources: freezeList(["神思-结构化管理规则.md"]),
  }),
});

const SETTING_INTENT = /(?:创建|生成|补充|规划|设计|新增|修改|完善|整理).{0,16}(?:设定|人物档案|世界观|力量体系|时间线|势力)|(?:人物设定|世界观设定|力量体系设定|势力设定).{0,16}(?:创建|生成|补充|规划|设计|修改|完善)/;
const OUTLINE_INTENT = /(?:创建|生成|补充|规划|设计|新增|修改|完善|整理|编写).{0,16}(?:全集大纲|全书大纲|卷纲|章纲|剧集大纲|分集大纲)|(?:规划故事|剧情规划)|(?:三幕结构|四幕结构|英雄之旅|起承转合).{0,16}(?:重构|调整|优化).{0,16}(?:当前卷|本卷|剧情|走向|大纲)|(?:重构|调整|优化).{0,16}(?:当前卷|本卷).{0,12}(?:剧情|走向|结构)/;
const ADAPTATION_INTENT = /小说.{0,12}改编?(?:成|为)?(?:短剧|剧本|漫剧)|改编(?:成|为)?(?:短剧|剧本|漫剧)|根据.{0,24}(?:小说|原著|原作|章节|原文)|原著改编|原作改编/;
const PROMPT_INTENT = /提示词|分镜提示词|镜头提示词|视觉资产|图片资产|全景调度|站位线稿|多人站位|空间调度/;
const REPAIR_INTENT = /返修|重写|改写|修改|润色/;
const REVIEW_INTENT = /自检|检查|审查|验收|复核|校对|质量评估|质量检查/;
const REVIEW_NEGATION = /(?:不要|无需|不用|不必|禁止|跳过|取消|先不|暂不).{0,12}(?:自检|检查|审查|验收|复核|校对)/;
const STRONG_STORY_REVIEW_INTENT = /强剧情自检|强剧情审查|强剧情验收|强悬念|强反转|高潮章节|开篇钩子|前三章|付费点|追读压力/;
const FULL_REVIEW_INTENT = /满血|全量(?:自检|检查|验收)|全面(?:自检|检查|验收)|完整(?:自检|检查|验收)|最终验收|质量争议/;
const reviewRequested = (prompt = "") => REVIEW_INTENT.test(String(prompt)) && !REVIEW_NEGATION.test(String(prompt));

export const reviewCapabilitiesForPrompt = ({ prompt = "", fullAudit = false } = {}) => {
  const source = String(prompt);
  if (fullAudit || FULL_REVIEW_INTENT.test(source)) return ["strong_story_reviewer", "regular_progress_reviewer"];
  if (STRONG_STORY_REVIEW_INTENT.test(source)) return ["strong_story_reviewer"];
  if (/小说自检模块/.test(source)) return ["effect_reviewer"];
  return ["regular_progress_reviewer"];
};

export const resolveProjectModule = ({ activeModule = "manuscript", prompt = "" } = {}) => {
  const source = String(prompt);
  if (SETTING_INTENT.test(source)) return "canon";
  if (OUTLINE_INTENT.test(source)) return "outline";
  return MODULE_REGISTRY[activeModule] ? activeModule : "manuscript";
};

const scriptWriterCapability = ({ prompt = "", sourceMode = "" } = {}) => (
  sourceMode === "adaptation" || ADAPTATION_INTENT.test(String(prompt)) ? "adaptation_writer" : "original_script_writer"
);

const manuscriptCapabilities = ({ prompt = "", contextDomain = "novel", targetDocumentId = "", sourceMode = "" } = {}) => {
  const text = `${prompt} ${targetDocumentId}`;
  if (targetDocumentId.startsWith("prompt-") || PROMPT_INTENT.test(text)) return ["visual_prompt_writer"];
  if (["script", "script-adaptation"].includes(contextDomain)) {
    return [scriptWriterCapability({ prompt: text, sourceMode }), ...(reviewRequested(prompt) ? ["effect_reviewer"] : [])];
  }
  return ["novel_prose_writer", ...(reviewRequested(prompt) ? reviewCapabilitiesForPrompt({ prompt }) : [])];
};

export const resolveProjectCapabilityPlan = ({
  activeModule = "manuscript",
  prompt = "",
  contextDomain = "novel",
  targetDocumentId = "",
  requestMode = "creative",
  sourceMode = "",
} = {}) => {
  const moduleId = resolveProjectModule({ activeModule, prompt });
  const definition = MODULE_REGISTRY[moduleId];
  const inferredScriptTask = ["script", "script-adaptation"].includes(contextDomain)
    || /短剧|漫剧|微短剧|竖屏短剧|真人短剧|AI\s*短剧/.test(`${prompt} ${targetDocumentId}`)
    || /^script-(?:episode|outline)-/.test(targetDocumentId);
  const effectiveContextDomain = inferredScriptTask ? "script" : contextDomain;
  const scriptOutline = moduleId === "outline" && inferredScriptTask;
  const visualOutput = requestMode === "visual_prompt"
    || targetDocumentId.startsWith("prompt-")
    || PROMPT_INTENT.test(String(prompt));
  const replaceable = visualOutput
    ? ["visual_prompt_writer"]
    : scriptOutline
    ? [scriptWriterCapability({ prompt: `${prompt} ${targetDocumentId}`, sourceMode }), ...(reviewRequested(prompt) ? ["effect_reviewer"] : [])]
    : moduleId === "manuscript"
    ? manuscriptCapabilities({ prompt, contextDomain: effectiveContextDomain, targetDocumentId, sourceMode })
    : moduleId === "reports" && effectiveContextDomain === "novel"
      ? reviewRequested(prompt) ? reviewCapabilitiesForPrompt({ prompt }) : ["effect_reviewer"]
    : [...definition.replaceableCapabilities];
  const guidanceCore = requestMode === "creative_guidance" ? ["guidance_control"] : [];
  if (requestMode === "creative_guidance") {
    const guidanceCapability = targetDocumentId.startsWith("prompt-") || PROMPT_INTENT.test(String(prompt))
      ? "prompt_guidance"
      : inferredScriptTask || (/剧本/.test(String(prompt)) && !/短视频/.test(String(prompt)))
        ? "short_drama_guidance"
        : "novel_guidance";
    replaceable.unshift(guidanceCapability);
  }
  if (moduleId === "manuscript" && REPAIR_INTENT.test(String(prompt))) replaceable.push("repair_writer");
  return {
    moduleId,
    task: visualOutput || replaceable.includes("visual_prompt_writer") ? "write_visual_prompt"
      : scriptOutline ? "plan_script_series"
      : replaceable.includes("adaptation_writer") ? "adapt_script"
        : replaceable.includes("original_script_writer") ? "write_original_script"
          : definition.defaultTask,
    capabilities: [...new Set([...COMMON_PROJECT_CORE, ...COMMON_PROJECT_ADVISORS, ...guidanceCore, ...replaceable, ...definition.trustedCapabilities])],
  };
};

export const moduleRuleSources = ({ activeModule = "manuscript", prompt = "" } = {}) => {
  const moduleId = resolveProjectModule({ activeModule, prompt });
  return [...MODULE_REGISTRY[moduleId].ruleSources];
};

const freezeSlotGroup = (group) => Object.freeze({
  ...group,
  groupType: group.groupType ?? "parallel",
  leaderSlotId: group.leaderSlotId ?? "",
  allowedCapabilities: freezeList(group.allowedCapabilities ?? []),
  writerSubstitutionCapabilities: freezeList(group.writerSubstitutionCapabilities ?? []),
  fixed: true,
});

export const FIXED_SKILL_SLOT_GROUPS = Object.freeze([
  { id: "group:creative-guidance", name: "创作引导", description: "按最终产物分别确认基础决策、增强看点和交付条件。", parentGroupId: "", order: 10, allowedCapabilities: ["creative_guidance", "novel_guidance", "short_drama_guidance", "public_account_guidance", "short_fiction_guidance", "short_video_guidance", "prompt_guidance"] },
  { id: "group:theory-advisors", name: "题材理论顾问", description: "保存可替换的类型、文体和赛道方法论，不接管可信路由与资料权限。", parentGroupId: "", order: 30, allowedCapabilities: ["theory_advisor"] },
  { id: "group:novel-script-theory", name: "小说和剧本理论顾问", description: "小说理论顾问为上位路由；科幻、男频、女频和其他题材理论为下位专精。", parentGroupId: "group:theory-advisors", order: 10, groupType: "organization", leaderSlotId: "builtin:novel-theory-advisor", allowedCapabilities: ["theory_advisor"] },
  { id: "group:short-fiction-theory", name: "短篇小说理论顾问", description: "短篇小说通用理论为上位；题材、结构和风格等细分理论后续作为下位接入。当前仅建立上位插槽。", parentGroupId: "group:theory-advisors", order: 20, groupType: "organization", leaderSlotId: "builtin:short-fiction-general-theory", allowedCapabilities: ["theory_advisor"] },
  { id: "group:public-account-theory", name: "公众号文章理论顾问", description: "公众号文章通用理论为上位；科普、社会观察、历史人文等细分品类理论为下位。命中下位时二者共同生效。", parentGroupId: "group:theory-advisors", order: 30, groupType: "organization", leaderSlotId: "builtin:public-account-theory", allowedCapabilities: ["theory_advisor"] },
  { id: "group:science-fiction-theory", name: "科幻题材", description: "融合、短篇、传统与网文科幻理论按任务特征并行竞争。", parentGroupId: "group:novel-script-theory", order: 10, groupType: "parallel", allowedCapabilities: ["theory_advisor"] },
  { id: "group:male-web-theory", name: "男频爽文题材", description: "男频爽文为上位理论；命中妖系、图录式等细分题材时共同生效。", parentGroupId: "group:novel-script-theory", order: 20, groupType: "organization", leaderSlotId: "builtin:male-web-theory", allowedCapabilities: ["theory_advisor"] },
  { id: "group:female-web-theory", name: "女频小说题材", description: "女频通用理论为上位；当前已有的女频爽文和真假千金理论为下位专精。", parentGroupId: "group:novel-script-theory", order: 30, groupType: "organization", leaderSlotId: "builtin:female-general-theory", allowedCapabilities: ["theory_advisor"] },
  { id: "group:short-video-theory", name: "短视频赛道", description: "短视频通用理论为上位；账号、系列和细分类型方法为下位。命中下位时二者共同生效；下位仅在同时声明主笔能力时可替代短视频主笔。", parentGroupId: "group:theory-advisors", order: 40, priorityWeight: 200, groupType: "organization", leaderSlotId: "builtin:short-video-general-theory", allowedCapabilities: ["theory_advisor", "short_video_script_writer"], writerSubstitutionCapabilities: ["short_video_script_writer"] },
  { id: "group:effect-review", name: "自检", description: "按文体执行创作效果检查；小说正文拆分为强剧情与常规推进两类专项自检。", parentGroupId: "", order: 40, allowedCapabilities: ["effect_reviewer", "strong_story_reviewer", "regular_progress_reviewer", "genre_reviewer", "format_extension"] },
].map(freezeSlotGroup));

const freezeSlotChainStage = (stage) => Object.freeze({
  ...stage,
  slotIds: freezeList(stage.slotIds ?? []),
  groupIds: freezeList(stage.groupIds ?? []),
  customCapabilities: freezeList(stage.customCapabilities ?? []),
  shared: Boolean(stage.shared),
});

const freezeSlotChain = (chain) => Object.freeze({
  ...chain,
  workspaceModes: freezeList(chain.workspaceModes ?? ["general"]),
  stages: Object.freeze((chain.stages ?? []).map(freezeSlotChainStage)),
});

// 插槽链只负责把原子能力按创作生命周期组织给用户查看。固定插槽、插槽组、
// 绑定 ID 与服务端路由拓扑保持不变，避免展示层调整破坏既有用户配置。
export const FIXED_SKILL_SLOT_CHAINS = Object.freeze([
  {
    id: "chain:novel",
    name: "小说创作链",
    description: "从创作意图确认到正文交付、效果复核、理论校正与最终记忆沉淀。",
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    order: 10,
    stages: [
      { id: "guidance", name: "创作引导", description: "确认题材、读者、目标效果和关键取舍。", slotIds: ["builtin:creative-guidance"], customCapabilities: ["novel_guidance"] },
      { id: "planning", name: "规划", description: "完成故事大纲、卷章规划与受正史约束的设定规划。", slotIds: ["builtin:story-planner", "builtin:setting-planner"], customCapabilities: ["story_planner", "setting_planner"] },
      { id: "writer", name: "主笔", description: "依据规划、正史和当前状态生成小说正文；默认主笔之外可按候选任务调用备用主笔。", slotIds: ["builtin:novel-writer"], customCapabilities: ["novel_prose_writer"] },
      { id: "review", name: "自检", description: "按章节任务选择强剧情或常规推进专项自检；满血审计可同时调用。", slotIds: ["builtin:strong-story-review", "builtin:effect-review"], customCapabilities: ["strong_story_reviewer", "regular_progress_reviewer", "effect_reviewer"] },
      { id: "theory", name: "理论顾问", description: "按题材命中通用理论与细分理论，为成稿提供方法校正。", groupIds: ["group:novel-script-theory"] },
      { id: "memory", name: "记忆", description: "在交付后提出状态、读者知识和伏笔更新建议；可信内核负责最终写入。", slotIds: ["builtin:memory-steps"], customCapabilities: ["memory_advisor"], shared: true },
      { id: "experience", name: "经验", description: "写作前只召回相关经验，采用后再沉淀新经验；经验仓读写由可信内核负责。", slotIds: ["builtin:experience-advisor", "builtin:experience-observer"], customCapabilities: ["experience_advisor", "experience_observer"], shared: true },
    ],
  },
  {
    id: "chain:original-short-drama",
    name: "原创短剧创作链",
    description: "从原创短剧方向确认到剧集开发、剧本交付、复核、理论校正与记忆沉淀。",
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    order: 20,
    stages: [
      { id: "guidance", name: "创作引导", description: "确认平台、集数、核心冲突、钩子和制作约束。", slotIds: ["builtin:short-drama-guidance"], customCapabilities: ["short_drama_guidance"] },
      { id: "planning", name: "规划", description: "剧集大纲由原创短剧主笔一体完成，沿用同一主笔插槽，不重复绑定。", note: "规划与主笔共用一个原子能力插槽。" },
      { id: "writer", name: "主笔", description: "从原创概念、人物与冲突出发完成剧集大纲和正式剧本。", slotIds: ["builtin:original-script-writer"], customCapabilities: ["original_script_writer"] },
      { id: "review", name: "自检", description: "复核钩子、冲突、场次、表演、对白、集尾和制作可执行性。", slotIds: ["builtin:short-drama-review"], customCapabilities: ["effect_reviewer"] },
      { id: "theory", name: "理论顾问", description: "按小说与剧本题材体系提供通用和细分理论校正。", groupIds: ["group:novel-script-theory"] },
      { id: "memory", name: "记忆", description: "在剧集交付后提出状态、信息台阶和伏笔更新建议；可信内核负责最终写入。", slotIds: ["builtin:memory-steps"], customCapabilities: ["memory_advisor"], shared: true },
    ],
  },
  {
    id: "chain:adapted-short-drama",
    name: "小说改短剧创作链",
    description: "从改编目标确认到原作颗粒映射、剧本交付、复核、理论校正与记忆沉淀。",
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    order: 30,
    stages: [
      { id: "guidance", name: "创作引导", description: "确认来源范围、平台、集数、改编边界和制作约束。", slotIds: ["builtin:short-drama-guidance"], customCapabilities: ["short_drama_guidance"] },
      { id: "planning", name: "规划", description: "原作颗粒映射和剧集大纲由改编主笔一体完成，沿用同一主笔插槽。", note: "规划与主笔共用一个原子能力插槽。" },
      { id: "writer", name: "主笔", description: "保护原作剧情颗粒并完成剧集大纲与正式短剧剧本。", slotIds: ["builtin:adapted-script-writer"], customCapabilities: ["adaptation_writer"] },
      { id: "review", name: "自检", description: "复核改编保真、钩子、冲突、表演、集尾和制作可执行性。", slotIds: ["builtin:short-drama-review"], customCapabilities: ["effect_reviewer"] },
      { id: "theory", name: "理论顾问", description: "按小说与剧本题材体系提供通用和细分理论校正。", groupIds: ["group:novel-script-theory"] },
      { id: "memory", name: "记忆", description: "在剧集交付后提出状态、信息台阶和伏笔更新建议；可信内核负责最终写入。", slotIds: ["builtin:memory-steps"], customCapabilities: ["memory_advisor"], shared: true },
    ],
  },
  {
    id: "chain:short-fiction",
    name: "短篇小说创作链",
    description: "围绕单篇交付组织引导、主笔、自检与短篇理论顾问。",
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    order: 40,
    stages: [
      { id: "guidance", name: "创作引导", description: "确认篇幅、核心冲突、叙事方式、情绪落点和结尾效果。", slotIds: ["builtin:short-fiction-guidance"], customCapabilities: ["short_fiction_guidance"] },
      { id: "planning", name: "规划", description: "单篇结构规划由短篇主笔一体完成，沿用同一主笔插槽。", note: "规划与主笔共用一个原子能力插槽。" },
      { id: "writer", name: "主笔", description: "完成短篇小说的场景、人物、冲突、叙事与收束。", slotIds: ["builtin:short-fiction-writer"], customCapabilities: ["short_fiction_writer"] },
      { id: "review", name: "自检", description: "使用常规推进自检复核短篇的效果、节奏、语言与结尾收束。", slotIds: ["builtin:effect-review"], customCapabilities: ["regular_progress_reviewer", "effect_reviewer"] },
      { id: "theory", name: "理论顾问", description: "提供篇幅压缩、单核冲突、视角、风格和结尾方法。", groupIds: ["group:short-fiction-theory"] },
      { id: "memory", name: "记忆", description: "单篇交付默认不启用跨文档持久记忆。", note: "当前链不配置持久记忆插槽。" },
    ],
  },
  {
    id: "chain:public-account",
    name: "公众号文章创作链",
    description: "围绕受众、选题、文章交付、品类理论与写后正文配图组织公众号长文创作。",
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    order: 50,
    stages: [
      { id: "guidance", name: "创作引导", description: "确认受众、选题、传播目标、观点、风格和文章结构。", slotIds: ["builtin:public-account-guidance"], customCapabilities: ["public_account_guidance"] },
      { id: "planning", name: "规划", description: "选题与结构规划由公众号主笔一体完成，沿用同一主笔插槽。", note: "规划与主笔共用一个原子能力插槽。" },
      { id: "writer", name: "主笔", description: "依据受众、观点、作者个性与传播目标完成文章。", slotIds: ["builtin:public-account-writer"], customCapabilities: ["public_account_writer"] },
      { id: "review", name: "自检", description: "当前由主笔复核和可信内核确定性检查完成，不设置独立可替换插槽。", note: "当前链不配置独立自检插槽。" },
      { id: "illustration", name: "正文配图", description: "用户明确要求配图时，按真实正文锚点规划小黑怪诞手绘插图；生成、保存与插入由可信内核执行。", slotIds: ["builtin:ian-xiaohei-illustrations"], customCapabilities: ["article_illustration_planner"] },
      { id: "theory", name: "理论顾问", description: "提供公众号通用理论及科普等细分品类方法。", groupIds: ["group:public-account-theory"] },
      { id: "memory", name: "记忆", description: "单篇文章交付默认不启用跨文档持久记忆。", note: "当前链不配置持久记忆插槽。" },
    ],
  },
  {
    id: "chain:short-video",
    name: "剧情短视频创作链",
    description: "围绕单条剧情短视频的方向、脚本、复核和赛道理论组织创作。",
    workspaceModes: CREATIVE_WORKSPACE_MODES,
    order: 60,
    stages: [
      { id: "guidance", name: "创作引导", description: "确认时长、平台、形式、钩子、冲突节奏和结尾动作。", slotIds: ["builtin:short-video-guidance"], customCapabilities: ["short_video_guidance"] },
      { id: "planning", name: "规划", description: "单条结构规划由短视频主笔一体完成，沿用同一主笔插槽。", note: "规划与主笔共用一个原子能力插槽。" },
      { id: "writer", name: "主笔", description: "完成适配时长、平台与共性节奏的剧情脚本。", slotIds: ["builtin:short-video-writer"], customCapabilities: ["short_video_script_writer"] },
      { id: "review", name: "自检", description: "复核观看问题、状态变化、情绪兑现、反转依据和制作压缩。", slotIds: ["builtin:short-video-review"], customCapabilities: ["effect_reviewer"] },
      { id: "theory", name: "理论顾问", description: "由短视频通用理论和命中的账号、系列或细分类型方法共同提供校正。", groupIds: ["group:short-video-theory"] },
      { id: "memory", name: "记忆", description: "单条短视频交付默认不启用跨文档持久记忆。", note: "当前链不配置持久记忆插槽。" },
    ],
  },
  {
    id: "chain:auxiliary",
    name: "辅助能力链",
    description: "收纳拆书、文风参考、小说封面设计及用户建立的其他按需能力和自定义插槽组。",
    workspaceModes: ["general"],
    order: 80,
    auxiliary: true,
    stages: [
      { id: "on-demand", name: "按需调用", description: "按明确触发条件调用，不进入固定创作流水线。" },
    ],
  },
].map(freezeSlotChain));

const freezeFixedSlot = (slot) => Object.freeze({
  ...slot,
  workspaceModes: freezeList(slot.workspaceModes ?? ["general"]),
  capabilities: freezeList(slot.capabilities ?? slot.replacementCapabilities ?? []),
  replacementCapabilities: freezeList(slot.replacementCapabilities ?? []),
  secondarySkillIds: freezeList(slot.secondarySkillIds ?? []),
  contextDomains: freezeList(slot.contextDomains ?? []),
  deliverableTypes: freezeList(slot.deliverableTypes ?? []),
  triggerKeywords: freezeList(slot.triggerKeywords ?? []),
  fixed: true,
  sealed: true,
  version: slot.developerDefault === false ? "空缺" : "内置",
  enabled: true,
});

export const LEGACY_BUILTIN_SKILL_ALIASES = Object.freeze({});

export const canonicalBuiltinSkillId = (id = "") => LEGACY_BUILTIN_SKILL_ALIASES[String(id || "").trim()] || String(id || "").trim();

export const FIXED_SKILL_SLOT_CATALOG = Object.freeze([
  { id: "builtin:memory-steps", name: "记忆与信息台阶", description: "小说与剧本共用的状态、读者知识和伏笔建议槽；最终更新与写入仍由可信内核执行。", category: "共享记忆", parentGroupId: "", order: 10, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["memory_advisor"] },
  { id: "builtin:structure-engineering", name: "工程化管理", description: "在作品中提供完整结构化管理，在笔记中提供智能文件夹与文档组织建议；目录变更仍由可信内核验证执行。", category: "工程化管理", parentGroupId: "", order: 20, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["auxiliary_advisor"] },
  { id: "builtin:experience-advisor", name: "创作经验顾问", description: "写作前读取可信内核筛选出的相关经验，只提供建议，不覆盖用户要求、正史或模板边界。", category: "创作经验", parentGroupId: "", order: 30, workspaceModes: ["project", "notebook"], replacementCapabilities: ["experience_advisor"] },
  { id: "builtin:experience-observer", name: "创作经验观察", description: "仅从作者已经采用的成品中提炼经验候选；经验验证和入库由可信内核执行。", category: "创作经验", parentGroupId: "", order: 40, workspaceModes: ["project", "notebook"], replacementCapabilities: ["experience_observer"] },

  { id: "builtin:creative-guidance", name: "小说创作引导", description: "逐步确认小说创作意图、目标效果与关键取舍。", category: "创作引导", parentGroupId: "group:creative-guidance", order: 10, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["novel_guidance"] },
  { id: "builtin:short-drama-guidance", name: "短剧剧本创作引导", description: "确认短剧或漫剧的来源模式、平台、集数、核心冲突、钩子、表演和制作约束。", category: "创作引导", parentGroupId: "group:creative-guidance", order: 20, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["short_drama_guidance"] },
  { id: "builtin:short-fiction-guidance", name: "短篇小说创作引导", description: "确认篇幅、核心冲突、叙事方式、情绪落点与结尾效果。", category: "创作引导", parentGroupId: "group:creative-guidance", order: 30, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["short_fiction_guidance"] },
  { id: "builtin:public-account-guidance", name: "公众号文章创作引导", description: "确认受众、选题、传播目标、观点、风格与文章结构。", category: "创作引导", parentGroupId: "group:creative-guidance", order: 40, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["public_account_guidance"] },
  { id: "builtin:short-video-guidance", name: "短视频剧本创作引导", description: "确认时长、平台、视频风格、表演形式、钩子、冲突节奏与结尾动作。", category: "创作引导", parentGroupId: "group:creative-guidance", order: 50, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["short_video_guidance"] },
  { id: "builtin:prompt-guidance", name: "提示词创作引导", description: "确认媒介、模型、质感、构图、光线、表演、运镜、声音与画幅。", category: "创作引导", parentGroupId: "group:creative-guidance", order: 60, workspaceModes: ["project", "notebook"], replacementCapabilities: ["prompt_guidance"] },

  { id: "builtin:story-planner", name: "故事与大纲规划主笔", description: "完成小说全集大纲、卷纲、章纲和阶段规划；短剧大纲由对应原创或改编剧本主笔负责。", category: "主笔", parentGroupId: "", order: 5, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["story_planner"] },
  { id: "builtin:setting-planner", name: "小说设定规划主笔", description: "生成受正史、冲突用途与结构约束的小说设定候选。", category: "主笔", parentGroupId: "", order: 10, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["setting_planner"] },
  { id: "builtin:novel-writer", name: "小说正文主笔", description: "依据章纲、当前状态和信息台阶生成正文候选。默认主笔；备用主笔仅在用户明确选择候选生成时启用。", category: "主笔", parentGroupId: "", order: 20, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["novel_prose_writer"], secondarySkillIds: ["builtin:chinese-novelist-skill"] },
  { id: "builtin:original-script-writer", name: "短剧原创剧本主笔", description: "从原创概念、人物与冲突出发生成短剧剧本及剧集大纲。", category: "主笔", parentGroupId: "", order: 30, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["original_script_writer"] },
  { id: "builtin:adapted-script-writer", name: "小说改短剧剧本主笔", description: "在保护原作剧情颗粒的基础上，提取故事功能并完成原创化短剧结构对位改编。", category: "主笔", parentGroupId: "", order: 40, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["adaptation_writer"], bundledSource: "短剧生产链/短剧结构对位改编/SKILL.md", sourceLabel: "用户提供 · 短剧结构对位改编" },
  { id: "builtin:short-fiction-writer", name: "短篇小说主笔", description: "完成短篇小说的场景、人物、冲突、叙事与收束。", category: "主笔", parentGroupId: "", order: 50, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["short_fiction_writer"] },
  { id: "builtin:public-account-writer", name: "公众号文章主笔", description: "根据受众、观点、作者个性与传播目标完成公众号文章。", category: "主笔", parentGroupId: "", order: 60, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["public_account_writer"] },
  { id: "builtin:ian-xiaohei-illustrations", name: "Ian 小黑正文配图", description: "从已完成的公众号正文提取认知锚点，规划 16:9 白底手绘、小黑 IP、少量红橙蓝批注的怪诞正文配图；图片生成、保存和插入仍由可信内核执行。", category: "文章配图", parentGroupId: "", order: 10, workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["public_account"], triggerKeywords: ["正文配图", "自动配图", "文章配图", "公众号配图", "插图规划", "shot list", "小黑配图", "小黑风格"], replacementCapabilities: ["article_illustration_planner"], author: "Ian", sourceLabel: "GitHub · helloianneo/ian-xiaohei-illustrations", bundledSource: "公众号文章创作理论/ian-xiaohei-illustrations/SKILL.md", upstreamCommit: "91b560849e8f883922cc2fa8a358a668caa94105" },
  { id: "builtin:short-video-writer", name: "短视频剧本主笔", description: "完成适配时长、平台与共性节奏的剧情脚本。", category: "主笔", parentGroupId: "", order: 70, workspaceModes: CREATIVE_WORKSPACE_MODES, replacementCapabilities: ["short_video_script_writer"] },
  { id: "builtin:visual-asset-prompt-writer", name: "AI 漫剧图片资产提示词", description: "图片资产组织模块的上位 Skill：从小说、剧本或文本中提取人物、场景、道具及其他资产特征；已有下位专项时只负责提取，没有专项时直接完成提示词。", category: "提示词专项主笔", parentGroupId: "", order: 81, workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"], triggerKeywords: ["视觉资产", "图片资产", "图像资产", "人物资产", "角色资产", "场景资产", "道具资产", "定妆资产", "物品图片", "物件图片", "道具图片", "具体图片", "设定图", "定妆图", "三视图", "视觉资产skill", "图片资产skill"], replacementCapabilities: ["visual_prompt_writer", "prompt_writer"], sourceLabel: "神思官方 · AI 漫剧图片资产提示词", bundledSource: "AI漫剧图片资产提示词skill/AI漫剧图片资产提示词skill.md" },
  { id: "builtin:industrial-character-prompt-writer", name: "工业角色提示词", description: "图片资产组织模块的角色下位 Skill：将已提取或用户直接提供的人物特征输出为固定三维高精度国漫风格的十六比九四视图角色提示词。", category: "提示词专项主笔", parentGroupId: "", order: 82, workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"], triggerKeywords: ["工业角色提示词", "角色提示词", "人物提示词", "角色设计", "人物设计", "角色资产", "人物资产", "角色设定图", "人物设定图", "角色三视图", "人物三视图", "角色四视图", "人物四视图", "角色反推", "人物反推", "定妆图"], replacementCapabilities: ["visual_prompt_writer", "prompt_writer"], sourceLabel: "用户提供 · 工业角色提示词 v2", bundledSource: "AI漫剧图片资产提示词skill/工业角色提示词/SKILL.md" },
  { id: "builtin:guoman-scene-prompt-writer", name: "国漫场景提示词", description: "图片资产组织模块的场景下位 Skill：将已提取或用户直接提供的场景特征输出为十六比九、无人、空间清晰的三维国漫建模场景提示词。", category: "提示词专项主笔", parentGroupId: "", order: 83, workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"], triggerKeywords: ["国漫场景提示词", "场景提示词", "环境提示词", "场景设计", "环境设计", "场景资产", "环境资产", "场景设定图", "环境设定图", "场景建模", "环境建模", "无人场景", "纯场景"], replacementCapabilities: ["visual_prompt_writer", "prompt_writer"], sourceLabel: "用户提供 · 国漫场景提示词（十六比九）", bundledSource: "AI漫剧图片资产提示词skill/国漫场景提示词/SKILL.md" },
  { id: "builtin:video-prompt-writer", name: "AI 视频导演（二）", description: "按 30 秒视频导演规范将剧本、故事或动作构想转换为紧凑、连续且台词时长合理的可执行分镜提示词；唯一的视频提示词主笔 Skill。", category: "提示词专项主笔", parentGroupId: "", order: 84, workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"], triggerKeywords: ["AI 视频导演（二）", "AI视频导演二", "AI 视频导演 2", "ai导演（二）", "AI导演二", "视频导演二", "视频导演二（30秒）", "AI视频导演", "AI 视频导演", "视频导演", "Seedance", "Seedance 2.5", "镜头导演", "分镜导演"], replacementCapabilities: ["visual_prompt_writer", "prompt_writer"], sourceLabel: "神思官方 · AI 视频导演（二）", bundledSource: "ai漫剧提示词转换skill/漫剧提示词转换skill.md" },
  { id: "builtin:panorama-prompt-writer", name: "多人物场景站位线稿图", description: "为多人物场景、全景调度、空间关系和站位线稿生成专项提示词。", category: "提示词专项主笔", parentGroupId: "", order: 85, workspaceModes: ["project", "notebook"], deliverableTypes: ["visual_prompt"], triggerKeywords: ["全景调度", "多人站位", "人物站位", "站位图", "站位线稿", "空间调度"], replacementCapabilities: ["visual_prompt_writer", "prompt_writer"], sourceLabel: "神思官方 · 多人物场景站位线稿图", bundledSource: "ai漫剧提示词转换skill/多人物场景站位线稿图 Skill.md" },

  { id: "builtin:novel-theory-advisor", name: "小说理论顾问", description: "识别小说与剧本的题材归属、理论边界和下位理论调用，不替代正文、规划或自检主笔。", category: "题材理论顾问", parentGroupId: "group:novel-script-theory", order: 5, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], deliverableTypes: ["novel", "short_drama_script"], triggerKeywords: ["小说理论", "题材理论", "类型理论", "理论顾问"], replacementCapabilities: ["theory_advisor"], bundledSource: "小说类型理论研究/小说类型理论研究.md", sourceLabel: "神思官方 · 小说理论顾问" },
  { id: "builtin:hybrid-science-fiction-theory", name: "融合型科幻", description: "以商业类型动力承载科幻思想命题。", category: "题材理论顾问", parentGroupId: "group:science-fiction-theory", order: 10, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["融合型科幻", "科幻悬疑", "科幻爱情"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:short-science-fiction-theory", name: "短篇科幻", description: "以压缩叙事完成单一思想实验与高密度收束。", category: "题材理论顾问", parentGroupId: "group:science-fiction-theory", order: 20, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["短篇科幻", "科幻短篇"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:traditional-science-fiction-theory", name: "传统科幻", description: "围绕严肃科幻命题、世界规则与思想实验组织创作。", category: "题材理论顾问", parentGroupId: "group:science-fiction-theory", order: 30, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["传统科幻", "严肃科幻", "硬科幻"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:web-novel-science-fiction-theory", name: "网文科幻", description: "以长篇升级、追读动力和商业兑现组织科幻网文。", category: "题材理论顾问", parentGroupId: "group:science-fiction-theory", order: 40, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["网文科幻", "科幻网文", "商业长篇科幻"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:male-web-theory", name: "男频爽文", description: "提供男频升级、目标推进、爽点兑现与长线追读的上位理论。", category: "题材理论顾问", parentGroupId: "group:male-web-theory", order: 10, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["男频", "男频爽文", "玄幻", "仙侠", "都市爽文", "系统文", "升级流", "妖系", "图录式爽剧"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:catalog-power-drama-theory", name: "图录式爽剧与妖系升级流", description: "在男频上位理论之下处理图录收集、妖系单元与阶段升级。", category: "题材理论顾问", parentGroupId: "group:male-web-theory", order: 20, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["图录式爽剧", "妖系单元", "妖系升级", "妖怪图鉴"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:female-general-theory", name: "女频通用理论", description: "提供女性主体、关系叙事、情绪因果与读者承诺的共同底座，不预设爽文或虐文结局。", category: "题材理论顾问", parentGroupId: "group:female-web-theory", order: 10, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["女频", "女性向", "古言", "现言", "宫斗", "宅斗", "甜宠", "虐恋", "女性成长"], replacementCapabilities: ["theory_advisor"], bundledSource: "小说类型理论研究/女频小说通用理论.md", sourceLabel: "神思官方 · 女频通用理论" },
  { id: "builtin:female-web-theory", name: "女频爽文", description: "处理价值修正、反击兑现、身份重构和先虐后爽；不用于纯虐文。", category: "题材理论顾问", parentGroupId: "group:female-web-theory", order: 20, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["女频爽文", "女性爽文", "女频复仇", "女性成长爽文", "弃妇逆袭", "职场翻身", "娱乐圈翻盘", "先虐后爽", "虐转爽", "后期转爽"], replacementCapabilities: ["theory_advisor"], bundledSource: "小说类型理论研究/女频爽文创作概论.md", sourceLabel: "神思官方 · 女频爽文理论" },
  { id: "builtin:true-false-heiress-theory", name: "真假千金", description: "在女频通用理论之下处理身份错位、家庭亏欠与价值重建。", category: "题材理论顾问", parentGroupId: "group:female-web-theory", order: 30, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["真假千金", "真千金", "假千金", "豪门认亲"], replacementCapabilities: ["theory_advisor"], bundledSource: "小说类型理论研究/真假千金剧情创作概论.md", sourceLabel: "神思官方 · 真假千金理论" },
  { id: "builtin:green-hat-emotion-theory", name: "极致情绪拉扯", description: "处理认知落差、关系羞辱与高强度情绪拉扯。", category: "题材理论顾问", parentGroupId: "group:novel-script-theory", order: 40, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["绿帽剧情", "认知羞辱", "情绪拉扯"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:revenge-drama-theory", name: "复仇爽剧", description: "以情绪债务、证据回收与高频反转组织复仇兑现。", category: "题材理论顾问", parentGroupId: "group:novel-script-theory", order: 50, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["复仇爽剧", "复仇爽文", "情绪债务"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:otome-content-theory", name: "乙女向内容", description: "围绕长期陪伴、角色关系与持续情感回报组织乙女向内容。", category: "题材理论顾问", parentGroupId: "group:novel-script-theory", order: 60, workspaceModes: ["project", "notebook"], contextDomains: ["novel", "script", "script-adaptation"], triggerKeywords: ["乙女向", "乙女游戏", "女性向恋爱"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:short-fiction-general-theory", name: "短篇小说通用理论", description: "提供篇幅压缩、单核冲突、叙事视角、风格控制与结尾收束的短篇小说上位理论。", category: "题材理论顾问", parentGroupId: "group:short-fiction-theory", order: 10, workspaceModes: ["project", "notebook"], deliverableTypes: ["short_fiction"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:public-account-theory", name: "公众号文章通用理论", description: "提供受众承诺、选题价值、证据边界、内容组织与传播机制的公众号文章上位理论。", category: "题材理论顾问", parentGroupId: "group:public-account-theory", order: 10, workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["public_account"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:alternative-popular-science-theory", name: "另类科普", description: "在公众号通用理论之下处理反常识、故事化和假设型科普的选题、证据、因果解释与传播。", category: "题材理论顾问", parentGroupId: "group:public-account-theory", order: 20, workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["public_account"], triggerKeywords: ["另类科普", "反常识科普", "故事化科普", "假设型科普", "逆向科普", "黑暗科普", "微观世界科普", "文明科普", "如果世界改变", "奇怪问题解释世界", "科普公众号", "科普爆款", "科普长文"], replacementCapabilities: ["theory_advisor"] },
  { id: "builtin:short-video-general-theory", name: "短视频通用理论", description: "提供观看问题、状态变化、情绪兑现、因果反转与制作适配的短视频上位理论。", category: "题材理论顾问", parentGroupId: "group:short-video-theory", order: 10, workspaceModes: CREATIVE_WORKSPACE_MODES, deliverableTypes: ["short_video_script"], replacementCapabilities: ["theory_advisor"] },

  { id: "builtin:strong-story-review", name: "强剧情自检", description: "检查开局、高潮、强悬念、强反转、商业承诺与追读压力。", category: "自检", parentGroupId: "group:effect-review", order: 10, workspaceModes: ["project", "notebook"], contextDomains: ["novel"], deliverableTypes: ["novel"], replacementCapabilities: ["strong_story_reviewer"], bundledSource: "小说写作技能skill/强剧情自检.md", sourceLabel: "神思内置 · 强剧情自检" },
  { id: "builtin:effect-review", name: "常规推进自检", description: "检查章节目标、人物行动、信息推进、局部兑现与结尾功能；兼容旧小说自检绑定。", category: "自检", parentGroupId: "group:effect-review", order: 20, workspaceModes: ["project", "notebook"], contextDomains: ["novel"], deliverableTypes: ["novel", "short_fiction"], replacementCapabilities: ["regular_progress_reviewer", "effect_reviewer"], bundledSource: "小说写作技能skill/常规推进自检.md", sourceLabel: "神思内置 · 常规推进自检", legacyNames: ["小说自检"] },
  { id: "builtin:short-drama-review", name: "短剧剧本自检", description: "以精髓锁为核心检查短剧保真、冲突升级、爽点兑现、节奏、对白、集尾钩子和制作可执行性。", category: "自检", parentGroupId: "group:effect-review", order: 20, workspaceModes: CREATIVE_WORKSPACE_MODES, contextDomains: ["script", "script-adaptation"], deliverableTypes: ["short_drama_script"], replacementCapabilities: ["effect_reviewer"], bundledSource: "短剧生产链/短剧精髓保真与爆点增强/SKILL.md", sourceLabel: "用户提供 · 短剧精髓保真与爆点增强" },
  { id: "builtin:short-video-review", name: "短视频剧本自检", description: "检查单条剧情短视频的观看问题、状态变化、情绪兑现、反转依据和制作压缩。", category: "自检", parentGroupId: "group:effect-review", order: 30, workspaceModes: CREATIVE_WORKSPACE_MODES, contextDomains: ["general"], deliverableTypes: ["short_video_script"], replacementCapabilities: ["effect_reviewer"] },
  { id: "builtin:short-drama-script-reconstructor", name: "短剧视频逆推剧本", description: "从用户明确提供的短剧视频、链接或剧集素材中，按可观察证据重构人物、场景、动作、对白、声音与连续性。", category: "辅助能力", parentGroupId: "", order: 10, workspaceModes: CREATIVE_WORKSPACE_MODES, contextDomains: ["script", "script-adaptation"], deliverableTypes: ["short_drama_script"], triggerKeywords: ["短剧逆推", "视频逆推剧本", "逆推剧本", "重构剧本", "还原短剧", "短剧视频分析"], replacementCapabilities: ["auxiliary_advisor"], bundledSource: "短剧生产链/短剧视频逆推剧本/SKILL.md", sourceLabel: "用户提供 · 短剧视频逆推剧本" },
].map(freezeFixedSlot));

export const DEFAULT_CUSTOM_SKILL_SLOTS = Object.freeze([
  Object.freeze({
    id: "bestseller-ranking-scan",
    name: "爆款扫榜",
    description: "由 Agent 按任务语义采集所需公开榜单样本，核验原始页面并形成可追溯的市场观察报告。",
    capabilityBoundary: "通过统一只读内置浏览器搜索和读取公开网页；不代替用户执行网页操作，登录或人工验证由用户完成。报告默认只在对话区交付。",
    workspaceModes: freezeList(["general"]),
    capabilities: freezeList(["market_research", "ranking_scan", "knowledge_reference"]),
    slotType: "single",
    triggerRules: "由 Agent 结合任务路由、用户目标和本 Skill 能力边界自主判断是否需要公开榜单研究；普通提及不自动启动采集。",
    triggerConditions: freezeList([]),
    developerSkillId: "builtin:bestseller-ranking-scan",
    developerSkillName: "爆款扫榜",
    parentGroupId: "",
    enabled: true,
  }),
  Object.freeze({
    id: "book-deconstruction",
    name: "拆爆款书",
    description: "对本轮获准读取的完整作品或指定范围进行逆向拆解。",
    capabilityBoundary: "只分析本轮明确授权的作品文本并生成非正史参考报告，不接管资料权限、正史裁决或文件落盘。",
    workspaceModes: freezeList(["general"]),
    capabilities: freezeList(["knowledge_reference"]),
    slotType: "single",
    triggerKeywords: freezeList(["拆书", "爆款拆书", "拆文", "逆向分析作品"]),
    triggerConditions: freezeList([]),
    developerSkillId: "builtin:book-deconstruction",
    developerSkillName: "爆款拆书",
    parentGroupId: "",
    enabled: true,
  }),
]);

export const fixedSkillSlotById = (id) => FIXED_SKILL_SLOT_CATALOG.find((slot) => slot.id === canonicalBuiltinSkillId(id)) ?? null;

export const BUILTIN_SECONDARY_SKILL_CATALOG = Object.freeze([
  freezeFixedSlot({ id: "builtin:chinese-novelist-skill", name: "小说原型设计", description: "作为小说正文主笔的备用主笔，从人物、世界观、大纲到样章提供轻量原型与候选稿；不改变默认主笔，也不自动改写既有正文。", category: "主笔", parentGroupId: "", order: 21, workspaceModes: ["project", "notebook"], replacementCapabilities: ["novel_prose_writer"], bundledSource: "小说写作技能skill/02-chinese-novelist-skill/SKILL.md", sourceLabel: "神思内置 · chinese-novelist-skill", secondaryOnly: true }),
]);

export const BUILTIN_SKILL_CATALOG = Object.freeze([
  ...FIXED_SKILL_SLOT_CATALOG.filter((slot) => slot.developerDefault !== false),
  ...BUILTIN_SECONDARY_SKILL_CATALOG,
].map((slot) => Object.freeze({ ...slot })));
