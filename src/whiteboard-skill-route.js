import { classifyRequestMode, creativeDeliverableType } from "./request-routing.js";
import { CREATIVE_GUIDANCE_CAPABILITIES } from "./skill-reference.js";
import {
  normalizeSemanticSkillCapabilities,
  semanticSkillRouteMetadata,
  skillSelectionMatchesSemanticCapabilities,
} from "./semantic-skill-route.js";

const NOTEBOOK_DELIVERABLES = new Set(["short_fiction", "public_account", "short_video_script"]);
const PROJECT_DELIVERABLES = new Set(["novel", "short_drama_script"]);
const GUIDANCE_CAPABILITIES = new Set(CREATIVE_GUIDANCE_CAPABILITIES);
const MANUAL_ACTIVATION_SOURCES = new Set(["explicit", "whiteboard_explicit"]);

const list = (value) => Array.isArray(value) ? value : [];
const uniqueStrings = (values = []) => [...new Set(list(values).map(String).filter(Boolean))];
const selectionCapabilities = (skill = {}) => uniqueStrings(
  skill.authorizedCapabilities?.length
    ? skill.authorizedCapabilities
    : skill.selectionAuthorizedCapabilities?.length
      ? skill.selectionAuthorizedCapabilities
      : skill.capabilities,
);
const skillIdentity = (skill = {}) => `${skill.id || skill.relativePath || ""}::${skill.slotId || ""}`;
const normalizedGroupPath = (value = []) => list(value).map((entry) => (
  entry && typeof entry === "object" ? String(entry.name || entry.id || "") : String(entry)
)).filter(Boolean).slice(0, 20);

export const planWhiteboardSkillRoute = ({
  prompt = "",
  workspaceKind = "project",
  hasResources = false,
  forceGuidance = false,
  skillCapabilities = null,
  semanticCapabilities = null,
  semanticCapabilitiesAuthoritative = null,
  agentDecision = null,
} = {}) => {
  const text = String(prompt).trim();
  const structuredDecision = agentDecision
    && ["guided_dialogue", "task_execution"].includes(agentDecision.lane)
    ? agentDecision
    : null;
  const structuredCapabilities = skillCapabilities ?? semanticCapabilities;
  const normalizedCapabilities = normalizeSemanticSkillCapabilities(structuredCapabilities);
  const hasSemanticCapabilityInput = Array.isArray(structuredCapabilities);
  const semanticCapabilityAuthority = Boolean(structuredDecision) || semanticCapabilitiesAuthoritative === true
    || (semanticCapabilitiesAuthoritative !== false && hasSemanticCapabilityInput);
  const semanticMetadata = semanticCapabilityAuthority && normalizedCapabilities.length
    ? semanticSkillRouteMetadata(normalizedCapabilities)
    : null;
  const route = structuredDecision
    ? {
        mode: structuredDecision.requestMode || (structuredDecision.lane === "guided_dialogue" ? "creative_guidance" : "general"),
        reason: `统一 Agent 决策：${String(structuredDecision.objective || structuredDecision.requestMode || "当前任务")}`,
        shensiLed: structuredDecision.taskKind === "quality_review"
          || ["creative_guidance", "creative", "quick_revision", "visual_prompt"].includes(structuredDecision.requestMode),
        ...(structuredDecision.deliverableType ? { deliverableType: structuredDecision.deliverableType } : {}),
      }
    : semanticCapabilityAuthority && !semanticMetadata
    ? {
        mode: "general",
        reason: "Agent 未声明可自动启用的文字能力；等待明确的 Agent 决策或手动 Skill",
        shensiLed: false,
      }
    : semanticMetadata
    ? {
        mode: semanticMetadata.requestMode,
        reason: `Agent 已声明结构化能力：${normalizedCapabilities.join("、")}`,
        shensiLed: semanticMetadata.requestMode !== "general",
        ...(semanticMetadata.deliverableType ? { deliverableType: semanticMetadata.deliverableType } : {}),
      }
    : classifyRequestMode({
        text,
        workspaceKind: workspaceKind === "notebook" ? "notebook" : "project",
        targetModuleId: "library",
        hasResources: hasResources === true,
      });
  const deliverableType = structuredDecision?.deliverableType
    || semanticMetadata?.deliverableType
    || (structuredDecision || semanticMetadata ? "" : route.deliverableType || creativeDeliverableType({ text }));
  const workspaceMode = NOTEBOOK_DELIVERABLES.has(deliverableType)
    ? "notebook"
    : PROJECT_DELIVERABLES.has(deliverableType)
      ? "project"
      : workspaceKind === "notebook" ? "notebook" : "project";
  const contextDomain = structuredDecision
    ? structuredDecision.sourceMode === "adaptation"
      ? "script-adaptation"
      : deliverableType === "short_drama_script"
        ? "script"
        : ["novel", "short_fiction"].includes(deliverableType) ? "novel" : "general"
    : semanticMetadata?.contextDomain
    || (semanticMetadata
      ? "general"
      : deliverableType === "short_drama_script"
        ? /改编|小说改|原著|章节/.test(text) ? "script-adaptation" : "script"
        : ["novel", "short_fiction"].includes(deliverableType) ? "novel" : "general");
  const activeModule = structuredDecision
    ? normalizedCapabilities.includes("setting_planner")
      ? "canon"
      : normalizedCapabilities.includes("story_planner")
        ? "outline"
        : route.shensiLed ? "manuscript" : "library"
    : semanticMetadata?.activeModule
    || (semanticMetadata
      ? (route.shensiLed ? "manuscript" : "library")
      : /设定|人物小传|世界观|力量体系/.test(text)
        ? "canon"
        : /大纲|章纲|分集规划|故事规划/.test(text)
          ? "outline"
          : route.shensiLed ? "manuscript" : "library");
  return {
    ...route,
    deliverableType,
    workspaceMode,
    contextDomain,
    activeModule,
    inferredMode: route.mode,
    requestMode: forceGuidance ? "creative_guidance" : route.mode,
    guidanceRequired: (forceGuidance ? "creative_guidance" : route.mode) === "creative_guidance",
    ...(hasSemanticCapabilityInput ? { skillCapabilities: normalizedCapabilities } : {}),
    ...(semanticCapabilityAuthority ? { semanticCapabilitiesAuthoritative: true } : {}),
  };
};

export const activeWhiteboardSkillRuntimeSkills = (runtime = {}) => {
  const slots = runtime.slotSkills ?? {};
  const ordered = [
    slots.guidance,
    slots.planning,
    slots.writer,
    ...list(slots.theoryAdvisors),
    slots.theoryAdvice,
    slots.effectReview,
    ...list(slots.genreReviews),
    slots.repair,
    ...list(slots.formatExtensions),
    slots.memoryAdvice,
    ...list(runtime.auxiliarySkills),
  ].filter(Boolean);
  const seen = new Set();
  return ordered.filter((skill) => {
    const identity = skillIdentity(skill);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

const materializedSelection = (skill = {}, source = "") => {
  const id = String(skill.id || skill.relativePath || "");
  if (!id) return null;
  const capabilities = selectionCapabilities(skill);
  return {
    id,
    relativePath: id,
    name: String(skill.name || skill.slotName || id),
    requestedRole: skill.requestedRole || "auto",
    source: String(source || skill.activationSource || skill.source || "capability_template"),
    authorizedCapabilities: capabilities,
    autoRouted: true,
    ...(skill.slotId ? { slotId: String(skill.slotId) } : {}),
    ...(skill.slotName ? { slotName: String(skill.slotName) } : {}),
    ...(skill.parentGroupId ? { parentGroupId: String(skill.parentGroupId) } : {}),
    ...(normalizedGroupPath(skill.groupPath).length ? { groupPath: normalizedGroupPath(skill.groupPath) } : {}),
    ...(Number(skill.routePriority) ? { routePriority: Number(skill.routePriority) } : {}),
    ...(skill.capabilityBoundary ? { capabilityBoundary: String(skill.capabilityBoundary).slice(0, 500) } : {}),
    ...(skill.organizationGroupId ? { organizationGroupId: String(skill.organizationGroupId) } : {}),
    ...(skill.organizationRole ? { organizationRole: String(skill.organizationRole) } : {}),
  };
};

export const whiteboardAutoSkillSelections = ({
  runtime = {},
  activatedSelections = [],
  guidanceOnly = false,
  limit = 12,
  skillCapabilities = null,
  semanticCapabilities = null,
  semanticCapabilitiesAuthoritative = null,
} = {}) => {
  const fallbackCapabilities = new Set(list(runtime.builtinFallbackCapabilities));
  const structuredCapabilities = skillCapabilities ?? semanticCapabilities;
  const normalizedCapabilities = normalizeSemanticSkillCapabilities(structuredCapabilities);
  const hasSemanticCapabilityInput = Array.isArray(structuredCapabilities);
  const filterBySemanticCapabilities = semanticCapabilitiesAuthoritative === true
    || (semanticCapabilitiesAuthoritative !== false && hasSemanticCapabilityInput);
  if (filterBySemanticCapabilities && !normalizedCapabilities.length) return [];
  const routed = activeWhiteboardSkillRuntimeSkills(runtime)
    .filter((skill) => !MANUAL_ACTIVATION_SOURCES.has(String(skill.activationSource || "")))
    .filter((skill) => !filterBySemanticCapabilities || skillSelectionMatchesSemanticCapabilities(skill, normalizedCapabilities))
    .map((skill) => materializedSelection(skill))
    .filter(Boolean);
  const builtins = list(activatedSelections)
    .filter((selection) => String(selection?.id || "").startsWith("builtin:"))
    .filter((selection) => selectionCapabilities(selection).some((capability) => fallbackCapabilities.has(capability)))
    .filter((selection) => !filterBySemanticCapabilities || skillSelectionMatchesSemanticCapabilities(selection, normalizedCapabilities))
    .map((selection) => materializedSelection(selection, "capability_template"))
    .filter(Boolean);
  const unique = new Map();
  for (const selection of [...routed, ...builtins]) {
    if (guidanceOnly && !selection.authorizedCapabilities.some((capability) => GUIDANCE_CAPABILITIES.has(capability))) continue;
    if (!unique.has(selection.id)) unique.set(selection.id, selection);
  }
  return [...unique.values()].slice(0, Math.max(1, Number(limit) || 12));
};

export const whiteboardSkillSelectionIsGuidance = (selection = {}) => (
  selectionCapabilities(selection).some((capability) => GUIDANCE_CAPABILITIES.has(capability))
);
