const DESTINATIONS = Object.freeze({
  public_account: { placement: "dedicated_notebook", notebookName: "公众号文章", label: "公众号文章" },
  short_video_script: { placement: "active_notebook", label: "短视频脚本" },
  short_fiction: { placement: "active_notebook", label: "短篇小说" },
  visual_prompt: { placement: "active_notebook", label: "提示词" },
});

const PROJECT_PROMPT_TRANSFORMATION = /(?:把|将|根据|基于|读取|参考).{0,48}(?:小说|故事|剧本|短剧|漫剧|正文|章节|大纲|当前内容|本项目|本作|第\s*[零一二两三四五六七八九十百千万\d]+\s*[章集]).{0,32}(?:改编成|改编为|改成|改写成|转换成|转换为|转化成|转化为|转成|制作成|生成).{0,12}(?:提示词|分镜)|(?:小说|剧本|短剧|漫剧|章节|剧情).{0,20}(?:转|改|生成|制作).{0,12}(?:视频|图片|分镜|镜头|视觉资产)?提示词/;

export const projectLinkedPromptRequest = ({ text = "", targetDocumentId = "", hasProjectReferences = false } = {}) => (
  String(targetDocumentId).startsWith("prompt-")
  || hasProjectReferences === true
  || PROJECT_PROMPT_TRANSFORMATION.test(String(text))
);

export const notebookDestinationForDeliverable = ({
  deliverableType = "",
  text = "",
  targetDocumentId = "",
  hasProjectReferences = false,
} = {}) => {
  const destination = DESTINATIONS[deliverableType];
  if (!destination) return null;
  if (deliverableType === "visual_prompt" && projectLinkedPromptRequest({ text, targetDocumentId, hasProjectReferences })) return null;
  return { deliverableType, ...destination };
};

const cleanHeadingText = (value = "") => String(value)
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/\s+/g, " ")
  .trim();

export const standaloneDocumentParts = ({ content = "", fallbackTitle = "未命名" } = {}) => {
  const source = String(content ?? "").replace(/\r\n?/g, "\n").trim();
  const htmlHeading = source.match(/^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>\s*/i);
  if (htmlHeading) return {
    title: cleanHeadingText(htmlHeading[1]) || fallbackTitle,
    body: source.slice(htmlHeading[0].length).trim(),
  };
  const markdownHeading = source.match(/^\s*#\s+([^\n]+)\n*/);
  if (markdownHeading) return {
    title: cleanHeadingText(markdownHeading[1]) || fallbackTitle,
    body: source.slice(markdownHeading[0].length).trim(),
  };
  const centeredHeading = source.match(/^\s*<(?:div|p)\b[^>]*(?:align=["']?center["']?|text-align\s*:\s*center)[^>]*>([\s\S]*?)<\/(?:div|p)>\s*/i);
  if (centeredHeading) return {
    title: cleanHeadingText(centeredHeading[1]) || fallbackTitle,
    body: source.slice(centeredHeading[0].length).trim(),
  };
  const firstLine = source.match(/^([^\n]{2,60})\n\s*\n/);
  if (firstLine && !/[。！？!?；;：:]\s*$/.test(firstLine[1]) && !/^(?:摘要|正文|开头|引言|导语|脚本|提示词)$/.test(firstLine[1].trim())) {
    return {
      title: cleanHeadingText(firstLine[1]) || fallbackTitle,
      body: source.slice(firstLine[0].length).trim(),
    };
  }
  return { title: fallbackTitle, body: source };
};

const blankManagedNote = (documentState = {}) => (
  documentState?.documentKind !== "whiteboard"
  && documentState?.systemGeneratedTitle === true
  && !String(documentState?.html || documentState?.markdown || "").trim()
  && /^(?:未命名笔记|Untitled Note)$/.test(String(documentState?.title || ""))
);

const uniqueNoteId = (documents = {}, now = Date.now()) => {
  let suffix = Math.max(1, Number(now) || Date.now());
  while (documents[`note-${suffix}`]) suffix += 1;
  return `note-${suffix}`;
};

export const materializeNotebookDeliverable = (workspaceState, {
  notebookName,
  deliverableType,
  title,
  html,
  landingKey = "",
  sourceWorkspaceName = "",
  sourceConversationId = "",
  updatedAt = "刚刚",
  now = Date.now(),
} = {}) => {
  const state = workspaceState;
  state.workspaceKind = "notebook";
  state.projectName = notebookName || state.projectName || "我的笔记";
  state.activeModule = "library";
  state.moduleItems ??= {};
  for (const moduleId of ["manuscript", "outline", "canon", "memory", "reports", "library", "index"]) state.moduleItems[moduleId] ??= [];
  state.documents ??= {};
  state.histories ??= {};
  state.activities ??= [];
  const duplicate = landingKey
    ? Object.entries(state.documents).find(([, documentState]) => documentState?.generationLandingKey === landingKey)
    : null;
  if (duplicate) return { created: false, duplicate: true, documentId: duplicate[0], title: duplicate[1].title };

  const reusable = Object.entries(state.documents).find(([, documentState]) => blankManagedNote(documentState));
  const documentId = reusable?.[0] || uniqueNoteId(state.documents, now);
  const safeTitle = String(title || "未命名").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180) || "未命名";
  const itemOptions = { workspaceView: "default", contextDomain: "general", placementOverride: true };
  for (const items of Object.values(state.moduleItems)) {
    const index = items.findIndex(([id]) => id === documentId);
    if (index >= 0) items.splice(index, 1);
  }
  state.moduleItems.library.push([documentId, safeTitle, itemOptions]);
  state.documents[documentId] = {
    ...(state.documents[documentId] ?? {}),
    title: safeTitle,
    html: String(html || ""),
    updatedAt,
    moduleId: "library",
    workspaceView: "default",
    contextDomain: "general",
    placementOverride: true,
    documentKind: "note",
    systemGeneratedTitle: false,
    deliverableType,
    generationLandingKey: landingKey || undefined,
    sourceWorkspaceName: sourceWorkspaceName || undefined,
    sourceConversationId: sourceConversationId || undefined,
  };
  state.histories[documentId] ??= [];
  state.activeDocument = documentId;
  state.activities.unshift({
    id: `activity-${now}`,
    type: "edit",
    label: `自动归类并保存“${safeTitle}”`,
    documentId,
    time: updatedAt,
  });
  return { created: true, reusedBlank: Boolean(reusable), duplicate: false, documentId, title: safeTitle };
};
