import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { appDataRoot, setConfiguredDataRoot } from "./app-data.mjs";

const SKIP_ROOT_NAMES = new Set(["updates", "machine-sessions"]);
const SKIP_FILE_PATTERN = /(?:\.tmp|\.lock|\.pending)$/i;
const SHENSI_DATA_ROOT_NAMES = new Set([
  "作品",
  "笔记",
  "Skill库",
  "知识图谱",
  "experience-store",
  "external-markdown",
  "generation-attempts",
  "generation-jobs",
  "task-sessions",
  "recovery",
  "迁移",
  "迁移备份",
]);

const isInside = (candidate, parent) => {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const validateTarget = (value) => {
  const source = String(value ?? "").trim();
  if (!source || !isAbsolute(source)) throw new Error("请输入数据目录的绝对路径");
  const target = resolve(source);
  const parsedRoot = parse(target).root;
  if (target === parsedRoot || target === resolve(homedir())) throw new Error("不能把磁盘根目录或用户主目录直接设为神思数据目录");
  const installRoot = String(process.env.SHENSI_INSTALL_ROOT || "").trim();
  if (installRoot) {
    const applicationRoot = resolve(installRoot);
    if (isInside(target, applicationRoot) || isInside(applicationRoot, target)) {
      throw new Error("神思数据目录必须与软件安装目录完全分离，避免覆盖安装或卸载影响用户文件");
    }
  }
  return target;
};

const collectFiles = async (root, directory = root, result = []) => {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) return result;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && SKIP_ROOT_NAMES.has(entry.name)) continue;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(root, absolutePath, result);
    else if (entry.isFile() && !SKIP_FILE_PATTERN.test(entry.name) && entry.name !== "bootstrap.json") {
      result.push({ absolutePath, relativePath: relative(root, absolutePath) });
    }
  }
  return result;
};

const fileHash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");

const directoryNames = async (root) => {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

const workspaceDirectoryCount = async (root, name) => {
  const entries = await readdir(join(root, name), { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).length;
};

export const storageStatus = () => ({
  root: appDataRoot(),
  fixedByEnvironment: Boolean(process.env.SHENSI_DATA_ROOT),
});

export const previewStorageRootChange = async ({ targetRoot } = {}) => {
  const sourceRoot = resolve(appDataRoot());
  const target = validateTarget(targetRoot);
  if (sourceRoot === target) return { sourceRoot, targetRoot: target, fileCount: 0, conflictCount: 0, conflicts: [], unchanged: true };
  if (isInside(target, sourceRoot) || isInside(sourceRoot, target)) throw new Error("新旧数据目录不能互相嵌套");
  const files = await collectFiles(sourceRoot);
  const conflicts = [];
  let identicalCount = 0;
  for (const file of files) {
    const destination = join(target, file.relativePath);
    const destinationInfo = await stat(destination).catch(() => null);
    if (!destinationInfo) continue;
    if (!destinationInfo.isFile()) {
      conflicts.push(file.relativePath);
      continue;
    }
    const sourceInfo = await stat(file.absolutePath);
    if (sourceInfo.size === destinationInfo.size && await fileHash(file.absolutePath) === await fileHash(destination)) identicalCount += 1;
    else conflicts.push(file.relativePath);
  }
  return {
    sourceRoot,
    targetRoot: target,
    fileCount: files.length,
    identicalCount,
    copyCount: files.length - identicalCount,
    conflictCount: conflicts.length,
    conflicts: conflicts.slice(0, 30),
    unchanged: false,
  };
};

export const previewStorageRootRead = async ({ targetRoot, currentRoot = appDataRoot() } = {}) => {
  const sourceRoot = resolve(currentRoot);
  const target = validateTarget(targetRoot);
  const targetInfo = await stat(target).catch(() => null);
  if (!targetInfo?.isDirectory()) throw new Error("所选百度网盘同步目录不存在或尚未下载到本机");
  if (sourceRoot !== target && (isInside(target, sourceRoot) || isInside(sourceRoot, target))) {
    throw new Error("同步目录与当前数据目录不能互相嵌套");
  }

  const targetFiles = await collectFiles(target);
  const sourceFiles = sourceRoot === target ? targetFiles : await collectFiles(sourceRoot);
  const sourceMap = new Map(sourceFiles.map((file) => [file.relativePath.toLocaleLowerCase("en-US"), file]));
  const targetKeys = new Set();
  const differentFiles = [];
  let targetOnlyCount = 0;
  let identicalCount = 0;
  const snapshotParts = [];

  for (const file of targetFiles) {
    const key = file.relativePath.toLocaleLowerCase("en-US");
    targetKeys.add(key);
    const targetFileInfo = await stat(file.absolutePath);
    snapshotParts.push(`${file.relativePath.normalize("NFC")}\u0000${targetFileInfo.size}\u0000${Math.trunc(targetFileInfo.mtimeMs)}`);
    const source = sourceMap.get(key);
    if (!source) {
      targetOnlyCount += 1;
      continue;
    }
    const sourceInfo = await stat(source.absolutePath).catch(() => null);
    if (sourceInfo?.isFile() && sourceInfo.size === targetFileInfo.size && await fileHash(source.absolutePath) === await fileHash(file.absolutePath)) {
      identicalCount += 1;
    } else {
      differentFiles.push(file.relativePath);
    }
  }

  const rootNames = await directoryNames(target);
  const recognizedRoots = rootNames.filter((name) => SHENSI_DATA_ROOT_NAMES.has(name));
  const recognizedFileCount = targetFiles.filter((file) => SHENSI_DATA_ROOT_NAMES.has(file.relativePath.split(/[\\/]/u)[0])).length;
  const readable = recognizedRoots.length > 0 || recognizedFileCount > 0;
  return {
    sourceRoot,
    targetRoot: target,
    unchanged: sourceRoot === target,
    readable,
    targetFileCount: targetFiles.length,
    targetOnlyCount,
    currentOnlyCount: sourceFiles.filter((file) => !targetKeys.has(file.relativePath.toLocaleLowerCase("en-US"))).length,
    identicalCount,
    differentCount: differentFiles.length,
    differentFiles: differentFiles.slice(0, 30),
    recognizedRoots,
    recognizedFileCount,
    projectCount: await workspaceDirectoryCount(target, "作品"),
    notebookCount: await workspaceDirectoryCount(target, "笔记"),
    snapshotId: createHash("sha256").update(snapshotParts.sort().join("\n")).digest("hex"),
  };
};

const atomicCopy = async (source, target) => {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, target);
};

export const applyStorageRootChange = async ({ targetRoot, currentWorkspacePath = "" } = {}) => {
  const preview = await previewStorageRootChange({ targetRoot });
  if (preview.unchanged) return { ...preview, applied: false, workspacePath: currentWorkspacePath };
  if (preview.conflictCount) throw new Error(`目标目录存在 ${preview.conflictCount} 个不同内容的同名文件，请选择空目录或先解决冲突`);
  const files = await collectFiles(preview.sourceRoot);
  let copied = 0;
  for (const file of files) {
    const destination = join(preview.targetRoot, file.relativePath);
    if (await stat(destination).catch(() => null)) continue;
    await atomicCopy(file.absolutePath, destination);
    copied += 1;
  }
  await setConfiguredDataRoot(preview.targetRoot);
  const workspacePath = currentWorkspacePath && isInside(resolve(currentWorkspacePath), preview.sourceRoot)
    ? join(preview.targetRoot, relative(preview.sourceRoot, resolve(currentWorkspacePath)))
    : currentWorkspacePath;
  return { ...preview, applied: true, copied, workspacePath };
};

export const applyStorageRootRead = async ({
  targetRoot,
  expectedSnapshotId = "",
  currentRoot = appDataRoot(),
  activateRoot = setConfiguredDataRoot,
} = {}) => {
  const preview = await previewStorageRootRead({ targetRoot, currentRoot });
  if (!preview.readable) throw new Error("所选目录中没有检测到可读取的神思作品、笔记或数据结构");
  if (expectedSnapshotId && preview.snapshotId !== expectedSnapshotId) {
    throw new Error("同步目录在预览后发生了变化，请重新读取预览后再确认");
  }
  if (preview.unchanged) return { ...preview, applied: false, previousRoot: preview.sourceRoot, root: preview.targetRoot };
  await activateRoot(preview.targetRoot);
  return { ...preview, applied: true, previousRoot: preview.sourceRoot, root: preview.targetRoot };
};
