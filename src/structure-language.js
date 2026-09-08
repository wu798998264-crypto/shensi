import { isNarrativeUnitDocumentId } from "./narrative-placeholder.js";

export const normalizeStructureLanguage = (value) => value === "en-US" ? "en-US" : "zh-CN";

export const FIXED_STRUCTURE_TITLES_EN = Object.freeze({
  "script-episode-1": "Episode 1 Sample Episode",
  "prompt-video-1": "Episode 1 Video Prompt",
  "prompt-visual-assets": "Visual Asset Master List",
  "prompt-panorama-1": "Episode 1 Panorama Staging Prompt",
  "outline-series": "Series Outline",
  "script-outline-series": "Script Series Outline",
  "canon-characters": "Character Profiles",
  "canon-world": "Worldbuilding & Core Rules",
  "canon-factions": "Factions & Organizations",
  "canon-relations": "Character Relationships",
  "canon-locations": "Maps & Locations",
  "canon-items": "Items & Props",
  "canon-events": "Events & Timeline",
  "canon-glossary": "Glossary",
  "script-canon-characters": "Character Adaptation",
  "script-canon-world": "World & Rule Adaptation",
  "script-canon-factions": "Faction & Organization Adaptation",
  "script-canon-relations": "Relationship Adaptation",
  "script-canon-locations": "Scene & Location Adaptation",
  "script-canon-items": "Prop Adaptation",
  "script-canon-events": "Event & Timeline Adaptation",
  "script-canon-glossary": "Script Terminology",
  "memory-foreshadowing": "Foreshadowing",
  "memory-first-appearance": "Important Information Ledger",
  "memory-release": "Information Release",
  "memory-reader": "Reader Knowledge",
  "memory-snapshot": "State Snapshot",
  "script-memory-foreshadowing": "Script Foreshadowing",
  "script-memory-first-appearance": "Script Information Ledger",
  "script-memory-release": "Script Information Release",
  "script-memory-audience": "Audience Knowledge",
  "script-memory-snapshot": "Script State Snapshot",
  "report-novel": "Novel Review",
  "report-script": "Script Review",
  "report-compile": "Project Overview",
  "report-adaptation": "Novel-to-Script Compilation Report",
  "library-reference": "Reference Materials",
  "library-retired": "Retired Settings",
  "index-language-blacklist": "Project Rules",
  "index-update-log": "Update Log",
  "index-pending": "Pending Items",
});

const numberedTitle = (documentId, source) => {
  const chapter = String(documentId).match(/^chapter-(\d+)$/);
  if (chapter) {
    const suffix = String(source).replace(/^第.+?章[\s　]*/, "").replace(/^Chapter\s+\d+[\s　]*/i, "").trim();
    return `Chapter ${chapter[1]} ${!suffix || suffix === "未命名" ? "Untitled" : suffix}`;
  }
  const volumeOutline = String(documentId).match(/^outline-volume-(\d+)$/);
  if (volumeOutline) return `Volume ${volumeOutline[1]} Outline`;
  const chapterOutline = String(documentId).match(/^outline-chapter-(\d+)$/);
  if (chapterOutline) return `Chapter ${chapterOutline[1]} Outline`;
  const episodeOutline = String(documentId).match(/^script-outline-episode-(\d+)$/);
  if (episodeOutline) return `Episode ${episodeOutline[1]} Outline`;
  const episode = String(documentId).match(/^script-episode-(\d+)$/);
  if (episode) {
    const sample = /样集|sample/i.test(String(source));
    return `Episode ${episode[1]} ${sample ? "Sample Episode" : "Untitled"}`;
  }
  const videoPrompt = String(documentId).match(/^prompt-video-(\d+)$/);
  if (videoPrompt) return `Episode ${videoPrompt[1]} Video Prompt`;
  const panoramaPrompt = String(documentId).match(/^prompt-panorama-(\d+)$/);
  if (panoramaPrompt) return `Episode ${panoramaPrompt[1]} Panorama Staging Prompt`;
  return null;
};

export const fixedStructureTitle = ({ documentId = "", title = "", language = "zh-CN" } = {}) => {
  if (normalizeStructureLanguage(language) !== "en-US") return String(title);
  return FIXED_STRUCTURE_TITLES_EN[documentId] ?? numberedTitle(documentId, title) ?? String(title);
};

const englishBlankHtml = (documentId, title) => documentId === "index-language-blacklist"
  ? `<h1>${title}</h1><h2>Project banned terms</h2><p>No project-specific banned terms.</p><h2>Special project constraints</h2><p>No project-specific special constraints.</p>`
  : isNarrativeUnitDocumentId(documentId)
    ? ""
    : `<h1>${title}</h1><p>Define this document's purpose in the chat panel before filling it in.</p>`;

export const applyStructureCreationLanguage = (targetState, language, { blank = false } = {}) => {
  const normalized = normalizeStructureLanguage(language);
  targetState.structureLanguage = normalized;
  if (normalized !== "en-US") return targetState;

  for (const items of Object.values(targetState.moduleItems ?? {})) {
    for (const item of items ?? []) item[1] = fixedStructureTitle({ documentId: item[0], title: item[1], language: normalized });
  }
  for (const [documentId, documentState] of Object.entries(targetState.documents ?? {})) {
    const previousTitle = String(documentState?.title ?? "");
    const title = fixedStructureTitle({ documentId, title: previousTitle, language: normalized });
    if (title === previousTitle && !FIXED_STRUCTURE_TITLES_EN[documentId] && !numberedTitle(documentId, previousTitle)) continue;
    documentState.title = title;
    documentState.titleLanguage = normalized;
    documentState.systemGeneratedTitle ??= true;
    if (typeof documentState.html === "string") {
      documentState.html = blank
        ? englishBlankHtml(documentId, title)
        : documentState.html.replace(/<h1>.*?<\/h1>/i, `<h1>${title}</h1>`);
    }
  }

  const firstChapter = targetState.moduleItems?.manuscript?.find(([id]) => id === "chapter-1");
  if (firstChapter) {
    firstChapter[2] = {
      ...(firstChapter[2] ?? {}),
      workspaceView: "novel",
      contextDomain: "novel",
      folderId: "manuscript-volume:Volume-001-Untitled",
      folderLabel: "Volume 001 Untitled",
      volumeFolder: "Volume-001-Untitled",
      treeGroup: "volume",
    };
    Object.assign(targetState.documents?.["chapter-1"] ?? {}, {
      volumeLabel: "Volume 001 Untitled",
      volumeFolder: "Volume-001-Untitled",
    });
  }
  return targetState;
};
