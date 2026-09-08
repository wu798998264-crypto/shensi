const text = (value = "") => String(value ?? "").trim();

const INSERT_BEFORE_PATTERN = /(?:在|向)?(?:选区|选中内容|这段|这句|当前位置).{0,10}(?:前|之前|前面).{0,10}(?:补写|插入|插写|增补|补充|增加|添加|加入)|(?:补写|插入|插写|增补|补充|增加|添加|加入).{0,12}(?:选区|选中内容|这段|这句).{0,8}(?:前|之前|前面)/u;
const INSERT_AFTER_PATTERN = /(?:在|向)?(?:选区|选中内容|这段|这句|当前位置).{0,10}(?:后|之后|后面).{0,10}(?:补写|插入|插写|增补|补充|增加|添加|加入|续写)|(?:补写|插入|插写|增补|补充|增加|添加|加入|续写).{0,12}(?:选区|选中内容|这段|这句).{0,8}(?:后|之后|后面)/u;
const INSERT_PATTERN = /补写|插入|插写|增补|补充|增加|添加|加入|续写/u;

export const inlineSelectionMutationMode = ({ instruction = "", hasSelection = true, requestedMode = "" } = {}) => {
  const explicitMode = text(requestedMode);
  if (["replace", "insert_before", "insert_after", "insert_at_caret"].includes(explicitMode)) return explicitMode;
  const source = text(instruction);
  if (!hasSelection) return "insert_at_caret";
  if (INSERT_BEFORE_PATTERN.test(source)) return "insert_before";
  if (INSERT_AFTER_PATTERN.test(source) || INSERT_PATTERN.test(source)) return "insert_after";
  return "replace";
};

export const inlineEditModeLabel = (mode = "replace") => ({
  replace: "局部修改",
  insert_before: "在选区前补写",
  insert_after: "在选区后补写",
  insert_at_caret: "从此处补写",
})[mode] || "局部修改";

export const inlineEditAppliedText = ({ mode = "replace", originalText = "", candidate = "" } = {}) => {
  const original = String(originalText ?? "");
  const addition = String(candidate ?? "").trim();
  if (mode === "insert_before") return `${addition}${original}`;
  if (mode === "insert_after") return `${original}${addition}`;
  if (mode === "insert_at_caret") return addition;
  return addition;
};

export const inlineEditChangeSet = ({ mode = "replace", originalText = "", candidate = "", startOffset = 0 } = {}) => {
  const original = String(originalText ?? "");
  const addition = String(candidate ?? "").trim();
  const start = Math.max(0, Number(startOffset) || 0);
  if (mode === "insert_before" || mode === "insert_at_caret") return [{
    editId: `inline-${mode}`,
    start,
    end: start,
    before: "",
    after: addition,
  }];
  if (mode === "insert_after") return [{
    editId: "inline-insert-after",
    start: start + original.length,
    end: start + original.length,
    before: "",
    after: addition,
  }];
  return [{
    editId: "inline-replace",
    start,
    end: start + original.length,
    before: original,
    after: addition,
  }];
};

export const buildInlineSelectionPrompt = ({ selectedText = "", instruction = "", anchor = null, documentTitle = "", mode = "" } = {}) => {
  const selected = String(selectedText).trim();
  const requirement = String(instruction).trim();
  const mutationMode = inlineSelectionMutationMode({ instruction: requirement, hasSelection: Boolean(selected), requestedMode: mode });
  if (!requirement || (mutationMode !== "insert_at_caret" && !selected)) return "";
  const prefix = String(anchor?.prefix ?? "").slice(-600).trim();
  const suffix = String(anchor?.suffix ?? "").slice(0, 600).trim();
  const insertion = mutationMode !== "replace";
  return [
    insertion
      ? "局部补写任务。直接生成需要插入的新内容，不要追问；程序会在可信锚点处插入，禁止改写、复述或省略插入点两侧原文。"
      : "局部修改任务。直接生成替换版本，不要追问；该版本必须能够原位替换，不要重写选区之外的内容。",
    `操作方式：${inlineEditModeLabel(mutationMode)}`,
    documentTitle ? `目标文档：${String(documentTitle).trim()}` : "",
    prefix ? `插入点前文锚点：\n${prefix}` : "",
    selected ? `${insertion ? "受保护的选中文字（必须逐字保持不变）" : "选中文字"}：\n${selected}` : "",
    suffix ? `插入点后文锚点：\n${suffix}` : "",
    `${insertion ? "补写" : "修改"}要求：${requirement}`,
    insertion
      ? "完整理解前文和后文，使新增片段同时承接两侧内容。只返回新增片段本身，不要返回受保护选区、上下文、标题、解释、引号或补丁标记。"
      : "保持前后事实、指代、语气、时态和段落衔接一致。只返回能够直接替换选中文字的文本本身，不要附带标题、解释、引号、补丁标记或未修改的上下文。",
  ].filter(Boolean).join("\n\n");
};

export const inlineContextPosition = ({ startOffset = 0, endOffset = 0, totalLength = 0 } = {}) => {
  const total = Math.max(0, Number(totalLength) || 0);
  if (!total) return "middle";
  const edgeSize = Math.min(800, Math.max(120, Math.round(total * 0.2)));
  const nearStart = Math.max(0, Number(startOffset) || 0) <= edgeSize;
  const nearEnd = total - Math.max(0, Number(endOffset) || 0) <= edgeSize;
  if (nearStart && nearEnd) return "both";
  if (nearStart) return "start";
  if (nearEnd) return "end";
  return "middle";
};

export const inlineContextDocumentIds = ({ documentId = "", position = "middle", hasDocument = () => false, hasSubstantive = hasDocument } = {}) => {
  const ids = [];
  const add = (id) => {
    if (id && hasDocument(id) && !ids.includes(id)) ids.push(id);
  };
  const includeStart = position === "start" || position === "both";
  const includeEnd = position === "end" || position === "both";
  const chapterNumber = Number(String(documentId).match(/^chapter-(\d+)$/)?.[1] ?? 0);
  const episodeNumber = Number(String(documentId).match(/^script-episode-(\d+)$/)?.[1] ?? 0);
  if (chapterNumber && includeStart && hasSubstantive(`chapter-${chapterNumber - 1}`)) add(`chapter-${chapterNumber - 1}`);
  if (episodeNumber && includeStart && hasSubstantive(`script-episode-${episodeNumber - 1}`)) add(`script-episode-${episodeNumber - 1}`);
  add(documentId);
  if (chapterNumber && includeEnd) {
    const nextChapter = `chapter-${chapterNumber + 1}`;
    if (hasSubstantive(nextChapter)) add(nextChapter);
    else add(`outline-chapter-${chapterNumber + 1}`);
  }
  if (episodeNumber && includeEnd) {
    const nextEpisode = `script-episode-${episodeNumber + 1}`;
    if (hasSubstantive(nextEpisode)) add(nextEpisode);
    else add(`script-outline-episode-${episodeNumber + 1}`);
  }
  return ids;
};
