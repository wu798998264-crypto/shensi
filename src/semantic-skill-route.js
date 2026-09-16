import { ALL_SKILL_CAPABILITIES } from "./skill-contract.js";

const KNOWN_CAPABILITIES = new Set(ALL_SKILL_CAPABILITIES);

const CAPABILITY_ROUTE_METADATA = Object.freeze({
  novel_guidance: { requestMode: "creative_guidance", deliverableType: "novel", contextDomain: "novel", activeModule: "manuscript" },
  short_fiction_guidance: { requestMode: "creative_guidance", deliverableType: "short_fiction", contextDomain: "novel", activeModule: "manuscript" },
  short_drama_guidance: { requestMode: "creative_guidance", deliverableType: "short_drama_script", contextDomain: "script", activeModule: "manuscript" },
  short_video_guidance: { requestMode: "creative_guidance", deliverableType: "short_video_script", contextDomain: "general", activeModule: "manuscript" },
  public_account_guidance: { requestMode: "creative_guidance", deliverableType: "public_account", contextDomain: "general", activeModule: "manuscript" },
  prompt_guidance: { requestMode: "creative_guidance", deliverableType: "visual_prompt", contextDomain: "general", activeModule: "library" },
  novel_prose_writer: { requestMode: "creative", deliverableType: "novel", contextDomain: "novel", activeModule: "manuscript" },
  short_fiction_writer: { requestMode: "creative", deliverableType: "short_fiction", contextDomain: "novel", activeModule: "manuscript" },
  original_script_writer: { requestMode: "creative", deliverableType: "short_drama_script", contextDomain: "script", activeModule: "manuscript" },
  adaptation_writer: { requestMode: "creative", deliverableType: "short_drama_script", contextDomain: "script-adaptation", activeModule: "manuscript", sourceMode: "adaptation" },
  short_video_script_writer: { requestMode: "creative", deliverableType: "short_video_script", contextDomain: "general", activeModule: "manuscript" },
  public_account_writer: { requestMode: "creative", deliverableType: "public_account", contextDomain: "general", activeModule: "manuscript" },
  visual_prompt_writer: { requestMode: "visual_prompt", deliverableType: "visual_prompt", contextDomain: "general", activeModule: "library" },
  prompt_writer: { requestMode: "visual_prompt", deliverableType: "visual_prompt", contextDomain: "general", activeModule: "library" },
  story_planner: { requestMode: "creative", activeModule: "outline", contextDomain: "novel" },
  setting_planner: { requestMode: "creative", activeModule: "canon", contextDomain: "novel" },
  memory_advisor: { requestMode: "creative", activeModule: "memory", contextDomain: "novel" },
  effect_reviewer: { requestMode: "creative", activeModule: "reports", contextDomain: "novel" },
  strong_story_reviewer: { requestMode: "creative", activeModule: "reports", contextDomain: "novel" },
  regular_progress_reviewer: { requestMode: "creative", activeModule: "reports", contextDomain: "novel" },
  genre_reviewer: { requestMode: "creative", activeModule: "reports", contextDomain: "novel" },
  repair_writer: { requestMode: "creative", activeModule: "manuscript", contextDomain: "novel" },
  format_extension: { requestMode: "creative", activeModule: "reports", contextDomain: "novel" },
  creative_guidance: { requestMode: "creative_guidance" },
  theory_advisor: { requestMode: "creative", activeModule: "manuscript", contextDomain: "novel" },
  auxiliary_advisor: { requestMode: "creative", activeModule: "manuscript", contextDomain: "novel" },
  style_reference: { requestMode: "creative", activeModule: "manuscript", contextDomain: "novel" },
  knowledge_reference: { requestMode: "creative", activeModule: "manuscript", contextDomain: "novel" },
  experience_advisor: { requestMode: "creative", activeModule: "manuscript", contextDomain: "novel" },
  experience_observer: { requestMode: "creative", activeModule: "reports", contextDomain: "novel" },
  article_illustration_planner: { requestMode: "creative", activeModule: "manuscript", contextDomain: "general" },
  novel_cover_designer: { requestMode: "visual_prompt", deliverableType: "visual_prompt", contextDomain: "general", activeModule: "library" },
  custom_writer: { requestMode: "creative", activeModule: "manuscript", contextDomain: "novel" },
});

const uniqueStrings = (values = []) => [...new Set(
  (Array.isArray(values) ? values : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean),
)];

export const normalizeSemanticSkillCapabilities = (value = []) => uniqueStrings(value)
  .filter((capability) => KNOWN_CAPABILITIES.has(capability))
  .slice(0, 16);

const capabilityPriority = (capability = "") => {
  const metadata = CAPABILITY_ROUTE_METADATA[capability];
  if (!metadata) return 0;
  if (metadata.requestMode === "creative_guidance") return 100;
  if (metadata.requestMode === "visual_prompt") return 90;
  if (metadata.deliverableType) return 80;
  if (["story_planner", "setting_planner"].includes(capability)) return 70;
  return 20;
};

export const semanticSkillRouteMetadata = (value = []) => {
  const capabilities = normalizeSemanticSkillCapabilities(value);
  const selected = [...capabilities]
    .sort((left, right) => capabilityPriority(right) - capabilityPriority(left))
    .map((capability) => ({ capability, metadata: CAPABILITY_ROUTE_METADATA[capability] }))
    .find((entry) => entry.metadata);
  if (!selected) return null;
  const metadata = selected.metadata;
  return {
    ...metadata,
    capability: selected.capability,
    capabilities,
    semanticCapabilitiesAuthoritative: true,
  };
};

export const skillSelectionMatchesSemanticCapabilities = (selection = {}, requestedCapabilities = []) => {
  const requested = new Set(normalizeSemanticSkillCapabilities(requestedCapabilities));
  if (!requested.size) return true;
  const available = uniqueStrings(
    selection.authorizedCapabilities
      ?? selection.selectionAuthorizedCapabilities
      ?? selection.capabilities
      ?? [],
  );
  return available.some((capability) => requested.has(capability));
};
