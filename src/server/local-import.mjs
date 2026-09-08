import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { extractDocumentText } from "./document-extraction.mjs";

const MAX_FILES = 2_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const JOB_TTL_MS = 30 * 60 * 1000;
const SUPPORTED_EXTENSIONS = new Set([
  ".md", ".txt", ".csv", ".json", ".xml", ".html", ".htm", ".rtf",
  ".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp", ".wps", ".et", ".dps",
]);
const EXCLUDED_DIRECTORY_NAMES = new Set([".git", ".shensi", "node_modules", "history-isolated"]);
const importJobs = new Map();

const cleanupJobs = () => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of importJobs) {
    if (job.createdAt < cutoff) importJobs.delete(id);
  }
};

const normalizedSourcePath = (value) => {
  const source = String(value ?? "").trim();
  if (!source || !isAbsolute(source)) throw new Error("请输入要导入的文件或文件夹绝对路径");
  return resolve(source);
};

const collectFiles = async (sourcePath) => {
  const sourceInfo = await stat(sourcePath).catch(() => null);
  if (!sourceInfo) throw new Error("导入路径不存在");
  if (sourceInfo.isFile()) return [{ absolutePath: sourcePath, relativePath: basename(sourcePath), size: sourceInfo.size }];
  if (!sourceInfo.isDirectory()) throw new Error("导入路径不是文件或文件夹");
  const result = [];
  let totalBytes = 0;
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const info = await stat(absolutePath);
      totalBytes += info.size;
      if (result.length >= MAX_FILES) throw new Error(`单次最多导入 ${MAX_FILES} 个文档`);
      if (totalBytes > MAX_SOURCE_BYTES) throw new Error("单次导入源文件总大小不能超过 512 MB");
      result.push({ absolutePath, relativePath: relative(sourcePath, absolutePath).replaceAll("\\", "/"), size: info.size });
    }
  };
  await walk(sourcePath);
  return result;
};

const titleFromPath = (path) => basename(path, extname(path)).trim() || "未命名文档";
const documentIdFor = (jobId, relativePath, index) => `local-import-${createHash("sha1")
  .update(`${jobId}\u0000${relativePath}\u0000${index}`)
  .digest("hex")
  .slice(0, 14)}`;

const normalizedDirectoryPart = (value) => String(value ?? "")
  .trim()
  .replace(/^\d{1,3}[\s_.-]*/, "")
  .toLocaleLowerCase("zh-CN");

const PROJECT_MODULE_FOLDERS = new Map([
  ["正文", "manuscript"],
  ["章节", "manuscript"],
  ["manuscript", "manuscript"],
  ["chapter", "manuscript"],
  ["chapters", "manuscript"],
  ["大纲", "outline"],
  ["章纲", "outline"],
  ["outline", "outline"],
  ["outlines", "outline"],
  ["设定", "canon"],
  ["正史设定", "canon"],
  ["世界观", "canon"],
  ["canon", "canon"],
  ["setting", "canon"],
  ["settings", "canon"],
  ["记忆", "memory"],
  ["memory", "memory"],
  ["编译报告", "reports"],
  ["报告", "reports"],
  ["report", "reports"],
  ["reports", "reports"],
  ["资料库", "library"],
  ["资料", "library"],
  ["参考资料", "library"],
  ["library", "library"],
  ["reference", "library"],
  ["references", "library"],
  ["索引", "index"],
  ["index", "index"],
  ["indexes", "index"],
]);

const importedDirectoryPlacement = ({ relativePath, workspaceKind, destinationMode }) => {
  if (destinationMode !== "workspace") return {};
  const parts = String(relativePath ?? "").split("/").filter(Boolean);
  const directories = parts.slice(0, -1);
  if (workspaceKind === "notebook") {
    return {
      moduleId: "manuscript",
      workspaceView: "novel",
      contextDomain: "general",
      folderPath: directories.join("/"),
      rootPlacement: directories.length === 0,
    };
  }
  const matchedModuleId = PROJECT_MODULE_FOLDERS.get(normalizedDirectoryPart(directories[0]));
  const moduleId = matchedModuleId || "manuscript";
  const folderParts = matchedModuleId ? directories.slice(1) : directories;
  return {
    moduleId,
    workspaceView: ["manuscript", "outline", "canon", "memory"].includes(moduleId) ? "novel" : "default",
    contextDomain: "novel",
    folderPath: folderParts.join("/"),
    rootPlacement: folderParts.length === 0,
  };
};

export const previewLocalImport = async ({ sourcePath, workspaceKind = "project", existingTitles = [], destinationMode = "current" } = {}) => {
  cleanupJobs();
  const source = normalizedSourcePath(sourcePath);
  const files = await collectFiles(source);
  if (!files.length) throw new Error("没有找到支持导入的文档；当前支持 Markdown、TXT、WPS 和常见 Office/OpenDocument 格式");
  const existing = new Set((Array.isArray(existingTitles) ? existingTitles : []).map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  const jobId = `local_import_${randomUUID()}`;
  const prepared = [];
  for (const [index, file] of files.entries()) {
    const bytes = await readFile(file.absolutePath);
    const extraction = extractDocumentText({ bytes, name: file.relativePath });
    const title = titleFromPath(file.relativePath);
    prepared.push({
      id: documentIdFor(jobId, file.relativePath, index),
      title,
      text: extraction.text,
      extractionStatus: extraction.extractionStatus,
      extractionError: extraction.extractionError || "",
      relativePath: file.relativePath,
      size: file.size,
      conflict: existing.has(title.toLowerCase()),
    });
  }
  const normalizedDestinationMode = destinationMode === "workspace" ? "workspace" : "current";
  const targetLabel = normalizedDestinationMode === "workspace"
    ? workspaceKind === "notebook" ? "新建本地笔记本" : "新建本地作品"
    : workspaceKind === "notebook" ? "当前笔记本 / 根目录" : "当前作品 / 资料库 / 导入资料";
  importJobs.set(jobId, {
    id: jobId,
    createdAt: Date.now(),
    sourcePath: source,
    sourceName: basename(source),
    workspaceKind,
    destinationMode: normalizedDestinationMode,
    targetLabel,
    documents: prepared,
  });
  return {
    jobId,
    sourcePath: source,
    sourceName: basename(source),
    workspaceKind,
    destinationMode: normalizedDestinationMode,
    targetLabel,
    fileCount: prepared.length,
    readableCount: prepared.filter((item) => item.text).length,
    unsupportedCount: prepared.filter((item) => !item.text).length,
    conflictCount: prepared.filter((item) => item.conflict).length,
    files: prepared.slice(0, 100).map(({ text, ...item }) => ({ ...item, characters: text.length })),
  };
};

export const applyLocalImport = async ({ jobId } = {}) => {
  cleanupJobs();
  const job = importJobs.get(String(jobId ?? ""));
  if (!job) throw new Error("导入预览已过期，请重新预览");
  importJobs.delete(job.id);
  const documents = job.documents
    .filter((item) => item.text)
    .map((item) => {
      const placement = importedDirectoryPlacement({
        relativePath: item.relativePath,
        workspaceKind: job.workspaceKind,
        destinationMode: job.destinationMode,
      });
      return {
        id: item.id,
        title: item.conflict ? `${item.title}（导入）` : item.title,
        text: item.text,
        sourcePath: item.relativePath,
        moduleId: placement.moduleId || (job.workspaceKind === "notebook" ? "manuscript" : "library"),
        workspaceView: placement.workspaceView || (job.workspaceKind === "notebook" ? "novel" : "default"),
        contextDomain: placement.contextDomain || (job.workspaceKind === "notebook" ? "general" : "novel"),
        folderPath: placement.folderPath || "",
        rootPlacement: placement.rootPlacement === true,
        customFolderId: job.destinationMode === "workspace" ? "" : job.workspaceKind === "notebook" ? "" : "custom-folder:library-imported",
        folderLabel: job.destinationMode === "workspace" ? "" : job.workspaceKind === "notebook" ? "" : "导入资料",
      };
    });
  if (!documents.length) throw new Error("这些文件没有提取出可导入的文字");
  return {
    jobId: job.id,
    sourcePath: job.sourcePath,
    sourceName: job.sourceName,
    workspaceKind: job.workspaceKind,
    destinationMode: job.destinationMode,
    targetLabel: job.targetLabel,
    importedCount: documents.length,
    documents,
  };
};
