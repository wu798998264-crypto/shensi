const text = (value = "") => String(value ?? "").trim();

export const AGENT_OPERATION_KINDS = Object.freeze({
  SKILL_INSTALL: "skill_install",
  SELF_REPAIR: "self_repair",
});

export const AGENT_OPERATION_IMPACT = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
});

const MODULE_BY_CAPABILITY = Object.freeze({
  auxiliary_advisor: "module:auxiliary-skills",
  knowledge_reference: "module:auxiliary-skills",
  style_reference: "module:auxiliary-skills",
  theory_advisor: "module:auxiliary-skills",
  novel_prose_writer: "module:novel-writer",
  story_planner: "module:novel-planning",
  setting_planner: "module:novel-planning",
  effect_reviewer: "module:novel-review",
  genre_reviewer: "module:novel-review",
  repair_writer: "module:novel-review",
  original_script_writer: "module:original-drama-writer",
  adaptation_writer: "module:adapted-drama-writer",
  short_drama_guidance: "module:short-drama-guidance",
  short_video_script_writer: "module:short-video-writer",
});

const REGISTERED_BINDING_CAPABILITIES = new Set([
  "auxiliary_advisor", "knowledge_reference", "style_reference", "theory_advisor", "novel_prose_writer",
  "story_planner", "setting_planner", "effect_reviewer", "genre_reviewer", "repair_writer",
  "original_script_writer", "adaptation_writer", "short_drama_guidance", "short_video_script_writer",
]);

export const skillTargetModuleForCapabilities = (capabilities = [], source = "") => {
  if (/(?:短剧|短视频|短剧视频|剧本)/i.test(text(source))) {
    for (const capability of Array.isArray(capabilities) ? capabilities : []) {
      if (["effect_reviewer", "genre_reviewer", "repair_writer"].includes(text(capability))) return "module:short-drama-review";
      if (["adaptation_writer"].includes(text(capability))) return "module:adapted-drama-writer";
      if (["original_script_writer"].includes(text(capability))) return "module:original-drama-writer";
      if (["short_drama_guidance"].includes(text(capability))) return "module:short-drama-guidance";
      if (["short_video_script_writer"].includes(text(capability))) return "module:short-video-writer";
    }
  }
  for (const capability of Array.isArray(capabilities) ? capabilities : []) {
    const moduleId = MODULE_BY_CAPABILITY[text(capability)];
    if (moduleId) return moduleId;
  }
  return "module:auxiliary-skills";
};

export const skillPanelBindingCapabilities = (capabilities = []) => (
  [...new Set((Array.isArray(capabilities) ? capabilities : []).map(text).filter((capability) => REGISTERED_BINDING_CAPABILITIES.has(capability)))].slice(0, 24)
);

export const extractConversationSkillText = ({ prompt = "", attachments = [] } = {}) => {
  const attachment = (Array.isArray(attachments) ? attachments : []).find((item) => (
    String(item?.name || "").toLowerCase().endsWith(".md")
      || String(item?.name || "").toLowerCase().endsWith(".skill")
      || /skill|技能|markdown/i.test(String(item?.name || ""))
  )) || (Array.isArray(attachments) ? attachments : []).find((item) => String(item?.mimeType || "").includes("text"));
  const attachmentText = text(attachment?.text);
  if (attachmentText) return { content: attachmentText, sourceName: text(attachment?.name) || "对话附件" };
  const fenced = String(prompt || "").match(/```(?:markdown|md|skill)?\s*([\s\S]*?)```/i)?.[1];
  if (text(fenced)) return { content: text(fenced), sourceName: "对话文本" };
  const marker = String(prompt || "").match(/(?:技能内容|Skill 内容|Skill正文|技能正文)\s*[:：]\s*([\s\S]+)/i)?.[1];
  if (text(marker)) return { content: text(marker), sourceName: "对话文本" };
  if (/^---\s*\r?\n[\s\S]*\b(?:name|id|capabilities|workspace_modes):[\s\S]*\r?\n---(?:\r?\n|$)/im.test(String(prompt || ""))) {
    return { content: text(prompt), sourceName: "对话文本" };
  }
  return { content: "", sourceName: "" };
};

export const createAgentOperationProposal = ({
  kind,
  title,
  objective,
  impact = AGENT_OPERATION_IMPACT.HIGH,
  target = "",
  deliverables = [],
  exclusions = [],
  acceptanceCriteria = [],
  benefits = [],
  risks = [],
  rollback = "保留操作前版本、diff 和可撤销点。",
} = {}) => ({
  schemaVersion: 1,
  taskType: kind,
  objective: text(objective),
  title: text(title) || "Agent 操作确认",
  impact,
  target: text(target),
  deliverables: (Array.isArray(deliverables) ? deliverables : []).map((item) => ({
    kind: text(item?.kind),
    targetDocument: text(item?.targetDocument || item?.target),
    required: item?.required !== false,
    status: "pending",
  })),
  exclusions: (Array.isArray(exclusions) ? exclusions : []).map(text).filter(Boolean),
  acceptanceCriteria: (Array.isArray(acceptanceCriteria) ? acceptanceCriteria : []).map(text).filter(Boolean),
  benefits: (Array.isArray(benefits) ? benefits : []).map(text).filter(Boolean),
  risks: (Array.isArray(risks) ? risks : []).map(text).filter(Boolean),
  rollback: text(rollback),
  completionStatus: "awaiting_confirmation",
});
