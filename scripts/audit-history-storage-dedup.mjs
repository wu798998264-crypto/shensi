import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const dataRoot = process.env.SHENSI_DATA_ROOT || "E:\\ShensiUserData";
const worksRoot = join(dataRoot, "作品");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const walk = async (root) => {
  const result = [];
  const visit = async (current) => {
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else result.push(target);
    }
  };
  await visit(root);
  return result;
};

const findDirectories = async (root) => {
  const result = [];
  const visit = async (current) => {
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = join(current, entry.name);
      result.push(target);
      await visit(target);
    }
  };
  await visit(root);
  return result;
};

const historyRoots = (await findDirectories(worksRoot)).filter((path) => path.endsWith("\\.shensi\\history-isolated"));
const globalContentHashes = new Map();
const reports = [];
let totalObjects = 0;
let totalReferenced = 0;
let totalBytes = 0;
let totalEntries = 0;
let totalMissing = 0;

for (const historyRoot of historyRoots) {
  let index;
  try { index = JSON.parse(await readFile(join(historyRoot, "index.json"), "utf8")); } catch { index = null; }
  const shardPaths = [...new Set(Object.values(index?.documents ?? {})
    .concat(Object.values(index?.views ?? {}), Object.values(index?.volumes ?? {}), Object.values(index?.modules ?? {}), [index?.project])
    .filter(Boolean))];
  const referenced = new Set();
  let referenceOccurrences = 0;
  const collectHashValues = (value) => {
    if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) {
      referenced.add(value);
      referenceOccurrences += 1;
      return;
    }
    if (!value || typeof value !== "object") return;
    Object.values(value).forEach(collectHashValues);
  };
  let entries = 0;
  const collectRefs = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(collectRefs); return; }
    for (const [key, item] of Object.entries(value)) {
      if (key.endsWith("Refs")) {
        collectHashValues(item);
        continue;
      }
      if (typeof item === "string" && /^[a-f0-9]{64}$/u.test(item)
        && (key.endsWith("Ref") || key.endsWith("Refs") || key === "hash")) {
        referenced.add(item);
        referenceOccurrences += 1;
      }
      else collectRefs(item);
    }
  };
  for (const shardPath of shardPaths) {
    try {
      const shard = JSON.parse(await readFile(join(historyRoot, shardPath), "utf8"));
      entries += Array.isArray(shard.entries) ? shard.entries.length : 0;
      collectRefs(shard);
    } catch { /* stale shard is reported by normal workspace audit */ }
  }
  const objectFiles = (await walk(join(historyRoot, "objects"))).filter((path) => /[a-f0-9]{64}\.json$/u.test(path));
  const objectHashes = new Set();
  const contentHashes = new Map();
  let bytes = 0;
  let filenameHashMismatch = 0;
  for (const objectPath of objectFiles) {
    const bytesValue = await readFile(objectPath);
    bytes += bytesValue.length;
    const fileNameHash = objectPath.match(/([a-f0-9]{64})\.json$/u)?.[1] || "";
    const contentHash = sha256(bytesValue);
    objectHashes.add(fileNameHash);
    contentHashes.set(contentHash, (contentHashes.get(contentHash) || 0) + 1);
    globalContentHashes.set(contentHash, (globalContentHashes.get(contentHash) || 0) + 1);
    if (contentHash !== fileNameHash) filenameHashMismatch += 1;
  }
  const missing = [...referenced].filter((hash) => !objectHashes.has(hash));
  const duplicatePhysicalObjects = [...contentHashes.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
  const activeReferenced = [...referenced].filter((hash) => objectHashes.has(hash));
  const workspaceName = relative(worksRoot, historyRoot).replaceAll("\\.shensi\\history-isolated", "").replaceAll("\\", "/") || ".";
  reports.push({
    workspace: workspaceName,
    entries,
    objectFiles: objectFiles.length,
    referencedObjects: referenced.size,
    referenceOccurrences,
    duplicateReferences: Math.max(0, referenceOccurrences - referenced.size),
    unreferencedObjects: Math.max(0, objectFiles.length - activeReferenced.length),
    duplicatePhysicalObjects,
    filenameHashMismatch,
    missingReferencedObjects: missing.length,
    objectBytes: bytes,
  });
  totalObjects += objectFiles.length;
  totalReferenced += referenced.size;
  totalBytes += bytes;
  totalEntries += entries;
  totalMissing += missing.length;
}

const globalDuplicateCopies = [...globalContentHashes.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0);
reports.sort((a, b) => b.objectBytes - a.objectBytes);
console.log(JSON.stringify({
  dataRoot,
  historyRoots: historyRoots.length,
  totalEntries,
  totalObjects,
  totalReferenced,
  totalObjectBytes: totalBytes,
  totalMissingReferencedObjects: totalMissing,
  duplicatePhysicalCopiesWithinWorkspace: reports.reduce((sum, item) => sum + item.duplicatePhysicalObjects, 0),
  duplicatePhysicalCopiesAcrossWorkspaces: globalDuplicateCopies,
  filenameHashMismatches: reports.reduce((sum, item) => sum + item.filenameHashMismatch, 0),
  largestWorkspaces: reports.slice(0, 10),
}, null, 2));
