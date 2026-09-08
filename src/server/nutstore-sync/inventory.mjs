import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { collectAllowedFiles } from "./path-policy.mjs";

export const hashFile = (path) => new Promise((resolveHash, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.once("error", reject);
  stream.once("end", () => resolveHash(hash.digest("hex")));
});

const contentTypeFor = (logicalPath) => {
  const lower = logicalPath.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json";
  if (/\.(?:png|jpg|jpeg|webp|gif)$/i.test(lower)) return `image/${lower.split(".").pop().replace("jpg", "jpeg")}`;
  if (/\.(?:mp4|webm|mov)$/i.test(lower)) return "video/mp4";
  if (/\.(?:mp3|wav|m4a)$/i.test(lower)) return "audio/mpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
};

export const createLocalInventory = async ({ dataRoot, baseline = {}, includeSourcePaths = false, onProgress = null } = {}) => {
  const candidates = await collectAllowedFiles({ dataRoot });
  const files = [];
  let scanned = 0;
  for (const item of candidates) {
    const previous = baseline[item.logicalPath];
    const contentType = contentTypeFor(item.logicalPath);
    const cacheableLargeBinary = !/^(?:text\/|application\/json)/i.test(contentType);
    const hash = cacheableLargeBinary && previous && previous.size === item.size && previous.mtimeMs === item.mtimeMs && previous.localHash
      ? previous.localHash
      : await hashFile(item.absolutePath);
    const value = {
      logicalPath: item.logicalPath,
      hash,
      size: item.size,
      contentType,
      deleted: false,
      ...(includeSourcePaths ? { sourcePath: item.absolutePath, mtimeMs: item.mtimeMs } : {}),
    };
    files.push(value);
    scanned += 1;
    onProgress?.({ scanned, total: candidates.length, logicalPath: item.logicalPath });
  }
  return { schemaVersion: 1, files, totalFiles: files.length, totalBytes: files.reduce((sum, item) => sum + item.size, 0) };
};
