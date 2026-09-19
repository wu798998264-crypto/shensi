export const MAX_DOCUMENT_TABS = 8;

const text = (value = "") => String(value ?? "").trim();

let fallbackTabSequence = 0;
const fallbackTabId = () => `document-tab-${Date.now().toString(36)}-${(++fallbackTabSequence).toString(36)}`;

const tabId = (candidate, used, createId) => {
  let id = text(candidate);
  while (!id || used.has(id)) id = text(createId?.()) || fallbackTabId();
  used.add(id);
  return id;
};

const blankTab = (createId, used = new Set()) => ({ id: tabId("", used, createId), documentId: "" });

export const normalizeDocumentViewStates = (viewStates = {}, documents = {}) => Object.fromEntries(
  Object.entries(viewStates && typeof viewStates === "object" && !Array.isArray(viewStates) ? viewStates : {})
    .filter(([documentId]) => Boolean(documents?.[documentId]))
    .map(([documentId, viewState]) => [documentId, {
      mode: viewState?.mode === "read" ? "read" : "edit",
      scrollTop: Math.max(0, Number(viewState?.scrollTop) || 0),
    }]),
);

export const normalizeDocumentTabState = ({
  documentTabs = [],
  activeDocumentTabId = "",
  documentViewStates = {},
  activeDocument = "",
  documents = {},
  createId = fallbackTabId,
} = {}) => {
  const usedIds = new Set();
  const openedDocumentIds = new Set();
  const tabs = [];
  for (const candidate of Array.isArray(documentTabs) ? documentTabs : []) {
    if (tabs.length >= MAX_DOCUMENT_TABS) break;
    const documentId = text(candidate?.documentId);
    if (documentId && (!documents?.[documentId] || openedDocumentIds.has(documentId))) continue;
    if (documentId) openedDocumentIds.add(documentId);
    tabs.push({ id: tabId(candidate?.id, usedIds, createId), documentId });
  }

  const requestedDocumentId = text(activeDocument);
  if (!tabs.length) {
    tabs.push(requestedDocumentId && documents?.[requestedDocumentId]
      ? { id: tabId("", usedIds, createId), documentId: requestedDocumentId }
      : blankTab(createId, usedIds));
  }

  let activeTab = tabs.find((tab) => tab.id === text(activeDocumentTabId));
  if (requestedDocumentId && documents?.[requestedDocumentId]) {
    const existing = tabs.find((tab) => tab.documentId === requestedDocumentId);
    if (existing) activeTab = existing;
    else {
      const replaceIndex = Math.max(0, tabs.findIndex((tab) => tab.id === activeTab?.id));
      tabs[replaceIndex] = { ...tabs[replaceIndex], documentId: requestedDocumentId };
      activeTab = tabs[replaceIndex];
    }
  } else if (!requestedDocumentId) {
    const activeBlank = activeTab?.documentId ? tabs.find((tab) => !tab.documentId) : activeTab;
    if (activeBlank) activeTab = activeBlank;
  }
  activeTab ||= tabs[0];

  return {
    documentTabs: tabs,
    activeDocumentTabId: activeTab.id,
    activeDocument: activeTab.documentId,
    documentViewStates: normalizeDocumentViewStates(documentViewStates, documents),
  };
};

export const openBlankDocumentTab = (input = {}) => {
  const normalized = normalizeDocumentTabState(input);
  if (normalized.documentTabs.length >= MAX_DOCUMENT_TABS) return { ...normalized, changed: false, limitReached: true };
  const used = new Set(normalized.documentTabs.map((tab) => tab.id));
  const tab = blankTab(input.createId || fallbackTabId, used);
  return {
    ...normalized,
    documentTabs: [...normalized.documentTabs, tab],
    activeDocumentTabId: tab.id,
    activeDocument: "",
    changed: true,
    limitReached: false,
  };
};

export const openDocumentInTabs = (input = {}, requestedDocumentId = "") => {
  const normalized = normalizeDocumentTabState(input);
  const documentId = text(requestedDocumentId);
  if (!documentId || !input.documents?.[documentId]) return { ...normalized, changed: false };
  const existing = normalized.documentTabs.find((tab) => tab.documentId === documentId);
  if (existing) return {
    ...normalized,
    activeDocumentTabId: existing.id,
    activeDocument: documentId,
    changed: existing.id !== normalized.activeDocumentTabId,
  };
  const activeIndex = Math.max(0, normalized.documentTabs.findIndex((tab) => tab.id === normalized.activeDocumentTabId));
  const activeTab = normalized.documentTabs[activeIndex];
  // A blank tab is the placeholder created by the adjacent `+` action. Once
  // the user chooses a document, that active placeholder becomes the document
  // tab; it must not leave an extra blank tab behind.
  const tabs = normalized.documentTabs.map((tab, index) => index === activeIndex ? { ...tab, documentId } : tab);
  return {
    ...normalized,
    documentTabs: tabs,
    activeDocumentTabId: tabs[activeIndex].id,
    activeDocument: documentId,
    changed: true,
  };
};

export const activateDocumentTab = (input = {}, requestedTabId = "") => {
  const normalized = normalizeDocumentTabState(input);
  const active = normalized.documentTabs.find((tab) => tab.id === text(requestedTabId));
  if (!active) return { ...normalized, changed: false };
  return {
    ...normalized,
    activeDocumentTabId: active.id,
    activeDocument: active.documentId,
    changed: active.id !== normalized.activeDocumentTabId,
  };
};

export const reorderDocumentTabs = (input = {}, draggedTabId = "", targetTabId = "", placement = "before") => {
  const normalized = normalizeDocumentTabState(input);
  const draggedId = text(draggedTabId);
  const targetId = text(targetTabId);
  if (!draggedId || !targetId || draggedId === targetId) return { ...normalized, changed: false };
  const dragged = normalized.documentTabs.find((tab) => tab.id === draggedId);
  if (!dragged || !normalized.documentTabs.some((tab) => tab.id === targetId)) return { ...normalized, changed: false };

  const tabs = normalized.documentTabs.filter((tab) => tab.id !== draggedId);
  const targetIndex = tabs.findIndex((tab) => tab.id === targetId);
  const insertionIndex = targetIndex + (placement === "after" ? 1 : 0);
  tabs.splice(insertionIndex, 0, dragged);
  const changed = tabs.some((tab, index) => tab.id !== normalized.documentTabs[index]?.id);
  return { ...normalized, documentTabs: changed ? tabs : normalized.documentTabs, changed };
};

export const closeDocumentTab = (input = {}, requestedTabId = "") => {
  const normalized = normalizeDocumentTabState(input);
  const closeIndex = normalized.documentTabs.findIndex((tab) => tab.id === text(requestedTabId));
  if (closeIndex < 0) return { ...normalized, changed: false };
  const closingActive = normalized.documentTabs[closeIndex].id === normalized.activeDocumentTabId;
  const tabs = normalized.documentTabs.filter((_, index) => index !== closeIndex);
  if (!tabs.length) {
    const used = new Set();
    const tab = blankTab(input.createId || fallbackTabId, used);
    return { ...normalized, documentTabs: [tab], activeDocumentTabId: tab.id, activeDocument: "", changed: true };
  }
  const active = closingActive
    ? tabs[Math.min(closeIndex, tabs.length - 1)]
    : tabs.find((tab) => tab.id === normalized.activeDocumentTabId) || tabs[0];
  return { ...normalized, documentTabs: tabs, activeDocumentTabId: active.id, activeDocument: active.documentId, changed: true };
};

export const removeDocumentFromTabs = (input = {}, removedDocumentId = "") => {
  const documentId = text(removedDocumentId);
  const documentsForRemoval = { ...(input.documents || {}) };
  if (documentId && !documentsForRemoval[documentId]) documentsForRemoval[documentId] = {};
  const normalized = normalizeDocumentTabState({ ...input, documents: documentsForRemoval });
  const target = normalized.documentTabs.find((tab) => tab.documentId === documentId);
  if (!target) return normalizeDocumentTabState({ ...normalized, documents: input.documents || {} });
  const next = closeDocumentTab({ ...input, ...normalized, documents: documentsForRemoval }, target.id);
  return normalizeDocumentTabState({ ...next, documents: input.documents || {} });
};

export const updateDocumentViewState = (viewStates = {}, documentId = "", patch = {}) => {
  const id = text(documentId);
  if (!id) return { ...(viewStates || {}) };
  const current = viewStates?.[id] ?? {};
  return {
    ...(viewStates || {}),
    [id]: {
      mode: (patch.mode ?? current.mode) === "read" ? "read" : "edit",
      scrollTop: Math.max(0, Number(patch.scrollTop ?? current.scrollTop) || 0),
    },
  };
};
