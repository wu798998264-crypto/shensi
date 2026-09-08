const itemView = (moduleId, item, moduleViews) => item?.[2]?.workspaceView ?? (moduleViews[moduleId] ? "novel" : "default");

export const reconcileActiveDocumentState = (state, moduleViews = {}) => {
  const moduleItems = state.moduleItems ?? {};
  const documents = state.documents ?? {};
  if (!moduleItems[state.activeModule]) state.activeModule = Object.keys(moduleItems)[0] ?? "manuscript";
  const viewId = state.moduleViews?.[state.activeModule] ?? moduleViews[state.activeModule]?.[0]?.id ?? "default";
  const candidates = (moduleItems[state.activeModule] ?? [])
    .filter((item) => itemView(state.activeModule, item, moduleViews) === viewId)
    .filter(([id, , options = {}]) => !options.alias && documents[id]);
  if (!candidates.some(([id]) => id === state.activeDocument)) state.activeDocument = candidates[0]?.[0] ?? null;
  return state.activeDocument;
};
