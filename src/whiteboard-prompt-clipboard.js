// Clipboard contents are user-visible data.  Do not normalize whitespace here:
// leading/trailing spaces, line breaks and Markdown punctuation are all part of
// the selected prompt and must survive a copy/paste round trip.
const text = (value) => (value == null ? "" : String(value));

export const enrichWhiteboardPromptClipboardSegments = (
  segments = [],
  { references = [], contentForNode = (node) => text(node?.text) } = {},
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
    if (content === "") return segment;
    // Expand every occurrence.  A repeated reference is intentional user
    // content and must remain repeated in the same order when copied.
    return { ...segment, content };
  });
};

export const whiteboardPromptClipboardText = (segments = []) => (Array.isArray(segments) ? segments : []).map((segment) => {
  if (segment?.kind === "text") return text(segment.text);
  if (segment?.kind !== "reference") return "";
  const token = text(segment.token);
  const content = text(segment.content);
  return content === "" ? token : `${token}\n【已插入参考内容】\n${content}`;
}).join("");
