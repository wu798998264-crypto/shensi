const normalize = (value = "") => String(value).replace(/\s+/g, " ").trim();

export const createIncrementalGlobalSearchIndex = () => {
  const cache = new Map();
  const keyFor = (workspaceKey, documentId) => `${workspaceKey}::${documentId}`;

  const get = ({ workspaceKey, documentId, documentState, normalizeCanvas, documentText }) => {
    const key = keyFor(workspaceKey, documentId);
    const cached = cache.get(key);
    if (cached) return cached;
    const title = documentState?.title || "未命名文档";
    let indexed;
    if (documentState?.documentKind === "whiteboard") {
      const canvas = normalizeCanvas(documentState.canvas);
      indexed = {
        documentId,
        documentState,
        title,
        titleSearch: title.toLocaleLowerCase("zh-CN"),
        canvas,
        nodes: canvas.nodes.map((node) => {
          const text = normalize(node.text);
          return { node, text, search: text.toLocaleLowerCase("zh-CN") };
        }),
        assets: canvas.assets.filter((asset) => asset.kind === "text").map((asset) => {
          const text = normalize(asset.text);
          return { asset, text, search: text.toLocaleLowerCase("zh-CN") };
        }),
      };
    } else {
      const text = normalize(documentText(documentState));
      indexed = { documentId, documentState, title, text, search: `${title} ${text}`.toLocaleLowerCase("zh-CN") };
    }
    cache.set(key, indexed);
    return indexed;
  };

  const invalidate = (workspaceKey, documentId) => cache.delete(keyFor(workspaceKey, documentId));
  const clear = () => cache.clear();
  const size = () => cache.size;

  return { clear, get, invalidate, size };
};
