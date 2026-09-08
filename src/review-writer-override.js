const sourceText = (value = "") => String(value ?? "").replace(/\s+/gu, " ").trim();

const PRODUCTION_PATTERN = /(?:写|书写|创作|生成|续写|改写|重写|润色|扩写|压缩|正文|章节|作品|剧本|大纲|设定|规划|自检|审稿|审查|验收|检查|返修|修复)/u;
const META_QUERY_PATTERN = /(?:能不能|是否|可不可以|能否|为什么|怎么|如何|是什么|有哪些|会不会|是否可以)/u;

// A role transfer is opt-in. Ordinary mentions of a Skill, including a
// request for advice about it, continue through the normal route.
const ROLE_ASSIGNMENT_PATTERNS = Object.freeze([
  /(?:作为|担任|充当|当作|成为|接管|代替|指定为|强制(?:使用|让)?).{0,28}(?:主笔|作者|正文(?:生成|写作)?|写作|创作|规划|大纲|设定|引导|追问|自检|审稿|审查|验收|检查|返修|修复|记忆|理论顾问|配图|视觉资产)/iu,
  /(?:主笔|作者|正文(?:生成|写作)?|写作|创作|规划|大纲|设定|引导|追问|自检|审稿|审查|验收|检查|返修|修复|记忆|理论顾问|配图|视觉资产).{0,24}(?:使用|采用|由|让|指定|接管|代替)/iu,
  /(?:用|使用|采用|强制用|强制使用|让|由).{0,48}(?:规则|标准|方法|能力)?(?:.{0,18})(?:写|书写|创作|生成|续写|改写|检查|审查|规划|设定|引导|返修|修复)/iu,
]);

const TARGET_SLOT_LABELS = Object.freeze({
  routing: "任务路由",
  writer: "主笔",
  planning: "规划",
  guidance: "创作引导",
  effectReview: "自检",
  repair: "返修",
  theoryAdvice: "理论顾问",
  memoryAdvice: "记忆管理",
  experienceAdvice: "经验顾问",
  experienceObservation: "经验观察",
  artifactPlanning: "配图规划",
  genreReviews: "题材审查",
  formatExtensions: "格式标准",
});

const TARGET_SLOT_PATTERNS = Object.freeze([
  ["routing", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:任务路由|路由模块|路由)/iu]],
  ["genreReviews", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:题材审查|题材检查|类型审查)/iu]],
  ["formatExtensions", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:格式标准|格式检查|格式审查)/iu]],
  ["effectReview", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:自检|审稿|审查|验收|检查|效果检查|质量检查)/iu]],
  ["repair", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:返修|修复|修改|改稿)/iu]],
  ["artifactPlanning", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:配图规划|配图|视觉资产)/iu]],
  ["planning", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:规划|大纲|设定|策划)/iu]],
  ["guidance", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:创作引导|引导|追问)/iu]],
  ["theoryAdvice", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:理论顾问|理论)/iu]],
  ["memoryAdvice", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:记忆管理|记忆顾问|记忆)/iu]],
  ["experienceAdvice", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:经验顾问|经验建议)/iu]],
  ["experienceObservation", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为|用于|做).{0,24}(?:经验观察|观察器)/iu]],
  ["writer", [/(?:作为|担任|充当|当作|成为|接管|代替|指定为).{0,24}(?:主笔|作者|正文|写作|创作)/iu, /(?:用|使用|采用|强制用|强制使用|让|由).{0,48}(?:写|书写|创作|生成|续写|改写).{0,12}(?:正文|章节|作品|剧本)?/iu]],
]);

const WRITER_STAGES = new Set(["creative", "response", "quick-revision", "visual-generation", "visual-revision", "revision"]);
const SLOT_STAGES = Object.freeze({
  routing: new Set(["planning", "response"]),
  writer: WRITER_STAGES,
  planning: new Set(["planning", "response"]),
  guidance: new Set(["planning", "response"]),
  effectReview: new Set(["evaluation", "combined-check", "audit", "audit-final", "theory-support", "drama-development-check"]),
  repair: new Set(["revision"]),
  theoryAdvice: new Set(["planning", "response", "revision", "theory-support"]),
  memoryAdvice: new Set(["planning", "response", "creative", "revision", "evaluation"]),
  experienceAdvice: new Set(["planning", "response", "creative", "revision"]),
  experienceObservation: new Set(["creative", "revision", "evaluation"]),
  artifactPlanning: new Set(["planning", "response", "artifact-planning"]),
  genreReviews: new Set(["evaluation", "combined-check", "audit", "audit-final", "drama-development-check"]),
  formatExtensions: new Set(["evaluation", "combined-check", "audit", "audit-final"]),
});
const ARRAY_SLOTS = new Set(["theoryAdvisors", "genreReviews", "formatExtensions", "experienceAdvice", "experienceObservation", "artifactPlanning"]);

const ARTIFACT_CAPABILITIES = new Set([
  "article_illustration_planner",
  "novel_cover_designer",
  "image_asset_producer",
  "artifact_inserter",
]);

const capabilityValues = (skill = {}) => [
  ...(Array.isArray(skill.capabilities) ? skill.capabilities : []),
  ...(Array.isArray(skill.authorizedCapabilities) ? skill.authorizedCapabilities : []),
  ...(Array.isArray(skill.declaredCapabilities) ? skill.declaredCapabilities : []),
].map(sourceText).filter(Boolean);

const skillKind = (skill = {}) => {
  const capabilities = capabilityValues(skill);
  if (capabilities.length && capabilities.every((capability) => ARTIFACT_CAPABILITIES.has(capability))) return "artifact";
  return "text";
};

const targetKind = (slot = "writer") => slot === "artifactPlanning" ? "artifact" : "text";

const targetSlotFromPrompt = (source = "") => {
  // “作为主笔” must win over a Skill name such as “小说自检模块”.
  for (const [slot, patterns] of TARGET_SLOT_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(source))) return slot;
  }
  if (/(?:作为|担任|充当|当作|成为|接管|代替|指定为).{0,18}(?:主笔|作者)/iu.test(source)) return "writer";
  return "writer";
};

export const explicitSlotRoleOverrideRequest = ({
  prompt = "",
  requestMode = "creative",
  activeModule = "manuscript",
  contextDomain = "novel",
} = {}) => {
  const source = sourceText(prompt);
  const production = PRODUCTION_PATTERN.test(source);
  const roleAssigned = ROLE_ASSIGNMENT_PATTERNS.some((pattern) => pattern.test(source));
  const creativeSurface = requestMode === "creative"
    || requestMode === "quick_revision"
    || requestMode === "planning"
    || requestMode === "response"
    || (requestMode === "visual_prompt" && /(?:剧本|分镜|提示词)/u.test(source));
  const documentSurface = activeModule !== "reports"
    && activeModule !== "library"
    && activeModule !== "index";
  const metaOnly = META_QUERY_PATTERN.test(source) && !/(?:请执行|直接|开始|现在|请用|请让|请指定|强制)/u.test(source);
  const requested = Boolean(source && production && roleAssigned && creativeSurface && documentSurface && !metaOnly);
  const targetSlot = requested ? targetSlotFromPrompt(source) : "";
  return {
    requested,
    targetSlot,
    targetLabel: TARGET_SLOT_LABELS[targetSlot] || "目标槽位",
    reason: requested ? `用户明确要求本轮由指定 Skill/模块临时承担${TARGET_SLOT_LABELS[targetSlot] || "目标槽位"}规则` : "",
    evidence: { production, roleAssigned, creativeSurface, documentSurface, metaOnly },
  };
};

// Kept as a compatibility export for code and tests using the original name.
export const explicitWriterRoleOverrideRequest = (options = {}) => {
  const result = explicitSlotRoleOverrideRequest(options);
  return { ...result, requested: result.requested && result.targetSlot === "writer" };
};

const skillLabels = (skill = {}) => [
  skill.name,
  skill.slotName,
  skill.id,
  skill.skillId,
  ...(Array.isArray(skill.groupPath) ? skill.groupPath : []),
].map(sourceText).filter(Boolean);

const capabilityAliases = Object.freeze({
  short_video_script_writer: ["短视频编剧", "短视频剧本", "短视频主笔", "短视频剧本主笔"],
  effect_reviewer: ["自检", "审稿", "审查", "验收", "效果审查"],
  story_planner: ["故事规划", "大纲规划", "规划主笔", "剧情规划"],
  setting_planner: ["设定规划", "设定主笔"],
  creative_guidance: ["创作引导", "引导模块", "追问"],
  repair_writer: ["返修", "修复", "改稿"],
  theory_advisor: ["理论顾问", "题材理论"],
  memory_advisor: ["记忆管理", "记忆顾问"],
  experience_advisor: ["经验顾问", "经验建议"],
  experience_observer: ["经验观察", "观察器"],
});

const explicitlyNamed = (source, skill) => {
  const labels = skillLabels(skill);
  if (labels.some((label) => label.length >= 2 && source.includes(label))) return true;
  if (/(?:不存在|未配置|找不到|没有(?:可用|已加载)?)/u.test(source)) return false;
  return capabilityValues(skill).some((capability) => (capabilityAliases[capability] ?? [])
    .some((alias) => source.includes(alias)));
};

const explicitlyNamedExactly = (source, skill) => skillLabels(skill)
  .some((label) => label.length >= 2 && source.includes(label));

const sourceBeforeRoleAssignment = (source = "") => source
  .split(/(?:作为|担任|充当|当作|成为|接管|代替|指定为)/u)[0]
  .split(/(?:写|书写|创作|生成|检查|审查|规划|设定|引导|返修|修复)/u)[0]
  .trim();

const sameSkill = (left, right) => left && right
  && `${left.id || left.skillId || ""}:${left.slotId || ""}` === `${right.id || right.skillId || ""}:${right.slotId || ""}`;

const candidateSkills = (runtime = {}, availableSkills = []) => {
  const slots = runtime.slotSkills ?? {};
  return [
    runtime.primarySkill,
    ...Object.values(slots).flatMap((value) => Array.isArray(value) ? value : [value]),
    ...(runtime.auxiliarySkills ?? []),
    ...(Array.isArray(availableSkills) ? availableSkills : []),
  ].filter((skill, index, values) => skill
    && Boolean(String(skill.content ?? "").trim())
    && values.findIndex((candidate) => sameSkill(candidate, skill)) === index);
};

const roleName = (skill = {}) => String(skill.name || skill.slotName || skill.id || "指定 Skill");

const unsuccessfulMetadata = (request, reason, extra = {}) => ({
  requested: true,
  applied: false,
  targetSlot: request.targetSlot,
  targetLabel: request.targetLabel,
  reason,
  temporary: true,
  ...extra,
});

export const applyExplicitSlotRoleOverride = (runtime = {}, {
  prompt = "",
  requestMode = "creative",
  activeModule = "manuscript",
  contextDomain = "novel",
  availableSkills = [],
} = {}) => {
  const request = explicitSlotRoleOverrideRequest({ prompt, requestMode, activeModule, contextDomain });
  if (!request.requested) return runtime;
  const source = sourceText(prompt);
  const candidates = candidateSkills(runtime, availableSkills);
  // Prefer a full Skill/module label over generic aliases such as “自检” or
  // “规划”; the latter also occur naturally as target-slot names.
  const sourcePrefix = sourceBeforeRoleAssignment(source);
  const exactNamed = candidates.filter((skill) => explicitlyNamedExactly(sourcePrefix, skill));
  const named = (exactNamed.length ? exactNamed : candidates.filter((skill) => explicitlyNamed(source, skill)));
  if (named.length !== 1) {
    const metadata = unsuccessfulMetadata(request, named.length > 1
      ? "用户明确提到多个候选 Skill，无法安全确定唯一委派对象"
      : "用户指定的 Skill/模块未能唯一匹配到已完整加载的本轮候选", {
      ambiguous: named.length > 1,
      message: named.length > 1
        ? "本轮存在多个可能的 Skill，请明确指定一个后再临时委派。"
        : "未找到唯一匹配的已加载 Skill，本轮继续使用默认路由。",
    });
    return {
      ...runtime,
      slotRoleOverride: metadata,
      ...(request.targetSlot === "writer" ? { writerRoleOverride: metadata } : {}),
    };
  }
  const target = named[0];
  const sourceRole = target.effectiveRole || "skill";
  const compatible = skillKind(target) === targetKind(request.targetSlot);
  if (!compatible) {
    const message = `“${roleName(target)}”不具备“${request.targetLabel}”的${targetKind(request.targetSlot) === "text" ? "文字处理" : "视觉资产"}能力；它属于${skillKind(target) === "artifact" ? "配图或视觉资产" : "文字处理"}能力。`;
    return {
      ...runtime,
      slotRoleOverride: unsuccessfulMetadata(request, "指定 Skill 与目标槽位能力类型不匹配", {
        skillId: String(target.id || ""),
        skillName: roleName(target),
        originalRole: sourceRole,
        incompatible: true,
        message,
      }),
      ...(request.targetSlot === "writer" ? {
        writerRoleOverride: unsuccessfulMetadata(request, "指定 Skill 与目标槽位能力类型不匹配", {
          skillId: String(target.id || ""),
          skillName: roleName(target),
          originalRole: sourceRole,
          incompatible: true,
          message,
        }),
      } : {}),
    };
  }
  const override = {
    ...target,
    effectiveRole: request.targetSlot === "writer" ? "primary_writer" : sourceRole,
    slotRoleOverride: true,
    slotRoleOverrideTarget: request.targetSlot,
    slotRoleOverrideFrom: sourceRole,
    slotRoleOverrideReason: request.reason,
    ...(request.targetSlot === "writer" ? {
      writerRoleOverride: true,
      writerRoleOverrideFrom: sourceRole,
      writerRoleOverrideReason: request.reason,
    } : {}),
  };
  const slotSkills = {
    ...(runtime.slotSkills ?? {}),
    [request.targetSlot]: ARRAY_SLOTS.has(request.targetSlot) ? [override] : override,
  };
  if (request.targetSlot === "theoryAdvice") slotSkills.theoryAdvisors = [override];
  const result = {
    ...runtime,
    primarySkill: request.targetSlot === "writer" ? override : runtime.primarySkill,
    slotSkills,
    slotRoleOverride: {
      requested: true,
      applied: true,
      targetSlot: request.targetSlot,
      targetLabel: request.targetLabel,
      skillId: String(target.id || ""),
      skillName: roleName(target),
      originalRole: sourceRole,
      reason: request.reason,
      temporary: true,
      compatible: true,
      message: `已将“${roleName(target)}”临时用于${request.targetLabel}槽位；任务结束后恢复默认路由。`,
    },
  };
  if (request.targetSlot === "writer") result.writerRoleOverride = { ...result.slotRoleOverride };
  return result;
};

// Backward-compatible wrapper used by existing callers.
export const applyExplicitWriterRoleOverride = (runtime = {}, options = {}) => applyExplicitSlotRoleOverride(runtime, options);
export const explicitReviewWriterOverride = explicitWriterRoleOverrideRequest;

export const slotRoleOverrideRunsAtStage = (skill, stage = "") => {
  const targetSlot = skill?.slotRoleOverrideTarget || (skill?.writerRoleOverride ? "writer" : "");
  return Boolean(skill?.slotRoleOverride || skill?.writerRoleOverride)
    && Boolean(SLOT_STAGES[targetSlot]?.has(stage));
};

export const writerRoleOverrideRunsAtStage = slotRoleOverrideRunsAtStage;
