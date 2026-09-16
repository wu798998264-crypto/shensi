import { resolveProjectCapabilityPlan } from "./module-registry.js";
import { creativeDeliverableType } from "./request-routing.js";
import { compatibleTriggerDeclaration, normalizeTriggerConditions, normalizeTriggerKeywords, validateTriggerDeclaration } from "./skill-trigger.js";
import { TRUSTED_CORE_CAPABILITY_IDS } from "./capability-registry.js";

export const SKILL_SCHEMA_VERSION = 2;
export const SUPPORTED_SKILL_SCHEMA_VERSIONS = Object.freeze([1, 2]);

export const PROJECT_SKILL_CAPABILITIES = Object.freeze([
  "creative_guidance",
  "novel_guidance",
  "short_drama_guidance",
  "prompt_guidance",
  "story_planner",
  "setting_planner",
  "novel_prose_writer",
  "original_script_writer",
  "adaptation_writer",
  "visual_prompt_writer",
  "theory_advisor",
  "effect_reviewer",
  "strong_story_reviewer",
  "regular_progress_reviewer",
  "genre_reviewer",
  "repair_writer",
  "format_extension",
  "custom_writer",
  "auxiliary_advisor",
  "style_reference",
  "knowledge_reference",
  "memory_advisor",
  "experience_advisor",
  "experience_observer",
  "article_illustration_planner",
  "novel_cover_designer",
]);

export const NOTEBOOK_SKILL_CAPABILITIES = Object.freeze([
  "creative_guidance",
  "public_account_guidance",
  "short_fiction_guidance",
  "short_video_guidance",
  "prompt_guidance",
  "public_account_writer",
  "short_fiction_writer",
  "short_video_script_writer",
  "prompt_writer",
  "custom_writer",
  "theory_advisor",
  "effect_reviewer",
  "strong_story_reviewer",
  "regular_progress_reviewer",
  "genre_reviewer",
  "repair_writer",
  "format_extension",
  "auxiliary_advisor",
  "style_reference",
  "knowledge_reference",
  "memory_advisor",
  "experience_advisor",
  "experience_observer",
  "article_illustration_planner",
  "novel_cover_designer",
]);

export const ALL_SKILL_CAPABILITIES = Object.freeze([...new Set([
  ...PROJECT_SKILL_CAPABILITIES,
  ...NOTEBOOK_SKILL_CAPABILITIES,
])]);

export const TRUSTED_CORE_CAPABILITIES = TRUSTED_CORE_CAPABILITY_IDS;

export const PRIMARY_WRITER_CAPABILITIES = Object.freeze([
  "story_planner",
  "setting_planner",
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

export const REPLACEABLE_SLOT_CAPABILITIES = Object.freeze({
  guidance: ["creative_guidance", "novel_guidance", "short_drama_guidance", "public_account_guidance", "short_fiction_guidance", "short_video_guidance", "prompt_guidance"],
  planning: ["story_planner", "setting_planner"],
  writer: PRIMARY_WRITER_CAPABILITIES,
  theory_advice: ["theory_advisor"],
  effect_review: ["effect_reviewer", "strong_story_reviewer", "regular_progress_reviewer"],
  genre_review: ["genre_reviewer"],
  repair: ["repair_writer"],
  format_extension: ["format_extension"],
  memory_advice: ["memory_advisor"],
  experience_advice: ["experience_advisor"],
  experience_observation: ["experience_observer"],
  artifact_planning: ["article_illustration_planner"],
});

const SEMANTIC_GUIDANCE_CAPABILITIES = Object.freeze({
  novel: "novel_guidance",
  short_fiction: "short_fiction_guidance",
  short_drama_script: "short_drama_guidance",
  short_video_script: "short_video_guidance",
  public_account: "public_account_guidance",
  visual_prompt: "prompt_guidance",
});

const SEMANTIC_WRITER_CAPABILITIES = Object.freeze({
  novel: "novel_prose_writer",
  short_fiction: "short_fiction_writer",
  short_drama_script: "original_script_writer",
  short_video_script: "short_video_script_writer",
  public_account: "public_account_writer",
  visual_prompt: "visual_prompt_writer",
});

const CAPABILITY_SLOT = new Map(Object.entries(REPLACEABLE_SLOT_CAPABILITIES)
  .flatMap(([slot, capabilities]) => capabilities.map((capability) => [capability, slot])));

export const capabilitySlot = (capability) => CAPABILITY_SLOT.get(capability) ?? "advisor";

const VALID_CAPABILITIES = new Set([...PROJECT_SKILL_CAPABILITIES, ...NOTEBOOK_SKILL_CAPABILITIES]);
const VALID_ROLES = new Set(["primary_writer", "guidance", "planner", "reviewer", "repairer", "manager", "auxiliary"]);
const VALID_MODES = new Set(["project", "notebook", "general"]);
const VALID_CONFLICT_POLICIES = new Set(["replace", "stack", "advisory"]);
const ARRAY_FIELDS = new Set(["capabilities", "workspace_modes", "artifact_types", "input_requirements", "stages", "slots", "trigger_keywords", "trigger_conditions"]);

const stripQuotes = (value = "") => String(value).trim().replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_, double, single) => double ?? single ?? "");

export const parseSkillMarkdown = (content = "") => {
  const source = String(content).replace(/^\uFEFF/, "");
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  const metadata = {};
  if (match) {
    let activeArray = "";
    for (const rawLine of match[1].split(/\r?\n/)) {
      if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue;
      const item = rawLine.match(/^\s*-\s+(.+)$/);
      if (item && activeArray) {
        metadata[activeArray].push(stripQuotes(item[1]));
        continue;
      }
      const field = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/);
      if (!field) continue;
      const key = field[1];
      const value = field[2].trim();
      activeArray = ARRAY_FIELDS.has(key) ? key : "";
      if (activeArray) {
        metadata[key] = value
          ? value.replace(/^\[|\]$/g, "").split(",").map(stripQuotes).filter(Boolean)
          : [];
      } else {
        metadata[key] = stripQuotes(value);
      }
    }
  }
  const body = match ? source.slice(match[0].length).trim() : source.trim();
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  return { metadata, body, frontmatter: match?.[1] ?? "", heading };
};

const inferredCapability = (source = "") => {
  const text = String(source);
  if (/公众号|公号文章/.test(text) && /自动配图|插图规划|配图计划/.test(text)) return "article_illustration_planner";
  if (/经验/.test(text) && /观察|沉淀|复盘|提炼/.test(text)) return "experience_observer";
  if (/经验/.test(text) && /读取|召回|顾问|参考/.test(text)) return "experience_advisor";
  if (/公众号|公号文章/.test(text)) return /引导|追问|需求/.test(text) ? "public_account_guidance" : "public_account_writer";
  if (/短视频/.test(text)) return /引导|追问|需求/.test(text) ? "short_video_guidance" : "short_video_script_writer";
  if (/短篇小说|微小说/.test(text)) return /引导|追问|需求/.test(text) ? "short_fiction_guidance" : "short_fiction_writer";
  if (/提示词|分镜|构图|运镜/.test(text)) return /引导|追问|需求/.test(text) ? "prompt_guidance" : "prompt_writer";
  if (/强剧情自检|强剧情审查|强剧情验收/.test(text)) return "strong_story_reviewer";
  if (/常规推进自检|常规推进审查|常规推进验收/.test(text)) return "regular_progress_reviewer";
  if (/自检|审查|验收/.test(text)) return "effect_reviewer";
  if (/理论|顾问|方法论/.test(text)) return "theory_advisor";
  if (/大纲|剧情规划/.test(text)) return "story_planner";
  if (/设定|世界观|角色档案/.test(text)) return "setting_planner";
  if (/小说|正文|章节/.test(text)) return "novel_prose_writer";
  return "auxiliary_advisor";
};

const inferredBoundary = (body = "") => {
  const section = String(body).match(/(?:^|\n)#{1,4}\s*能力边界\s*\n+([\s\S]*?)(?=\n#{1,4}\s|$)/i)?.[1]?.trim();
  if (section) return section.split(/\r?\n/).filter(Boolean).slice(0, 3).join(" ").slice(0, 500);
  return "只在所绑定插槽授权的能力范围内提供创作方法或候选内容，不接管任务路由、资料权限、正史裁决、记忆更新或文件落盘。";
};

export const extractSkillDraft = (content = "") => {
  const parsed = parseSkillMarkdown(content);
  const metadata = parsed.metadata;
  const normalized = normalizeSkillMetadata(metadata, { heading: parsed.heading });
  const explicitCapabilities = normalizedList(metadata.capabilities).filter((item) => VALID_CAPABILITIES.has(item));
  const inferred = inferredCapability(`${parsed.heading}\n${metadata.description || ""}\n${parsed.body}`);
  const title = String(metadata.name || parsed.heading || "").trim();
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48);
  const fingerprint = [...`${title}\n${parsed.body}`].reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 2166136261).toString(36);
  const declaredId = String(metadata.id || "").trim();
  const compatibleTriggers = compatibleTriggerDeclaration({
    triggerKeywords: normalized.triggerKeywords,
    triggerConditions: normalized.triggerConditions,
  });
  const id = /^[a-z0-9][a-z0-9._-]{2,79}$/i.test(declaredId)
    ? declaredId : slug ? `user.${slug}` : `imported.skill-${fingerprint}`;
  const firstParagraph = parsed.body.replace(/^#.+$/m, "").split(/\n\s*\n/).map((item) => item.replace(/^#+\s*/gm, "").trim()).find(Boolean) || "";
  const missingFields = [
    !/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(declaredId) && "id",
    !title && "name",
    !metadata.author && "author",
    !metadata.description && "description",
    !normalizedList(metadata.workspace_modes).length && "workspaceMode",
    !explicitCapabilities.length && "capabilities",
    !metadata.capability_boundary && "capabilityBoundary",
  ].filter(Boolean);
  return {
    draft: {
      id,
      version: normalized.version === "0.0.0" ? "1.0.0" : normalized.version,
      name: title,
      author: String(metadata.author || "").trim(),
      description: String(metadata.description || firstParagraph).trim().slice(0, 300),
      prototypeId: String(metadata.prototype_id || "").trim().slice(0, 160),
      prototypeName: String(metadata.prototype_name || "").trim().slice(0, 160),
      prototypeFingerprint: String(metadata.prototype_fingerprint || "").trim().slice(0, 128),
      derivativeCopy: metadata.derivative_copy === true || String(metadata.derivative_copy || "").toLowerCase() === "true",
      changeSummary: String(metadata.change_summary || "").trim().slice(0, 2_000),
      workspaceModes: normalizedList(metadata.workspace_modes).filter((item) => VALID_MODES.has(item)),
      capabilities: explicitCapabilities.length ? explicitCapabilities : [inferred],
      capabilityBoundary: String(metadata.capability_boundary || inferredBoundary(parsed.body)).trim().slice(0, 500),
      triggerKeywords: compatibleTriggers.keywords,
      triggerConditions: compatibleTriggers.conditions,
      ignoredTriggerKeywords: compatibleTriggers.ignoredKeywords,
      ignoredTriggerConditions: compatibleTriggers.ignoredConditions,
      body: parsed.body,
    },
    missingFields,
    method: "local",
  };
};

const normalizedList = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => String(item ?? "").trim())
  .filter(Boolean))];

export const normalizeSkillMetadata = (metadata = {}, { heading = "", legacyId = "" } = {}) => {
  const capabilities = normalizedList(metadata.capabilities).filter((item) => VALID_CAPABILITIES.has(item));
  const workspaceModes = normalizedList(metadata.workspace_modes).filter((item) => VALID_MODES.has(item));
  const inferredRole = capabilities.some((item) => PRIMARY_WRITER_CAPABILITIES.includes(item)) ? "primary_writer"
    : capabilities.some((item) => REPLACEABLE_SLOT_CAPABILITIES.guidance.includes(item)) ? "guidance"
      : capabilities.some((item) => ["effect_reviewer", "strong_story_reviewer", "regular_progress_reviewer", "genre_reviewer", "format_extension"].includes(item)) ? "reviewer"
      : capabilities.includes("repair_writer") ? "repairer"
          : capabilities.some((item) => ["memory_advisor", "experience_observer", "article_illustration_planner"].includes(item)) ? "manager"
          : "auxiliary";
  const role = VALID_ROLES.has(metadata.role) ? metadata.role : inferredRole;
  const conflictPolicy = VALID_CONFLICT_POLICIES.has(metadata.conflict_policy)
    ? metadata.conflict_policy
    : capabilities.some((item) => ["genre_reviewer", "format_extension"].includes(item)) ? "stack" : "replace";
  return {
    schemaVersion: Number(metadata.schema_version) || 0,
    id: String(metadata.id || legacyId || "").trim(),
    name: String(metadata.name || heading || "未命名 Skill").trim().slice(0, 100),
    version: String(metadata.version || "0.0.0").trim(),
    author: String(metadata.author || "未署名").trim().slice(0, 100),
    description: String(metadata.description || "自定义 Markdown 指令型 Skill").trim().slice(0, 300),
    source: String(metadata.source || "user").trim(),
    prototypeId: String(metadata.prototype_id || "").trim().slice(0, 160),
    prototypeName: String(metadata.prototype_name || "").trim().slice(0, 160),
    prototypeFingerprint: String(metadata.prototype_fingerprint || "").trim().slice(0, 128),
    derivativeCopy: metadata.derivative_copy === true || String(metadata.derivative_copy || "").toLowerCase() === "true",
    upstreamId: String(metadata.upstream_id || "").trim().slice(0, 180),
    upstreamVersion: String(metadata.upstream_version || "").trim().slice(0, 80),
    changeSummary: String(metadata.change_summary || "").trim().slice(0, 2_000),
    capabilityBoundary: String(metadata.capability_boundary || metadata.description || "仅在所绑定插槽授权的能力范围内提供方法，不接管可信内核。").trim().slice(0, 500),
    capabilities,
    declaredCapabilities: normalizedList(metadata.capabilities),
    role,
    workspaceModes: workspaceModes.length ? workspaceModes : ["general"],
    artifactTypes: normalizedList(metadata.artifact_types),
    inputRequirements: normalizedList(metadata.input_requirements),
    outputContract: String(metadata.output_contract || "text_candidate").trim().slice(0, 120),
    stages: normalizedList(metadata.stages),
    slots: normalizedList(metadata.slots).length ? normalizedList(metadata.slots) : normalizedList(capabilities.map(capabilitySlot)),
    conflictPolicy,
    fallback: String(metadata.fallback || "builtin").trim() === "block" ? "block" : "builtin",
    triggerKeywords: normalizeTriggerKeywords(metadata.trigger_keywords),
    triggerConditions: normalizeTriggerConditions(metadata.trigger_conditions),
  };
};

export const validateSkillMetadata = (skill = {}) => {
  const errors = [];
  if (!SUPPORTED_SKILL_SCHEMA_VERSIONS.includes(skill.schemaVersion)) errors.push(`schema_version 必须为 ${SUPPORTED_SKILL_SCHEMA_VERSIONS.join(" 或 ")}`);
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/i.test(skill.id)) errors.push("Skill ID 需为 3-80 位字母、数字、点、下划线或连字符");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(skill.version)) errors.push("version 必须使用语义化版本，例如 1.0.0");
  if (!skill.name || skill.name === "未命名 Skill") errors.push("缺少 Skill 名称");
  if (!skill.description) errors.push("缺少用途说明");
  if (!skill.capabilityBoundary) errors.push("缺少能力边界");
  if (!skill.capabilities.length) errors.push("未声明可识别的合法能力，只能作为未授权参考保存");
  errors.push(...validateTriggerDeclaration({ triggerKeywords: skill.triggerKeywords, triggerConditions: skill.triggerConditions }).errors);
  return { valid: errors.filter((item) => !item.startsWith("未声明")).length === 0, errors };
};

export const allowedSkillCapabilities = (workspaceMode = "project") => workspaceMode === "general"
  ? [...new Set([...PROJECT_SKILL_CAPABILITIES, ...NOTEBOOK_SKILL_CAPABILITIES])]
  : workspaceMode === "notebook" ? [...NOTEBOOK_SKILL_CAPABILITIES] : [...PROJECT_SKILL_CAPABILITIES];

export const skillSupportsWorkspace = (skill = {}, workspaceMode = "project") => {
  const modes = skill.workspaceModes?.length ? skill.workspaceModes : ["general"];
  return modes.includes("general") || modes.includes(workspaceMode);
};

export const resolveRequiredCapabilities = ({
  workspaceMode = "project",
  activeModule = "manuscript",
  prompt = "",
  requestMode = "creative",
  contextDomain = "novel",
  targetDocumentId = "",
  sourceMode = "",
  deliverableType: semanticDeliverableType = "",
  semanticCapabilities = [],
  semanticCapabilitiesAuthoritative = false,
} = {}) => {
  const source = String(prompt);
  const semanticDeliverableTypes = new Set(["novel", "short_fiction", "short_drama_script", "short_video_script", "public_account", "visual_prompt", "document", "report"]);
  const hasSemanticDeliverableType = semanticDeliverableTypes.has(semanticDeliverableType);
  // Output mode is authoritative.  Source modules (short-video script,
  // public-account article, novel, drama...) contribute context but must not
  // replace the writer required by the requested final asset.
  const deliverableType = requestMode === "visual_prompt"
    ? "visual_prompt"
    : hasSemanticDeliverableType
      ? semanticDeliverableType
      : creativeDeliverableType({ text: source, targetDocumentId });
  const required = new Set(["task_routing", "reference_routing", "live_route_compilation", "context_compilation", "security_review", "format_validation", "structured_landing", "version_backup"]);
  const declaredSemanticCapabilities = [...new Set((Array.isArray(semanticCapabilities) ? semanticCapabilities : [])
    .map((capability) => String(capability || "").trim())
    .filter((capability) => ALL_SKILL_CAPABILITIES.includes(capability)))];
  if (semanticCapabilitiesAuthoritative) {
    // The Agent's structured mode and deliverable are semantic decisions too.
    // They must still select the corresponding capability when the model only
    // provides a natural-language skill query. This branch remains
    // authoritative because it never scans the raw user prompt.
    if (requestMode === "creative_guidance") required.add("guidance_control");
    if (requestMode === "creative_guidance") required.add("experience_advisor");
    const classifiedCapability = requestMode === "creative_guidance"
      ? SEMANTIC_GUIDANCE_CAPABILITIES[deliverableType]
      : SEMANTIC_WRITER_CAPABILITIES[deliverableType];
    if (classifiedCapability) required.add(classifiedCapability);
    return [...new Set([...required, ...declaredSemanticCapabilities])];
  }
  if (requestMode === "general") return [...required];
  if (requestMode === "creative_guidance") {
    required.add("guidance_control");
    required.add("experience_advisor");
    const semanticGuidanceCapability = SEMANTIC_GUIDANCE_CAPABILITIES[deliverableType];
    if (hasSemanticDeliverableType) {
      if (semanticGuidanceCapability) required.add(semanticGuidanceCapability);
    } else if (/提示词|prompt|分镜|视觉资产|图片资产|全景调度|站位/i.test(source) || targetDocumentId.startsWith("prompt-")) required.add("prompt_guidance");
    else if (deliverableType === "short_drama_script" || ["script", "script-adaptation"].includes(contextDomain) || /短剧|漫剧/.test(source) || (/剧本/.test(source) && !/短视频/.test(source))) required.add("short_drama_guidance");
    else if (deliverableType === "public_account") required.add("public_account_guidance");
    else if (deliverableType === "short_fiction") required.add("short_fiction_guidance");
    else if (deliverableType === "short_video_script") required.add("short_video_guidance");
    else required.add("novel_guidance");
    return [...required];
  }
  if (workspaceMode === "project") {
    const planCapabilities = resolveProjectCapabilityPlan({ activeModule, prompt: source, requestMode, contextDomain, targetDocumentId, sourceMode }).capabilities;
    if (!hasSemanticDeliverableType || !SEMANTIC_WRITER_CAPABILITIES[deliverableType]) return planCapabilities;
    const semanticWriter = SEMANTIC_WRITER_CAPABILITIES[deliverableType];
    return [...new Set([
      ...planCapabilities.filter((capability) => !PRIMARY_WRITER_CAPABILITIES.includes(capability)),
      semanticWriter,
    ])];
  }
  if (hasSemanticDeliverableType) {
    if (SEMANTIC_WRITER_CAPABILITIES[deliverableType]) required.add(SEMANTIC_WRITER_CAPABILITIES[deliverableType]);
    else required.add("auxiliary_advisor");
  } else if (deliverableType === "public_account") required.add("public_account_writer");
  else if (deliverableType === "short_fiction") required.add("short_fiction_writer");
  else if (deliverableType === "short_video_script") required.add("short_video_script_writer");
  else if (deliverableType === "visual_prompt") required.add("visual_prompt_writer");
  else if (/提示词|prompt/i.test(source)) required.add("prompt_writer");
  else required.add("auxiliary_advisor");
  if (["public_account_writer", "short_fiction_writer", "short_video_script_writer"].some((item) => required.has(item))) {
    required.add("theory_advisor");
    if (/自检|检查|审查|验收|复核|校对|质量评估|质量检查/u.test(source)
      && !/(?:不要|无需|不用|不必|禁止|跳过|取消|先不|暂不)[^。！？；\n]{0,12}(?:自检|检查|审查|验收|复核|校对)/u.test(source)) required.add("effect_reviewer");
  }
  if (deliverableType === "public_account" && /正文配图|自动配图|文章配图|公众号配图|插图(?:规划|建议)?|shot\s*list|小黑(?:配图|风格)?/i.test(source)) {
    required.add("article_illustration_planner");
  }
  required.add("experience_advisor");
  required.add("experience_observer");
  return [...required];
};

export const negotiateSkillCapabilities = ({
  requiredCapabilities = [],
  skill = null,
  workspaceMode = "project",
  authorizedCapabilities = null,
  attemptedCapabilities = [],
} = {}) => {
  const required = new Set(requiredCapabilities);
  const allowed = new Set(allowedSkillCapabilities(workspaceMode));
  const declared = new Set(skill?.capabilities ?? []);
  const explicitAuthorization = new Set(authorizedCapabilities ?? [...declared]);
  const authorized = [...required].filter((item) => declared.has(item) && allowed.has(item) && explicitAuthorization.has(item));
  const fallback = [...required].filter((item) => !authorized.includes(item));
  const blocked = [...new Set([...(skill?.declaredCapabilities ?? []), ...attemptedCapabilities])]
    .filter((item) => !allowed.has(item) || !explicitAuthorization.has(item));
  return { authorizedCapabilities: authorized, builtinFallbackCapabilities: fallback, blockedCapabilities: blocked };
};

export const skillHasPrimaryCapability = (skill = {}, workspaceMode = "project") => {
  const allowed = new Set(allowedSkillCapabilities(workspaceMode));
  return (skill.capabilities ?? []).some((item) => allowed.has(item) && PRIMARY_WRITER_CAPABILITIES.includes(item));
};
