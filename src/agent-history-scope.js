const normalizedPath = (value = "") => String(value || "")
  .trim()
  .replace(/^"|"$/g, "")
  .replaceAll("\\", "/")
  .replace(/\/+/g, "/")
  .replace(/\/$/, "");

const comparablePath = (value = "") => normalizedPath(value).toLocaleLowerCase("en-US");
const absolutePath = (value = "") => /^(?:[a-z]:\/|\/)/i.test(normalizedPath(value));

const pathRelativeTo = (file, root) => {
  const source = normalizedPath(file).replace(/^(?:a|b)\//, "");
  const normalizedRoot = normalizedPath(root);
  if (!source) return "";
  if (!absolutePath(source)) return source;
  const sourceKey = comparablePath(source);
  const rootKey = comparablePath(normalizedRoot);
  if (sourceKey === rootKey) return "";
  if (!sourceKey.startsWith(`${rootKey}/`)) return null;
  return source.slice(normalizedRoot.length + 1);
};

const documentPlacement = (documentId, documentState, moduleItems = {}) => {
  const located = Object.entries(moduleItems).find(([, items]) => (
    Array.isArray(items) && items.some(([id]) => id === documentId)
  ));
  const moduleId = documentState?.moduleId || located?.[0] || "library";
  const item = located?.[1]?.find(([id]) => id === documentId) || [];
  const options = item?.[2] || {};
  const viewId = options.workspaceView || (["manuscript", "outline", "canon", "memory"].includes(moduleId) ? "novel" : "default");
  return {
    documentId,
    moduleId,
    viewId,
    volumeId: options.customFolderId || options.folderId || null,
    structural: false,
  };
};

export const agentHistoryTargetsForFiles = ({
  files = [],
  workspacePath = "",
  agentCwd = "",
  documents = {},
  moduleItems = {},
} = {}) => {
  if (!workspacePath || !agentCwd || comparablePath(workspacePath) !== comparablePath(agentCwd)) return [];
  const documentsByPath = new Map(Object.entries(documents)
    .map(([documentId, documentState]) => [comparablePath(documentState?.sourcePath || documentState?.relativePath), { documentId, documentState }])
    .filter(([path]) => path));
  const targets = [];
  const identities = new Set();
  for (const file of [...new Set((Array.isArray(files) ? files : []).map(String).filter(Boolean))]) {
    const relativePath = pathRelativeTo(file, agentCwd);
    if (relativePath == null || !relativePath || comparablePath(relativePath).startsWith(".shensi/")) continue;
    if (!/\.md$/i.test(relativePath)) continue;
    const matched = documentsByPath.get(comparablePath(relativePath));
    const target = matched
      ? documentPlacement(matched.documentId, matched.documentState, moduleItems)
      : { scopeType: "project", structural: true, sourcePath: normalizedPath(relativePath) };
    const identity = target.scopeType === "project" ? "project" : target.documentId;
    if (identities.has(identity)) continue;
    identities.add(identity);
    targets.push(target);
  }
  return targets;
};

