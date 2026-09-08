import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

const dataRoot = process.env.SHENSI_DATA_ROOT || "E:\\ShensiUserData";
const worksRoot = join(dataRoot, "作品");
const apply = process.argv.includes("--apply");
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
const backupRoot = join(dataRoot, ".shensi-history-dedup-backups", timestamp);
const objectNamePattern = /^([a-f0-9]{64})\.json$/u;
const isInside = (target, root) => {
  const normalizedTarget = resolve(target).toLocaleLowerCase("en-US");
  const normalizedRoot = resolve(root).toLocaleLowerCase("en-US");
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}\\`);
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const serializeCanonical = (value) => JSON.stringify(canonicalize(value));
const hashCanonical = (value) => createHash("sha256").update(serializeCanonical(value), "utf8").digest("hex");

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const walk = async (root) => {
  const files = [];
  const visit = async (current) => {
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else files.push(target);
    }
  };
  await visit(root);
  return files;
};
const findHistoryRoots = async (root) => (await walk(root))
  .filter((path) => path.endsWith("\\.shensi\\history-isolated\\index.json"))
  .map((path) => dirname(path));

const historyShardPaths = (index = {}) => [...new Set([
  ...Object.values(index.documents ?? {}),
  ...Object.values(index.views ?? {}),
  ...Object.values(index.volumes ?? {}),
  ...Object.values(index.modules ?? {}),
  index.project,
  index.rollback,
  index.rollbackObjects,
].filter(Boolean))];

const replaceReference = (value, replacements, key = "") => {
  if (typeof value === "string") {
    if ((key.endsWith("Ref") || key === "hash") && replacements.has(value)) return replacements.get(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceReference(item, replacements, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => {
    if (childKey.endsWith("Refs") && childValue && typeof childValue === "object" && !Array.isArray(childValue)) {
      return [childKey, Object.fromEntries(Object.entries(childValue).map(([id, hash]) => [id, replacements.get(hash) ?? hash]))];
    }
    return [childKey, replaceReference(childValue, replacements, childKey)];
  }));
};

const atomicWrite = async (path, content) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.dedup-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
};

const objectFilesFor = async (historyRoot) => (await walk(join(historyRoot, "objects")))
  .map((path) => ({ path, name: basename(path), hash: basename(path).match(objectNamePattern)?.[1] ?? "" }))
  .filter(({ hash }) => hash);

const collectReferenceHashes = (value, result = new Set(), key = "") => {
  if (typeof value === "string") {
    if ((key.endsWith("Ref") || key === "hash") && objectNamePattern.test(`${value}.json`)) result.add(value);
    return result;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectReferenceHashes(item, result, key));
    return result;
  }
  if (!value || typeof value !== "object") return result;
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey.endsWith("Refs") && childValue && typeof childValue === "object" && !Array.isArray(childValue)) {
      Object.values(childValue).forEach((hash) => {
        if (typeof hash === "string" && objectNamePattern.test(`${hash}.json`)) result.add(hash);
      });
      continue;
    }
    collectReferenceHashes(childValue, result, childKey);
  }
  return result;
};

const inspectHistoryRoot = async (historyRoot) => {
  const index = await readJson(join(historyRoot, "index.json"));
  const shardFiles = historyShardPaths(index).map((path) => resolve(historyRoot, path));
  const shards = [];
  const references = new Set();
  let entries = 0;
  for (const path of shardFiles) {
    if (!isInside(path, historyRoot)) throw new Error(`历史分片路径越界：${path}`);
    let value;
    try {
      value = await readJson(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    shards.push({ path, value, serialized: JSON.stringify(value, null, 2) });
    entries += Array.isArray(value.entries) ? value.entries.length : 0;
    collectReferenceHashes(value, references);
  }
  const objects = [];
  for (const item of await objectFilesFor(historyRoot)) {
    const value = await readJson(item.path);
    const canonical = serializeCanonical(value);
    objects.push({ ...item, value, canonical, canonicalHash: hashCanonical(value), bytes: Buffer.byteLength(await readFile(item.path)) });
  }
  const groups = new Map();
  for (const object of objects) {
    const group = groups.get(object.canonicalHash) ?? [];
    group.push(object);
    groups.set(object.canonicalHash, group);
  }
  return { index, shards, references, entries, objects, duplicateGroups: [...groups.values()].filter((group) => group.length > 1) };
};

const backupHistoryRoot = async (historyRoot) => {
  const destination = join(backupRoot, relative(worksRoot, historyRoot));
  await mkdir(dirname(destination), { recursive: true });
  await cp(historyRoot, destination, { recursive: true, force: false, errorOnExist: true });
  return destination;
};

const migrateHistoryRoot = async (historyRoot) => {
  const before = await inspectHistoryRoot(historyRoot);
  if (!before.duplicateGroups.length) return { historyRoot, duplicateGroups: 0, removedFiles: 0, removedBytes: 0, entries: before.entries, changed: false };
  const backup = apply ? await backupHistoryRoot(historyRoot) : "";
  const replacements = new Map();
  const removed = [];
  for (const group of before.duplicateGroups) {
    const canonicalHash = group[0].canonicalHash;
    const canonicalPath = join(historyRoot, "objects", canonicalHash.slice(0, 2), `${canonicalHash}.json`);
    const existingCanonical = group.find((item) => item.hash === canonicalHash);
    if (!existingCanonical) {
      if (apply) await atomicWrite(canonicalPath, group[0].canonical);
    } else if (apply && existingCanonical.canonical !== group[0].canonical) {
      await atomicWrite(canonicalPath, group[0].canonical);
    }
    for (const object of group) {
      if (object.hash === canonicalHash) continue;
      replacements.set(object.hash, canonicalHash);
      removed.push(object);
    }
  }
  if (apply && replacements.size) {
    for (const shard of before.shards) {
      const next = replaceReference(shard.value, replacements);
      const serialized = JSON.stringify(next, null, 2);
      if (serialized !== shard.serialized) await atomicWrite(shard.path, serialized);
    }
    const afterRefs = await inspectHistoryRoot(historyRoot);
    const dangling = [...afterRefs.references].filter((hash) => !afterRefs.objects.some((object) => object.hash === hash));
    if (afterRefs.entries !== before.entries) throw new Error(`历史条目数量变化：${before.entries} -> ${afterRefs.entries}`);
    if (dangling.length) throw new Error(`历史引用悬空：${dangling.slice(0, 3).join(",")}`);
    for (const object of removed) {
      const path = object.path;
      if (path === join(historyRoot, "objects", object.canonicalHash.slice(0, 2), `${object.canonicalHash}.json`)) continue;
      await rm(path, { force: false });
    }
    const verified = await inspectHistoryRoot(historyRoot);
    if (verified.entries !== before.entries) throw new Error(`删除后历史条目数量变化：${before.entries} -> ${verified.entries}`);
    for (const hash of verified.references) {
      if (!verified.objects.some((object) => object.hash === hash)) throw new Error(`删除后历史引用悬空：${hash}`);
    }
  }
  return {
    historyRoot,
    backup,
    duplicateGroups: before.duplicateGroups.length,
    removedFiles: removed.length,
    removedBytes: removed.reduce((total, object) => total + object.bytes, 0),
    entries: before.entries,
    changed: apply,
  };
};

const roots = await findHistoryRoots(worksRoot);
const reports = [];
for (const historyRoot of roots) reports.push(await migrateHistoryRoot(historyRoot));
console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  dataRoot,
  historyRoots: roots.length,
  backupRoot: apply && reports.some((report) => report.backup) ? backupRoot : null,
  duplicateGroups: reports.reduce((sum, report) => sum + report.duplicateGroups, 0),
  removableFiles: reports.reduce((sum, report) => sum + report.removedFiles, 0),
  removableBytes: reports.reduce((sum, report) => sum + report.removedBytes, 0),
  changedRoots: reports.filter((report) => report.changed).length,
  reports: reports.filter((report) => report.duplicateGroups),
}, null, 2));
