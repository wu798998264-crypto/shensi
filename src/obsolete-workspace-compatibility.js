export const OBSOLETE_CREATIVE_GUIDANCE_DOCUMENT_ID = "index-creative-guidance";
export const OBSOLETE_WORKSPACE_COMPATIBILITY_VERSION = 1;

const text = (value = "") => String(value ?? "").trim();

const removeExactReference = (value, obsoleteId, seen, report) => {
  if (!value || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (item === obsoleteId || (Array.isArray(item) && item[0] === obsoleteId)) {
        value.splice(index, 1);
        report.removedReferences += 1;
        continue;
      }
      removeExactReference(item, obsoleteId, seen, report);
    }
    return;
  }

  for (const key of Object.keys(value)) {
    if (key === obsoleteId || value[key] === obsoleteId) {
      delete value[key];
      report.removedReferences += 1;
      continue;
    }
    removeExactReference(value[key], obsoleteId, seen, report);
  }
};

const activeTextProfileId = (settings = {}) => {
  const profiles = Array.isArray(settings.textConnections) ? settings.textConnections : [];
  const ids = new Set(profiles.map((profile) => text(profile?.id)).filter(Boolean));
  return [settings.activeTextAgentConnectionId, settings.activeTextConnectionId, settings.activeTextChatConnectionId]
    .map(text)
    .find((profileId) => ids.has(profileId)) || "";
};

export const synchronizeUnifiedTextAgentSelection = (state = {}) => {
  const settings = state?.settings;
  if (!settings || typeof settings !== "object") return false;
  const profileId = activeTextProfileId(settings);
  if (!profileId) return false;
  const changed = ["activeTextConnectionId", "activeTextAgentConnectionId", "activeTextChatConnectionId"]
    .some((key) => text(settings[key]) !== profileId);
  if (!changed) return false;
  settings.activeTextConnectionId = profileId;
  settings.activeTextAgentConnectionId = profileId;
  // Kept as a serialized alias for older state readers; it has no independent Chat runtime.
  settings.activeTextChatConnectionId = profileId;
  return true;
};

export const purgeObsoleteWorkspaceCompatibility = (state = {}) => {
  const report = {
    changed: false,
    removedGuidanceDocument: false,
    removedReferences: 0,
    synchronizedTextSelection: false,
  };
  if (!state || typeof state !== "object") return report;

  const obsoleteId = OBSOLETE_CREATIVE_GUIDANCE_DOCUMENT_ID;
  const hasGuidanceDocument = Boolean(state.documents?.[obsoleteId]);
  const hasGuidanceDirectoryItem = Object.values(state.moduleItems ?? {})
    .some((items) => Array.isArray(items) && items.some((item) => item?.[0] === obsoleteId));
  const migrationRequired = Number(state.obsoleteWorkspaceCompatibilityVersion || 0)
    < OBSOLETE_WORKSPACE_COMPATIBILITY_VERSION;

  if (migrationRequired || hasGuidanceDocument || hasGuidanceDirectoryItem) {
    removeExactReference(state, obsoleteId, new WeakSet(), report);
    report.removedGuidanceDocument = hasGuidanceDocument;
    state.obsoleteWorkspaceCompatibilityVersion = OBSOLETE_WORKSPACE_COMPATIBILITY_VERSION;
    report.changed = migrationRequired || report.removedReferences > 0;
  }

  if (!Object.hasOwn(state, "activeDocument")) state.activeDocument = "";
  if (state.activeDocument === obsoleteId) {
    report.changed = true;
    state.activeDocument = "";
  }
  if (state.moduleLastDocuments && typeof state.moduleLastDocuments === "object") {
    for (const key of Object.keys(state.moduleLastDocuments)) {
      if (state.moduleLastDocuments[key] === obsoleteId) {
        state.moduleLastDocuments[key] = "";
        report.changed = true;
      }
    }
  }

  report.synchronizedTextSelection = synchronizeUnifiedTextAgentSelection(state);
  report.changed ||= report.synchronizedTextSelection;
  return report;
};
