import { chapterNumberValue } from "./chapter-target.js";

const NUMBER_TOKEN = "\\d+|[零〇一二两三四五六七八九十百千万]+";

export const normalizePastedDocumentTitle = (value = "") => String(value ?? "")
  .replace(/[\u0000-\u001f\u007f]+/gu, " ")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, 160);

export const sequencedDocumentKind = (documentId = "", documentState = null) => (
  documentState?.sequenceType === "chapter" || /^chapter-\d+$/.test(String(documentId)) ? "chapter"
    : documentState?.sequenceType === "episode" || /^script-episode-\d+$/.test(String(documentId)) ? "episode"
      : ""
);

export const sequencedDocumentNumber = (documentId = "") => (
  Number(String(documentId).match(/^(?:chapter|script-episode)-(\d+)$/)?.[1] || 0)
);

const positiveSequenceNumber = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : 0;
};

export const legacySequencedTitleParts = ({ documentId = "", title = "" } = {}) => {
  const kind = sequencedDocumentKind(documentId);
  if (!kind) return null;
  const source = String(title ?? "").trim();
  const unit = kind === "chapter" ? "章" : "集";
  const englishUnit = kind === "chapter" ? "Chapter" : "Episode";
  const chinese = source.match(new RegExp(`^第\\s*(${NUMBER_TOKEN})\\s*${unit}(?:[\\t 　:：·—|｜-]+(.+))?$`));
  const english = source.match(new RegExp(`^${englishUnit}\\s+(${NUMBER_TOKEN})(?:[\\t 　:：·—|｜-]+(.+))?$`, "i"));
  const match = chinese ?? english;
  if (!match) return null;
  const number = chapterNumberValue(match[1]);
  if (!Number.isInteger(number) || number < 1) return null;
  return {
    kind,
    number,
    title: String(match[2] || "").trim(),
    language: english ? "en-US" : "zh-CN",
  };
};

export const freeDocumentTitle = ({ documentId = "", title = "", language = "zh-CN" } = {}) => {
  const source = String(title ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const parsed = legacySequencedTitleParts({ documentId, title: source });
  if (parsed) return parsed.title || (language === "en-US" ? "Untitled" : "未命名");
  return source || (language === "en-US" ? "Untitled" : "未命名");
};

export const effectiveSequencedDocumentNumber = ({ documentId = "", documentState = {}, title = "" } = {}) => {
  const storedSequenceNumber = positiveSequenceNumber(documentState?.sequenceNumber);
  if (storedSequenceNumber) return storedSequenceNumber;
  const storedNumber = positiveSequenceNumber(documentState?.manualChapterNumber);
  if (storedNumber) return storedNumber;
  if (documentState?.manualChapterNumber === true) {
    const legacyNumber = legacySequencedTitleParts({ documentId, title: title || documentState?.title })?.number;
    if (legacyNumber) return legacyNumber;
  }
  return sequencedDocumentNumber(documentId);
};

export const sequencedDocumentRenameSpec = ({
  documentId = "",
  currentTitle = "",
  currentSequenceNumber = 0,
  nextName = "",
  language = "zh-CN",
} = {}) => {
  const normalized = String(nextName ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  const parsed = legacySequencedTitleParts({ documentId, title: normalized });
  const sequenceNumber = positiveSequenceNumber(parsed?.number)
    || positiveSequenceNumber(currentSequenceNumber)
    || sequencedDocumentNumber(documentId);
  const title = parsed
    ? parsed.title || (language === "en-US" ? "Untitled" : "未命名")
    : normalized || freeDocumentTitle({ documentId, title: currentTitle, language });
  return { title, sequenceNumber, explicitSequenceNumber: Boolean(parsed) };
};

export const sequencedDocumentLabel = ({ documentId = "", title = "", language = "zh-CN", sequenceNumber = 0, documentState = null } = {}) => {
  const kind = sequencedDocumentKind(documentId, documentState);
  const number = positiveSequenceNumber(sequenceNumber)
    || effectiveSequencedDocumentNumber({ documentId, documentState: documentState ?? {}, title });
  const parsed = legacySequencedTitleParts({ documentId, title });
  const resolvedLanguage = language || parsed?.language || "zh-CN";
  const freeTitle = freeDocumentTitle({ documentId, title, language: resolvedLanguage });
  if (!kind || !number) return freeTitle;
  if (resolvedLanguage === "en-US") return `${kind === "chapter" ? "Chapter" : "Episode"} ${number} ${freeTitle}`;
  return `第${number}${kind === "chapter" ? "章" : "集"}　${freeTitle}`;
};

export const synchronizeDocumentDirectoryLabels = ({ documents = {}, moduleItems = {}, language = "zh-CN" } = {}) => {
  let changed = false;
  for (const items of Object.values(moduleItems ?? {})) {
    if (!Array.isArray(items)) continue;
    for (const item of items) {
      const [documentId, currentLabel, options = {}] = Array.isArray(item) ? item : [];
      const documentState = documents?.[documentId];
      if (!documentState || options?.alias === true) continue;
      const title = String(documentState.title || "").replace(/[\r\n]+/g, " ").trim();
      if (!title) continue;
      const nextLabel = sequencedDocumentKind(documentId, documentState)
        ? sequencedDocumentLabel({ documentId, title, language: documentState.titleLanguage || language, documentState })
        : title;
      if (nextLabel === currentLabel) continue;
      item[1] = nextLabel;
      changed = true;
    }
  }
  return changed;
};
