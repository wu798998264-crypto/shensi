import { chapterNumberValue } from "./chapter-target.js";

const text = (value = "") => String(value ?? "").trim();
const TEMPORARY_FOLDER_PATTERN = /(?:未命名|新建文件夹|untitled|new folder)/iu;
const GENERIC_VOLUME_TITLE_PATTERN = /^(?:第\s*[\d零〇一二两三四五六七八九十百千]+\s*卷[\s　:：·—-]*)?(?:卷纲|分卷大纲|卷大纲|未命名)?$/u;

const visibleText = (value = "") => String(value ?? "")
  .replace(/<\s*br\s*\/?\s*>/giu, "\n")
  .replace(/<\/(?:p|div|h[1-6]|li|tr|section)>/giu, "\n")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&nbsp;|&#160;/giu, " ")
  .replace(/&amp;/giu, "&")
  .replace(/\r\n?/gu, "\n")
  .replace(/[ \t]+/gu, " ")
  .replace(/\n{3,}/gu, "\n\n")
  .trim();

const safeFolderLabel = (value = "") => text(value)
  .replace(/[\\/*?"<>|]/gu, "-")
  .replace(/[:：]+/gu, "·")
  .replace(/[.\s]+$/gu, "")
  .replace(/\s{2,}/gu, " ")
  .slice(0, 120)
  .trim();

const ordinal = (value = "") => chapterNumberValue(String(value).trim());

const chapterRange = (documentState = {}) => {
  const stored = documentState?.longFormVolumeRange;
  const storedStart = Number(stored?.startChapter) || 0;
  const storedEnd = Number(stored?.endChapter) || 0;
  if (storedStart > 0 && storedEnd >= storedStart) return { startChapter: storedStart, endChapter: storedEnd };
  const source = visibleText(documentState?.html ?? documentState?.markdown ?? documentState?.text ?? "");
  const match = source.match(/(?:章节范围\s*[：:]\s*)?第?\s*([\d零〇一二两三四五六七八九十百千]+)\s*章?\s*(?:至|到|[-~～—])\s*第?\s*([\d零〇一二两三四五六七八九十百千]+)\s*章/u);
  const startChapter = ordinal(match?.[1] ?? "");
  const endChapter = ordinal(match?.[2] ?? "");
  return startChapter > 0 && endChapter >= startChapter ? { startChapter, endChapter } : null;
};

const declaredSeriesChapterRange = (value = "") => {
  const match = text(value).match(/^(?:(?:章节范围|卷内章节|本卷章节)\s*[：:]\s*)?第?\s*([\d零〇一二两三四五六七八九十百千]+)\s*章\s*(?:至|到|[-~～—])\s*第?\s*([\d零〇一二两三四五六七八九十百千]+)\s*章\s*$/u);
  const startChapter = ordinal(match?.[1] ?? "");
  const endChapter = ordinal(match?.[2] ?? "");
  return startChapter > 0 && endChapter >= startChapter ? { startChapter, endChapter } : null;
};

const volumeHeading = (value = "") => text(value).match(/^第\s*([\d零〇一二两三四五六七八九十百千]+)\s*卷(?:\s*[：:·—-]\s*|\s+|(?=[《〈“"'])|$)([^\n]*)/u);

const namedVolumeLabel = ({ value = "", volumeNumber = 0 } = {}) => {
  const source = safeFolderLabel(value).replace(/^(?:卷名|分卷名称|卷标题|标题)\s*[·:：-]\s*/u, "").trim();
  if (!source || TEMPORARY_FOLDER_PATTERN.test(source) || GENERIC_VOLUME_TITLE_PATTERN.test(source)) return "";
  const heading = volumeHeading(source);
  if (heading) {
    const name = safeFolderLabel(heading[2])
      .replace(/^(?:卷纲|分卷大纲|分卷规划)\s*[·:：—-]*\s*/u, "")
      .replace(/^[·:：—-]+/u, "")
      .replace(/^[《〈“"']+|[》〉”"']+$/gu, "")
      .trim();
    if (!name || /^(?:规划|大纲|卷纲|分卷规划|分卷大纲)$/u.test(name) || TEMPORARY_FOLDER_PATTERN.test(name)) return "";
    return safeFolderLabel(`第${heading[1]}卷·${name}`);
  }
  return volumeNumber > 0 ? safeFolderLabel(`第${volumeNumber}卷·${source}`) : source;
};

const volumeNumberFromDocument = (documentId = "", documentState = {}) => {
  const stored = Number(documentState?.longFormVolumeNumber || documentState?.volumeNumber) || 0;
  if (stored > 0) return stored;
  const idNumber = Number(String(documentId).match(/^outline-volume-(\d+)$/u)?.[1]) || 0;
  if (idNumber > 0) return idNumber;
  const heading = volumeHeading(documentState?.title || visibleText(documentState?.html ?? ""));
  return ordinal(heading?.[1] ?? "");
};

const volumeNameFromDocument = (documentId = "", documentState = {}) => {
  const volumeNumber = volumeNumberFromDocument(documentId, documentState);
  const explicit = [
    documentState?.plannedFolderLabel,
    documentState?.longFormVolumeTitle,
    documentState?.volumeTitle,
  ].map(text).find(Boolean);
  if (explicit) return namedVolumeLabel({ value: explicit, volumeNumber });
  const titleLabel = namedVolumeLabel({ value: documentState?.title, volumeNumber });
  if (titleLabel) return titleLabel;
  const source = visibleText(documentState?.html ?? documentState?.markdown ?? documentState?.text ?? "");
  const declared = source.match(/(?:^|\n)\s*(?:卷名|分卷名称|卷标题)\s*[：:]\s*([^\n]+)/u)?.[1];
  if (declared) return namedVolumeLabel({ value: declared, volumeNumber });
  const heading = source.split("\n").map((line) => volumeHeading(line)).find(Boolean);
  return heading ? namedVolumeLabel({ value: heading[0], volumeNumber: ordinal(heading[1]) || volumeNumber }) : "";
};

const seriesVolumePlans = (documents = {}) => {
  const plans = [];
  for (const [documentId, documentState] of Object.entries(documents ?? {})) {
    if (!/^outline-(?:series|general)/u.test(documentId)) continue;
    const lines = visibleText(documentState?.html ?? documentState?.markdown ?? documentState?.text ?? "").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const heading = volumeHeading(lines[index]);
      if (!heading) continue;
      const nextHeading = lines.slice(index + 1).findIndex((line) => volumeHeading(line));
      const end = nextHeading < 0 ? lines.length : index + 1 + nextHeading;
      // 全集大纲只能使用紧邻卷标题的独立范围声明。带序号、章节标题或
      // “逐章章纲”的全局小节不能作为分卷证据，避免剧情句误建空卷。
      const range = lines
        .slice(index + 1, Math.min(end, index + 3))
        .map((line) => declaredSeriesChapterRange(line))
        .find(Boolean) ?? null;
      const volumeNumber = ordinal(heading[1]);
      const folderLabel = namedVolumeLabel({ value: heading[0], volumeNumber });
      if (range && folderLabel) plans.push({ ...range, volumeNumber, folderLabel, sourceDocumentId: documentId });
    }
  }
  return plans;
};

export const plannedVolumeFolderForChapter = ({ chapterNumber = 0, target = {}, documents = {} } = {}) => {
  const number = Number(chapterNumber || target?.chapterNumber || String(target?.documentId || "").match(/^chapter-(\d+)$/u)?.[1]) || 0;
  if (!number) return null;
  const explicitValue = target?.plannedFolderLabel || target?.plannedVolumeTitle || "";
  const explicitLabel = namedVolumeLabel({
    value: explicitValue,
    volumeNumber: Number(target?.plannedVolumeNumber) || 0,
  });
  if (explicitLabel) return {
    chapterNumber: number,
    folderLabel: explicitLabel,
    volumeFolder: explicitLabel,
    volumeNumber: Number(target?.plannedVolumeNumber) || ordinal(volumeHeading(explicitLabel)?.[1] ?? ""),
    sourceDocumentId: text(target?.folderSourceDocumentId),
  };

  for (const [documentId, documentState] of Object.entries(documents ?? {})) {
    if (!documentId.startsWith("outline-volume-")) continue;
    const range = chapterRange(documentState);
    if (!range || number < range.startChapter || number > range.endChapter) continue;
    const folderLabel = volumeNameFromDocument(documentId, documentState);
    if (!folderLabel) return null;
    return {
      chapterNumber: number,
      folderLabel,
      volumeFolder: folderLabel,
      volumeNumber: volumeNumberFromDocument(documentId, documentState),
      sourceDocumentId: documentId,
      ...range,
    };
  }

  const seriesPlan = seriesVolumePlans(documents).find((plan) => number >= plan.startChapter && number <= plan.endChapter);
  return seriesPlan ? { chapterNumber: number, volumeFolder: seriesPlan.folderLabel, ...seriesPlan } : null;
};

const itemForDocument = (state, documentId) => Object.values(state?.moduleItems ?? {})
  .flat()
  .find((item) => item?.[0] === documentId) ?? null;

const folderKeyForOptions = (options = {}) => text(options.customFolderId || options.folderId);
const folderLabelForOptions = (options = {}) => text(options.customFolderLabel || options.folderLabel || options.volumeFolder);

const folderOptions = (record) => ({
  ...(record.parentOptions ?? {}),
  workspaceView: record.viewId,
  contextDomain: ["script", "prompts"].includes(record.viewId) ? "script" : "novel",
  treeGroup: record.moduleId === "manuscript" && record.viewId === "novel" ? "volume" : record.parentOptions?.treeGroup,
  folderId: record.id,
  folderLabel: record.label,
  volumeFolder: record.label,
  customFolderId: record.id,
  customFolderLabel: record.label,
  customFolderPath: record.folderPath || record.label,
  placementOverride: true,
});

const updateFolderGroupLabel = ({ state, folderId, label }) => {
  const record = (state.customFolders ?? []).find((folder) => folder.id === folderId);
  if (record) {
    record.label = label;
    record.systemGeneratedLabel = false;
    record.folderPath = label;
    Object.assign(record.parentOptions ?? (record.parentOptions = {}), { folderId, folderLabel: label, volumeFolder: label, treeGroup: "volume" });
  }
  for (const item of state.moduleItems?.manuscript ?? []) {
    const options = item?.[2] ?? (item[2] = {});
    if (folderKeyForOptions(options) !== folderId) continue;
    Object.assign(options, {
      folderLabel: label,
      volumeFolder: label,
      ...(options.customFolderId ? { customFolderLabel: label, customFolderPath: label } : {}),
    });
    const documentState = state.documents?.[item[0]];
    if (!documentState) continue;
    Object.assign(documentState, {
      volumeLabel: label,
      volumeFolder: label,
      ...(options.customFolderId ? { customFolderName: label, customFolderPath: label } : {}),
    });
  }
};

const groupCanAdoptPlan = ({ state, folderId, folderLabel, documents }) => {
  const chapters = (state.moduleItems?.manuscript ?? [])
    .filter((item) => folderKeyForOptions(item?.[2]) === folderId)
    .map((item) => Number(String(item?.[0] || "").match(/^chapter-(\d+)$/u)?.[1]) || 0)
    .filter(Boolean);
  if (!chapters.length) return false;
  return chapters.every((number) => plannedVolumeFolderForChapter({ chapterNumber: number, documents })?.folderLabel === folderLabel);
};

export const applyPlannedFolderToDocument = ({ state, documentId, folder }) => {
  if (!folder?.treeOptions || !documentId) return false;
  const item = itemForDocument(state, documentId);
  if (!item) return false;
  const options = item[2] ?? (item[2] = {});
  Object.assign(options, folder.treeOptions);
  const documentState = state.documents?.[documentId];
  if (documentState) Object.assign(documentState, {
    moduleId: "manuscript",
    workspaceView: "novel",
    contextDomain: "novel",
    treeGroup: "volume",
    volumeFolder: folder.folderLabel,
    volumeLabel: folder.folderLabel,
    ...(folder.treeOptions.customFolderId ? {
      customFolderId: folder.treeOptions.customFolderId,
      customFolderName: folder.folderLabel,
      customFolderPath: folder.treeOptions.customFolderPath || folder.folderLabel,
    } : {}),
  });
  return true;
};

export const ensurePlannedChapterFolder = ({
  state,
  target = {},
  referenceDocumentId = "",
  createFolderId = () => `custom-folder:${Date.now().toString(36)}`,
  createdAt = new Date().toISOString(),
} = {}) => {
  const plan = plannedVolumeFolderForChapter({ target, documents: state?.documents ?? {} });
  if (!plan) return { planned: false, created: false, renamed: false, treeOptions: null };
  state.customFolders ??= [];
  state.expandedFolders ??= [];
  const folderLabel = plan.folderLabel;
  let record = state.customFolders.find((folder) => (
    folder.moduleId === "manuscript" && folder.viewId === "novel" && text(folder.label).toLocaleLowerCase() === folderLabel.toLocaleLowerCase()
  ));
  let folderId = record?.id || "";
  let renamed = false;

  if (!folderId) {
    const matchingVirtual = (state.moduleItems?.manuscript ?? []).find((item) => (
      folderLabelForOptions(item?.[2]).toLocaleLowerCase() === folderLabel.toLocaleLowerCase()
    ));
    folderId = folderKeyForOptions(matchingVirtual?.[2]);
  }

  if (!folderId) {
    const candidates = [target?.documentId, referenceDocumentId]
      .map((documentId) => itemForDocument(state, documentId))
      .filter(Boolean);
    const adoptable = candidates.find((item) => {
      const options = item?.[2] ?? {};
      const candidateId = folderKeyForOptions(options);
      if (!candidateId) return false;
      return groupCanAdoptPlan({ state, folderId: candidateId, folderLabel, documents: state.documents })
        || TEMPORARY_FOLDER_PATTERN.test(folderLabelForOptions(options))
          && groupCanAdoptPlan({ state, folderId: candidateId, folderLabel, documents: state.documents });
    });
    folderId = folderKeyForOptions(adoptable?.[2]);
    if (folderId) {
      updateFolderGroupLabel({ state, folderId, label: folderLabel });
      record = state.customFolders.find((folder) => folder.id === folderId) ?? null;
      renamed = true;
    }
  }

  let created = false;
  if (!folderId) {
    folderId = text(createFolderId(folderLabel)) || `custom-folder:${Date.now().toString(36)}`;
    while (state.customFolders.some((folder) => folder.id === folderId)) folderId = `${folderId}-next`;
    record = {
      id: folderId,
      label: folderLabel,
      systemGeneratedLabel: false,
      moduleId: "manuscript",
      viewId: "novel",
      parentLocationId: "manuscript:novel:root",
      parentLabel: "小说正文",
      parentOptions: {
        workspaceView: "novel",
        contextDomain: "novel",
        folderId,
        folderLabel,
        volumeFolder: folderLabel,
        treeGroup: "volume",
      },
      folderPath: folderLabel,
      createdAt,
    };
    state.customFolders.push(record);
    state.expandedFolders.push(folderId);
    created = true;
  }

  const treeOptions = record ? folderOptions(record) : {
    workspaceView: "novel",
    contextDomain: "novel",
    treeGroup: "volume",
    folderId,
    folderLabel,
    volumeFolder: folderLabel,
    placementOverride: true,
  };
  const result = { ...plan, planned: true, created, renamed, folderId, folderLabel, volumeFolder: folderLabel, treeOptions };
  if (state.documents?.[target?.documentId]) applyPlannedFolderToDocument({ state, documentId: target.documentId, folder: result });
  return result;
};

export const documentMatchesPlannedFolder = ({ state, documentId, folderLabel = "" } = {}) => {
  if (!folderLabel || !documentId) return true;
  const item = itemForDocument(state, documentId);
  const options = item?.[2] ?? {};
  const documentState = state?.documents?.[documentId] ?? {};
  const actual = text(options.customFolderLabel || options.folderLabel || options.volumeFolder || documentState.customFolderName || documentState.volumeLabel || documentState.volumeFolder);
  return actual === text(folderLabel);
};
