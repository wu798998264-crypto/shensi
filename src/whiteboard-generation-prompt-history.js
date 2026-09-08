const MAX_HISTORY_ENTRIES = 120;

const normalizedSelection = (value) => {
  if (!value || typeof value !== "object") return null;
  const start = Number(value.start);
  const end = Number(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return {
    start: Math.max(0, Math.floor(start)),
    end: Math.max(0, Math.floor(end)),
  };
};

export const normalizeWhiteboardPromptHistorySnapshot = (value = {}) => {
  const source = value && typeof value === "object" ? value : {};
  return {
    value: String(source.value ?? ""),
    explicitReferences: String(source.explicitReferences ?? ""),
    referenceOrder: String(source.referenceOrder ?? ""),
    promptReferenceSequence: String(source.promptReferenceSequence ?? ""),
    includeTargetReference: String(source.includeTargetReference ?? ""),
    multiframeTransitions: String(source.multiframeTransitions ?? ""),
    selection: normalizedSelection(source.selection),
  };
};

const sameSelection = (left, right) => (left?.start ?? null) === (right?.start ?? null)
  && (left?.end ?? null) === (right?.end ?? null);

export const sameWhiteboardPromptHistorySnapshot = (left, right) => {
  const a = normalizeWhiteboardPromptHistorySnapshot(left);
  const b = normalizeWhiteboardPromptHistorySnapshot(right);
  return a.value === b.value
    && a.explicitReferences === b.explicitReferences
    && a.referenceOrder === b.referenceOrder
    && a.promptReferenceSequence === b.promptReferenceSequence
    && a.includeTargetReference === b.includeTargetReference
    && a.multiframeTransitions === b.multiframeTransitions
    && sameSelection(a.selection, b.selection);
};

export const createWhiteboardPromptHistory = (initial = {}) => ({
  entries: [normalizeWhiteboardPromptHistorySnapshot(initial)],
  index: 0,
});

export const pushWhiteboardPromptHistory = (history, nextSnapshot) => {
  const current = history && typeof history === "object" ? history : createWhiteboardPromptHistory();
  const entries = Array.isArray(current.entries) && current.entries.length
    ? current.entries.map(normalizeWhiteboardPromptHistorySnapshot)
    : [normalizeWhiteboardPromptHistorySnapshot()];
  const index = Math.max(0, Math.min(Number(current.index) || 0, entries.length - 1));
  const next = normalizeWhiteboardPromptHistorySnapshot(nextSnapshot);
  // Moving the caret must not create an undo step. Selection is retained on
  // each content snapshot solely so an undo can restore a useful caret range.
  const currentSnapshot = entries[index];
  const contentUnchanged = currentSnapshot.value === next.value
    && currentSnapshot.explicitReferences === next.explicitReferences
    && currentSnapshot.promptReferenceSequence === next.promptReferenceSequence
    && currentSnapshot.includeTargetReference === next.includeTargetReference
    && currentSnapshot.multiframeTransitions === next.multiframeTransitions;
  if (contentUnchanged) return { entries, index };
  const retained = entries.slice(0, index + 1);
  retained.push(next);
  const bounded = retained.length > MAX_HISTORY_ENTRIES
    ? retained.slice(retained.length - MAX_HISTORY_ENTRIES)
    : retained;
  return { entries: bounded, index: bounded.length - 1 };
};

export const stepWhiteboardPromptHistory = (history, direction = "undo") => {
  const current = history && typeof history === "object" ? history : createWhiteboardPromptHistory();
  const entries = Array.isArray(current.entries) && current.entries.length
    ? current.entries.map(normalizeWhiteboardPromptHistorySnapshot)
    : [normalizeWhiteboardPromptHistorySnapshot()];
  const currentIndex = Math.max(0, Math.min(Number(current.index) || 0, entries.length - 1));
  const delta = direction === "redo" ? 1 : -1;
  const nextIndex = Math.max(0, Math.min(entries.length - 1, currentIndex + delta));
  return {
    history: { entries, index: nextIndex },
    snapshot: entries[nextIndex] || null,
    changed: nextIndex !== currentIndex,
  };
};

export const whiteboardPromptHistoryLimit = () => MAX_HISTORY_ENTRIES;
