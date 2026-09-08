const mediaPaths = (html = "") => [...String(html).matchAll(/data-attachment-path=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .filter(Boolean);

const artifactIds = (html = "") => [...String(html).matchAll(/data-artifact-id=["']([^"']+)["']/gi)]
  .map((match) => match[1])
  .filter(Boolean);

export const protectedDocumentMediaFragments = (html = "") => {
  const source = String(html || "");
  const figures = [...source.matchAll(/<figure\b[^>]*>[\s\S]*?<\/figure>/gi)]
    .map((match) => match[0])
    .filter((fragment) => /data-(?:attachment-path|artifact-id)=/i.test(fragment));
  const figurePaths = new Set(figures.flatMap(mediaPaths));
  const standaloneImages = [...source.matchAll(/<img\b[^>]*data-attachment-path=["'][^"']+["'][^>]*>/gi)].map((match) => match[0]);
  const standalonePlayable = [...source.matchAll(/<(video|audio)\b[^>]*data-attachment-path=["'][^"']+["'][^>]*>[\s\S]*?<\/\1>/gi)].map((match) => match[0]);
  const standalone = [...standaloneImages, ...standalonePlayable]
    .filter((fragment) => mediaPaths(fragment).some((path) => !figurePaths.has(path)));
  return [...figures, ...standalone];
};

export const preserveProtectedDocumentMedia = ({ previousHtml = "", nextHtml = "" } = {}) => {
  const next = String(nextHtml || "");
  const existingPaths = new Set(mediaPaths(next));
  const existingArtifacts = new Set(artifactIds(next));
  const missing = protectedDocumentMediaFragments(previousHtml).filter((fragment) => {
    const paths = mediaPaths(fragment);
    const artifacts = artifactIds(fragment);
    if (paths.length && paths.every((path) => existingPaths.has(path))) return false;
    if (!paths.length && artifacts.length && artifacts.every((id) => existingArtifacts.has(id))) return false;
    paths.forEach((path) => existingPaths.add(path));
    artifacts.forEach((id) => existingArtifacts.add(id));
    return true;
  });
  return missing.length ? `${next}${missing.join("")}` : next;
};
