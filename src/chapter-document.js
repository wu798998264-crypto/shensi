import { newDocumentTreeOptions } from "./document-tree.js";
import { chapterNumberValue } from "./chapter-target.js";
import { sequencedDocumentLabel } from "./document-title-policy.js";

const chapterNumberFromId = (id = "") => Number(String(id).match(/^chapter-(\d+)$/)?.[1] ?? 0);

const notebookSequence = (item = [], documents = {}) => {
  const [documentId, label = "", options = {}] = item;
  const documentState = documents?.[documentId] ?? {};
  if (documentState.documentKind === "whiteboard") return null;
  const source = String(documentState.title || label || "").trim();
  const match = source.match(/^第\s*(\d+|[零〇一二两三四五六七八九十百千万]+)\s*(章|集)/u);
  const idMatch = String(documentId).match(/^(chapter|script-episode)-(\d+)$/u);
  const storedNumber = Number(documentState.sequenceNumber || documentState.manualChapterNumber || options.sequenceNumber || 0);
  const number = Number.isInteger(storedNumber) && storedNumber > 0
    ? storedNumber
    : chapterNumberValue(match?.[1] || idMatch?.[2] || "");
  if (!Number.isInteger(number) || number < 1) return null;
  const type = documentState.sequenceType || options.sequenceType
    || (match?.[2] === "集" || idMatch?.[1] === "script-episode" ? "episode" : "chapter");
  const folderId = options.customFolderId || documentState.customFolderId
    || options.folderId || documentState.folderId
    || options.volumeFolder || documentState.volumeFolder
    || "root";
  const viewId = options.workspaceView || documentState.workspaceView || "default";
  return { type, number, group: `${viewId}:${folderId}:${type}` };
};

export const sortNotebookChapterItems = (items = [], documents = {}) => {
  const source = (Array.isArray(items) ? items : []).map((item) => item);
  const groups = new Map();
  source.forEach((item, index) => {
    const sequence = notebookSequence(item, documents);
    if (!sequence) return;
    if (!groups.has(sequence.group)) groups.set(sequence.group, []);
    groups.get(sequence.group).push({ item, index, number: sequence.number });
  });
  const result = [...source];
  for (const records of groups.values()) {
    const sorted = [...records].sort((left, right) => left.number - right.number || left.index - right.index);
    records.map(({ index }) => index).sort((left, right) => left - right)
      .forEach((index, position) => { result[index] = sorted[position].item; });
  }
  return result;
};

export const chapterInsertionIndex = (items, chapterNumber) => {
  const chapters = items.map(([id], index) => ({ index, number: chapterNumberFromId(id) }))
    .filter(({ number }) => number > 0);
  const nextChapter = chapters.filter(({ number }) => number > chapterNumber)
    .sort((left, right) => left.number - right.number)[0];
  if (nextChapter) return nextChapter.index;
  const previousChapter = chapters.filter(({ number }) => number < chapterNumber)
    .sort((left, right) => right.number - left.number)[0];
  if (previousChapter) return previousChapter.index + 1;
  const firstNonChapter = items.findIndex(([id]) => !chapterNumberFromId(id));
  return firstNonChapter >= 0 ? firstNonChapter : items.length;
};

const explicitChineseChapterName = (value = "") => String(value).match(
  /^第\s*([\d零〇一二两三四五六七八九十百千]+)\s*章(?:[\s　:：\-—·]*(.*))?$/,
);

const explicitEnglishChapterName = (value = "") => String(value).match(
  /^(?:chapter|ch\.?)\s*(\d+)\b(?:[\s:：\-—·]*(.*))?$/i,
);

export const novelChapterCreationSpec = ({ name = "", existingIds = [], existingNumbers = [], language = "zh-CN" } = {}) => {
  const rawName = String(name).trim();
  const chineseMatch = explicitChineseChapterName(rawName);
  const englishMatch = chineseMatch ? null : explicitEnglishChapterName(rawName);
  const explicitNumber = chapterNumberValue(chineseMatch?.[1] ?? englishMatch?.[1] ?? "");
  const occupiedNumbers = [
    ...existingNumbers,
    ...existingIds
    .map((id) => chapterNumberFromId(id))
  ].map(Number).filter((number) => Number.isInteger(number) && number > 0);
  const number = explicitNumber || Math.max(0, ...occupiedNumbers) + 1;
  const explicitTitle = chineseMatch?.[2] ?? englishMatch?.[2];
  const title = String(explicitTitle ?? rawName)
    .replace(/^[\s　:：\-—·]+/, "")
    .trim()
    .slice(0, 100) || (language === "en-US" ? "Untitled" : "未命名");
  const documentId = `chapter-${number}`;
  return {
    number,
    title,
    documentId,
    explicitNumber: Boolean(explicitNumber),
    collision: occupiedNumbers.includes(number),
    label: language === "en-US" ? `Chapter ${number} ${title}` : `第${number}章　${title}`,
  };
};

export const bindConversationToCreatedDocument = ({ conversation, documentId } = {}) => {
  if (!conversation || !documentId) return false;
  const chapterNumber = chapterNumberFromId(documentId);
  conversation.boundDocumentId = documentId;
  conversation.intentTarget = chapterNumber
    ? { documentId, chapterNumber, explicitChapter: true }
    : { documentId, explicitArtifact: true };
  conversation.contextCapsule = null;
  conversation.references = (conversation.references ?? []).filter((id) => id !== documentId);
  return true;
};

export const createMissingChapterDocument = ({
  state,
  target,
  referenceDocumentId,
  updatedAt = "",
  treeOptions: requestedTreeOptions = null,
} = {}) => {
  const documentId = target?.documentId;
  const chapterNumber = chapterNumberFromId(documentId);
  if (!chapterNumber) return { created: false, documentId: null };
  if (state.documents?.[documentId]) return { created: false, documentId };

  state.moduleItems ??= {};
  state.moduleItems.manuscript ??= [];
  state.documents ??= {};
  state.histories ??= {};
  const items = state.moduleItems.manuscript;
  const treeOptions = requestedTreeOptions && typeof requestedTreeOptions === "object"
    ? { ...requestedTreeOptions, workspaceView: "novel", contextDomain: "novel" }
    : newDocumentTreeOptions({
        moduleId: "manuscript",
        viewId: "novel",
        items,
        documents: state.documents,
        activeDocumentId: referenceDocumentId,
      });
  const chapterTitle = String(target?.chapterTitle ?? "未命名").trim().replace(/^第.+?章[\s　]*/, "").slice(0, 100) || "未命名";
  const label = sequencedDocumentLabel({ documentId, title: chapterTitle, language: state.structureLanguage || "zh-CN" });
  const insertionIndex = chapterInsertionIndex(items, chapterNumber);
  items.splice(insertionIndex, 0, [documentId, label, treeOptions]);
  state.documents[documentId] = {
    title: chapterTitle,
    html: "",
    updatedAt,
    moduleId: "manuscript",
    workspaceView: "novel",
    contextDomain: "novel",
    treeGroup: treeOptions.treeGroup,
    volumeFolder: treeOptions.volumeFolder,
    volumeLabel: treeOptions.folderLabel,
    ...(treeOptions.customFolderId ? {
      customFolderId: treeOptions.customFolderId,
      customFolderName: treeOptions.customFolderLabel,
      customFolderPath: treeOptions.customFolderPath || treeOptions.customFolderLabel,
      placementOverride: true,
    } : {}),
  };
  state.histories[documentId] = [];
  return { created: true, documentId, label, treeOptions };
};
