const text = (value = "") => String(value ?? "").trim();

export const INDEX_ROLES = Object.freeze({
  control: "control",
  decision: "decision",
  guidance: "guidance",
  continuity: "continuity",
  display: "display",
});

export const INDEX_CONTEXT_MODES = Object.freeze({
  constraints: "constraints",
  relevant: "relevant",
  guidance: "guidance",
  displayOnly: "display-only",
});

const INDEX_POLICIES = Object.freeze({
  "index-language-blacklist": {
    role: INDEX_ROLES.control,
    contextMode: INDEX_CONTEXT_MODES.constraints,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "explicit-author-update",
    writeScenarios: ["explicit_contract_update"],
    writeTarget: "index-language-blacklist",
    writeAuthority: "user_explicit",
  },
  "index-pending": {
    role: INDEX_ROLES.decision,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "author-confirmation",
    writeScenarios: ["author_confirmation_queue", "post_commit_pending"],
    writeTarget: "index-pending",
    writeAuthority: "host_transaction",
  },
  "index-creative-guidance": {
    role: INDEX_ROLES.guidance,
    contextMode: INDEX_CONTEXT_MODES.guidance,
    readStages: ["guidance", "planning"],
    syncMode: "explicit-author-update",
    writeScenarios: ["explicit_guidance_update"],
    writeTarget: "index-creative-guidance",
    writeAuthority: "user_explicit",
  },
  "memory-foreshadowing": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "memory-foreshadowing",
    writeAuthority: "host_derived",
  },
  "memory-information-ledger": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "memory-information-ledger",
    writeAuthority: "host_derived",
  },
  "memory-first-appearance": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "memory-first-appearance",
    writeAuthority: "host_derived",
  },
  "memory-release": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "memory-release",
    writeAuthority: "host_derived",
  },
  "memory-reader": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "memory-reader",
    writeAuthority: "host_derived",
  },
  "memory-snapshot": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "memory-snapshot",
    writeAuthority: "host_derived",
  },
  "script-memory-foreshadowing": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "script-memory-foreshadowing",
    writeAuthority: "host_derived",
  },
  "script-memory-information-ledger": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "script-memory-information-ledger",
    writeAuthority: "host_derived",
  },
  "script-memory-first-appearance": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "script-memory-first-appearance",
    writeAuthority: "host_derived",
  },
  "script-memory-release": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "script-memory-release",
    writeAuthority: "host_derived",
  },
  "script-memory-audience": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "script-memory-audience",
    writeAuthority: "host_derived",
  },
  "script-memory-snapshot": {
    role: INDEX_ROLES.continuity,
    contextMode: INDEX_CONTEXT_MODES.relevant,
    readStages: ["planning", "writing", "modification", "diagnosis"],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_memory_projection"],
    writeTarget: "script-memory-snapshot",
    writeAuthority: "host_derived",
  },
  "index-update-log": {
    role: INDEX_ROLES.display,
    contextMode: INDEX_CONTEXT_MODES.displayOnly,
    readStages: [],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_log"],
    writeTarget: "index-update-log",
    writeAuthority: "host_derived",
  },
  "report-compile": {
    role: INDEX_ROLES.display,
    contextMode: INDEX_CONTEXT_MODES.displayOnly,
    readStages: [],
    syncMode: "post-commit-derived",
    writeScenarios: ["post_commit_overview"],
    writeTarget: "report-compile",
    writeAuthority: "host_derived",
  },
  "report-novel": {
    role: INDEX_ROLES.display,
    contextMode: INDEX_CONTEXT_MODES.displayOnly,
    readStages: [],
    syncMode: "explicit-self-check",
    writeScenarios: ["explicit_self_check_report"],
    writeTarget: "report-novel",
    writeAuthority: "user_explicit",
  },
  "report-script": {
    role: INDEX_ROLES.display,
    contextMode: INDEX_CONTEXT_MODES.displayOnly,
    readStages: [],
    syncMode: "explicit-self-check",
    writeScenarios: ["explicit_self_check_report"],
    writeTarget: "report-script",
    writeAuthority: "user_explicit",
  },
  "report-adaptation": {
    role: INDEX_ROLES.display,
    contextMode: INDEX_CONTEXT_MODES.displayOnly,
    readStages: [],
    syncMode: "explicit-self-check",
    writeScenarios: ["explicit_self_check_report"],
    writeTarget: "report-adaptation",
    writeAuthority: "user_explicit",
  },
});

const DEFAULT_POLICY = Object.freeze({
  role: "document",
  contextMode: INDEX_CONTEXT_MODES.relevant,
  readStages: [],
  syncMode: "none",
  writeScenarios: [],
  writeTarget: "",
  writeAuthority: "none",
});

export const indexPolicyForDocument = (documentId = "") => (
  INDEX_POLICIES[text(documentId)] ?? DEFAULT_POLICY
);

export const indexRoleForDocument = (documentId = "") => indexPolicyForDocument(documentId).role;

export const indexContextModeForDocument = (documentId = "") => indexPolicyForDocument(documentId).contextMode;

export const indexIsDisplayOnly = (documentId = "") => indexRoleForDocument(documentId) === INDEX_ROLES.display;

export const indexCanBeReadForStage = (documentId = "", stage = "") => {
  const policy = indexPolicyForDocument(documentId);
  return policy.readStages.includes(text(stage));
};

export const indexSyncModeForDocument = (documentId = "") => indexPolicyForDocument(documentId).syncMode;

export const indexWritePolicyForDocument = (documentId = "") => {
  const policy = indexPolicyForDocument(documentId);
  return {
    documentId: text(documentId),
    scenarios: [...(policy.writeScenarios ?? [])],
    target: text(policy.writeTarget || documentId),
    authority: text(policy.writeAuthority || "none"),
  };
};

export const indexWriteTargetForScenario = (scenario = "", { contextDomain = "" } = {}) => {
  const wanted = text(scenario);
  const domain = text(contextDomain).toLowerCase();
  const candidates = Object.entries(INDEX_POLICIES)
    .filter(([, policy]) => policy.writeScenarios?.includes(wanted))
    .map(([documentId, policy]) => ({
      documentId,
      target: text(policy.writeTarget || documentId),
      authority: text(policy.writeAuthority || "none"),
    }));
  if (wanted === "explicit_self_check_report") {
    const preferredId = ["script-adaptation", "adaptation"].includes(domain)
      ? "report-adaptation"
      : domain === "script" ? "report-script" : "report-novel";
    return candidates.find((item) => item.documentId === preferredId) ?? null;
  }
  return candidates.length === 1 ? candidates[0] : null;
};

export const indexWriteScenarioAllows = (documentId = "", scenario = "", { authority = "" } = {}) => {
  const policy = indexWritePolicyForDocument(documentId);
  return policy.scenarios.includes(text(scenario))
    && (!authority || policy.authority === text(authority));
};

export const indexPolicies = () => structuredClone(INDEX_POLICIES);

export const displayOnlyIndexDocumentIds = () => Object.entries(INDEX_POLICIES)
  .filter(([, policy]) => policy.role === INDEX_ROLES.display)
  .map(([documentId]) => documentId);
