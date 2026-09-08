export const SKILL_CAPABILITY_CATEGORIES = Object.freeze([
  { id: "guidance", label: "创作引导", defaultCapability: "creative_guidance" },
  { id: "planning", label: "规划", defaultCapability: "story_planner" },
  { id: "writer", label: "主笔", defaultCapability: "custom_writer" },
  { id: "review", label: "自检", defaultCapability: "effect_reviewer" },
  { id: "theory", label: "理论顾问", defaultCapability: "theory_advisor" },
  { id: "memory", label: "记忆", defaultCapability: "memory_advisor" },
  { id: "auxiliary", label: "辅助", defaultCapability: "auxiliary_advisor" },
]);

const CATEGORY_IDS = new Set(SKILL_CAPABILITY_CATEGORIES.map((category) => category.id));
const CAPABILITY_CATEGORY = new Map([
  ...["creative_guidance", "novel_guidance", "short_drama_guidance", "public_account_guidance", "short_fiction_guidance", "short_video_guidance", "prompt_guidance"].map((capability) => [capability, "guidance"]),
  ...["story_planner", "setting_planner"].map((capability) => [capability, "planning"]),
  ...["novel_prose_writer", "original_script_writer", "adaptation_writer", "visual_prompt_writer", "public_account_writer", "short_fiction_writer", "short_video_script_writer", "prompt_writer", "custom_writer", "repair_writer"].map((capability) => [capability, "writer"]),
  ...["effect_reviewer", "genre_reviewer", "format_extension"].map((capability) => [capability, "review"]),
  ["theory_advisor", "theory"],
  ["memory_advisor", "memory"],
  ...["auxiliary_advisor", "style_reference", "knowledge_reference", "novel_cover_designer"].map((capability) => [capability, "auxiliary"]),
]);

const normalizedText = (value = "") => String(value ?? "").trim().toLocaleLowerCase("zh-CN");

export const skillCapabilityCategoryId = (capability = "") => CAPABILITY_CATEGORY.get(String(capability)) || "auxiliary";

export const skillCapabilityCategoryIds = (capabilities = []) => {
  const present = new Set((Array.isArray(capabilities) ? capabilities : []).map(skillCapabilityCategoryId));
  return SKILL_CAPABILITY_CATEGORIES.map((category) => category.id).filter((id) => present.has(id));
};
export const skillCapabilityCategoryLabels = (capabilities = []) => {
  const ids = new Set(skillCapabilityCategoryIds(capabilities));
  return SKILL_CAPABILITY_CATEGORIES.filter((category) => ids.has(category.id)).map((category) => category.label);
};

export const inferSkillCapabilityForCategory = (categoryId = "", text = "") => {
  const source = normalizedText(text);
  if (categoryId === "guidance") {
    if (/短剧|剧本/.test(source)) return "short_drama_guidance";
    if (/公众号|推文/.test(source)) return "public_account_guidance";
    if (/短篇小说|微小说/.test(source)) return "short_fiction_guidance";
    if (/短视频/.test(source)) return "short_video_guidance";
    if (/提示词|prompt/.test(source)) return "prompt_guidance";
    if (/小说|正文/.test(source)) return "novel_guidance";
    return "creative_guidance";
  }
  if (categoryId === "planning") {
    return /设定|世界观|角色|人物|地点|势力|体系/.test(source) ? "setting_planner" : "story_planner";
  }
  if (categoryId === "writer") {
    if (/返修|修订|润色|改写/.test(source)) return "repair_writer";
    if (/公众号|推文/.test(source)) return "public_account_writer";
    if (/短篇小说|微小说/.test(source)) return "short_fiction_writer";
    if (/短视频/.test(source)) return "short_video_script_writer";
    if (/视觉提示词|分镜提示词|漫剧提示词|视频提示词|图片提示词/.test(source)) return "visual_prompt_writer";
    if (/提示词|prompt/.test(source)) return "prompt_writer";
    if (/改编|小说改.*剧本|adapt/.test(source)) return "adaptation_writer";
    if (/短剧|剧本/.test(source)) return "original_script_writer";
    if (/小说|正文/.test(source)) return "novel_prose_writer";
    return "custom_writer";
  }
  if (categoryId === "review") {
    if (/格式|模板|规范/.test(source)) return "format_extension";
    if (/题材|类型|品类|genre/.test(source)) return "genre_reviewer";
    return "effect_reviewer";
  }
  if (categoryId === "theory") return "theory_advisor";
  if (categoryId === "memory") return "memory_advisor";
  if (categoryId === "auxiliary") {
    if (/小说封面|网文封面|书封|封面设计|novel.?cover/.test(source)) return "novel_cover_designer";
    if (/文风|风格|style/.test(source)) return "style_reference";
    if (/知识|资料|拆书|参考|knowledge/.test(source)) return "knowledge_reference";
    return "auxiliary_advisor";
  }
  return "auxiliary_advisor";
};

export const resolveSkillCapabilitiesFromCategories = ({ categories = [], existingCapabilities = [], text = "" } = {}) => {
  const selected = [...new Set((Array.isArray(categories) ? categories : []).filter((category) => CATEGORY_IDS.has(category)))];
  const existing = [...new Set((Array.isArray(existingCapabilities) ? existingCapabilities : []).filter(Boolean))];
  return selected.flatMap((categoryId) => {
    const preserved = existing.filter((capability) => skillCapabilityCategoryId(capability) === categoryId);
    return preserved.length ? preserved : [inferSkillCapabilityForCategory(categoryId, text)];
  });
};
