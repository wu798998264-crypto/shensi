import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { createUndoTransactionContract } from "../task-execution-domain.js";

const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const DEFAULT_EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", ".next", ".cache", "dist", "build", "release", "out"]);

const pathInside = (root, target) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const normalizedLogicalPath = (value = "") => String(value || "")
  .replaceAll("\\", "/")
  .replace(/^a\//, "")
  .replace(/^b\//, "")
  .replace(/^\.\//, "")
  .trim();

const atomicWriteJson = async (targetPath, value) => {
  await mkdir(dirname(targetPath), { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, targetPath).catch(async (error) => {
    if (process.platform !== "win32") throw error;
    await copyFile(temporaryPath, targetPath);
    await unlink(temporaryPath).catch(() => {});
  });
};

export const sha256FileContent = (filePath) => new Promise((resolveHash, rejectHash) => {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.once("error", rejectHash);
  stream.once("end", () => resolveHash(hash.digest("hex")));
});

const objectPathForHash = (objectRoot, hash) => resolve(objectRoot, hash.slice(0, 2), hash);

const ensureContentObject = async ({ sourcePath, objectRoot, expectedHash }) => {
  const objectPath = objectPathForHash(objectRoot, expectedHash);
  const existing = await stat(objectPath).catch(() => null);
  if (existing?.isFile()) return objectPath;
  await mkdir(dirname(objectPath), { recursive: true });
  const temporaryPath = `${objectPath}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(sourcePath, temporaryPath);
  const copiedHash = await sha256FileContent(temporaryPath);
  if (copiedHash !== expectedHash) {
    await unlink(temporaryPath).catch(() => {});
    throw new Error(`建立修改基线时文件发生并发变化：${sourcePath}`);
  }
  await rename(temporaryPath, objectPath).catch(async (error) => {
    const raced = await stat(objectPath).catch(() => null);
    if (!raced?.isFile()) throw error;
    await unlink(temporaryPath).catch(() => {});
  });
  return objectPath;
};

export const captureMutationCandidateBaseline = async ({
  cwd,
  transactionRoot,
  transactionId,
  modificationIntent = null,
  maxFiles = DEFAULT_MAX_FILES,
  maxObjectBytes = DEFAULT_MAX_OBJECT_BYTES,
  excludedDirectories = DEFAULT_EXCLUDED_DIRECTORIES,
} = {}) => {
  const workspaceRoot = resolve(cwd);
  const root = resolve(transactionRoot);
  const objectRoot = resolve(root, "objects", "sha256");
  const candidatePath = resolve(root, "candidates", `${transactionId}.json`);
  const entries = new Map();
  const unsafeEntries = new Map();
  const excludedPrefixes = [];
  const stack = [{ absolute: workspaceRoot, relativePath: "" }];
  let scannedFiles = 0;

  while (stack.length) {
    const current = stack.pop();
    let children;
    try { children = await readdir(current.absolute, { withFileTypes: true }); } catch { continue; }
    for (const child of children) {
      const logicalPath = [current.relativePath, child.name].filter(Boolean).join("/");
      const absolute = resolve(current.absolute, child.name);
      if (!pathInside(workspaceRoot, absolute)) throw new Error(`修改基线路径越界：${logicalPath}`);
      if (child.isDirectory()) {
        if (excludedDirectories.has(child.name)) {
          excludedPrefixes.push(`${logicalPath}/`);
          continue;
        }
        stack.push({ absolute, relativePath: logicalPath });
        continue;
      }
      scannedFiles += 1;
      if (scannedFiles > maxFiles) throw new Error(`工作区文件超过安全修改基线上限（${maxFiles}），已在 Agent 写入前停止`);
      const info = await lstat(absolute).catch(() => null);
      if (!info) continue;
      if (info.isSymbolicLink() || !info.isFile()) {
        unsafeEntries.set(logicalPath, { reason: info.isSymbolicLink() ? "symbolic_link" : "not_regular_file" });
        continue;
      }
      if (info.size > maxObjectBytes) {
        unsafeEntries.set(logicalPath, { reason: "file_too_large", size: info.size });
        continue;
      }
      const beforeHash = await sha256FileContent(absolute);
      await ensureContentObject({ sourcePath: absolute, objectRoot, expectedHash: beforeHash });
      entries.set(logicalPath, {
        logicalPath,
        existed: true,
        beforeHash,
        objectHash: beforeHash,
        size: info.size,
      });
    }
  }

  const baselineDigest = createHash("sha256").update(JSON.stringify({
    cwd: workspaceRoot,
    entries: [...entries.values()].map(({ logicalPath, existed, beforeHash, size }) => ({ logicalPath, existed, beforeHash, size })),
    unsafeEntries: [...unsafeEntries.entries()].map(([logicalPath, value]) => ({ logicalPath, ...value })),
    excludedPrefixes: [...excludedPrefixes].sort(),
  })).digest("hex");
  const candidate = {
    schemaVersion: 1,
    transactionId: String(transactionId || ""),
    cwd: workspaceRoot,
    createdAt: new Date().toISOString(),
    baselineDigest,
    modificationIntent: modificationIntent && typeof modificationIntent === "object" ? { ...modificationIntent, baselineId: baselineDigest } : null,
    complete: true,
    scannedFiles,
    excludedPrefixes,
    entries: [...entries.values()],
    unsafeEntries: [...unsafeEntries.entries()].map(([logicalPath, value]) => ({ logicalPath, ...value })),
  };
  await atomicWriteJson(candidatePath, candidate);
  return { ...candidate, candidatePath, objectRoot, entries, unsafeEntries };
};

const candidateEntryForPath = (candidate, logicalPath) => {
  const normalized = normalizedLogicalPath(logicalPath);
  const unsafe = candidate?.unsafeEntries?.get?.(normalized);
  if (unsafe) throw new Error(`文件不能建立安全撤销基线：${normalized}（${unsafe.reason}）`);
  if ((candidate?.excludedPrefixes || []).some((prefix) => normalized.startsWith(prefix))) {
    throw new Error(`文件位于不可撤销的生成目录，已拒绝 Agent 修改：${normalized}`);
  }
  const entry = candidate?.entries?.get?.(normalized);
  if (entry) return entry;
  if (candidate?.complete !== true) throw new Error(`修改基线不完整，无法安全处理：${normalized}`);
  return { logicalPath: normalized, existed: false, beforeHash: "", objectHash: "", size: 0 };
};

export const solidifyMutationUndoManifest = async ({ candidate, paths = [], undoRoot, turnId } = {}) => {
  if (!candidate?.complete) throw new Error("Agent 修改候选基线不存在或不完整");
  const uniquePaths = [...new Set(paths.map(normalizedLogicalPath).filter(Boolean))];
  if (!uniquePaths.length) throw new Error("Agent 没有提供可核验的修改文件清单，已拒绝静默写入");
  const snapshotRoot = resolve(undoRoot, String(turnId || candidate.transactionId));
  const manifestPath = resolve(snapshotRoot, "manifest.json");
  let manifest = {
    schemaVersion: 2,
    turnId: String(turnId || candidate.transactionId),
    transactionId: candidate.transactionId,
    cwd: candidate.cwd,
    createdAt: new Date().toISOString(),
    retentionClass: "active-undo-indefinite",
    baselineDigest: String(candidate.baselineDigest || ""),
    modificationIntent: candidate.modificationIntent || null,
    undoContract: createUndoTransactionContract({
      transactionId: candidate.transactionId,
      turnId: String(turnId || candidate.transactionId),
      baselineId: String(candidate.baselineDigest || ""),
      modificationIntent: candidate.modificationIntent || null,
    }),
    objectRoot: candidate.objectRoot,
    entries: [],
  };
  try { manifest = { ...manifest, ...JSON.parse(await readFile(manifestPath, "utf8")) }; } catch {}
  const existing = new Map((manifest.entries || []).map((entry) => [entry.logicalPath, entry]));
  for (const logicalPath of uniquePaths) {
    if (existing.has(logicalPath)) continue;
    const before = candidateEntryForPath(candidate, logicalPath);
    const entry = {
      logicalPath,
      existed: before.existed === true,
      beforeHash: String(before.beforeHash || ""),
      objectHash: String(before.objectHash || ""),
      afterHash: "",
      afterExists: null,
    };
    manifest.entries.push(entry);
    existing.set(logicalPath, entry);
  }
  await atomicWriteJson(manifestPath, manifest);
  return { manifest, manifestPath };
};

export const restoreContentAddressedObject = async ({ objectRoot, objectHash, destination }) => {
  const sourcePath = objectPathForHash(resolve(objectRoot), String(objectHash || ""));
  const info = await stat(sourcePath).catch(() => null);
  if (!info?.isFile()) throw new Error(`撤销对象缺失：${objectHash}`);
  const actualHash = await sha256FileContent(sourcePath);
  if (actualHash !== objectHash) throw new Error(`撤销对象完整性校验失败：${objectHash}`);
  const temporaryPath = `${destination}.${process.pid}.${randomUUID()}.undo.tmp`;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(sourcePath, temporaryPath);
  await rename(temporaryPath, destination).catch(async (error) => {
    if (process.platform !== "win32") throw error;
    await copyFile(temporaryPath, destination);
    await unlink(temporaryPath).catch(() => {});
  });
};

const readJson = async (path) => {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
};

const listFilesRecursive = async (root) => {
  const output = [];
  const stack = [resolve(root)];
  while (stack.length) {
    const current = stack.pop();
    const children = await readdir(current, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
    for (const child of children) {
      const absolute = resolve(current, child.name);
      if (!pathInside(root, absolute) || child.isSymbolicLink()) continue;
      if (child.isDirectory()) stack.push(absolute);
      else if (child.isFile()) output.push(absolute);
    }
  }
  return output;
};

export const maintainMutationTransactionStore = async ({
  transactionRoot,
  undoRoot,
  activeTransactionIds = [],
  undoneRetentionDays = 30,
  staleCandidateDays = 7,
  maxBytes = 20 * 1024 * 1024 * 1024,
  now = Date.now(),
} = {}) => {
  const root = resolve(transactionRoot);
  const verifiedUndoRoot = resolve(undoRoot);
  const objectRoot = resolve(root, "objects", "sha256");
  const candidatesRoot = resolve(root, "candidates");
  const active = new Set(activeTransactionIds.map(String));
  const referencedObjects = new Set();
  const staleCandidateMs = Math.max(1, Number(staleCandidateDays) || 7) * 86_400_000;
  const undoneRetentionMs = Math.max(1, Number(undoneRetentionDays) || 30) * 86_400_000;
  let prunedCandidates = 0;
  let prunedUndoneTransactions = 0;
  let protectedUndoTransactions = 0;
  let corruptManifests = 0;

  for (const candidatePath of await listFilesRecursive(candidatesRoot)) {
    if (!candidatePath.endsWith(".json")) continue;
    const candidate = await readJson(candidatePath);
    const transactionId = String(candidate?.transactionId || "");
    const createdAt = Date.parse(candidate?.createdAt || "");
    if (!candidate || (!active.has(transactionId) && Number.isFinite(createdAt) && now - createdAt > staleCandidateMs)) {
      await unlink(candidatePath).catch(() => {});
      prunedCandidates += 1;
      continue;
    }
    for (const entry of candidate.entries || []) if (/^[a-f0-9]{64}$/i.test(String(entry.objectHash || ""))) referencedObjects.add(String(entry.objectHash).toLowerCase());
  }

  const undoChildren = await readdir(verifiedUndoRoot, { withFileTypes: true }).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  for (const child of undoChildren) {
    if (!child.isDirectory() || child.isSymbolicLink()) continue;
    const directory = resolve(verifiedUndoRoot, child.name);
    if (!pathInside(verifiedUndoRoot, directory)) continue;
    const manifest = await readJson(resolve(directory, "manifest.json"));
    if (!manifest) {
      corruptManifests += 1;
      continue;
    }
    const undoneAt = Date.parse(manifest.undoneAt || "");
    if (Number.isFinite(undoneAt) && now - undoneAt > undoneRetentionMs) {
      await rm(directory, { recursive: true, force: true });
      prunedUndoneTransactions += 1;
      continue;
    }
    if (!Number.isFinite(undoneAt)) protectedUndoTransactions += 1;
    for (const entry of manifest.entries || []) if (/^[a-f0-9]{64}$/i.test(String(entry.objectHash || ""))) referencedObjects.add(String(entry.objectHash).toLowerCase());
  }

  let objectBytes = 0;
  let objectCount = 0;
  let prunedObjects = 0;
  let prunedObjectBytes = 0;
  for (const objectPath of await listFilesRecursive(objectRoot)) {
    const hash = objectPath.split(/[\\/]/).at(-1)?.toLowerCase() || "";
    const info = await stat(objectPath).catch(() => null);
    if (!info?.isFile()) continue;
    if (!/^[a-f0-9]{64}$/.test(hash) || !referencedObjects.has(hash)) {
      await unlink(objectPath).catch(() => {});
      prunedObjects += 1;
      prunedObjectBytes += info.size;
      continue;
    }
    objectCount += 1;
    objectBytes += info.size;
  }

  return {
    schemaVersion: 1,
    policy: {
      activeUndoRetention: "indefinite",
      undoneRetentionDays: Math.max(1, Number(undoneRetentionDays) || 30),
      staleCandidateDays: Math.max(1, Number(staleCandidateDays) || 7),
      maxBytes: Math.max(1, Number(maxBytes) || 1),
      overCapacityAction: "warn-and-block-future-unprotected-write;never-evict-active-undo",
    },
    protectedUndoTransactions,
    corruptManifests,
    referencedObjectCount: objectCount,
    referencedObjectBytes: objectBytes,
    overCapacity: objectBytes > Math.max(1, Number(maxBytes) || 1),
    prunedCandidates,
    prunedUndoneTransactions,
    prunedObjects,
    prunedObjectBytes,
  };
};

export const mutationTransactionInternals = {
  atomicWriteJson,
  normalizedLogicalPath,
  objectPathForHash,
};
