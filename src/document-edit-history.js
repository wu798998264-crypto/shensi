const HISTORY_ENTRY_LIMIT = 180;
const HISTORY_BYTE_BUDGET = 16 * 1024 * 1024;
const COALESCE_WINDOW_MS = 1_000;

const normalizeSelection = (selection) => {
  if (!selection || !Number.isFinite(Number(selection.start)) || !Number.isFinite(Number(selection.end))) return null;
  const start = Math.max(0, Math.trunc(Number(selection.start)));
  const end = Math.max(start, Math.trunc(Number(selection.end)));
  return { start, end };
};

const snapshot = (html, selection = null) => ({
  html: String(html ?? ""),
  selection: normalizeSelection(selection),
});

const trimSnapshots = (entries) => {
  const kept = entries.slice(-HISTORY_ENTRY_LIMIT);
  let bytes = kept.reduce((total, entry) => total + entry.html.length * 2 + 64, 0);
  while (kept.length > 1 && bytes > HISTORY_BYTE_BUDGET) {
    const removed = kept.shift();
    bytes -= removed.html.length * 2 + 64;
  }
  return kept;
};

const coalescingGroup = (inputType) => {
  const normalized = String(inputType || "");
  if (["insertText", "insertCompositionText", "deleteCompositionText"].includes(normalized)) return "typing";
  if (normalized === "deleteContentBackward") return "delete-backward";
  if (normalized === "deleteContentForward") return "delete-forward";
  return "";
};

export const createDocumentEditHistory = (currentHtml = "", currentSelection = null) => ({
  currentHtml: String(currentHtml ?? ""),
  currentSelection: normalizeSelection(currentSelection),
  undo: [],
  redo: [],
  lastMutation: null,
});

export const rebaseDocumentEditHistory = (history, currentHtml = "", currentSelection = null) => {
  const normalizedHtml = String(currentHtml ?? "");
  if (!history || history.currentHtml !== normalizedHtml) return createDocumentEditHistory(normalizedHtml, currentSelection);
  return {
    ...history,
    currentSelection: normalizeSelection(currentSelection) ?? history.currentSelection ?? null,
  };
};

export const recordDocumentEditMutation = (history, {
  beforeHtml = "",
  afterHtml = "",
  beforeSelection = null,
  afterSelection = null,
  inputType = "",
  at = Date.now(),
  forceBoundary = false,
} = {}) => {
  const before = String(beforeHtml ?? "");
  const after = String(afterHtml ?? "");
  const baseline = rebaseDocumentEditHistory(history, before, beforeSelection);
  if (before === after) return {
    ...baseline,
    currentSelection: normalizeSelection(afterSelection) ?? baseline.currentSelection,
  };

  const group = forceBoundary ? "" : coalescingGroup(inputType);
  const timestamp = Number.isFinite(Number(at)) ? Number(at) : Date.now();
  const canCoalesce = Boolean(group
    && baseline.undo.length
    && baseline.lastMutation?.group === group
    && baseline.lastMutation.afterHtml === before
    && timestamp - baseline.lastMutation.at >= 0
    && timestamp - baseline.lastMutation.at <= COALESCE_WINDOW_MS);
  const undo = canCoalesce
    ? baseline.undo
    : trimSnapshots([...baseline.undo, snapshot(before, beforeSelection ?? baseline.currentSelection)]);

  return {
    currentHtml: after,
    currentSelection: normalizeSelection(afterSelection),
    undo,
    redo: [],
    lastMutation: group ? { group, at: timestamp, afterHtml: after } : null,
  };
};

export const stepDocumentEditHistory = (history, direction, {
  currentHtml = "",
  currentSelection = null,
} = {}) => {
  if (!["undo", "redo"].includes(direction)) return { history: rebaseDocumentEditHistory(history, currentHtml, currentSelection), snapshot: null };
  const baseline = rebaseDocumentEditHistory(history, currentHtml, currentSelection);
  const source = direction === "undo" ? baseline.undo : baseline.redo;
  if (!source.length) return { history: baseline, snapshot: null };

  const target = source[source.length - 1];
  const present = snapshot(currentHtml, currentSelection ?? baseline.currentSelection);
  const next = direction === "undo"
    ? {
        currentHtml: target.html,
        currentSelection: target.selection,
        undo: source.slice(0, -1),
        redo: trimSnapshots([...baseline.redo, present]),
        lastMutation: null,
      }
    : {
        currentHtml: target.html,
        currentSelection: target.selection,
        undo: trimSnapshots([...baseline.undo, present]),
        redo: source.slice(0, -1),
        lastMutation: null,
      };
  return { history: next, snapshot: target };
};

export const documentEditHistoryAvailability = (history) => ({
  undo: Boolean(history?.undo?.length),
  redo: Boolean(history?.redo?.length),
});
