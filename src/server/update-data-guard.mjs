import {
  copyFile,
  chmod,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  statfs,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { appDataRoot } from "./app-data.mjs";

const SNAPSHOT_SCHEMA_VERSION = 2;
const UPDATE_TRANSACTION_SCHEMA_VERSION = 1;
const RETAINED_RECOVERY_SNAPSHOT_LIMIT = 3;
const RETAINED_RECOVERY_CLASS = "pre-install-recovery";
// Electron creates and locks Chromium session files before the local core starts.
// They are machine-local runtime caches, not user-authored content, and attempting
// to hash them during the startup version guard fails with EBUSY on Windows.
const VOLATILE_TOP_LEVEL = new Set([
  "DesktopRuntime",
  "diagnostics",
  "machine-sessions",
  "update-coordination",
  "updates",
]);
const INSTALLER_PHASES = new Set(["installer_launch_pending", "installer_running", "installer_succeeded", "complete"]);

const HASH_BUFFER_BYTES = 256 * 1024;

const hashFileWithBuffer = async (filePath, buffer) => {
  const hash = createHash("sha256");
  const handle = await open(filePath, "r");
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

// Full update snapshots can hash tens of thousands of files. Reusing one
// buffer per inventory avoids retaining thousands of stream buffer slabs in
// the long-lived desktop process after an upgrade.
const hashFile = (filePath) => hashFileWithBuffer(filePath, Buffer.allocUnsafe(HASH_BUFFER_BYTES));

const safeLabel = (value = "") => String(value).trim().replace(/[^0-9A-Za-z._-]/g, "-").slice(0, 80) || "unknown";
const timestampLabel = (date = new Date()) => date.toISOString().replace(/[:.]/g, "-");
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "ENOTEMPTY", "EPERM"]);

const renameWithTransientLockRetry = async (source, target, { attempts = 10 } = {}) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!WINDOWS_RENAME_RETRY_CODES.has(error?.code) || attempt >= attempts) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(50 * attempt, 500)));
    }
  }
};

const atomicWriteJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
};

const assertContained = (root, target) => {
  const rel = relative(resolve(root), resolve(target));
  if (!rel || rel.startsWith("..") || resolve(root) === resolve(target)) throw new Error("更新快照路径边界无效");
  return rel;
};

const shouldSkip = (relativePath) => {
  const top = String(relativePath).split(/[\\/]/)[0];
  return VOLATILE_TOP_LEVEL.has(top);
};

export const updateTransactionJournalPath = (dataRoot = appDataRoot()) => {
  const root = resolve(dataRoot);
  return join(dirname(root), `.${basename(root)}-update-transaction.json`);
};

const snapshotContainerFor = (dataRoot) => {
  const root = resolve(dataRoot);
  return join(dirname(root), `.${basename(root)}-update-snapshots`);
};

const assertJournalSnapshotBoundary = ({ dataRoot, snapshotRoot }) => {
  const container = resolve(snapshotContainerFor(dataRoot));
  const target = resolve(snapshotRoot || "");
  const rel = relative(container, target);
  if (!rel
    || rel.startsWith("..")
    || resolve(container) === target
    || resolve(dirname(target)) !== container) throw new Error("更新事务快照路径越界");
  return target;
};

const assertSnapshotContainerSafe = async (dataRoot) => {
  const container = resolve(snapshotContainerFor(dataRoot));
  const info = await lstat(container).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error("更新快照容器不是安全文件夹");
  return container;
};

export const cleanupUpdateSnapshot = async ({ dataRoot = appDataRoot(), snapshotRoot } = {}) => {
  const container = await assertSnapshotContainerSafe(dataRoot);
  const target = assertJournalSnapshotBoundary({ dataRoot, snapshotRoot });
  const info = await lstat(target).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (info?.isSymbolicLink() || (info && !info.isDirectory())) throw new Error("更新快照目标不是安全文件夹");
  if (info) await rm(target, { recursive: true, force: true });
  const remaining = await readdir(container).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error));
  if (remaining.length === 0) await rmdir(container).catch((error) => {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
  });
  return { removed: Boolean(info), snapshotRoot: target };
};

const retainUpdateSnapshotForRecovery = async ({ dataRoot = appDataRoot(), snapshotRoot } = {}) => {
  const container = await assertSnapshotContainerSafe(dataRoot);
  const target = assertJournalSnapshotBoundary({ dataRoot, snapshotRoot });
  const manifestPath = join(target, "snapshot-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (![1, SNAPSHOT_SCHEMA_VERSION].includes(manifest.schemaVersion)
    || manifest.snapshotId !== basename(target)
    || resolve(manifest.sourceRoot || "") !== resolve(dataRoot)) {
    throw new Error("更新前恢复快照清单无效；为保护用户数据，不能将其标记为可恢复版本");
  }
  const retainedAt = new Date().toISOString();
  await atomicWriteJson(manifestPath, {
    ...manifest,
    retentionClass: RETAINED_RECOVERY_CLASS,
    retainedAt,
  });

  const retained = [];
  for (const entry of await readdir(container, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === "_objects") continue;
    const candidateRoot = join(container, entry.name);
    const candidate = await readFile(join(candidateRoot, "snapshot-manifest.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (candidate?.retentionClass !== RETAINED_RECOVERY_CLASS) continue;
    retained.push({
      snapshotRoot: candidateRoot,
      retainedAt: Date.parse(candidate.retainedAt || candidate.createdAt || 0) || 0,
    });
  }
  retained.sort((left, right) => right.retainedAt - left.retainedAt);
  const pruned = [];
  for (const expired of retained.slice(RETAINED_RECOVERY_SNAPSHOT_LIMIT)) {
    const cleanup = await cleanupUpdateSnapshot({ dataRoot, snapshotRoot: expired.snapshotRoot });
    if (cleanup.removed) pruned.push(expired.snapshotRoot);
  }
  return {
    retained: true,
    retentionClass: RETAINED_RECOVERY_CLASS,
    retainedAt,
    snapshotRoot: target,
    pruned,
  };
};

export const readUpdateTransactionJournal = async ({ dataRoot = appDataRoot() } = {}) => {
  const path = updateTransactionJournalPath(dataRoot);
  const parsed = await readFile(path, "utf8").then(JSON.parse).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!parsed) return null;
  if (parsed.schemaVersion !== UPDATE_TRANSACTION_SCHEMA_VERSION || resolve(parsed.dataRoot || "") !== resolve(dataRoot)) {
    throw new Error("更新事务 journal 无效；已停止自动恢复");
  }
  assertJournalSnapshotBoundary({ dataRoot, snapshotRoot: parsed.snapshotRoot });
  return { path, journal: parsed };
};

const writeUpdateTransactionJournal = async ({ dataRoot, journal }) => {
  const path = updateTransactionJournalPath(dataRoot);
  await atomicWriteJson(path, {
    ...journal,
    schemaVersion: UPDATE_TRANSACTION_SCHEMA_VERSION,
    dataRoot: resolve(dataRoot),
    updatedAt: new Date().toISOString(),
  });
  return path;
};

const removeUpdateTransactionJournal = async (dataRoot) => rm(updateTransactionJournalPath(dataRoot), { force: true });

const processIsAlive = (pid) => {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
};

export const inventoryDataRoot = async (rootPath, { allowMissing = true } = {}) => {
  const root = resolve(rootPath);
  const rootInfo = await stat(root).catch((error) => {
    if (allowMissing && error?.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return { directories: [], files: [], totalBytes: 0 };
  if (!rootInfo.isDirectory()) throw new Error("用户数据根目录不是文件夹");
  const directories = [];
  const files = [];
  let totalBytes = 0;
  const queue = [""];
  const hashBuffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex];
    const entries = await readdir(join(root, current), { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = current ? `${current}/${entry.name}` : entry.name;
      if (shouldSkip(relativePath)) continue;
      const absolutePath = join(root, ...relativePath.split("/"));
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`用户数据快照不接受符号链接：${relativePath}`);
      if (info.isDirectory()) {
        directories.push(relativePath);
        queue.push(relativePath);
        continue;
      }
      if (!info.isFile()) throw new Error(`用户数据包含不受支持的文件类型：${relativePath}`);
      const sha256 = await hashFileWithBuffer(absolutePath, hashBuffer);
      files.push({ path: relativePath, sizeBytes: info.size, sha256 });
      totalBytes += info.size;
    }
  }
  return { directories, files, totalBytes };
};

const copyInventory = async ({ sourceRoot, targetRoot, inventory, copyFileImpl = copyFile }) => {
  await mkdir(targetRoot, { recursive: true });
  for (const directory of inventory.directories) {
    const target = join(targetRoot, ...directory.split("/"));
    assertContained(targetRoot, target);
    await mkdir(target, { recursive: true });
  }
  for (const file of inventory.files) {
    const source = join(sourceRoot, ...file.path.split("/"));
    const target = join(targetRoot, ...file.path.split("/"));
    assertContained(sourceRoot, source);
    assertContained(targetRoot, target);
    await mkdir(dirname(target), { recursive: true });
    await copyFileImpl(source, target);
    let copiedHandle;
    let originalMode = null;
    try {
      try {
        copiedHandle = await open(target, "r+");
      } catch (error) {
        if (!['EACCES', 'EPERM'].includes(error?.code)) throw error;
        const targetInfo = await stat(target);
        originalMode = targetInfo.mode;
        await chmod(target, targetInfo.mode | 0o200);
        copiedHandle = await open(target, "r+");
      }
      await copiedHandle.sync();
    } finally {
      await copiedHandle?.close();
      if (originalMode !== null) await chmod(target, originalMode);
    }
  }
};

const snapshotObjectRootFor = (snapshotContainer) => join(snapshotContainer, "_objects", "sha256");
const snapshotObjectPath = (objectRoot, sha256) => join(objectRoot, sha256.slice(0, 2), sha256);

const syncCopiedFile = async (path) => {
  let handle;
  let originalMode = null;
  try {
    try {
      handle = await open(path, "r+");
    } catch (error) {
      if (!["EACCES", "EPERM"].includes(error?.code)) throw error;
      const info = await stat(path);
      originalMode = info.mode;
      await chmod(path, info.mode | 0o200);
      handle = await open(path, "r+");
    }
    await handle.sync();
  } finally {
    await handle?.close();
    if (originalMode !== null) await chmod(path, originalMode);
  }
};

export const estimateContentAddressedSnapshotSpace = async ({ snapshotContainer, inventory }) => {
  const objectRoot = snapshotObjectRootFor(resolve(snapshotContainer));
  let missingBytes = 0;
  let missingObjects = 0;
  let reusedObjects = 0;
  for (const file of inventory.files || []) {
    const objectPath = snapshotObjectPath(objectRoot, file.sha256);
    const info = await stat(objectPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (info?.isFile() && info.size === file.sizeBytes) reusedObjects += 1;
    else {
      missingObjects += 1;
      missingBytes += file.sizeBytes;
    }
  }
  const disk = await statfs(dirname(resolve(snapshotContainer)), { bigint: true });
  const availableBytes = Number(disk.bavail * disk.bsize);
  const safetyBytes = Math.max(64 * 1024 * 1024, Math.ceil(missingBytes * 0.05));
  const requiredBytes = missingBytes + safetyBytes;
  return { objectRoot, missingBytes, missingObjects, reusedObjects, safetyBytes, requiredBytes, availableBytes };
};

const materializeContentAddressedSnapshot = async ({ sourceRoot, targetRoot, inventory, objectRoot, copyFileImpl = copyFile }) => {
  await mkdir(targetRoot, { recursive: true });
  for (const directory of inventory.directories) {
    const target = join(targetRoot, ...directory.split("/"));
    assertContained(targetRoot, target);
    await mkdir(target, { recursive: true });
  }
  let createdObjects = 0;
  let reusedObjects = 0;
  let hardLinkedFiles = 0;
  let copiedLinkFallbacks = 0;
  for (const file of inventory.files) {
    const source = join(sourceRoot, ...file.path.split("/"));
    const target = join(targetRoot, ...file.path.split("/"));
    const objectPath = snapshotObjectPath(objectRoot, file.sha256);
    assertContained(sourceRoot, source);
    assertContained(targetRoot, target);
    assertContained(resolve(objectRoot, "..", ".."), objectPath);
    await mkdir(dirname(objectPath), { recursive: true });
    const objectInfo = await stat(objectPath).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (objectInfo) {
      if (!objectInfo.isFile() || objectInfo.size !== file.sizeBytes || await hashFile(objectPath) !== file.sha256) {
        throw new Error(`更新快照对象完整性校验失败：${file.path}`);
      }
      reusedObjects += 1;
    } else {
      const temporaryObject = `${objectPath}.${process.pid}.${randomUUID()}.tmp`;
      await copyFileImpl(source, temporaryObject);
      await syncCopiedFile(temporaryObject);
      if (await hashFile(temporaryObject) !== file.sha256) {
        await rm(temporaryObject, { force: true }).catch(() => {});
        throw new Error(`更新快照对象复制校验失败：${file.path}`);
      }
      await rename(temporaryObject, objectPath).catch(async (error) => {
        const raced = await stat(objectPath).catch(() => null);
        if (!raced?.isFile()) throw error;
        await rm(temporaryObject, { force: true }).catch(() => {});
      });
      createdObjects += 1;
    }
    await mkdir(dirname(target), { recursive: true });
    try {
      await link(objectPath, target);
      hardLinkedFiles += 1;
    } catch (error) {
      if (!["EXDEV", "EPERM", "EACCES", "ENOSYS", "EISDIR"].includes(error?.code)) throw error;
      await copyFileImpl(objectPath, target);
      await syncCopiedFile(target);
      copiedLinkFallbacks += 1;
    }
  }
  return { createdObjects, reusedObjects, hardLinkedFiles, copiedLinkFallbacks };
};

const sameInventory = (expected, actual) => {
  if (expected.totalBytes !== actual.totalBytes || expected.files.length !== actual.files.length) return false;
  const actualFiles = new Map(actual.files.map((file) => [file.path, file]));
  return expected.files.every((file) => {
    const candidate = actualFiles.get(file.path);
    return candidate?.sizeBytes === file.sizeBytes && candidate?.sha256 === file.sha256;
  });
};

const containsInventory = (expected, actual) => {
  const actualFiles = new Map(actual.files.map((file) => [file.path, file]));
  return expected.files.every((file) => {
    const candidate = actualFiles.get(file.path);
    return candidate?.sizeBytes === file.sizeBytes && candidate?.sha256 === file.sha256;
  });
};

const changedExistingInventoryFiles = (before, after) => {
  const actualFiles = new Map(after.files.map((file) => [file.path, file]));
  const missing = [];
  const changed = [];
  for (const file of before.files) {
    const candidate = actualFiles.get(file.path);
    if (!candidate) missing.push(file.path);
    else if (candidate.sizeBytes !== file.sizeBytes || candidate.sha256 !== file.sha256) changed.push(file.path);
  }
  return { missing, changed };
};

const STARTUP_MIGRATION_MUTABLE_HISTORY_FILE = /(?:^|\/)\.shensi\/history-isolated\/(?:index\.json|rollback\/(?:conversations-and-branches|document-objects)\.json)$/;

const validateStartupMigrationInventory = ({ before, after }) => {
  const mutations = changedExistingInventoryFiles(before, after);
  const unexpected = mutations.changed.filter((path) => (
    path !== "workspace-migrations.json" && !STARTUP_MIGRATION_MUTABLE_HISTORY_FILE.test(path)
  ));
  return {
    valid: mutations.missing.length === 0 && unexpected.length === 0,
    missingCount: mutations.missing.length,
    changedExistingCount: mutations.changed.length,
    unexpectedCount: unexpected.length,
    missing: mutations.missing.slice(0, 20),
    unexpected: unexpected.slice(0, 20),
  };
};

export const createVerifiedDataSnapshot = async ({
  dataRoot = appDataRoot(),
  targetVersion,
  operation,
  now = new Date(),
  copyFileImpl = copyFile,
} = {}) => {
  const sourceRoot = resolve(dataRoot);
  await mkdir(sourceRoot, { recursive: true });
  const snapshotContainer = await assertSnapshotContainerSafe(sourceRoot);
  if (resolve(snapshotContainer).startsWith(`${sourceRoot}\\`) || resolve(snapshotContainer).startsWith(`${sourceRoot}/`)) {
    throw new Error("更新快照目录不能位于用户数据根目录内部");
  }
  const snapshotId = `${timestampLabel(now)}-${safeLabel(operation)}-${safeLabel(targetVersion)}-${randomUUID()}`;
  const snapshotRoot = join(snapshotContainer, snapshotId);
  const snapshotDataRoot = join(snapshotRoot, "data");
  assertContained(snapshotContainer, snapshotRoot);
  const before = await inventoryDataRoot(sourceRoot);
  const space = await estimateContentAddressedSnapshotSpace({ snapshotContainer, inventory: before });
  if (space.availableBytes < space.requiredBytes) {
    const error = new Error(`更新前安全快照空间不足：需要 ${space.requiredBytes} 字节，可用 ${space.availableBytes} 字节。为保护用户数据，本次更新不能跳过快照。`);
    error.code = "UPDATE_SNAPSHOT_SPACE_REQUIRED";
    error.requiredBytes = space.requiredBytes;
    error.availableBytes = space.availableBytes;
    throw error;
  }
  try {
    const storage = await materializeContentAddressedSnapshot({
      sourceRoot,
      targetRoot: snapshotDataRoot,
      inventory: before,
      objectRoot: space.objectRoot,
      copyFileImpl,
    });
    const copied = await inventoryDataRoot(snapshotDataRoot, { allowMissing: false });
    if (!sameInventory(before, copied)) throw new Error("更新前用户数据快照校验失败；已停止迁移");
    const manifest = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      snapshotId,
      createdAt: now.toISOString(),
      targetVersion: safeLabel(targetVersion),
      operation: safeLabel(operation),
      sourceRoot,
      excludedVolatileTopLevel: [...VOLATILE_TOP_LEVEL].sort(),
      storage: {
        kind: "content-addressed-hardlink-v1",
        objectRoot: space.objectRoot,
        ...storage,
        requiredAdditionalBytes: space.requiredBytes,
        availableBytesAtStart: space.availableBytes,
      },
      inventory: before,
    };
    await atomicWriteJson(join(snapshotRoot, "snapshot-manifest.json"), manifest);
    return { snapshotRoot, snapshotDataRoot, manifest };
  } catch (error) {
    try {
      await cleanupUpdateSnapshot({ dataRoot: sourceRoot, snapshotRoot });
    } catch (cleanupError) {
      error.snapshotCleanupError = String(cleanupError?.message || cleanupError).slice(0, 1_000);
    }
    throw error;
  }
};

export const restoreVerifiedDataSnapshot = async ({ dataRoot = appDataRoot(), snapshotRoot, copyFileImpl = copyFile } = {}) => {
  const targetRoot = resolve(dataRoot);
  await assertSnapshotContainerSafe(targetRoot);
  const verifiedSnapshotRoot = assertJournalSnapshotBoundary({ dataRoot: targetRoot, snapshotRoot });
  const snapshotInfo = await lstat(verifiedSnapshotRoot).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
  if (!snapshotInfo?.isDirectory() || snapshotInfo.isSymbolicLink()) throw new Error("更新回滚快照不存在或不是安全文件夹");
  const sourceRoot = join(verifiedSnapshotRoot, "data");
  const manifest = JSON.parse(await readFile(join(verifiedSnapshotRoot, "snapshot-manifest.json"), "utf8"));
  if (![1, SNAPSHOT_SCHEMA_VERSION].includes(manifest.schemaVersion)
    || resolve(manifest.sourceRoot || "") !== targetRoot
    || manifest.snapshotId !== basename(verifiedSnapshotRoot)
    || !sameInventory(manifest.inventory, await inventoryDataRoot(sourceRoot, { allowMissing: false }))) {
    throw new Error("更新回滚快照无效；为避免覆盖用户数据已停止自动回滚");
  }
  const quarantineRoot = join(dirname(targetRoot), `.${basename(targetRoot)}-failed-update-${timestampLabel()}-${randomUUID()}`);
  const targetExists = await stat(targetRoot).then(() => true).catch((error) => error?.code === "ENOENT" ? false : Promise.reject(error));
  const movedEntries = [];
  if (targetExists) {
    // Keep volatile runtime directories in place. Chromium, diagnostics and
    // detached workers may legitimately hold handles inside them on Windows;
    // renaming the whole data root would make a protected startup rollback fail
    // with EPERM before the application can recover. Only durable top-level
    // data is quarantined, while the verified inventory deliberately excludes
    // these runtime directories.
    await mkdir(quarantineRoot, { recursive: true });
    const entries = await readdir(targetRoot, { withFileTypes: true });
    try {
      for (const entry of entries) {
        if (shouldSkip(entry.name)) continue;
        const source = join(targetRoot, entry.name);
        const target = join(quarantineRoot, entry.name);
        assertContained(targetRoot, source);
        assertContained(quarantineRoot, target);
        await renameWithTransientLockRetry(source, target);
        movedEntries.push(entry.name);
      }
    } catch (error) {
      for (const entryName of movedEntries.reverse()) {
        await renameWithTransientLockRetry(join(quarantineRoot, entryName), join(targetRoot, entryName)).catch(() => {});
      }
      await rm(quarantineRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    if (!movedEntries.length) await rmdir(quarantineRoot).catch(() => {});
  }
  try {
    await copyInventory({ sourceRoot, targetRoot, inventory: manifest.inventory, copyFileImpl });
    const restored = await inventoryDataRoot(targetRoot, { allowMissing: false });
    if (!sameInventory(manifest.inventory, restored)) throw new Error("自动回滚后的用户数据校验失败");
    return {
      restored: true,
      quarantineRoot: movedEntries.length ? quarantineRoot : "",
      retainedQuarantine: movedEntries.length > 0,
      snapshotRoot: verifiedSnapshotRoot,
    };
  } catch (error) {
    try {
      const entries = await readdir(targetRoot, { withFileTypes: true }).catch((readError) => (
        readError?.code === "ENOENT" ? [] : Promise.reject(readError)
      ));
      for (const entry of entries) {
        if (shouldSkip(entry.name)) continue;
        await rm(join(targetRoot, entry.name), { recursive: true, force: true });
      }
      for (const entryName of movedEntries) {
        await renameWithTransientLockRetry(join(quarantineRoot, entryName), join(targetRoot, entryName));
      }
      if (movedEntries.length) await rmdir(quarantineRoot).catch(() => {});
    } catch (recoveryError) {
      error.quarantineRoot = movedEntries.length ? quarantineRoot : "";
      error.quarantineRecoveryError = String(recoveryError?.message || recoveryError).slice(0, 1_000);
    }
    throw error;
  }
};

const finalizeUpdateTransactionArtifacts = async ({ dataRoot, journal }) => {
  try {
    const retainSuccessfulSnapshot = journal.retainSnapshotOnSuccess === true
      && ["installer_succeeded", "complete"].includes(journal.phase);
    const snapshotCleanup = retainSuccessfulSnapshot
      ? await retainUpdateSnapshotForRecovery({ dataRoot, snapshotRoot: journal.snapshotRoot })
      : await cleanupUpdateSnapshot({ dataRoot, snapshotRoot: journal.snapshotRoot });
    await removeUpdateTransactionJournal(dataRoot);
    return { snapshotCleanup, cleanupDeferred: false };
  } catch (error) {
    const cleanupFailure = String(error?.message || error).slice(0, 1_000);
    await writeUpdateTransactionJournal({
      dataRoot,
      journal: {
        ...journal,
        cleanupDeferred: true,
        cleanupFailure,
      },
    }).catch(() => {});
    return {
      snapshotCleanup: { removed: false, snapshotRoot: resolve(journal.snapshotRoot || "") },
      cleanupDeferred: true,
      cleanupFailure,
    };
  }
};

export const prepareUserDataForUpdate = async ({
  dataRoot = appDataRoot(),
  targetVersion,
  operation,
  releaseManifest,
  retainSnapshotOnSuccess = false,
  migrate = async () => ({ migrated: 0 }),
  validateMigrationInventory = null,
} = {}) => {
  if (!targetVersion || !["upgrade", "downgrade", "repair"].includes(operation)) throw new Error("更新数据保护参数无效");
  if (releaseManifest && Number(releaseManifest.dataSchemaVersion) !== 1) throw new Error("安装包数据 schema 与当前迁移器不兼容");
  const outstanding = await readUpdateTransactionJournal({ dataRoot });
  if (outstanding) {
    const error = new Error("存在尚未完成的更新事务；必须先恢复后再开始新更新");
    error.code = "UPDATE_TRANSACTION_ACTIVE";
    throw error;
  }
  const snapshot = await createVerifiedDataSnapshot({ dataRoot, targetVersion, operation });
  const transactionId = snapshot.manifest.snapshotId;
  let journal = {
    transactionId,
    targetVersion: safeLabel(targetVersion),
    operation: safeLabel(operation),
    phase: "snapshot_verified",
    snapshotRoot: snapshot.snapshotRoot,
    createdAt: new Date().toISOString(),
    ownerPid: process.pid,
    retainSnapshotOnSuccess: retainSnapshotOnSuccess === true,
  };
  let journalPath;
  try {
    journalPath = await writeUpdateTransactionJournal({ dataRoot, journal });
  } catch (error) {
    await cleanupUpdateSnapshot({ dataRoot, snapshotRoot: snapshot.snapshotRoot }).catch((cleanupError) => {
      error.snapshotCleanupError = String(cleanupError?.message || cleanupError).slice(0, 1_000);
    });
    throw error;
  }
  try {
    journal = { ...journal, phase: "migrating" };
    await writeUpdateTransactionJournal({ dataRoot, journal });
    const migration = await migrate();
    const after = await inventoryDataRoot(dataRoot, { allowMissing: false });
    const migrationValidation = typeof validateMigrationInventory === "function"
      ? await validateMigrationInventory({ before: snapshot.manifest.inventory, after, migration })
      : { valid: containsInventory(snapshot.manifest.inventory, after) };
    if (migrationValidation !== true && migrationValidation?.valid !== true) {
      const detail = migrationValidation && typeof migrationValidation === "object"
        ? `：${JSON.stringify(migrationValidation).slice(0, 2_000)}`
        : "";
      throw new Error(`迁移修改或删除了未授权的既有用户数据${detail}`);
    }
    journal = {
      ...journal,
      phase: "data_prepared",
      migration,
      migrationValidation: migrationValidation === true ? { valid: true } : migrationValidation,
    };
    await writeUpdateTransactionJournal({ dataRoot, journal });
    return {
      transactionId,
      dataRoot: resolve(dataRoot),
      journalPath,
      snapshotPath: snapshot.snapshotRoot,
      snapshotFileCount: snapshot.manifest.inventory.files.length,
      snapshotBytes: snapshot.manifest.inventory.totalBytes,
      migration,
      validated: true,
    };
  } catch (error) {
    const rollback = await restoreVerifiedDataSnapshot({ dataRoot, snapshotRoot: snapshot.snapshotRoot });
    const rolledBackJournal = { ...journal, phase: "rolled_back", rollback, failure: String(error?.message || error).slice(0, 1_000) };
    await writeUpdateTransactionJournal({
      dataRoot,
      journal: rolledBackJournal,
    }).catch(() => {});
    const finalization = await finalizeUpdateTransactionArtifacts({ dataRoot, journal: rolledBackJournal });
    const wrapped = new Error(`用户数据迁移失败，已自动回滚：${error.message}`);
    wrapped.code = "UPDATE_DATA_MIGRATION_ROLLED_BACK";
    wrapped.rollback = { ...rollback, ...finalization };
    throw wrapped;
  }
};

export const markPreparedUpdateInstallerState = async ({
  dataRoot = appDataRoot(),
  transactionId,
  phase,
  installerPid = 0,
  detail = {},
} = {}) => {
  if (!INSTALLER_PHASES.has(phase)) throw new Error("更新安装器事务阶段无效");
  const active = await readUpdateTransactionJournal({ dataRoot });
  if (!active || active.journal.transactionId !== transactionId) throw new Error("更新安装器事务不存在或已变化");
  const journal = {
    ...active.journal,
    phase,
    installerPid: Number(installerPid) || 0,
    detail: detail && typeof detail === "object" ? detail : {},
  };
  await writeUpdateTransactionJournal({ dataRoot, journal });
  return journal;
};

export const rollbackPreparedUserDataUpdate = async ({
  dataRoot = appDataRoot(),
  transactionId,
  reason = "installer-failed",
} = {}) => {
  const active = await readUpdateTransactionJournal({ dataRoot });
  if (!active) return { restored: false, alreadyFinalized: true };
  if (transactionId && active.journal.transactionId !== transactionId) throw new Error("更新回滚事务标识不一致");
  const rollback = await restoreVerifiedDataSnapshot({ dataRoot, snapshotRoot: active.journal.snapshotRoot });
  const rolledBackJournal = { ...active.journal, phase: "rolled_back", rollback, failure: safeLabel(reason) };
  await writeUpdateTransactionJournal({
    dataRoot,
    journal: rolledBackJournal,
  }).catch(() => {});
  const finalization = await finalizeUpdateTransactionArtifacts({ dataRoot, journal: rolledBackJournal });
  return { ...rollback, ...finalization, transactionId: active.journal.transactionId };
};

export const recoverInterruptedDataUpdate = async ({
  dataRoot = appDataRoot(),
  isProcessAlive = processIsAlive,
} = {}) => {
  const active = await readUpdateTransactionJournal({ dataRoot });
  if (!active) return { recovered: false, status: "none" };
  const { journal } = active;
  if (["installer_succeeded", "complete"].includes(journal.phase)) {
    const finalization = await finalizeUpdateTransactionArtifacts({ dataRoot, journal });
    return {
      recovered: true,
      status: finalization.cleanupDeferred ? "completed_cleanup_deferred" : "completed",
      transactionId: journal.transactionId,
      ...finalization,
    };
  }
  if (journal.phase === "rolled_back") {
    const finalization = await finalizeUpdateTransactionArtifacts({ dataRoot, journal });
    return {
      recovered: true,
      status: finalization.cleanupDeferred ? "rolled_back_cleanup_deferred" : "rolled_back",
      transactionId: journal.transactionId,
      ...finalization,
    };
  }
  if (journal.phase === "installer_running" && isProcessAlive(Number(journal.installerPid))) {
    const error = new Error("更新安装器仍在运行；为避免并发写入，已暂停启动数据服务");
    error.code = "UPDATE_INSTALLER_STILL_RUNNING";
    throw error;
  }
  const rollback = await rollbackPreparedUserDataUpdate({
    dataRoot,
    transactionId: journal.transactionId,
    reason: `startup-recovery-${journal.phase}`,
  });
  return { recovered: true, status: "rolled_back", transactionId: journal.transactionId, rollback };
};

export const guardDesktopStartupDataVersion = async ({
  dataRoot = appDataRoot(),
  machineRoot,
  currentVersion,
  buildId = "",
  dataSchemaVersion = 1,
  migrate = async () => ({ migrated: 0 }),
} = {}) => {
  const version = safeLabel(currentVersion);
  const normalizedBuildId = safeLabel(buildId || `legacy-${version}`);
  const normalizedDataSchemaVersion = Number(dataSchemaVersion);
  if (!Number.isSafeInteger(normalizedDataSchemaVersion) || normalizedDataSchemaVersion <= 0) throw new Error("数据 schema 版本无效");
  const privateRoot = resolve(machineRoot || dirname(resolve(dataRoot)));
  const markerPath = join(privateRoot, "runtime", "data-version-state.json");
  const previous = await readFile(markerPath, "utf8").then((text) => JSON.parse(text.replace(/^\uFEFF/, ""))).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (previous?.schemaVersion === 2
    && safeLabel(previous.appVersion) === version
    && safeLabel(previous.buildId) === normalizedBuildId
    && Number(previous.dataSchemaVersion) === normalizedDataSchemaVersion) {
    return {
      guarded: false,
      status: "same-build",
      previousVersion: version,
      currentVersion: version,
      buildId: normalizedBuildId,
      dataSchemaVersion: normalizedDataSchemaVersion,
      markerPath,
    };
  }

  // Application-only releases must never synchronously hash/snapshot the
  // entire user library before the desktop HTTP core listens. A full verified
  // migration is reserved for an actual data-schema change; compatible builds
  // retain the existing data root and atomically advance the marker instead.
  if (previous?.schemaVersion === 2
    && Number(previous.dataSchemaVersion) === normalizedDataSchemaVersion) {
    await atomicWriteJson(markerPath, {
      schemaVersion: 2,
      appVersion: version,
      buildId: normalizedBuildId,
      dataSchemaVersion: normalizedDataSchemaVersion,
      previousVersion: safeLabel(previous.appVersion || ""),
      validatedAt: new Date().toISOString(),
      snapshotFileCount: previous.snapshotFileCount ?? 0,
      snapshotBytes: previous.snapshotBytes ?? 0,
    });
    return {
      guarded: false,
      status: safeLabel(previous.appVersion) === version ? "same-version-different-build" : "compatible-schema-upgrade",
      previousVersion: safeLabel(previous.appVersion || ""),
      currentVersion: version,
      buildId: normalizedBuildId,
      dataSchemaVersion: normalizedDataSchemaVersion,
      markerPath,
    };
  }

  const before = await inventoryDataRoot(dataRoot);
  if (!previous && (before.files.length === 0 || normalizedDataSchemaVersion === 1)) {
    await atomicWriteJson(markerPath, {
      schemaVersion: 2,
      appVersion: version,
      buildId: normalizedBuildId,
      dataSchemaVersion: normalizedDataSchemaVersion,
      validatedAt: new Date().toISOString(),
    });
    return { guarded: false, status: before.files.length ? "legacy-compatible-schema" : "clean-install", previousVersion: "", currentVersion: version, buildId: normalizedBuildId, dataSchemaVersion: normalizedDataSchemaVersion, markerPath };
  }

  const previousVersion = safeLabel(previous?.appVersion || "legacy-unversioned-data");
  const prepared = await prepareUserDataForUpdate({
    dataRoot,
    targetVersion: `${version}-${normalizedBuildId}`,
    operation: previous ? "upgrade" : "repair",
    retainSnapshotOnSuccess: true,
    migrate,
    validateMigrationInventory: validateStartupMigrationInventory,
  });
  await markPreparedUpdateInstallerState({
    dataRoot,
    transactionId: prepared.transactionId,
    phase: "installer_succeeded",
    detail: { source: "desktop-startup-version-guard", previousVersion, currentVersion: version, buildId: normalizedBuildId, dataSchemaVersion: normalizedDataSchemaVersion },
  });
  const finalized = await recoverInterruptedDataUpdate({ dataRoot });
  await atomicWriteJson(markerPath, {
    schemaVersion: 2,
    appVersion: version,
    buildId: normalizedBuildId,
    dataSchemaVersion: normalizedDataSchemaVersion,
    previousVersion,
    validatedAt: new Date().toISOString(),
    snapshotFileCount: prepared.snapshotFileCount,
    snapshotBytes: prepared.snapshotBytes,
  });
  return {
    guarded: true,
    status: finalized.status,
    previousVersion,
    currentVersion: version,
    buildId: normalizedBuildId,
    dataSchemaVersion: normalizedDataSchemaVersion,
    markerPath,
    snapshotFileCount: prepared.snapshotFileCount,
    snapshotBytes: prepared.snapshotBytes,
  };
};
