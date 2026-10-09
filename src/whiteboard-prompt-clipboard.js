// Clipboard contents are user-visible data.  Do not normalize whitespace here:
// leading/trailing spaces, line breaks and Markdown punctuation are all part of
// the selected prompt and must survive a copy/paste round trip.
const text = (value) => (value == null ? "" : String(value));

export const enrichWhiteboardPromptClipboardSegments = (
  segments = [],
  { references = [], contentForNode = (node) => text(node?.text), source = {} } = {},
) => {
  const nodeById = new Map((Array.isArray(references) ? references : [])
    .filter((node) => node?.id)
    .map((node) => [String(node.id), node]));
  return (Array.isArray(segments) ? segments : []).map((segment) => {
    if (segment?.kind !== "reference") return segment;
    const referenceId = String(segment.nodeId || "");
    const node = nodeById.get(referenceId);
    if (!node) return segment;
    const content = text(contentForNode(node));
    // Canvas media nodes store `file` as a relative path; imported attachment
    // records may instead carry a file descriptor.
    const file = typeof node.file === "string" ? {
      relativePath: node.file, name: node.name, mimeType: node.mimeType,
      size: node.size, durationMs: node.durationMs,
    } : node.file;
    const portableReference = {
      kind: node.kind, title: text(node.title || node.name), text: content,
      width: Number(node.width) || 320, height: Number(node.height) || 180,
      workspacePath: text(source.workspacePath), documentId: text(source.documentId),
      ...(["image", "video", "audio"].includes(node.kind) && file?.relativePath ? { file: {
        relativePath: text(file.relativePath), name: text(file.name), mimeType: text(file.mimeType),
        size: Number(file.size) || 0, durationMs: Number(file.durationMs) || 0,
      } } : {}),
    };
    if (content === "") return { ...segment, reference: portableReference };
    // Expand every occurrence.  A repeated reference is intentional user
    // content and must remain repeated in the same order when copied.
    return { ...segment, content, reference: portableReference };
  });
};

export const whiteboardPromptClipboardText = (segments = []) => (Array.isArray(segments) ? segments : []).map((segment) => {
  if (segment?.kind === "text") return text(segment.text);
  if (segment?.kind !== "reference") return "";
  const token = text(segment.token);
  const content = text(segment.content);
  return content === "" ? token : `${token}\n【已插入参考内容】\n${content}`;
}).join("");

export const parseWhiteboardPromptClipboardPayload = (value) => {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    if (parsed?.version !== 1 || !Array.isArray(parsed.segments) || parsed.segments.length > 2000) return null;
    if (parsed.segments.some((segment) => !segment || !["text", "reference"].includes(segment.kind))) return null;
    return parsed.segments;
  } catch { return null; }
};

export const hasWhiteboardPromptClipboardHtml = (html = "") => /\bdata-(?:shensi-generation-prompt|rich-mention-(?:token|node-id))\s*=/iu.test(text(html));
