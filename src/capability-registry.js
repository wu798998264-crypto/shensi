export const CAPABILITY_DESCRIPTOR_SCHEMA_VERSION = 1;

export const CAPABILITY_PHASES = Object.freeze(["prewrite", "produce", "postwrite"]);

const descriptor = ({
  capabilityId,
  kind,
  phases,
  stages,
  stackPolicy = "stack",
  exclusiveKey = "",
  stackKey = "",
  budgetClass = "advisor",
  inputContract = "task_context_v1",
  outputContract = "text_advice_v1",
  authority = "skill",
  trustedAction = "",
  autoEligible = false,
} = {}) => Object.freeze({
  capabilityId,
  kind,
  phases: Object.freeze([...phases]),
  stages: Object.freeze([...stages]),
  stackPolicy,
  exclusiveKey,
  stackKey,
  budgetClass,
  inputContract,
  outputContract,
  authority,
  trustedAction,
  autoEligible,
});

const ALL_STAGES = Object.freeze(["*"]);
const PREWRITE_STAGES = Object.freeze(["planning", "response"]);
const WRITER_STAGES = Object.freeze(["creative", "response", "revision", "quick-revision", "visual-generation", "visual-revision"]);
const THEORY_STAGES = Object.freeze(["planning", "response", "creative", "revision", "theory-support"]);
const REVIEW_STAGES = Object.freeze(["evaluation", "combined-check", "audit", "audit-final", "drama-development-check"]);

const TRUSTED_CORE_IDS = Object.freeze([
  "task_routing",
  "reference_routing",
  "live_route_compilation",
  "guidance_control",
  "context_compilation",
  "continuity_gate",
  "format_validation",
  "memory_update",
  "structured_landing",
  "security_review",
  "version_backup",
  "canon_write",
  "index_update",
]);

const GUIDANCE_IDS = Object.freeze([
  "creative_guidance",
  "novel_guidance",
  "short_drama_guidance",
  "public_account_guidance",
  "short_fiction_guidance",
  "short_video_guidance",
  "prompt_guidance",
]);

const WRITER_IDS = Object.freeze([
  "novel_prose_writer",
  "original_script_writer",
  "adaptation_writer",
  "short_fiction_writer",
  "public_account_writer",
  "short_video_script_writer",
  "visual_prompt_writer",
  "prompt_writer",
  "custom_writer",
]);

const entries = [
  ...TRUSTED_CORE_IDS.map((capabilityId) => descriptor({
    capabilityId,
    kind: "trusted_core",
    phases: CAPABILITY_PHASES,
    stages: ALL_STAGES,
    stackPolicy: "trusted",
    budgetClass: "trusted_core",
    authority: "trusted-core",
    outputContract: "trusted_core_result_v1",
  })),
  ...GUIDANCE_IDS.map((capabilityId) => descriptor({
    capabilityId,
    kind: "guidance",
    phases: ["prewrite"],
    stages: PREWRITE_STAGES,
    stackPolicy: "exclusive",
    exclusiveKey: "creative_guidance",
    budgetClass: "guidance",
    outputContract: "creative_brief_v1",
  })),
  descriptor({ capabilityId: "story_planner", kind: "planner", phases: ["prewrite"], stages: PREWRITE_STAGES, stackPolicy: "exclusive", exclusiveKey: "story_planner", budgetClass: "planner", outputContract: "story_plan_v1" }),
  descriptor({ capabilityId: "setting_planner", kind: "planner", phases: ["prewrite"], stages: PREWRITE_STAGES, stackPolicy: "exclusive", exclusiveKey: "setting_planner", budgetClass: "planner", outputContract: "setting_plan_v1" }),
  ...WRITER_IDS.map((capabilityId) => descriptor({
    capabilityId,
    kind: "primary_writer",
    phases: ["produce"],
    stages: WRITER_STAGES,
    stackPolicy: "exclusive",
    exclusiveKey: "primary_writer",
    budgetClass: "writer",
    outputContract: "primary_artifact_v1",
  })),
  descriptor({ capabilityId: "theory_advisor", kind: "advisor", phases: CAPABILITY_PHASES, stages: THEORY_STAGES, stackPolicy: "stack", stackKey: "theory_advisor", budgetClass: "advisor", autoEligible: true }),
  // `effect_reviewer` remains the compatibility capability used by older
  // saved decisions and user Skills. New routing can select the two explicit
  // novel review modes without collapsing them into one generic reviewer.
  descriptor({ capabilityId: "effect_reviewer", kind: "reviewer", phases: ["postwrite"], stages: REVIEW_STAGES, stackPolicy: "exclusive", exclusiveKey: "effect_reviewer", budgetClass: "reviewer", inputContract: "artifact_candidate_v1", outputContract: "effect_review_v1" }),
  descriptor({ capabilityId: "strong_story_reviewer", kind: "reviewer", phases: ["postwrite"], stages: REVIEW_STAGES, stackPolicy: "exclusive", exclusiveKey: "strong_story_reviewer", budgetClass: "reviewer", inputContract: "artifact_candidate_v1", outputContract: "strong_story_review_v1" }),
  descriptor({ capabilityId: "regular_progress_reviewer", kind: "reviewer", phases: ["postwrite"], stages: REVIEW_STAGES, stackPolicy: "exclusive", exclusiveKey: "regular_progress_reviewer", budgetClass: "reviewer", inputContract: "artifact_candidate_v1", outputContract: "regular_progress_review_v1" }),
  descriptor({ capabilityId: "genre_reviewer", kind: "reviewer", phases: ["postwrite"], stages: REVIEW_STAGES, stackPolicy: "stack", stackKey: "genre_reviewer", budgetClass: "reviewer", inputContract: "artifact_candidate_v1", outputContract: "genre_review_v1", autoEligible: true }),
  descriptor({ capabilityId: "repair_writer", kind: "repairer", phases: ["postwrite"], stages: ["revision"], stackPolicy: "exclusive", exclusiveKey: "repair_writer", budgetClass: "writer", inputContract: "repair_findings_v1", outputContract: "repaired_artifact_v1" }),
  descriptor({ capabilityId: "format_extension", kind: "format_extension", phases: ["postwrite"], stages: REVIEW_STAGES, stackPolicy: "stack", stackKey: "format_extension", budgetClass: "format", inputContract: "artifact_candidate_v1", outputContract: "format_findings_v1", autoEligible: true }),
  descriptor({ capabilityId: "memory_advisor", kind: "memory_advisor", phases: ["postwrite"], stages: ["response", "evaluation", "combined-check", "memory-check", "audit", "audit-final"], stackPolicy: "exclusive", exclusiveKey: "memory_advisor", budgetClass: "memory", inputContract: "artifact_and_memory_context_v1", outputContract: "memory_advice_v1", autoEligible: true }),
  descriptor({ capabilityId: "auxiliary_advisor", kind: "advisor", phases: ["prewrite", "produce"], stages: ["planning", "response", "creative", "revision", "quick-revision", "visual-generation", "visual-revision"], stackPolicy: "stack", stackKey: "auxiliary_advisor", budgetClass: "advisor", autoEligible: true }),
  descriptor({ capabilityId: "novel_cover_designer", kind: "artifact_planner", phases: ["prewrite", "produce", "postwrite"], stages: ["planning", "response", "visual-generation", "visual-revision"], stackPolicy: "stack", stackKey: "novel_cover_designer", budgetClass: "artifact", inputContract: "novel_cover_brief_v1", outputContract: "novel_cover_plan_v1", autoEligible: true }),
  descriptor({ capabilityId: "style_reference", kind: "reference", phases: ["prewrite", "produce"], stages: ["planning", "response", "creative", "revision", "quick-revision", "visual-generation", "visual-revision"], stackPolicy: "stack", stackKey: "style_reference", budgetClass: "advisor", inputContract: "authorized_style_sources_v1", autoEligible: true }),
  descriptor({ capabilityId: "knowledge_reference", kind: "reference", phases: ["prewrite", "produce"], stages: ["planning", "response", "creative", "revision"], stackPolicy: "stack", stackKey: "knowledge_reference", budgetClass: "advisor", inputContract: "authorized_reference_sources_v1", autoEligible: true }),
  descriptor({ capabilityId: "market_research", kind: "reference", phases: ["prewrite", "produce"], stages: ["planning", "response"], stackPolicy: "stack", stackKey: "market_research", budgetClass: "advisor", inputContract: "authorized_market_sources_v1", outputContract: "market_research_report_v1", autoEligible: true }),
  descriptor({ capabilityId: "ranking_scan", kind: "reference", phases: ["prewrite", "produce"], stages: ["planning", "response"], stackPolicy: "stack", stackKey: "ranking_scan", budgetClass: "advisor", inputContract: "authorized_market_sources_v1", outputContract: "ranking_scan_report_v1", autoEligible: true }),
  descriptor({ capabilityId: "experience_advisor", kind: "experience_advisor", phases: ["prewrite"], stages: ["planning", "response", "creative"], stackPolicy: "stack", stackKey: "experience_advisor", budgetClass: "experience", inputContract: "kernel_experience_recall_v1", outputContract: "experience_advice_v1", autoEligible: true }),
  descriptor({ capabilityId: "experience_observer", kind: "experience_observer", phases: ["postwrite"], stages: ["evaluation", "combined-check", "memory-check", "audit-final", "experience-observation"], stackPolicy: "stack", stackKey: "experience_observer", budgetClass: "experience", inputContract: "artifact_and_feedback_v1", outputContract: "experience_candidate_v2", trustedAction: "submit_experience_candidate", autoEligible: true }),
  descriptor({ capabilityId: "article_illustration_planner", kind: "artifact_planner", phases: ["postwrite"], stages: ["response", "artifact-planning"], stackPolicy: "stack", stackKey: "article_illustration_planner", budgetClass: "artifact", inputContract: "article_and_style_context", outputContract: "illustration_plan_v1", trustedAction: "enqueue_image_generation", autoEligible: true }),
  descriptor({ capabilityId: "image_asset_producer", kind: "artifact_producer", phases: ["postwrite"], stages: ["trusted-action"], stackPolicy: "trusted", budgetClass: "trusted_action", inputContract: "illustration_plan_v1", outputContract: "generated_image_assets_v1", authority: "trusted-core", trustedAction: "enqueue_image_generation" }),
  descriptor({ capabilityId: "artifact_inserter", kind: "artifact_inserter", phases: ["postwrite"], stages: ["trusted-action"], stackPolicy: "trusted", budgetClass: "trusted_action", inputContract: "generated_image_assets_v1", outputContract: "anchored_artifact_patch_v1", authority: "trusted-core", trustedAction: "insert_artifact_at_anchor" }),
];

export const CAPABILITY_DESCRIPTOR_REGISTRY = Object.freeze(Object.fromEntries(entries.map((item) => [item.capabilityId, item])));

export const TRUSTED_CORE_CAPABILITY_IDS = TRUSTED_CORE_IDS;
export const OPEN_SKILL_CAPABILITY_IDS = Object.freeze(entries
  .filter((item) => item.authority === "skill")
  .map((item) => item.capabilityId));

const UNKNOWN_DESCRIPTOR = descriptor({
  capabilityId: "unknown",
  kind: "advisor",
  phases: ["prewrite", "produce"],
  stages: ["planning", "response", "creative", "revision"],
  stackPolicy: "stack",
  stackKey: "unknown",
  budgetClass: "advisor",
});

export const capabilityDescriptor = (capabilityId = "") => (
  CAPABILITY_DESCRIPTOR_REGISTRY[capabilityId]
  ?? Object.freeze({ ...UNKNOWN_DESCRIPTOR, capabilityId: String(capabilityId || "unknown"), stackKey: String(capabilityId || "unknown") })
);

export const capabilityRunsAtStage = (capabilityId = "", stage = "") => {
  const stages = capabilityDescriptor(capabilityId).stages;
  return stages.includes("*") || stages.includes(stage);
};

export const CAPABILITY_EXECUTION_BUDGET = Object.freeze({
  total: 24,
  guidance: 1,
  writer: 2,
  planner: 4,
  advisor: 24,
  reviewer: 8,
  format: 6,
  memory: 4,
  experience: 6,
  artifact: 6,
  trusted_core: 64,
  trusted_action: 12,
});

export const capabilityBudgetClass = (capabilityId = "") => capabilityDescriptor(capabilityId).budgetClass;

const DELIVERABLE_CONTEXT_PRIORITY = Object.freeze({
  novel: "novel",
  short_fiction: "novel",
  short_drama_script: "script",
  public_account: "general",
  short_video_script: "general",
  visual_prompt: "general",
  book_deconstruction: "reference",
});

export const normalizeCapabilityTask = ({
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
} = {}) => {
  const rawContextDomain = String(contextDomain || "general");
  const effectiveDeliverableType = String(deliverableType || (
    workspaceMode === "project" && ["script", "script-adaptation"].includes(rawContextDomain) ? "short_drama_script"
      : workspaceMode === "project" && rawContextDomain === "novel" ? "novel"
        : ""
  ));
  const preferredDomain = DELIVERABLE_CONTEXT_PRIORITY[effectiveDeliverableType] || rawContextDomain;
  const effectiveContextDomain = effectiveDeliverableType === "short_drama_script" && sourceMode === "adaptation"
    ? "script-adaptation"
    : preferredDomain;
  return Object.freeze({
    text: String(text || ""),
    workspaceMode: ["project", "notebook", "general"].includes(workspaceMode) ? workspaceMode : "general",
    activeModule: String(activeModule || "manuscript"),
    contextDomain: effectiveContextDomain,
    rawContextDomain,
    deliverableType: effectiveDeliverableType,
    targetDocumentId: String(targetDocumentId || ""),
    sourceMode: String(sourceMode || ""),
    requestMode: String(requestMode || "creative"),
    requiredCapabilities: Object.freeze([...new Set((Array.isArray(requiredCapabilities) ? requiredCapabilities : []).filter(Boolean))]),
    semanticCapabilities: Object.freeze([...new Set((Array.isArray(semanticCapabilities) ? semanticCapabilities : []).filter(Boolean))]),
    semanticCapabilitiesAuthoritative: semanticCapabilitiesAuthoritative === true,
  });
};

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
};

export const stableCapabilityHash = (value) => {
  const source = JSON.stringify(canonicalValue(value));
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193) >>> 0;
    right = Math.imul(right ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${left.toString(16).padStart(8, "0")}${right.toString(16).padStart(8, "0")}`;
};

export const deepFreezeCapabilityValue = (value) => {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreezeCapabilityValue(child);
  return value;
};

export const trustedActionsForCapability = (capabilityId = "", selectionId = "") => {
  if (capabilityId === "experience_observer") return [deepFreezeCapabilityValue({
    id: `trusted:experience:${selectionId}`,
    capabilityId: "experience_observer",
    action: "submit_experience_candidate",
    authority: "trusted-core",
    inputContract: "experience_candidate_v2",
    status: "planned",
  })];
  if (capabilityId !== "article_illustration_planner") return [];
  return [
    deepFreezeCapabilityValue({
      id: `trusted:image-producer:${selectionId}`,
      capabilityId: "image_asset_producer",
      action: "enqueue_image_generation",
      authority: "trusted-core",
      dependsOn: selectionId,
      inputContract: "illustration_plan_v1",
      outputContract: "generated_image_assets_v1",
      status: "planned",
    }),
    deepFreezeCapabilityValue({
      id: `trusted:artifact-inserter:${selectionId}`,
      capabilityId: "artifact_inserter",
      action: "insert_artifact_at_anchor",
      authority: "trusted-core",
      dependsOn: `trusted:image-producer:${selectionId}`,
      inputContract: "generated_image_assets_v1",
      outputContract: "anchored_artifact_patch_v1",
      status: "planned",
    }),
  ];
};
