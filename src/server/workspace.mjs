import { constants as fsConstants, createReadStream, createWriteStream, existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, stat, statfs, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gzip as gzipCallback, gunzip as gunzipCallback } from "node:zlib";
import { pruneTrashEntries, TRASH_RETENTION_MS, trashEntryDocumentIds } from "../trash.js";
import { markdownTableToHtml } from "../markdown-table.js";
import { sanitizeDocumentHtml } from "../document-sanitize.js";
import { cleanObsidianInlineMarkdown, cleanObsidianMigrationMarkdown } from "../obsidian-markdown.js";
import { normalizeStructureLanguage } from "../structure-language.js";
import {
  structuredGroupByKey,
  structuredGroupForDocument,
  structuredGroupForWorkspacePath,
} from "../structure-schema.js";
import { extractDocumentText } from "./document-extraction.mjs";
import { appDataRoot, persistentNotesRoot, persistentWorksRoot } from "./app-data.mjs";
import { portableGenerationSettings } from "../generation-profiles.js";
import { MAX_MODEL_MEDIA_REFERENCES } from "../model-presets.js";
import { mergeImportedDocuments } from "../imported-workspace.js";
import { classifyStructuredDocument } from "../structure-placement.js";
import { episodeHeadingParts, episodeMarkdownFileName } from "../episode-document.js";
import { freeDocumentTitle, sequencedDocumentKind, sequencedDocumentLabel } from "../document-title-policy.js";
import { verifyCommittedWorkspaceDocuments } from "./document-transaction-service.mjs";
import { prepareFullPrewriteHistory, verifyFullPrewriteHistory } from "./document-prewrite-history.mjs";
import { isStructuredMemoryDocumentId, memoryProjectionMarkdownToHtml } from "../structured-memory-store.js";

const normalizeForCompare = (value) => {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
};

const LEGACY_BUSINESS_DIRECTORY_TARGETS = Object.freeze({
  作品: () => persistentWorksRoot(),
  笔记: () => persistentNotesRoot(),
  Skill库: () => join(appDataRoot(), "Skill库"),
});

const workspaceIdentityKey = (workspaceRoot = "") => {
  try {
    const identity = JSON.parse(readFileSync(join(workspaceRoot, ".shensi", "project-identity.json"), "utf8"));
    return String(identity.workspaceId || identity.projectId || identity.legacyProjectId || "").trim();
  } catch {
    return "";
  }
};

const sameWorkspaceIdentity = (leftRoot, rightRoot) => {
  const left = workspaceIdentityKey(leftRoot);
  const right = workspaceIdentityKey(rightRoot);
  return Boolean(left && right && left === right);
};

const previewWorkspaceRootFromPath = (value = "") => {
  const normalized = String(value || "").replaceAll("/", "\\");
  const match = normalized.match(/^(.+?\\runtime\\browser-preview\\(作品|笔记)\\[^\\]+)(?:\\.*)?$/iu);
  return match ? { workspaceRoot: match[1], kind: match[2] } : null;
};

const migratedLegacyBusinessPath = (value = "", { workspaceRoot = "", aliases = [] } = {}) => {
  const source = String(value || "");
  // Only migrate fields that are themselves filesystem paths. Agent traces,
  // command output and document content may legitimately mention an old path;
  // treating those multi-line strings as paths corrupts the stored evidence.
  if (/[\r\n"'`]/u.test(source)) return source;
  if (!isAbsolute(source)) return source;
  for (const alias of aliases) {
    const sourceRoot = resolve(String(alias?.sourceRoot || ""));
    const targetRoot = resolve(String(alias?.targetRoot || ""));
    const remainder = relative(sourceRoot, source);
    if (remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder))) {
      return remainder ? join(targetRoot, remainder) : targetRoot;
    }
  }
  const match = source.replaceAll("/", "\\").match(/^[A-Za-z]:\\[^\r\n]*?\\ShensiCreativeEngine\\(作品|笔记|Skill库)(?:\\([^\r\n]*))?$/u);
  if (match) {
    const targetRoot = LEGACY_BUSINESS_DIRECTORY_TARGETS[match[1]]?.();
    if (targetRoot) return match[2] ? join(targetRoot, ...match[2].split("\\").filter(Boolean)) : targetRoot;
  }
  const preview = workspaceRoot ? previewWorkspaceRootFromPath(source) : null;
  if (!preview) return source;
  const currentKind = isInside(normalizeForCompare(workspaceRoot), normalizeForCompare(persistentNotesRoot()))
    ? "笔记"
    : isInside(normalizeForCompare(workspaceRoot), normalizeForCompare(persistentWorksRoot()))
      ? "作品"
      : "";
  if (preview.kind !== currentKind || !sameWorkspaceIdentity(preview.workspaceRoot, workspaceRoot)) return source;
  const remainder = relative(preview.workspaceRoot, source);
  return remainder ? join(workspaceRoot, remainder) : resolve(workspaceRoot);
};

const migrateLegacyBusinessPathsInValue = (value, options = {}) => {
  let changed = false;
  const visit = (input) => {
    if (typeof input === "string") {
      const migrated = migratedLegacyBusinessPath(input, options);
      if (migrated !== input) changed = true;
      return migrated;
    }
    if (Array.isArray(input)) return input.map(visit);
    if (!input || typeof input !== "object") return input;
    return Object.fromEntries(Object.entries(input).map(([key, child]) => [key, visit(child)]));
  };
  return { value: visit(value), changed };
};
const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);
const isInside = (candidate, parent) => {
  const rel = relative(parent, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export const resolveWorkspaceInternalRoot = (workspaceRoot) => join(workspaceRoot, ".shensi");

const safeName = (value) => {
  const name = String(value ?? "未命名")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return !name || name === "." || name === ".." ? "未命名" : name;
};

const RESERVED_MANAGED_ROOTS = new Set([".shensi"]);
const normalizeManagedRelativePath = (value, { allowInternal = false, label = "文件" } = {}) => {
  const source = String(value ?? "").trim().replaceAll("\\", "/");
  if (!source || source.includes("\u0000") || isAbsolute(source) || /^[a-z]:/i.test(source) || source.startsWith("//")) {
    throw new Error(`${label}路径无效`);
  }
  const parts = source.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`${label}路径越界`);
  if (!allowInternal && RESERVED_MANAGED_ROOTS.has(parts[0].toLowerCase())) throw new Error(`${label}不能写入神思内部目录`);
  return parts.join("/");
};

const resolveManagedTarget = (workspaceRoot, value, options = {}) => {
  const relativePath = normalizeManagedRelativePath(value, options);
  const targetPath = resolve(workspaceRoot, relativePath);
  if (!isInside(targetPath, workspaceRoot)) throw new Error(`${options.label ?? "文件"}路径越界`);
  return { relativePath, targetPath };
};

const assertManagedTargetDoesNotEscapeLinks = async (workspaceRoot, targetPath, label = "文件", validationCache = null) => {
  const cache = validationCache instanceof Map ? validationCache : new Map();
  const rootKey = `root:${normalizeForCompare(workspaceRoot)}`;
  const rootReal = cache.get(rootKey) || await realpath(workspaceRoot).catch((error) => {
    if (error.code === "ENOENT") return resolve(workspaceRoot);
    throw error;
  });
  cache.set(rootKey, rootReal);
  let cursor = workspaceRoot;
  for (const part of relative(workspaceRoot, targetPath).split(/[\\/]+/).filter(Boolean)) {
    cursor = join(cursor, part);
    const cursorKey = `entry:${normalizeForCompare(cursor)}`;
    if (cache.has(cursorKey)) continue;
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        const actual = await realpath(cursor);
        if (!isInside(actual, rootReal)) throw new Error(`${label}路径经过了工作区外的链接`);
      }
      cache.set(cursorKey, true);
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
};

const secureManagedTarget = async (workspaceRoot, value, options = {}) => {
  const resolved = resolveManagedTarget(workspaceRoot, value, options);
  await assertManagedTargetDoesNotEscapeLinks(workspaceRoot, resolved.targetPath, options.label, options.linkValidationCache);
  return resolved;
};

const chapterPath = (id, documentState) => {
  const number = Number(id.match(/\d+/)?.[0] ?? 0);
  const padded = String(number).padStart(3, "0");
  const title = safeName(documentState.title.replace(/^第.+?章\s*/, ""));
  const volumeFolder = safeName(documentState.volumeFolder || "第001卷-未命名");
  return join("04_正文", "小说", volumeFolder, `第${padded}章-${title}.md`);
};

const dynamicOutlinePath = (id, documentState) => {
  const volumeNumber = Number(id.match(/^outline-volume-(\d+)$/)?.[1] ?? 0);
  if (volumeNumber) {
    const title = safeName(documentState.title.replace(/^第.+?卷卷纲[\s　]*/, ""));
    return join("01_剧情控制", "卷纲", `第${String(volumeNumber).padStart(3, "0")}卷卷纲-${title}.md`);
  }
  const chapterNumber = Number(id.match(/^outline-chapter-(\d+)$/)?.[1] ?? 0);
  if (chapterNumber) return join("01_剧情控制", "章纲", `第${String(chapterNumber).padStart(3, "0")}章章纲.md`);
  return null;
};

const englishProjectDocumentPath = (id, documentState = {}) => {
  const title = `${safeName(documentState.title || "Untitled document")}.md`;
  const customPath = String(documentState.customFolderPath ?? "").split(/[\\/]+/).map((part) => part.trim()).filter(Boolean).map(safeName);
  const chapterNumber = Number(String(id).match(/^chapter-(\d+)$/)?.[1] ?? 0);
  if (chapterNumber) {
    const chapterTitle = safeName(String(documentState.title || "Untitled").replace(/^Chapter\s+\d+\s*/i, "") || "Untitled");
    const volumeFolder = safeName(documentState.volumeFolder || "Volume-001-Untitled");
    return join("04_Manuscript", "Novel", volumeFolder, `Chapter ${String(chapterNumber).padStart(3, "0")}-${chapterTitle}.md`);
  }
  const volumeOutline = Number(String(id).match(/^outline-volume-(\d+)$/)?.[1] ?? 0);
  if (volumeOutline) return join("01_Plot Control", "Volume Outlines", title);
  const chapterOutline = Number(String(id).match(/^outline-chapter-(\d+)$/)?.[1] ?? 0);
  if (chapterOutline) return join("01_Plot Control", "Chapter Outlines", title);
  if (id === "outline-series" || id.startsWith("outline-general-")) return join("01_Plot Control", title);
  if (id.startsWith("script-outline-")) return join("04_Manuscript", "Short Drama", "Script Outlines", ...(id === "script-outline-series" || id.startsWith("script-outline-general-") ? [] : ["Episode Outlines"]), title);
  if (id.startsWith("script-episode-")) {
    return join("04_Manuscript", "Short Drama", "Scripts", episodeMarkdownFileName(id, documentState.title, { language: "en-US" }));
  }
  if (id.startsWith("prompt-video-")) return join("04_Manuscript", "Short Drama", "Video Prompts", title);
  if (id.startsWith("prompt-visual-")) return join("04_Manuscript", "Short Drama", "Visual Asset Prompts", title);
  if (id.startsWith("prompt-panorama-")) return join("04_Manuscript", "Short Drama", "Panorama Staging Prompts", title);
  if (id.startsWith("script-canon-") || (documentState.moduleId === "canon" && documentState.workspaceView === "script")) return join("04_Manuscript", "Short Drama", "Script Canon", ...customPath, title);
  if (id.startsWith("script-memory-") || (documentState.moduleId === "memory" && documentState.workspaceView === "script")) return join("04_Manuscript", "Short Drama", "Script Memory", ...customPath, title);
  if (id.startsWith("canon-") || documentState.moduleId === "canon") return join("02_Canon", ...customPath, title);
  if (id.startsWith("memory-") || documentState.moduleId === "memory") return join("03_Memory", ...customPath, title);
  if (id.startsWith("report-") || documentState.moduleId === "reports") return join("07_Reports", ...customPath, title);
  if (id.startsWith("library-deconstruction-")) return join("08_Library", "Reference Materials", title);
  if (id.startsWith("library-") || documentState.moduleId === "library") return join("08_Library", ...customPath, title);
  if (id.startsWith("index-") || documentState.moduleId === "index") return join("09_Index", ...customPath, title);
  if (documentState.moduleId === "manuscript") return join("04_Manuscript", "Novel", ...customPath, title);
  if (documentState.moduleId === "outline") return join("01_Plot Control", ...customPath, title);
  return join("10_Other", ...customPath, title);
};

const PATH_MAP = {
  "outline-series": join("01_剧情控制", "全集大纲.md"),
  "outline-volume-1": join("01_剧情控制", "卷纲", "第一卷卷纲.md"),
  "outline-chapter-6": join("01_剧情控制", "章纲", "第006章章纲.md"),
  "script-outline-series": join("04_正文", "短剧", "剧本大纲", "全集大纲.md"),
  "script-outline-episode-1": join("04_正文", "短剧", "剧本大纲", "集纲", "第001集集纲.md"),
  "canon-locations": join("02_正史设定", "地图与地点.md"),
  "canon-concepts": join("02_正史设定", "概念设定.md"),
  "canon-rules": join("02_正史设定", "规则设定.md"),
  "canon-basics": join("02_正史设定", "基础设定.md"),
  "canon-power": join("02_正史设定", "力量体系.md"),
  "canon-characters": join("02_正史设定", "人物设定.md"),
  "canon-relations": join("02_正史设定", "人物关系.md"),
  "canon-timeline": join("02_正史设定", "时间线.md"),
  "canon-world": join("02_正史设定", "世界观与基础规则.md"),
  "canon-events": join("02_正史设定", "事件与时间线.md"),
  "canon-factions": join("02_正史设定", "势力与组织.md"),
  "canon-special": join("02_正史设定", "特殊设定.md"),
  "canon-items": join("02_正史设定", "物品与道具.md"),
  "canon-derivatives": join("02_正史设定", "衍生设定.md"),
  "canon-races": join("02_正史设定", "种族设定.md"),
  "canon-glossary": join("02_正史设定", "术语表.md"),
  "memory-foreshadowing": join("01_剧情控制", "伏笔管理", "伏笔总表.md"),
  "memory-information-ledger": join("01_剧情控制", "信息账本.md"),
  "memory-first-appearance": join("01_剧情控制", "重要信息登场账本.md"),
  "memory-release": join("01_剧情控制", "信息释放表.md"),
  "memory-reader": join("01_剧情控制", "读者当前知识库.md"),
  "memory-snapshot": join("03_状态快照", "当前状态.md"),
  "memory-chapters": join("05_章节记忆", "章节记忆.md"),
  "memory-context": join("06_上下文包", "当前上下文包.md"),
  "script-episode-1": join("04_正文", "短剧", "短剧剧本", "第001集-样集.md"),
  "prompt-video-1": join("04_正文", "短剧", "视频提示词", "第一集视频提示词.md"),
  "prompt-visual-assets": join("04_正文", "短剧", "视觉资产提示词", "视觉资产总表.md"),
  "prompt-panorama-1": join("04_正文", "短剧", "全景调度图提示词", "第一集全景调度图提示词.md"),
  "script-canon-locations": join("04_正文", "短剧", "剧本设定", "场景与地点改编.md"),
  "script-canon-concepts": join("04_正文", "短剧", "剧本设定", "概念设定.md"),
  "script-canon-rules": join("04_正文", "短剧", "剧本设定", "规则设定.md"),
  "script-canon-basics": join("04_正文", "短剧", "剧本设定", "基础设定.md"),
  "script-canon-power": join("04_正文", "短剧", "剧本设定", "力量体系.md"),
  "script-canon-characters": join("04_正文", "短剧", "剧本设定", "人物改编.md"),
  "script-canon-relations": join("04_正文", "短剧", "剧本设定", "关系改编.md"),
  "script-canon-timeline": join("04_正文", "短剧", "剧本设定", "时间线.md"),
  "script-canon-world": join("04_正文", "短剧", "剧本设定", "世界与规则改编.md"),
  "script-canon-events": join("04_正文", "短剧", "剧本设定", "事件与时间线改编.md"),
  "script-canon-factions": join("04_正文", "短剧", "剧本设定", "势力与组织改编.md"),
  "script-canon-special": join("04_正文", "短剧", "剧本设定", "特殊设定.md"),
  "script-canon-items": join("04_正文", "短剧", "剧本设定", "道具改编.md"),
  "script-canon-derivatives": join("04_正文", "短剧", "剧本设定", "衍生设定.md"),
  "script-canon-races": join("04_正文", "短剧", "剧本设定", "种族设定.md"),
  "script-canon-glossary": join("04_正文", "短剧", "剧本设定", "剧本术语.md"),
  "script-memory-foreshadowing": join("04_正文", "短剧", "剧本连续性", "伏笔总表.md"),
  "script-memory-information-ledger": join("04_正文", "短剧", "剧本连续性", "信息账本.md"),
  "script-memory-first-appearance": join("04_正文", "短剧", "剧本连续性", "重要信息登场账本.md"),
  "script-memory-release": join("04_正文", "短剧", "剧本连续性", "信息释放表.md"),
  "script-memory-audience": join("04_正文", "短剧", "剧本连续性", "观众当前知识库.md"),
  "script-memory-snapshot": join("04_正文", "短剧", "剧本连续性", "当前状态.md"),
  "script-memory-episodes": join("04_正文", "短剧", "剧本连续性", "分集记忆.md"),
  "script-memory-context": join("04_正文", "短剧", "剧本连续性", "当前上下文包.md"),
  "report-novel": join("07_编译报告", "小说自检.md"),
  "report-script": join("07_编译报告", "剧本自检.md"),
  "report-adaptation": join("07_编译报告", "小说改剧本编译报告.md"),
  "report-compile": join("07_编译报告", "项目总览.md"),
  "library-reference": join("08_资料库", "参考资料.md"),
  "library-memo": join("08_资料库", "备忘录.md"),
  "library-drafts": join("08_资料库", "版本草案.md"),
  "library-retired": join("08_资料库", "废弃设定.md"),
  "library-trash": join("08_资料库", "回收站索引.md"),
  "index-documents": join("09_索引", "自动索引.md"),
  "index-language-blacklist": join("09_索引", "创作合同.md"),
  "index-update-log": join("09_索引", "更新日志.md"),
  "index-pending": join("09_索引", "待确认事项.md"),
};

// Compatibility-only IDs. The browser migration first folds historical unit
// summaries into their owning chapter/episode metadata. The server still
// refuses to persist these former standalone documents if an older client sends
// them, so they cannot reappear as active Markdown sources.
const RETIRED_PERSISTED_DOCUMENT_IDS = new Set([
  "memory-chapters",
  "memory-context",
  "script-memory-episodes",
  "script-memory-context",
  "library-drafts",
  "library-trash",
]);
const RETIRED_CANON_DOCUMENT_IDS = new Set([
  "canon-concepts",
  "canon-rules",
  "canon-basics",
  "canon-power",
  "canon-timeline",
  "canon-special",
  "canon-derivatives",
  "canon-races",
  "script-canon-concepts",
  "script-canon-rules",
  "script-canon-basics",
  "script-canon-power",
  "script-canon-timeline",
  "script-canon-special",
  "script-canon-derivatives",
  "script-canon-races",
]);

const normalizedRelative = (value) => value.replaceAll("\\", "/").toLowerCase();
const LEGACY_PATH_MAP = {
  "index-language-blacklist": join("09_索引", "项目规则.md"),
  "script-outline-series": join("04_正文", "短剧", "短剧大纲", "全集大纲.md"),
  "script-outline-episode-1": join("04_正文", "短剧", "短剧大纲", "集纲", "第001集集纲.md"),
  "script-memory-foreshadowing": join("04_正文", "短剧", "剧本改编记忆", "伏笔管理.md"),
  "script-memory-information-ledger": join("04_正文", "短剧", "剧本改编记忆", "信息账本.md"),
  "script-memory-first-appearance": join("04_正文", "短剧", "剧本改编记忆", "重要信息登场账本.md"),
  "script-memory-release": join("04_正文", "短剧", "剧本改编记忆", "信息释放表.md"),
  "script-memory-audience": join("04_正文", "短剧", "剧本改编记忆", "观众当前知识库.md"),
  "script-memory-snapshot": join("04_正文", "短剧", "剧本改编记忆", "状态快照.md"),
  "script-memory-episodes": join("04_正文", "短剧", "剧本改编记忆", "分集记忆.md"),
  "script-memory-context": join("04_正文", "短剧", "剧本改编记忆", "上下文包.md"),
};
const LEGACY_FRAMEWORK_PATH_MAP = {
  "canon-characters": join("02_正史设定", "人物设定.md"),
  "canon-world": join("02_正史设定", "世界观.md"),
  "canon-factions": join("02_正史设定", "势力设定.md"),
  "canon-relations": join("02_正史设定", "人物关系.md"),
  "canon-locations": join("02_正史设定", "地图设定.md"),
  "canon-items": join("02_正史设定", "物品设定.md"),
  "canon-events": join("02_正史设定", "事件.md"),
  "canon-timeline": join("02_正史设定", "时间线.md"),
  "script-canon-characters": join("04_正文", "短剧", "剧本设定", "人物.md"),
  "script-canon-world": join("04_正文", "短剧", "剧本设定", "世界观.md"),
  "script-canon-factions": join("04_正文", "短剧", "剧本设定", "势力.md"),
  "script-canon-relations": join("04_正文", "短剧", "剧本设定", "关系.md"),
  "script-canon-locations": join("04_正文", "短剧", "剧本设定", "地点.md"),
  "script-canon-items": join("04_正文", "短剧", "剧本设定", "物品.md"),
  "script-canon-events": join("04_正文", "短剧", "剧本设定", "事件.md"),
  "script-canon-timeline": join("04_正文", "短剧", "剧本设定", "时间线.md"),
  "script-memory-foreshadowing": join("04_正文", "短剧", "剧本记忆", "伏笔管理.md"),
  "script-memory-first-appearance": join("04_正文", "短剧", "剧本记忆", "重要信息登场账本.md"),
  "script-memory-release": join("04_正文", "短剧", "剧本记忆", "信息释放表.md"),
  "script-memory-audience": join("04_正文", "短剧", "剧本记忆", "观众当前知识库.md"),
  "script-memory-snapshot": join("04_正文", "短剧", "剧本记忆", "状态快照.md"),
  "script-memory-episodes": join("04_正文", "短剧", "剧本记忆", "分集记忆.md"),
  "script-memory-context": join("04_正文", "短剧", "剧本记忆", "上下文包.md"),
  "report-novel": join("07_编译报告", "小说自检.md"),
  "report-compile": join("07_编译报告", "最新编译结果.md"),
  "report-adaptation": join("07_编译报告", "小说改剧本编译报告.md"),
  "library-reference": join("08_资料库", "参考资料.md"),
  "index-documents": join("09_索引", "文档索引.md"),
  "index-language-blacklist": join("09_索引", "项目禁用词.md"),
  "index-pending": join("09_索引", "待确认事项.md"),
};
const LEGACY_REPORT_COMPILE_PATHS = [
  join("07_编译报告", "当前编译状态.md"),
  join("07_编译报告", "最新编译结果.md"),
  join("07_编译报告", "编译记录", "最新编译结果.md"),
];
const LEGACY_NESTED_PATH_MAP = {
  "canon-locations": join("02_正史设定", "地图设定", "地图设定.md"),
  "canon-concepts": join("02_正史设定", "概念设定", "概念设定.md"),
  "canon-rules": join("02_正史设定", "规则设定", "规则设定.md"),
  "canon-basics": join("02_正史设定", "基础设定", "基础设定.md"),
  "canon-power": join("02_正史设定", "力量体系", "力量体系.md"),
  "canon-characters": join("02_正史设定", "人物设定", "人物设定.md"),
  "canon-relations": join("02_正史设定", "人物设定", "人物关系.md"),
  "canon-timeline": join("02_正史设定", "时间线", "时间线.md"),
  "canon-world": join("02_正史设定", "世界观", "世界观.md"),
  "canon-events": join("02_正史设定", "事件", "事件.md"),
  "canon-factions": join("02_正史设定", "势力设定", "势力设定.md"),
  "canon-special": join("02_正史设定", "特殊设定", "特殊设定.md"),
  "canon-items": join("02_正史设定", "物品设定", "物品设定.md"),
  "canon-derivatives": join("02_正史设定", "衍生设定", "衍生设定.md"),
  "canon-races": join("02_正史设定", "种族设定", "种族设定.md"),
  "canon-glossary": join("02_正史设定", "术语表", "术语表.md"),
  "script-canon-locations": join("04_正文", "短剧", "剧本设定", "地图设定", "地点.md"),
  "script-canon-concepts": join("04_正文", "短剧", "剧本设定", "概念设定", "概念设定.md"),
  "script-canon-rules": join("04_正文", "短剧", "剧本设定", "规则设定", "规则设定.md"),
  "script-canon-basics": join("04_正文", "短剧", "剧本设定", "基础设定", "基础设定.md"),
  "script-canon-power": join("04_正文", "短剧", "剧本设定", "力量体系", "力量体系.md"),
  "script-canon-characters": join("04_正文", "短剧", "剧本设定", "人物设定", "人物.md"),
  "script-canon-relations": join("04_正文", "短剧", "剧本设定", "人物设定", "关系.md"),
  "script-canon-timeline": join("04_正文", "短剧", "剧本设定", "时间线", "时间线.md"),
  "script-canon-world": join("04_正文", "短剧", "剧本设定", "世界观", "世界观.md"),
  "script-canon-events": join("04_正文", "短剧", "剧本设定", "事件", "事件.md"),
  "script-canon-factions": join("04_正文", "短剧", "剧本设定", "势力设定", "势力.md"),
  "script-canon-special": join("04_正文", "短剧", "剧本设定", "特殊设定", "特殊设定.md"),
  "script-canon-items": join("04_正文", "短剧", "剧本设定", "物品设定", "物品.md"),
  "script-canon-derivatives": join("04_正文", "短剧", "剧本设定", "衍生设定", "衍生设定.md"),
  "script-canon-races": join("04_正文", "短剧", "剧本设定", "种族设定", "种族设定.md"),
  "script-canon-glossary": join("04_正文", "短剧", "剧本设定", "术语表", "术语表.md"),
  "script-memory-foreshadowing": join("04_正文", "短剧", "剧本记忆", "剧情与信息", "伏笔管理.md"),
  "script-memory-information-ledger": join("04_正文", "短剧", "剧本记忆", "剧情与信息", "信息账本.md"),
  "script-memory-first-appearance": join("04_正文", "短剧", "剧本记忆", "剧情与信息", "重要信息登场账本.md"),
  "script-memory-release": join("04_正文", "短剧", "剧本记忆", "剧情与信息", "信息释放表.md"),
  "script-memory-audience": join("04_正文", "短剧", "剧本记忆", "剧情与信息", "观众当前知识库.md"),
  "script-memory-snapshot": join("04_正文", "短剧", "剧本记忆", "状态快照", "状态快照.md"),
  "script-memory-episodes": join("04_正文", "短剧", "剧本记忆", "分集记忆", "分集记忆.md"),
  "script-memory-context": join("04_正文", "短剧", "剧本记忆", "上下文包", "上下文包.md"),
  "report-novel": join("07_编译报告", "小说报告", "小说自检.md"),
  "report-script": join("07_编译报告", "剧本报告", "剧本自检.md"),
  "report-adaptation": join("07_编译报告", "改编报告", "小说改剧本编译报告.md"),
  "report-compile": join("07_编译报告", "编译记录", "最新编译结果.md"),
  "library-reference": join("08_资料库", "参考资料", "参考资料.md"),
  "library-drafts": join("08_资料库", "版本草案", "版本草案.md"),
  "library-retired": join("08_资料库", "废弃设定", "废弃设定.md"),
  "library-trash": join("08_资料库", "回收站", "回收站索引.md"),
  "index-documents": join("09_索引", "文档索引", "文档索引.md"),
  "index-language-blacklist": join("09_索引", "写作规则", "项目禁用词.md"),
  "index-update-log": join("09_索引", "项目维护", "更新日志.md"),
  "index-pending": join("09_索引", "项目维护", "待确认事项.md"),
};
const LEGACY_PATH_ENTRIES = [
  ...Object.entries(LEGACY_PATH_MAP),
  ...Object.entries(LEGACY_FRAMEWORK_PATH_MAP),
  ...Object.entries(LEGACY_NESTED_PATH_MAP),
  ...LEGACY_REPORT_COMPILE_PATHS.map((path) => ["report-compile", path]),
];
const LEGACY_CANON_TARGET_IDS = {
  "canon-concepts": "canon-world",
  "canon-rules": "canon-world",
  "canon-basics": "canon-world",
  "canon-power": "canon-world",
  "canon-timeline": "canon-events",
  "canon-special": "canon-world",
  "canon-derivatives": "canon-world",
  "canon-races": "canon-world",
  "script-canon-concepts": "script-canon-world",
  "script-canon-rules": "script-canon-world",
  "script-canon-basics": "script-canon-world",
  "script-canon-power": "script-canon-world",
  "script-canon-timeline": "script-canon-events",
  "script-canon-special": "script-canon-world",
  "script-canon-derivatives": "script-canon-world",
  "script-canon-races": "script-canon-world",
};
const LEGACY_PATH_MIGRATIONS = new Map(LEGACY_PATH_ENTRIES
  .map(([id, path]) => [normalizedRelative(path), PATH_MAP[LEGACY_CANON_TARGET_IDS[id] ?? id]])
  .filter(([, targetPath]) => Boolean(targetPath)));
const LEGACY_DIRECTORY_MIGRATIONS = [
  ["04_正文/短剧/短剧大纲", "04_正文/短剧/剧本大纲"],
  ["04_正文/短剧/剧本改编记忆", "04_正文/短剧/剧本连续性"],
  ["04_正文/短剧/剧本记忆", "04_正文/短剧/剧本连续性"],
];
const migrateLegacyManagedPath = (value) => {
  const path = String(value).replaceAll("\\", "/");
  const normalized = path.toLowerCase();
  const fixed = LEGACY_PATH_MIGRATIONS.get(normalized);
  if (fixed) return fixed;
  for (const [legacyPrefix, currentPrefix] of LEGACY_DIRECTORY_MIGRATIONS) {
    const normalizedPrefix = legacyPrefix.toLowerCase();
    if (normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`)) {
      return `${currentPrefix}${path.slice(legacyPrefix.length)}`;
    }
  }
  return value;
};
const pruneEmptyDirectoryTree = async (root) => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) await pruneEmptyDirectoryTree(join(root, entry.name));
    }
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        if (!(await readdir(root)).length) await rmdir(root);
        return;
      } catch (error) {
        if (error.code === "ENOENT" || error.code === "ENOTEMPTY") return;
        if (!["EACCES", "EBUSY", "EPERM"].includes(error.code) || attempt === 5) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(500, 100 + attempt * 100)));
      }
    }
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
  }
};
const REVERSE_PATH_MAP = new Map([
  ...Object.entries(PATH_MAP).map(([id, path]) => [normalizedRelative(path), id]),
  ...LEGACY_PATH_ENTRIES.map(([id, path]) => [normalizedRelative(path), id]),
]);

const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const workspaceRenameAliases = new Map();
let workspaceRenameAliasesLoadedPath = "";
const workspaceRenameAliasesPath = () => join(appDataRoot(), "workspace-renames.json");
const loadWorkspaceRenameAliases = () => {
  const registryPath = workspaceRenameAliasesPath();
  if (workspaceRenameAliasesLoadedPath === registryPath) return;
  workspaceRenameAliasesLoadedPath = registryPath;
  workspaceRenameAliases.clear();
  try {
    const parsed = JSON.parse(readFileSync(registryPath, "utf8"));
    for (const [source, destination] of Object.entries(parsed?.mappings ?? {})) {
      if (typeof source === "string" && typeof destination === "string" && source && destination) {
        workspaceRenameAliases.set(source, destination);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      const registryError = new Error("工作区重命名保护记录损坏或不可读取，已停止写入以避免旧路径复活");
      registryError.code = "WORKSPACE_RENAME_REGISTRY_INVALID";
      registryError.statusCode = 409;
      registryError.cause = error;
      throw registryError;
    }
  }
};
const resolveWorkspaceRenameAlias = (requestedPath) => {
  loadWorkspaceRenameAliases();
  let current = resolve(requestedPath);
  const visited = new Set();
  for (let depth = 0; depth < 8; depth += 1) {
    const key = normalizeForCompare(current);
    if (visited.has(key)) break;
    visited.add(key);
    const next = workspaceRenameAliases.get(key);
    if (!next) break;
    current = resolve(next);
  }
  return current;
};

const registeredWorkspaceAliasesForTarget = (targetRoot) => {
  loadWorkspaceRenameAliases();
  return [...workspaceRenameAliases.keys()]
    .filter((sourceRoot) => normalizeForCompare(resolveWorkspaceRenameAlias(sourceRoot)) === normalizeForCompare(targetRoot))
    .map((sourceRoot) => ({ sourceRoot, targetRoot }));
};

const atomicWrite = async (path, content) => {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true });
  const temp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const swap = `${path}.swap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const handle = await open(temp, "w");
  try {
    await handle.writeFile(content, typeof content === "string" ? "utf8" : undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  let movedExisting = false;
  try {
    await rename(path, swap);
    movedExisting = true;
  } catch (error) {
    if (error.code !== "ENOENT") {
      await rm(temp, { force: true });
      throw error;
    }
  }
  try {
    await rename(temp, path);
    if (movedExisting) await rm(swap, { force: true });
    const directoryHandle = await open(parent, "r").catch((error) => {
      if (["EACCES", "EISDIR", "ENOTSUP", "EPERM"].includes(error.code)) return null;
      throw error;
    });
    if (directoryHandle) {
      try {
        await directoryHandle.sync().catch((error) => {
          if (["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) return;
          throw error;
        });
      } finally {
        await directoryHandle.close();
      }
    }
  } catch (error) {
    await rm(temp, { force: true });
    if (movedExisting) await rename(swap, path);
    throw error;
  }
};

const atomicWriteWithTransientRetry = async (path, content, { attempts = 12 } = {}) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await atomicWrite(path, content);
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.has(error.code) || attempt === attempts - 1) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(1000, 120 + (attempt * 120))));
    }
  }
  throw lastError;
};

const persistWorkspaceRenameAlias = async ({ source, destination }) => {
  loadWorkspaceRenameAliases();
  workspaceRenameAliases.set(normalizeForCompare(source), resolve(destination));
  const mappings = Object.fromEntries(workspaceRenameAliases.entries());
  await atomicWriteWithTransientRetry(
    workspaceRenameAliasesPath(),
    JSON.stringify({ schemaVersion: 1, mappings, updatedAt: new Date().toISOString() }, null, 2),
  );
};

const pathHashIfExists = async (path) => {
  try {
    return hashText(await readFile(path));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const atomicWriteIfChanged = async (path, content) => {
  const desiredHash = hashText(content);
  if (await pathHashIfExists(path) === desiredHash) return false;
  await atomicWrite(path, content);
  return true;
};

const runBounded = async (tasks, concurrency = 6) => {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await queue.shift()();
  });
  await Promise.all(workers);
};

const renameWithTransientRetry = async (sourcePath, targetPath, { attempts = 12 } = {}) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      lastError = error;
      // Windows can report a transient sharing violation after the move has
      // already completed. Treat the observable filesystem state as truth so
      // callers do not retry a completed move or report a false failure.
      if (TRANSIENT_RENAME_CODES.has(error.code)) {
        const [sourceInfo, targetInfo] = await Promise.all([
          stat(sourcePath).catch(() => null),
          stat(targetPath).catch(() => null),
        ]);
        if (!sourceInfo && targetInfo) return;
      }
      if (!TRANSIENT_RENAME_CODES.has(error.code) || attempt === attempts - 1) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(1000, 120 + (attempt * 120))));
    }
  }
  throw lastError;
};

const mergeMoveDirectory = async (sourceRoot, targetRoot, { skipRelativePaths = [] } = {}) => {
  const sourceInfo = await stat(sourceRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!sourceInfo) return 0;
  if (!sourceInfo.isDirectory()) throw new Error("文件夹迁移源不是目录");
  const skipped = new Set(skipRelativePaths.map(normalizedRelative));
  let moved = 0;
  const visit = async (currentSource) => {
    const entries = await readdir(currentSource, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error("文件夹包含符号链接，已停止移动");
      const sourcePath = join(currentSource, entry.name);
      const relativePath = relative(sourceRoot, sourcePath);
      const targetPath = resolve(targetRoot, relativePath);
      if (!isInside(targetPath, targetRoot)) throw new Error("文件夹移动目标越界");
      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        await visit(sourcePath);
        continue;
      }
      if (!entry.isFile() || skipped.has(normalizedRelative(relativePath))) continue;
      await mkdir(dirname(targetPath), { recursive: true });
      const [sourceHash, targetHash] = await Promise.all([pathHashIfExists(sourcePath), pathHashIfExists(targetPath)]);
      if (targetHash && targetHash !== sourceHash) throw new Error(`${relativePath} 的目标位置已有不同文件，已停止移动`);
      if (targetHash === sourceHash) await rm(sourcePath, { force: true });
      else await renameWithTransientRetry(sourcePath, targetPath);
      moved += 1;
    }
    if (!(await readdir(currentSource)).length) await rmdir(currentSource);
  };
  await mkdir(targetRoot, { recursive: true });
  await visit(sourceRoot);
  return moved;
};

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const workspaceQueues = new Map();
const enqueueWorkspaceWrite = (workspaceRoot, task) => {
  const key = normalizeForCompare(workspaceRoot);
  const previous = workspaceQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  const tracked = current.finally(() => {
    if (workspaceQueues.get(key) === tracked) workspaceQueues.delete(key);
  });
  workspaceQueues.set(key, tracked);
  return tracked;
};

const withWorkspaceFileLock = async (workspaceRoot, task, { workspaceLockToken = "" } = {}) => {
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  const lockPath = join(internalRoot, "workspace.lock");
  await mkdir(internalRoot, { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let lock = null;
      try {
        lock = JSON.parse(await readFile(lockPath, "utf8"));
      } catch {}
      if (lock?.mode === "migration") {
        if (workspaceLockToken && lock.token === workspaceLockToken) return task();
        if (processIsAlive(Number(lock?.pid))) throw new Error("当前作品正在执行数据迁移，请等待迁移完成");
        await rm(lockPath, { force: true });
        continue;
      }
      if (processIsAlive(Number(lock?.pid))) throw new Error("当前作品正在被另一个神思任务写入，请等待该任务完成");
      await rm(lockPath, { force: true });
    }
  }
  if (!handle) throw new Error("无法取得作品写入锁");
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
};

export const acquireWorkspaceMigrationLocks = async ({ appRoot, requestedPaths = [], token: requestedToken = "" } = {}) => {
  const workspaceRoots = [...new Set(requestedPaths.map((requestedPath) => resolveWorkspaceRoot({ appRoot, requestedPath })))]
    .sort((left, right) => normalizeForCompare(left).localeCompare(normalizeForCompare(right)));
  const token = requestedToken || randomUUID();
  const acquired = [];
  try {
    for (const workspaceRoot of workspaceRoots) {
      const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
      const lockPath = join(internalRoot, "workspace.lock");
      await mkdir(internalRoot, { recursive: true });
      let handle;
      try {
        handle = await open(lockPath, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        const lock = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => null);
        if (processIsAlive(Number(lock?.pid))) throw new Error("有工作区正在写入，无法开始迁移，请稍后重试");
        await rm(lockPath, { force: true });
        handle = await open(lockPath, "wx");
      }
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        token,
        mode: "migration",
        createdAt: new Date().toISOString(),
      }), "utf8");
      await handle.close();
      acquired.push({ workspaceRoot, lockPath });
    }
    return { token, workspaceRoots: acquired.map((entry) => entry.workspaceRoot) };
  } catch (error) {
    for (const entry of acquired.reverse()) {
      const lock = await readFile(entry.lockPath, "utf8").then(JSON.parse).catch(() => null);
      if (lock?.token === token) await rm(entry.lockPath, { force: true }).catch(() => {});
    }
    throw error;
  }
};

export const releaseWorkspaceMigrationLocks = async ({ token, workspaceRoots = [] } = {}) => {
  for (const workspaceRoot of [...workspaceRoots].reverse()) {
    const lockPath = join(resolveWorkspaceInternalRoot(workspaceRoot), "workspace.lock");
    const lock = await readFile(lockPath, "utf8").then(JSON.parse).catch(() => null);
    if (lock?.mode === "migration" && lock.token === token) await rm(lockPath, { force: true });
  }
};

const hashText = (content) => createHash("sha256").update(content, "utf8").digest("hex");
const canonicalHistoryValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalHistoryValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalHistoryValue(value[key])]));
};
export const serializeHistoryObjectForStorage = (value) => JSON.stringify(canonicalHistoryValue(value));
export const historyObjectHashForStorage = (value) => hashText(serializeHistoryObjectForStorage(value));
let testFaultRemaining = null;
const maybeInjectWorkspaceTestFault = (point) => {
  const configuredPoint = String(process.env.SHENSI_TEST_WORKSPACE_FAULT ?? "").trim();
  if (!configuredPoint || configuredPoint !== point) return;
  if (testFaultRemaining == null) {
    const configuredCount = Number(process.env.SHENSI_TEST_WORKSPACE_FAULT_COUNT ?? 1);
    testFaultRemaining = Number.isInteger(configuredCount) && configuredCount > 0 ? configuredCount : 1;
  }
  if (testFaultRemaining <= 0) return;
  testFaultRemaining -= 1;
  const mode = String(process.env.SHENSI_TEST_WORKSPACE_FAULT_MODE ?? "error").trim().toLowerCase();
  if (mode === "exit") process.exit(86);
  const error = new Error(mode === "enospc" ? `测试故障注入：${point} 模拟磁盘空间不足` : `测试故障注入：${point}`);
  if (mode === "enospc") error.code = "ENOSPC";
  throw error;
};
const contentRevision = (value = "") => {
  let hash = 2166136261;
  const source = String(value);
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const readJsonIfExists = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const readTransactionJson = async (directory, name) => {
  try {
    const compressed = await readFile(join(directory, `${name}.json.gz`));
    return JSON.parse((await gunzip(compressed)).toString("utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return readJsonIfExists(join(directory, `${name}.json`));
};

const writeTransactionJson = async (directory, name, value) => {
  const serialized = Buffer.from(JSON.stringify(value), "utf8");
  await atomicWrite(join(directory, `${name}.json.gz`), await gzip(serialized, { level: 6 }));
};

const historyShardRelativePath = (kind, scopeId) => {
  const suffix = hashText(String(scopeId)).slice(0, 12);
  return join(kind, `${safeName(scopeId).slice(0, 64)}-${suffix}.json`).replaceAll("\\", "/");
};

const historyIndexPaths = (index = {}) => {
  const safeIndex = index ?? {};
  return [
    ...Object.values(safeIndex.documents ?? {}),
    ...Object.values(safeIndex.views ?? {}),
    ...Object.values(safeIndex.volumes ?? {}),
    ...Object.values(safeIndex.modules ?? {}),
    safeIndex.project,
    safeIndex.rollback,
    safeIndex.rollbackObjects,
  ].filter(Boolean);
};

const historyObjectRelativePath = (hash) => join("objects", hash.slice(0, 2), `${hash}.json`).replaceAll("\\", "/");
const INLINE_HISTORY_DOCUMENT_FIELDS = ["html", "markdown", "continuityDelta"];

const historyObjectHashPattern = /^[a-f0-9]{64}$/u;
const collectStoredHistoryObjectRefs = (value, referencedObjects) => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectStoredHistoryObjectRefs(item, referencedObjects));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("Refs")) {
      if (typeof item === "string" && historyObjectHashPattern.test(item)) referencedObjects.add(item);
      else if (item && typeof item === "object") Object.values(item).forEach((hash) => {
        if (typeof hash === "string" && historyObjectHashPattern.test(hash)) referencedObjects.add(hash);
      });
      continue;
    }
    if (typeof item === "string" && historyObjectHashPattern.test(item) && (key.endsWith("Ref") || key === "hash")) {
      referencedObjects.add(item);
      continue;
    }
    collectStoredHistoryObjectRefs(item, referencedObjects);
  }
};

const externalizeHistoryDocuments = ({ historyRoot, entries = [], objectWrites, referencedObjects }) => entries.map((entry) => {
  const externalizeDocument = (documentState) => {
    const serialized = serializeHistoryObjectForStorage(documentState);
    const hash = historyObjectHashForStorage(documentState);
    const relativePath = historyObjectRelativePath(hash);
    referencedObjects.add(hash);
    if (!objectWrites.has(hash)) {
      objectWrites.set(hash, () => atomicWriteIfChanged(resolve(historyRoot, relativePath), serialized));
    }
    return hash;
  };
  const externalizeDocuments = (documents = {}) => Object.fromEntries(Object.entries(documents)
    .map(([documentId, documentState]) => [documentId, externalizeDocument(documentState)]));
  const stored = { ...entry };
  if (stored.document && typeof stored.document === "object") {
    stored.storageDocumentRef = externalizeDocument(stored.document);
    delete stored.document;
  }
  const inlineDocument = Object.fromEntries(INLINE_HISTORY_DOCUMENT_FIELDS
    .filter((field) => Object.hasOwn(stored, field))
    .map((field) => [field, stored[field]]));
  if (Object.keys(inlineDocument).length) {
    stored.storageDocumentContentRef = externalizeDocument(inlineDocument);
    INLINE_HISTORY_DOCUMENT_FIELDS.forEach((field) => delete stored[field]);
  }
  if (stored.documents && typeof stored.documents === "object") {
    stored.storageDocumentRefs = externalizeDocuments(stored.documents);
    delete stored.documents;
  }
  if (stored.state?.documents && typeof stored.state.documents === "object") {
    stored.state = { ...stored.state, storageDocumentRefs: externalizeDocuments(stored.state.documents) };
    delete stored.state.documents;
  }
  return stored;
});

const hydrateHistoryDocuments = async ({ historyRoot, entries = [] }) => {
  const cache = new Map();
  const readObject = async (hash) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("历史对象哈希无效");
    if (!cache.has(hash)) {
      const target = resolve(historyRoot, historyObjectRelativePath(hash));
      if (!isInside(target, historyRoot)) throw new Error("历史对象路径越界");
      cache.set(hash, readJsonIfExists(target));
    }
    const value = await cache.get(hash);
    if (value == null) throw new Error(`历史对象缺失：${hash}`);
    return structuredClone(value);
  };
  const hydrateRefs = async (refs = {}) => Object.fromEntries(await Promise.all(
    Object.entries(refs).map(async ([documentId, hash]) => [documentId, await readObject(hash)]),
  ));
  return Promise.all(entries.map(async (entry) => {
    const hydrated = { ...entry };
    if (hydrated.storageDocumentRef) {
      hydrated.document = await readObject(hydrated.storageDocumentRef);
      delete hydrated.storageDocumentRef;
    }
    if (hydrated.storageDocumentContentRef) {
      const content = await readObject(hydrated.storageDocumentContentRef);
      if (!content || typeof content !== "object" || Array.isArray(content)) throw new Error("历史正文对象无效");
      Object.assign(hydrated, content);
      delete hydrated.storageDocumentContentRef;
    }
    if (hydrated.storageDocumentRefs) {
      hydrated.documents = await hydrateRefs(hydrated.storageDocumentRefs);
      delete hydrated.storageDocumentRefs;
    }
    if (hydrated.state?.storageDocumentRefs) {
      hydrated.state = { ...hydrated.state, documents: await hydrateRefs(hydrated.state.storageDocumentRefs) };
      delete hydrated.state.storageDocumentRefs;
    }
    return hydrated;
  }));
};

const pruneUnreferencedHistoryObjects = async ({ historyRoot, referencedObjects }) => {
  const objectsRoot = join(historyRoot, "objects");
  let prefixes = [];
  try {
    prefixes = await readdir(objectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const prefix of prefixes) {
    if (!prefix.isDirectory()) continue;
    const prefixRoot = join(objectsRoot, prefix.name);
    const objects = await readdir(prefixRoot, { withFileTypes: true });
    for (const object of objects) {
      const hash = object.name.match(/^([a-f0-9]{64})\.json$/)?.[1];
      if (!hash || referencedObjects.has(hash)) continue;
      await rm(join(prefixRoot, object.name), { force: true });
    }
    const remaining = await readdir(prefixRoot);
    if (!remaining.length) await rmdir(prefixRoot).catch(() => {});
  }
};

const writeHistoryShard = async ({ historyRoot, relativePath, scopeType, scopeId, entries }) => {
  const target = resolve(historyRoot, relativePath);
  if (!isInside(target, historyRoot)) throw new Error("历史版本路径越界");
  await atomicWriteIfChanged(target, JSON.stringify({ schemaVersion: 2, scopeType, scopeId, entries }, null, 2));
};

const saveIsolatedHistoryState = async ({ historyRoot, isolatedState }) => {
  const indexPath = join(historyRoot, "index.json");
  const previousIndex = await readJsonIfExists(indexPath);
  const rollbackDocumentObjects = isolatedState.rollbackDocumentObjects ?? {};
  const index = {
    schemaVersion: 3,
    documents: {},
    views: {},
    volumes: {},
    modules: {},
    project: null,
    rollback: "rollback/conversations-and-branches.json",
    rollbackObjects: "rollback/document-objects.json",
    rollbackObjectCount: Object.keys(rollbackDocumentObjects).length,
  };
  const writes = [];
  const objectWrites = new Map();
  const referencedObjects = new Set();
  const register = (kind, scopeType, stores = {}) => {
    for (const [scopeId, entries] of Object.entries(stores)) {
      if (!Array.isArray(entries) || !entries.length) continue;
      const relativePath = historyShardRelativePath(kind, scopeId);
      index[kind][scopeId] = relativePath;
      const storedEntries = externalizeHistoryDocuments({ historyRoot, entries, objectWrites, referencedObjects });
      writes.push(() => writeHistoryShard({ historyRoot, relativePath, scopeType, scopeId, entries: storedEntries }));
    }
  };
  register("documents", "document", isolatedState.histories);
  register("views", "view", isolatedState.viewHistories);
  register("volumes", "volume", isolatedState.volumeHistories);
  const moduleHistoriesDeferred = isolatedState.moduleHistoriesDeferred === true;
  const loadedModuleScopes = new Set(Array.isArray(isolatedState.moduleHistoryScopesLoaded)
    ? isolatedState.moduleHistoryScopesLoaded.map(String)
    : []);
  // A deferred load contains only the module scopes the user has opened. Keep
  // references from untouched shards so pruning can still run safely after a
  // save without deleting objects owned by scopes that remain unloaded.
  if (moduleHistoriesDeferred) {
    for (const [scopeId, relativePath] of Object.entries(previousIndex?.modules ?? {})) {
      if (loadedModuleScopes.has(scopeId)) continue;
      const previousEntries = await readStoredHistoryShardEntries({ historyRoot, relativePath, scopeType: "module", scopeId });
      collectStoredHistoryObjectRefs(previousEntries, referencedObjects);
    }
  }
  if (!moduleHistoriesDeferred) {
    register("modules", "module", isolatedState.moduleHistories);
  } else {
    index.modules = { ...(previousIndex?.modules ?? {}) };
    for (const [scopeId, entries] of Object.entries(isolatedState.moduleHistories ?? {})) {
      if (!Array.isArray(entries)) continue;
      const relativePath = historyShardRelativePath("modules", scopeId);
      if (loadedModuleScopes.has(scopeId)) {
        if (!entries.length) {
          delete index.modules[scopeId];
          continue;
        }
        index.modules[scopeId] = relativePath;
        const storedEntries = externalizeHistoryDocuments({ historyRoot, entries, objectWrites, referencedObjects });
        writes.push(() => writeHistoryShard({ historyRoot, relativePath, scopeType: "module", scopeId, entries: storedEntries }));
        continue;
      }
      if (!entries.length) continue;
      const previousRelativePath = previousIndex?.modules?.[scopeId];
      const previousEntries = previousRelativePath
        ? await readStoredHistoryShardEntries({ historyRoot, relativePath: previousRelativePath, scopeType: "module", scopeId })
        : [];
      const storedEntries = externalizeHistoryDocuments({ historyRoot, entries, objectWrites, referencedObjects });
      const replacementIds = new Set(storedEntries.map((entry) => entry?.id).filter(Boolean));
      const mergedEntries = [...storedEntries, ...previousEntries.filter((entry) => !replacementIds.has(entry?.id))];
      index.modules[scopeId] = relativePath;
      writes.push(() => writeHistoryShard({ historyRoot, relativePath, scopeType: "module", scopeId, entries: mergedEntries }));
    }
  }
  if (isolatedState.projectHistories?.length) {
    index.project = "project/versions.json";
    const storedEntries = externalizeHistoryDocuments({
      historyRoot,
      entries: isolatedState.projectHistories,
      objectWrites,
      referencedObjects,
    });
    writes.push(() => writeHistoryShard({
      historyRoot,
      relativePath: index.project,
      scopeType: "project",
      scopeId: "project",
      entries: storedEntries,
    }));
  }
  writes.push(() => atomicWriteIfChanged(join(historyRoot, index.rollback), JSON.stringify({
    schemaVersion: 1,
    snapshots: isolatedState.snapshots ?? {},
    isolatedBranches: isolatedState.isolatedBranches ?? [],
    conversationState: isolatedState.conversationState ?? {},
  }, null, 2)));
  writes.push(() => atomicWriteIfChanged(join(historyRoot, index.rollbackObjects), JSON.stringify({
    schemaVersion: 1,
    rollbackDocumentObjects,
  })));
  await runBounded([...objectWrites.values()]);
  await runBounded(writes);
  await atomicWriteIfChanged(indexPath, JSON.stringify(index, null, 2));
  await pruneUnreferencedHistoryObjects({ historyRoot, referencedObjects });

  const currentPaths = new Set(historyIndexPaths(index));
  for (const staleRelativePath of historyIndexPaths(previousIndex)) {
    if (currentPaths.has(staleRelativePath)) continue;
    const stalePath = resolve(historyRoot, staleRelativePath);
    if (!isInside(stalePath, historyRoot)) throw new Error("旧历史版本路径越界");
    await rm(stalePath, { force: true });
  }
  await rm(join(historyRoot, "versions-and-rollback.json"), { force: true });
};

const readHistoryShardEntries = async ({ historyRoot, relativePath, scopeType, scopeId }) => {
  const target = resolve(historyRoot, relativePath);
  if (!isInside(target, historyRoot)) throw new Error("历史版本索引路径越界");
  const shard = await readJsonIfExists(target);
  if (!shard) return [];
  if (shard.scopeType !== scopeType || shard.scopeId !== scopeId || !Array.isArray(shard.entries)) {
    throw new Error(`历史版本分片校验失败：${scopeType}:${scopeId}`);
  }
  return hydrateHistoryDocuments({ historyRoot, entries: shard.entries });
};

const readStoredHistoryShardEntries = async ({ historyRoot, relativePath, scopeType, scopeId }) => {
  const target = resolve(historyRoot, relativePath);
  if (!isInside(target, historyRoot)) throw new Error("历史版本索引路径越界");
  const shard = await readJsonIfExists(target);
  if (!shard) return [];
  if (shard.scopeType !== scopeType || shard.scopeId !== scopeId || !Array.isArray(shard.entries)) {
    throw new Error(`历史版本分片校验失败：${scopeType}:${scopeId}`);
  }
  return shard.entries;
};

const rollbackDocumentObjectsFromIndex = async ({ historyRoot, index, rollback = null }) => {
  if (!index?.rollbackObjects) return rollback?.rollbackDocumentObjects ?? {};
  const target = resolve(historyRoot, index.rollbackObjects);
  if (!isInside(target, historyRoot)) throw new Error("历史回退正文对象索引路径越界");
  const payload = await readJsonIfExists(target);
  return payload?.rollbackDocumentObjects ?? {};
};

const loadIsolatedHistoryState = async (historyRoot, { deferModuleHistories = false, deferRollbackObjects = false } = {}) => {
  const index = await readJsonIfExists(join(historyRoot, "index.json"));
  if (!index) return readJsonIfExists(join(historyRoot, "versions-and-rollback.json"));
  const readStore = async (kind, scopeType) => Object.fromEntries(await Promise.all(
    Object.entries(index[kind] ?? {}).map(async ([scopeId, relativePath]) => [
      scopeId,
      await readHistoryShardEntries({ historyRoot, relativePath, scopeType, scopeId }),
    ]),
  ));
  const rollbackPath = index.rollback ?? "rollback/conversations-and-branches.json";
  const rollbackTarget = resolve(historyRoot, rollbackPath);
  if (!isInside(rollbackTarget, historyRoot)) throw new Error("历史回退索引路径越界");
  const [histories, viewHistories, volumeHistories, moduleHistories, projectHistories, rollback] = await Promise.all([
    readStore("documents", "document"),
    readStore("views", "view"),
    readStore("volumes", "volume"),
    deferModuleHistories ? {} : readStore("modules", "module"),
    index.project
      ? readHistoryShardEntries({ historyRoot, relativePath: index.project, scopeType: "project", scopeId: "project" })
      : [],
    readJsonIfExists(rollbackTarget),
  ]);
  const rollbackDocumentObjects = deferRollbackObjects
    ? {}
    : await rollbackDocumentObjectsFromIndex({ historyRoot, index, rollback });
  const rollbackDocumentObjectCount = Number.isSafeInteger(Number(index.rollbackObjectCount))
    ? Math.max(0, Number(index.rollbackObjectCount))
    : Object.keys(rollback?.rollbackDocumentObjects ?? rollbackDocumentObjects).length;
  return {
    histories,
    viewHistories,
    volumeHistories,
    moduleHistories,
    moduleHistoriesDeferred: deferModuleHistories && Object.keys(index.modules ?? {}).length > 0,
    moduleHistoryScopesLoaded: [],
    projectHistories,
    snapshots: rollback?.snapshots ?? {},
    isolatedBranches: rollback?.isolatedBranches ?? [],
    conversationState: rollback?.conversationState ?? {},
    rollbackDocumentObjects,
    rollbackDocumentObjectCount,
    rollbackDocumentObjectsDeferred: deferRollbackObjects && rollbackDocumentObjectCount > 0,
  };
};

const migrateIsolatedHistoryRollbackObjects = async (historyRoot) => {
  const indexPath = join(historyRoot, "index.json");
  const index = await readJsonIfExists(indexPath);
  if (!index) return { migrated: false, objectCount: 0 };
  const rollbackRelativePath = index.rollback ?? "rollback/conversations-and-branches.json";
  const rollbackTarget = resolve(historyRoot, rollbackRelativePath);
  if (!isInside(rollbackTarget, historyRoot)) throw new Error("历史回退索引路径越界");
  const rollback = await readJsonIfExists(rollbackTarget);
  if (!rollback) return { migrated: false, objectCount: 0 };

  const rollbackObjectsRelativePath = index.rollbackObjects ?? "rollback/document-objects.json";
  const rollbackObjectsTarget = resolve(historyRoot, rollbackObjectsRelativePath);
  if (!isInside(rollbackObjectsTarget, historyRoot)) throw new Error("历史回退正文对象索引路径越界");
  const inlineObjects = rollback.rollbackDocumentObjects;
  const existingObjects = index.rollbackObjects
    ? await readJsonIfExists(rollbackObjectsTarget)
    : null;
  const rollbackDocumentObjects = inlineObjects ?? existingObjects?.rollbackDocumentObjects ?? {};
  const objectCount = Object.keys(rollbackDocumentObjects).length;

  // Crash-safe order: create the object shard first, publish its index second,
  // and only then remove the duplicate inline payload from the metadata shard.
  // Every intermediate state therefore retains at least one authoritative copy.
  await atomicWriteIfChanged(rollbackObjectsTarget, JSON.stringify({
    schemaVersion: 1,
    rollbackDocumentObjects,
  }));
  const nextIndex = {
    ...index,
    schemaVersion: Math.max(3, Number(index.schemaVersion) || 0),
    rollback: rollbackRelativePath,
    rollbackObjects: rollbackObjectsRelativePath,
    rollbackObjectCount: objectCount,
  };
  await atomicWriteIfChanged(indexPath, JSON.stringify(nextIndex, null, 2));
  if (Object.hasOwn(rollback, "rollbackDocumentObjects")) {
    const { rollbackDocumentObjects: _objects, ...metadata } = rollback;
    await atomicWriteIfChanged(rollbackTarget, JSON.stringify(metadata, null, 2));
  }
  return {
    migrated: !index.rollbackObjects || Object.hasOwn(rollback, "rollbackDocumentObjects") || Number(index.schemaVersion) < 3,
    objectCount,
  };
};

export const migrateWorkspaceHistoryRollbackObjects = async ({ appRoot, requestedPath }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const historyRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "history-isolated");
  return { workspaceRoot, ...await migrateIsolatedHistoryRollbackObjects(historyRoot) };
};

export const migrateAllManagedWorkspaceHistoryIndexes = async ({ appRoot }) => {
  const [projects, notebooks] = await Promise.all([
    listWorkspaceProjects({ appRoot }),
    listWorkspaceNotebooks({ appRoot }),
  ]);
  const workspacePaths = [...new Set([...projects, ...notebooks]
    .map((workspace) => String(workspace?.workspacePath || "").trim())
    .filter(Boolean))];
  let migrated = 0;
  let rollbackObjectCount = 0;
  for (const requestedPath of workspacePaths) {
    const result = await migrateWorkspaceHistoryRollbackObjects({ appRoot, requestedPath });
    if (result.migrated) migrated += 1;
    rollbackObjectCount += result.objectCount;
  }
  return { scanned: workspacePaths.length, migrated, rollbackObjectCount };
};

const rollbackObjectKeysReferencedByState = (state = {}) => {
  const keys = new Set();
  const collectSnapshots = (snapshots = {}) => {
    for (const snapshot of Object.values(snapshots ?? {})) {
      for (const objectKey of Object.values(snapshot?.documentRefs ?? {})) {
        if (typeof objectKey === "string" && objectKey) keys.add(objectKey);
      }
    }
  };
  collectSnapshots(state.snapshots);
  for (const conversation of state.conversations ?? []) collectSnapshots(conversation?.snapshots);
  for (const branch of state.isolatedBranches ?? []) {
    for (const objectKey of Object.values(branch?.snapshot?.documentRefs ?? {})) {
      if (typeof objectKey === "string" && objectKey) keys.add(objectKey);
    }
  }
  for (const entry of state.trash ?? []) {
    if (entry?.kind === "conversation" || entry?.conversation) collectSnapshots(entry.conversation?.snapshots);
  }
  return keys;
};

const mergeDeferredRollbackObjects = async ({ workspaceRoot, state }) => {
  if (state?.rollbackDocumentObjectsDeferred !== true) return state;
  const historyRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "history-isolated");
  const index = await readJsonIfExists(join(historyRoot, "index.json"));
  const rollbackRelativePath = index?.rollback ?? "rollback/conversations-and-branches.json";
  const rollbackTarget = resolve(historyRoot, rollbackRelativePath);
  if (!isInside(rollbackTarget, historyRoot)) throw new Error("历史回退索引路径越界");
  const rollback = index?.rollbackObjects ? null : await readJsonIfExists(rollbackTarget);
  const existing = await rollbackDocumentObjectsFromIndex({ historyRoot, index, rollback });
  const merged = {
    ...existing,
    ...(state.rollbackDocumentObjects ?? {}),
  };
  const usedKeys = rollbackObjectKeysReferencedByState(state);
  state.rollbackDocumentObjects = Object.fromEntries([...usedKeys]
    .filter((key) => merged[key])
    .map((key) => [key, merged[key]]));
  delete state.rollbackDocumentObjectsDeferred;
  return state;
};

export const loadWorkspaceHistoryScope = async ({ appRoot, requestedPath, scopeType, scopeId }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  if (scopeType !== "module") throw new Error("暂不支持按需读取此类历史版本");
  const normalizedScopeId = String(scopeId || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(normalizedScopeId)) throw new Error("历史版本范围无效");
  const historyRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "history-isolated");
  const index = await readJsonIfExists(join(historyRoot, "index.json"));
  const relativePath = index?.modules?.[normalizedScopeId];
  return {
    workspaceRoot,
    scopeType,
    scopeId: normalizedScopeId,
    entries: relativePath
      ? await readHistoryShardEntries({ historyRoot, relativePath, scopeType, scopeId: normalizedScopeId })
      : [],
  };
};

export const loadWorkspaceRollbackDocumentObjects = async ({ appRoot, requestedPath, objectKeys = [] }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const requestedKeys = [...new Set((Array.isArray(objectKeys) ? objectKeys : [])
    .map((key) => String(key || "").trim())
    .filter((key) => /^[A-Za-z0-9._-]{1,200}$/.test(key)))]
    .slice(0, 2_000);
  if (!requestedKeys.length) return { workspaceRoot, objects: {} };
  const historyRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "history-isolated");
  const index = await readJsonIfExists(join(historyRoot, "index.json"));
  const rollbackRelativePath = index?.rollback ?? "rollback/conversations-and-branches.json";
  const rollbackTarget = resolve(historyRoot, rollbackRelativePath);
  if (!isInside(rollbackTarget, historyRoot)) throw new Error("历史回退索引路径越界");
  const rollback = index?.rollbackObjects ? null : await readJsonIfExists(rollbackTarget);
  const store = await rollbackDocumentObjectsFromIndex({ historyRoot, index, rollback });
  return {
    workspaceRoot,
    objects: Object.fromEntries(requestedKeys.filter((key) => store[key]).map((key) => [key, store[key]])),
  };
};

const removeTrashArchive = async (trashRoot, folder) => {
  const target = resolve(trashRoot, folder);
  if (!isInside(target, trashRoot) || normalizeForCompare(target) === normalizeForCompare(trashRoot)) {
    throw new Error("回收站归档路径越界");
  }
  await rm(target, { recursive: true, force: true });
};

const purgeLegacyTrash = async (trashRoot, now = Date.now()) => {
  try {
    const entries = await readdir(trashRoot, { withFileTypes: true });
    for (const entry of entries) {
      const timestamp = Number(entry.name.match(/^(\d{13})-/)?.[1]);
      if (!Number.isFinite(timestamp) || now - timestamp < TRASH_RETENTION_MS) continue;
      const target = resolve(trashRoot, entry.name);
      if (!isInside(target, trashRoot)) throw new Error("旧回收文件路径越界");
      await rm(target, { recursive: entry.isDirectory(), force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const scrubConfidentialMetadata = (value) => {
  if (Array.isArray(value)) return value.map(scrubConfidentialMetadata);
  if (typeof value === "string") {
    return value.replaceAll(
      "动态创作胶囊已编译；历史版本和隔离对话未进入本轮上下文。",
      "当前创作上下文已更新；历史版本和隔离对话未进入本轮参考范围。",
    );
  }
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, item] of Object.entries(value)) {
    if (["loadedRules", "loadedRuleCount", "requested", "shensiRoot", "ruleContext", "fingerprints", "promptText"].includes(key)) continue;
    clean[key] = scrubConfidentialMetadata(item);
  }
  return clean;
};

const omitSnapshotCollections = (snapshot, keys) => {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const clean = { ...snapshot };
  keys.forEach((key) => delete clean[key]);
  return clean;
};

const compactRollbackSnapshotForStorage = (snapshot) => {
  const clean = omitSnapshotCollections(snapshot, [
    "histories",
    "viewHistories",
    "volumeHistories",
    "moduleHistories",
    "projectHistories",
    "longFormJobs",
    "messages",
    "snapshots",
    "isolatedBranches",
  ]);
  if (clean?.settings) {
    clean.settings = portableGenerationSettings(clean.settings);
    delete clean.settings.workspacePath;
  }
  return clean;
};

const compactProjectVersionForStorage = (version) => {
  if (!version?.state) return version;
  const state = omitSnapshotCollections(version.state, [
    "histories",
    "viewHistories",
    "volumeHistories",
    "moduleHistories",
    "projectHistories",
    "snapshots",
    "isolatedBranches",
    "longFormJobs",
    "conversations",
    "messages",
    "activities",
    "trash",
  ]);
  if (state.settings) {
    state.settings = portableGenerationSettings(state.settings);
    delete state.settings.workspacePath;
  }
  return {
    ...version,
    state,
  };
};

const compactSnapshotStoreForStorage = (snapshots = {}) => Object.fromEntries(
  Object.entries(snapshots).map(([id, snapshot]) => [id, compactRollbackSnapshotForStorage(snapshot)]),
);

const containsMarkdown = async (root) => {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name !== ".shensi") queue.push(join(current, entry.name));
      } else if (entry.isFile() && /\.(?:md|canvas)$/i.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
};

const IMPORT_SKIPPED_DIRECTORIES = new Set([
  ".shensi",
  ".story-system",
  ".webnovel",
  "_备份_不参与规则扫描",
  "原始资料",
  "版本草案",
  "废弃设定",
  "回收站",
  "10_delivery_to_client",
  "连续性检查",
  "人物OOC报告",
  "伏笔风险报告",
  "设定冲突报告",
  "待确认更新",
  "短剧自检",
  "短剧逐集自检",
  "商业追读评分",
  "其他报告",
  "node_modules",
]);

const IMPORT_SKIPPED_FILES = new Set([
  "AI协作说明.md",
  "写作流程.md",
  "当前全局状态.md",
  "人物索引.md",
  "章节索引.md",
  "伏笔索引.md",
  "文档索引.md",
  "版本草案.md",
  "回收站索引.md",
]);

const skipImportDirectory = (name) => name.startsWith(".")
  || IMPORT_SKIPPED_DIRECTORIES.has(name)
  || name.includes("备份");

const listMarkdownFiles = async (root, { excludeIsolatedContent = false, excludedRelativePrefixes = [] } = {}) => {
  const files = [];
  const queue = [root];
  const excluded = excludedRelativePrefixes
    .map((value) => normalizedRelative(value).replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  while (queue.length) {
    const current = queue.shift();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      const relativePath = normalizedRelative(relative(root, absolutePath));
      if (excluded.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) {
        if (excludeIsolatedContent ? !skipImportDirectory(entry.name) : entry.name !== ".shensi") {
          queue.push(absolutePath);
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !IMPORT_SKIPPED_FILES.has(entry.name)) {
        files.push(absolutePath);
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
};

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

export const inlineMarkdownToHtml = (value) => escapeHtml(cleanObsidianInlineMarkdown(value))
  .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
  .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
  .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

const MARKDOWN_HTML_CACHE_LIMIT = 2_048;
const MARKDOWN_HTML_CACHE_MAX_CHARS = 64 * 1024 * 1024;
const markdownHtmlCache = new Map();
let markdownHtmlCacheChars = 0;

const renderMarkdownToHtml = (markdown) => sanitizeDocumentHtml(markdown
  .split(/\r?\n\s*\r?\n/)
  .map((block) => block.trim())
  .filter(Boolean)
  .map((block) => {
    const attachmentEmbed = block.match(/^!\[\[([^\]\n]+)\]\]$/);
    if (attachmentEmbed) {
      const rawPath = attachmentEmbed[1].split("|")[0].trim();
      const extension = rawPath.toLowerCase().match(/\.([a-z\d]+)$/)?.[1] ?? "";
      const video = ["mp4", "m4v", "mov", "webm", "ogv"].includes(extension);
      const image = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp"].includes(extension);
      if (image || video) {
        try {
          const relativePath = normalizeManagedRelativePath(rawPath, { label: "附件" });
          const name = basename(relativePath);
          const media = video
            ? `<video data-attachment-path="${escapeHtml(relativePath)}" aria-label="${escapeHtml(name)}" controls playsinline preload="metadata"></video>`
            : `<img data-attachment-path="${escapeHtml(relativePath)}" alt="${escapeHtml(name)}" loading="lazy" />`;
          return `<figure class="document-image" contenteditable="false">${media}<figcaption>${escapeHtml(name)}</figcaption></figure>`;
        } catch {}
      }
    }
    const table = markdownTableToHtml(block, { renderInline: inlineMarkdownToHtml });
    if (table) return table;
    if (/^(?:---+|___+|\*\*\*+)\s*$/.test(block)) return "";
    const heading = block.match(/^(#{1,6})\s+([\s\S]+)$/);
    if (heading) return `<h${heading[1].length}>${inlineMarkdownToHtml(heading[2])}</h${heading[1].length}>`;
    const unordered = block.split(/\r?\n/).map((line) => line.match(/^\s*(?:[-*+]|·)\s+(.+)$/)).filter(Boolean);
    if (unordered.length && unordered.length === block.split(/\r?\n/).length) return `<ul>${unordered.map((item) => `<li>${inlineMarkdownToHtml(item[1])}</li>`).join("")}</ul>`;
    const ordered = block.split(/\r?\n/).map((line) => line.match(/^\s*\d+[.)、]\s+(.+)$/)).filter(Boolean);
    if (ordered.length && ordered.length === block.split(/\r?\n/).length) return `<ol>${ordered.map((item) => `<li>${inlineMarkdownToHtml(item[1])}</li>`).join("")}</ol>`;
    return `<p>${inlineMarkdownToHtml(block).replace(/\r?\n/g, "<br>")}</p>`;
  })
  .join(""));

export const markdownToHtml = (markdown) => {
  const source = String(markdown ?? "");
  const key = `${source.length}:${hashText(source)}`;
  const cached = markdownHtmlCache.get(key);
  if (cached !== undefined) {
    markdownHtmlCache.delete(key);
    markdownHtmlCache.set(key, cached);
    return cached;
  }
  const html = renderMarkdownToHtml(source);
  markdownHtmlCache.set(key, html);
  markdownHtmlCacheChars += html.length;
  while (markdownHtmlCache.size > MARKDOWN_HTML_CACHE_LIMIT || markdownHtmlCacheChars > MARKDOWN_HTML_CACHE_MAX_CHARS) {
    const oldestKey = markdownHtmlCache.keys().next().value;
    if (!oldestKey) break;
    markdownHtmlCacheChars -= markdownHtmlCache.get(oldestKey)?.length ?? 0;
    markdownHtmlCache.delete(oldestKey);
  }
  return html;
};

const parseFrontmatter = (markdown) => {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return { data: {}, body: markdown };
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: markdown };
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try {
      data[key] = JSON.parse(raw);
    } catch {
      data[key] = raw;
    }
  }
  return { data, body: markdown.slice(match[0].length) };
};

const inferDocumentId = (workspaceRoot, filePath, frontmatter) => {
  if (frontmatter.shensi_id) return String(frontmatter.shensi_id);
  const relativePath = normalizedRelative(relative(workspaceRoot, filePath));
  const fixed = REVERSE_PATH_MAP.get(relativePath);
  if (fixed) return fixed;
  const chapter = relativePath.match(/04_正文\/小说\/.+?\/第(\d+)章-/);
  if (chapter) return `chapter-${Number(chapter[1])}`;
  return null;
};

const importedDocumentStateHash = (title, markdown) => hashText(`${title}\u0000${String(markdown ?? "").trim()}`);

const importModuleId = (id, relativePath, classification = null) => {
  if (classification?.placement?.moduleId) return classification.placement.moduleId;
  if (id.startsWith("chapter-") || id.startsWith("manuscript-") || id.startsWith("script-episode-") || id.startsWith("prompt-")) return "manuscript";
  if (id.startsWith("script-outline-") || id.startsWith("outline-")) return "outline";
  if (id.startsWith("script-canon-") || id.startsWith("canon-")) return "canon";
  if (id.startsWith("script-memory-") || id.startsWith("memory-")) return "memory";
  if (id.startsWith("report-")) return "reports";
  if (id.startsWith("index-")) return "index";
  if (id.startsWith("library-")) return "library";

  const normalized = normalizedRelative(relativePath);
  if (normalized.startsWith("01_剧情控制/")) {
    return /伏笔|信息释放|读者当前|重要信息登场/.test(relativePath) ? "memory" : "outline";
  }
  if (normalized.startsWith("02_正史设定/")) return "canon";
  if (/^(03_状态快照|05_章节记忆|06_上下文包)\//.test(relativePath)) return "memory";
  if (normalized.startsWith("04_正文/")) return "manuscript";
  if (normalized.startsWith("07_编译报告/")) return "reports";
  if (normalized.startsWith("09_索引/")) return "index";
  return relativePath.includes("/") ? "library" : "manuscript";
};

const importIdPrefix = (moduleId, relativePath) => {
  const script = normalizedRelative(relativePath).startsWith("04_正文/短剧/");
  if (moduleId === "manuscript") return script ? "script-episode" : "manuscript";
  if (moduleId === "outline") return script ? "script-outline" : "outline";
  if (moduleId === "canon") return script ? "script-canon" : "canon";
  if (moduleId === "memory") return script ? "script-memory" : "memory";
  if (moduleId === "reports") return "report";
  if (moduleId === "index") return "index";
  return "library";
};

const pathBasedDocumentId = (relativePath) => {
  const normalized = relativePath.replaceAll("\\", "/");
  const novelChapter = normalized.match(/^04_正文\/(?:小说\/[^/]+\/|第\d+卷[^/]*\/)?第0*(\d+)章(?:[-\s　]|\.md)/i);
  if (novelChapter) return `chapter-${Number(novelChapter[1])}`;
  const scriptEpisode = normalized.match(/^04_正文\/短剧\/短剧剧本\/第0*(\d+)集(?:[-\s　]|\.md)/i);
  if (scriptEpisode) return `script-episode-${Number(scriptEpisode[1])}`;
  const videoPrompt = normalized.match(/^04_正文\/短剧\/视频提示词\/第0*(\d+)集(?:[-\s　]|\.md)/i);
  if (videoPrompt) return `prompt-video-${Number(videoPrompt[1])}`;
  const visualPrompt = normalized.match(/^04_正文\/短剧\/(?:图片资产提示词|视觉资产提示词)\/第0*(\d+)集(?:[-\s　]|\.md)/i);
  if (visualPrompt) return `prompt-visual-${Number(visualPrompt[1])}`;
  const panoramaPrompt = normalized.match(/^04_正文\/短剧\/全景调度图提示词\/第0*(\d+)集(?:[-\s　]|\.md)/i);
  if (panoramaPrompt) return `prompt-panorama-${Number(panoramaPrompt[1])}`;
  const episodeOutline = normalized.match(/^04_正文\/短剧\/(?:剧本大纲|短剧大纲)\/(?:集纲\/)?第0*(\d+)集/i);
  if (episodeOutline) return `script-outline-episode-${Number(episodeOutline[1])}`;
  const volumeOutline = normalized.match(/^01_剧情控制\/卷纲\/第0*(\d+)卷/i);
  if (volumeOutline) return `outline-volume-${Number(volumeOutline[1])}`;
  const chapterOutline = normalized.match(/^01_剧情控制\/章纲\/第0*(\d+)章/i);
  if (chapterOutline) return `outline-chapter-${Number(chapterOutline[1])}`;
  return null;
};

const importDocumentOptions = (id, relativePath, classification = null) => {
  const normalized = relativePath.replaceAll("\\", "/");
  const options = {};
  if (normalized.startsWith("04_正文/短剧/")) {
    options.contextDomain = "script";
    if (normalized.includes("/短剧剧本/")) Object.assign(options, { workspaceView: "script", treeGroup: "scripts" });
    else if (normalized.includes("/视频提示词/")) Object.assign(options, { workspaceView: "prompts", treeGroup: "video" });
    else if (/\/(?:图片资产提示词|视觉资产提示词)\//.test(normalized)) Object.assign(options, { workspaceView: "prompts", treeGroup: "visual" });
    else if (normalized.includes("/全景调度图提示词/")) Object.assign(options, { workspaceView: "prompts", treeGroup: "panorama" });
    else if (/\/(?:剧本大纲|短剧大纲)\//.test(normalized)) Object.assign(options, {
      workspaceView: "script",
      treeGroup: id === "script-outline-series" ? "series" : "episodes",
    });
    else options.workspaceView = "script";
  }
  if (id === "report-adaptation") options.contextDomain = "script";
  if (id.startsWith("outline-volume-")) options.treeGroup = "volumes";
  if (id.startsWith("outline-chapter-")) options.treeGroup = "chapters";

  if (classification?.placement) {
    const placement = classification.placement;
    if (placement.viewId) options.workspaceView = placement.viewId;
    if (placement.contextDomain) options.contextDomain = placement.contextDomain;
    if (placement.treeGroup) options.treeGroup = placement.treeGroup;
  }

  const moduleId = importModuleId(id, relativePath, classification);
  const viewId = options.workspaceView ?? (["canon", "memory"].includes(moduleId) ? "novel" : "default");
  const structuredGroup = structuredGroupForDocument(moduleId, viewId, id)
    ?? structuredGroupForWorkspacePath(moduleId, viewId, normalized);
  if (structuredGroup) options.treeGroup = structuredGroup.key;

  const volume = normalized.match(/^04_正文\/小说\/([^/]+)\//)?.[1]
    || normalized.match(/^04_正文\/(第\d+卷[^/]*)\//)?.[1];
  if (volume) {
    const parsed = volume.match(/^第(\d+)卷[-　 ]?(.*)$/);
    options.volumeFolder = volume;
    options.volumeLabel = parsed ? `第${parsed[1].padStart(3, "0")}卷${parsed[2] ? `　${parsed[2]}` : ""}` : volume;
    options.folderId = `manuscript-volume:${volume}`;
    options.folderLabel = options.volumeLabel;
  }
  return options;
};

const stableImportId = (prefix, relativePath) => `${prefix}-import-${createHash("sha1")
  .update(normalizedRelative(relativePath))
  .digest("hex")
  .slice(0, 12)}`;

const scanMarkdownDocumentsAtRoot = async ({
  workspaceRoot,
  preferredIdsByPath = new Map(),
  preferredIdsByHash = new Map(),
  preservedDocumentsById = new Map(),
  sharedBinding = null,
}) => {
  const files = await listMarkdownFiles(workspaceRoot, {
    excludeIsolatedContent: true,
    excludedRelativePrefixes: sharedBinding?.excludedRelativePrefixes ?? [],
  });
  const documents = {};
  const manifest = {};
  const claimedIds = new Map();
  for (const filePath of files) {
    const sourceMarkdown = await readFile(filePath, "utf8");
    const parsed = parseFrontmatter(sourceMarkdown);
    const sourceHash = hashText(sourceMarkdown);
    const relativePath = relative(workspaceRoot, filePath).replaceAll("\\", "/");
    const normalizedPath = normalizedRelative(relativePath);
    const preferredId = preferredIdsByPath.get(normalizedPath) || preferredIdsByHash.get(sourceHash);
    const fallbackTitle = basename(filePath).replace(/\.md$/i, "");
    let id = preferredId || inferDocumentId(workspaceRoot, filePath, parsed.data) || pathBasedDocumentId(relativePath);
    const classification = classifyStructuredDocument({
      documentId: id || "",
      title: parsed.data.title || fallbackTitle,
      sourcePath: relativePath,
      markdown: parsed.body,
    });
    if (classification?.excluded) continue;
    const provisionalModuleId = importModuleId(id || "", relativePath, classification);
    const prefix = classification?.importPrefix || importIdPrefix(provisionalModuleId, relativePath);
    if (!id) id = stableImportId(prefix, relativePath);
    if (claimedIds.has(id) && claimedIds.get(id) !== normalizedPath) id = stableImportId(prefix, relativePath);
    claimedIds.set(id, normalizedPath);

    const chapterNumber = id.match(/^chapter-(\d+)$/)?.[1];
    const chapterName = chapterNumber ? fallbackTitle.replace(/^第\d+章[-\s　]*/, "") : "";
    const title = parsed.data.title || (chapterNumber ? `第${Number(chapterNumber)}章　${chapterName || fallbackTitle}` : fallbackTitle);
    const preservedDocument = preservedDocumentsById.get(id);
    const preserveObsidianMarkdown = sharedBinding?.sharedMarkdown === true || preservedDocument?.preserveObsidianMarkdown === true;
    const physicalFrontmatter = splitPreservedFrontmatter(sourceMarkdown);
    const preservedFrontmatterLines = preserveObsidianMarkdown
      ? preserveNonShensiFrontmatterLines(physicalFrontmatter.lines)
      : [];
    const markdown = preserveObsidianMarkdown
      ? [
          ...(preservedFrontmatterLines.length ? ["---", ...preservedFrontmatterLines, "---"] : []),
          physicalFrontmatter.body.replace(/\n+$/g, ""),
        ].join("\n")
      : parsed.body.trim();
    const html = sanitizeDocumentHtml(markdownToHtml(preserveObsidianMarkdown ? physicalFrontmatter.body : markdown));
    const moduleId = importModuleId(id, relativePath, classification);
    const options = importDocumentOptions(id, relativePath, classification);
    documents[id] = {
      ...(preserveObsidianMarkdown ? preservedDocument : {}),
      title,
      html,
      markdown,
      updatedAt: "已导入",
      sourcePath: relativePath,
      moduleId,
      ...options,
      importedStateHash: importedDocumentStateHash(title, markdown),
      importedHtmlRevision: contentRevision(html),
      ...(preserveObsidianMarkdown ? {
        preserveObsidianMarkdown: true,
        ...(sharedBinding?.sharedMarkdown === true ? { sharedObsidianMarkdown: true } : {}),
        sourceImportTargetPath: relativePath,
        sourceOriginalFrontmatter: preservedFrontmatterLines.length
          ? `---\n${preservedFrontmatterLines.join("\n")}\n---\n`
          : "",
        sourceOriginalMarkdownHash: sourceHash,
      } : {}),
      ...(parsed.data.shensi_memory && typeof parsed.data.shensi_memory === "object" ? {
        continuityDelta: Object.fromEntries(Object.entries(parsed.data.shensi_memory)
          .filter(([key]) => !["schemaVersion", "syncStatus", "syncedAt"].includes(key))),
        memorySyncStatus: parsed.data.shensi_memory.syncStatus ?? "unknown",
        memorySyncedAt: parsed.data.shensi_memory.syncedAt ?? "",
      } : {}),
    };
    manifest[id] = { path: relativePath, hash: sourceHash };
  }
  return { workspaceRoot, documents, manifest };
};

export const scanWorkspaceDocuments = async ({ appRoot, requestedPath, preferredIdsByPath = new Map(), preferredIdsByHash = new Map(), preservedDocumentsById = new Map() }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  return scanMarkdownDocumentsAtRoot({ workspaceRoot, preferredIdsByPath, preferredIdsByHash, preservedDocumentsById });
};

// External sources are scanned read-only. Unlike resolveWorkspaceRoot this entry
// intentionally accepts an arbitrary absolute directory, but it never writes to
// that directory and the walker does not follow symbolic links.
export const scanExternalWorkspaceDocuments = async ({ sourceRoot, preferredIdsByPath = new Map() }) => {
  const workspaceRoot = resolve(String(sourceRoot ?? ""));
  const info = await stat(workspaceRoot).catch(() => null);
  if (!info?.isDirectory()) throw new Error("外部作品目录不存在或不是文件夹");
  return scanMarkdownDocumentsAtRoot({ workspaceRoot, preferredIdsByPath });
};

export const resolveWorkspaceRoot = ({ appRoot, requestedPath }) => {
  const runtimeRoot = resolve(appRoot, "runtime");
  const vaultWorksRoot = resolve(appRoot, "..", "..", "作品");
  const persistentRoot = persistentWorksRoot();
  const notesRoot = persistentNotesRoot();
  const candidate = requestedPath
    ? resolve(requestedPath)
    : resolve(persistentRoot, "未命名");
  const resolvedCandidate = resolveWorkspaceRenameAlias(candidate);
  if (normalizeForCompare(candidate) !== normalizeForCompare(resolvedCandidate) && !existsSync(resolvedCandidate)) {
    const missingTarget = new Error("该工作区已完成重命名，但新目录当前不存在；已阻止旧路径重新创建，请从作品列表重新选择或恢复新目录");
    missingTarget.code = "WORKSPACE_RENAME_TARGET_MISSING";
    missingTarget.statusCode = 409;
    throw missingTarget;
  }
  const boundaryPath = (value) => {
    let existing = resolve(value);
    const remainder = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      remainder.unshift(basename(existing));
      existing = parent;
    }
    const realExisting = existsSync(existing) ? realpathSync(existing) : existing;
    return resolve(realExisting, ...remainder);
  };
  const allowed = [persistentRoot, notesRoot, runtimeRoot, vaultWorksRoot]
    .map((value) => normalizeForCompare(boundaryPath(value)));
  const normalized = normalizeForCompare(boundaryPath(resolvedCandidate));
  if (!allowed.some((root) => isInside(normalized, root))) {
    throw new Error("工作区目录只允许位于神思数据目录、运行目录或旧版作品目录内；外部目录请使用一键导入");
  }
  return resolvedCandidate;
};

export const resolveWorkspaceRevealTarget = async ({ appRoot, requestedPath, documentId = null, relativePath = null, revealFolder = false }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const workspaceInfo = await stat(workspaceRoot).catch(() => null);
  if (!workspaceInfo?.isDirectory()) throw new Error("作品目录不存在或尚未完成本地保存");
  if (relativePath) {
    const { targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: "文件或文件夹" });
    const targetInfo = await stat(targetPath).catch(() => null);
    if (targetInfo?.isDirectory()) return { targetPath, selectFile: false };
    if (targetInfo?.isFile()) return revealFolder
      ? { targetPath: dirname(targetPath), selectFile: false }
      : { targetPath, selectFile: true };
    throw new Error("对应文件或文件夹不存在，请等待自动保存后重试");
  }
  if (!documentId) return { targetPath: workspaceRoot, selectFile: false };

  const manifest = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "manifest.json"));
  const entry = manifest?.manifest?.[String(documentId)];
  const managedPath = typeof entry === "string" ? entry : entry?.path;
  if (!managedPath) throw new Error("该文档尚未完成本地保存");
  const { targetPath } = await secureManagedTarget(workspaceRoot, managedPath, { label: "文档" });
  const targetInfo = await stat(targetPath).catch(() => null);
  if (!targetInfo?.isFile()) throw new Error("本地文档不存在，请等待自动保存后重试");
  return revealFolder ? { targetPath: dirname(targetPath), selectFile: false } : { targetPath, selectFile: true };
};

const workspaceParentRoots = (appRoot) => [
  persistentWorksRoot(),
  resolve(appRoot, "runtime", "作品"),
  resolve(appRoot, "..", "..", "作品"),
].filter((value, index, values) => values.findIndex((item) => normalizeForCompare(item) === normalizeForCompare(value)) === index);

const migrationRegistryPath = () => join(appDataRoot(), "workspace-migrations.json");

const readMigrationRegistry = async () => {
  try {
    return JSON.parse(await readFile(migrationRegistryPath(), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { schemaVersion: 1, mappings: {} };
    throw error;
  }
};

const hashWorkspaceFile = (path) => new Promise((resolveHash, rejectHash) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", rejectHash);
  stream.on("end", () => resolveHash(hash.digest("hex")));
});

const workspaceCopyManifest = async (rootPath, currentPath = rootPath, manifest = {}) => {
  const entries = (await readdir(currentPath, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("作品目录包含符号链接，无法安全迁移");
    const absolutePath = join(currentPath, entry.name);
    const relativePath = relative(rootPath, absolutePath).replaceAll("\\", "/");
    if (relativePath === ".shensi/workspace.lock") continue;
    if (entry.isDirectory()) {
      await workspaceCopyManifest(rootPath, absolutePath, manifest);
    } else if (entry.isFile()) {
      const info = await stat(absolutePath);
      manifest[relativePath] = { size: info.size, hash: await hashWorkspaceFile(absolutePath) };
    }
  }
  return manifest;
};

const persistMigrationMapping = async ({ source, destination }) => {
  const registry = await readMigrationRegistry();
  registry.mappings[normalizeForCompare(source)] = destination;
  registry.updatedAt = new Date().toISOString();
  await atomicWrite(migrationRegistryPath(), JSON.stringify(registry, null, 2));
};

const uniqueMigratedWorkspacePath = async (source) => {
  const root = persistentWorksRoot();
  const base = safeName(basename(source));
  let suffix = 1;
  while (true) {
    const destination = join(root, suffix === 1 ? base : `${base}-旧版迁移-${suffix}`);
    const info = await stat(destination).catch(() => null);
    if (!info) return destination;
    suffix += 1;
  }
};

export const migrateLegacyWorkspaceToPersistent = async ({ appRoot, requestedPath }) => {
  const registry = await readMigrationRegistry();
  const requested = requestedPath ? resolve(requestedPath) : resolve(appRoot, "runtime", "作品", "未命名");
  const mapped = registry.mappings[normalizeForCompare(requested)];
  if (mapped && (await stat(mapped).catch(() => null))?.isDirectory()) {
    return { workspacePath: mapped, migrated: false, sourcePath: requested };
  }

  const runtimeRoot = resolve(appRoot, "runtime", "作品");
  if (!isInside(requested, runtimeRoot)) {
    return { workspacePath: resolveWorkspaceRoot({ appRoot, requestedPath }), migrated: false, sourcePath: requested };
  }
  const sourceInfo = await stat(requested).catch(() => null);
  if (!sourceInfo?.isDirectory()) {
    return { workspacePath: join(persistentWorksRoot(), safeName(basename(requested))), migrated: false, sourcePath: requested };
  }

  await mkdir(persistentWorksRoot(), { recursive: true });
  const destination = await uniqueMigratedWorkspacePath(requested);
  const staging = `${destination}.migrating-${randomUUID()}`;
  try {
    await cp(requested, staging, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    const [sourceManifest, copiedManifest] = await Promise.all([
      workspaceCopyManifest(requested),
      workspaceCopyManifest(staging),
    ]);
    if (JSON.stringify(sourceManifest) !== JSON.stringify(copiedManifest)) throw new Error("作品迁移校验失败，旧目录保持不变");
    await renameWithTransientRetry(staging, destination);
    const statePath = join(destination, ".shensi", "current-state.json");
    const currentState = await readJsonIfExists(statePath);
    if (currentState) {
      const migratedState = migrateLegacyBusinessPathsInValue(currentState, {
        workspaceRoot: destination,
        aliases: [{ sourceRoot: requested, targetRoot: destination }],
      }).value;
      migratedState.settings = portableGenerationSettings(migratedState.settings ?? {});
      delete migratedState.settings.workspacePath;
      await atomicWrite(statePath, JSON.stringify(migratedState, null, 2));
    }
    await persistMigrationMapping({ source: requested, destination });
    return { workspacePath: destination, migrated: true, sourcePath: requested };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
};

export const migrateAllLegacyWorkspacesToPersistent = async ({ appRoot }) => {
  const legacyRoot = resolve(appRoot, "runtime", "作品");
  const entries = await readdir(legacyRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    results.push(await migrateLegacyWorkspaceToPersistent({ appRoot, requestedPath: join(legacyRoot, entry.name) }));
  }
  return { migrated: results.filter((item) => item.migrated).length, workspaces: results };
};

const purgeDeletedProjects = async (parent, now = Date.now()) => {
  const archiveRoot = join(parent, ".shensi-deleted-projects");
  try {
    const entries = await readdir(archiveRoot, { withFileTypes: true });
    for (const entry of entries) {
      const deletedAt = Number(entry.name.match(/^(\d{13})-/)?.[1]);
      if (!entry.isDirectory() || !Number.isFinite(deletedAt) || now - deletedAt < TRASH_RETENTION_MS) continue;
      const target = resolve(archiveRoot, entry.name);
      if (!isInside(target, archiveRoot)) throw new Error("作品回收路径越界");
      await rm(target, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

export const listWorkspaceProjects = async ({ appRoot }) => {
  const projects = [];
  const migrationRegistry = await readMigrationRegistry();
  const migratedSources = new Set(Object.keys(migrationRegistry.mappings ?? {}));
  const skipped = new Set(["_备份_不参与规则扫描", "废弃设定", "原始资料", "node_modules"]);
  const writablePersistentRoot = normalizeForCompare(persistentWorksRoot());
  for (const parent of workspaceParentRoots(appRoot)) {
    if (normalizeForCompare(parent) === writablePersistentRoot) {
      await mkdir(parent, { recursive: true });
    } else {
      const legacyInfo = await stat(parent).catch(() => null);
      if (!legacyInfo?.isDirectory()) continue;
    }
    await purgeDeletedProjects(parent);
    const entries = await readdir(parent, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || skipped.has(entry.name)) continue;
      const workspacePath = join(parent, entry.name);
      if (migratedSources.has(normalizeForCompare(workspacePath))) continue;
      const state = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspacePath), "current-state.json"));
      projects.push({
        id: createHash("sha1").update(normalizeForCompare(workspacePath)).digest("hex").slice(0, 12),
        name: state?.projectName || entry.name,
        workspacePath,
        managed: Boolean(state),
        savedAt: state?.savedAt ?? "",
      });
    }
  }
  return projects.sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt), "zh-CN"));
};

const createWorkspaceDirectory = async ({ parent, name, fallbackName, operationId = "", workspaceKind = "project" }) => {
  await mkdir(parent, { recursive: true });
  const base = safeName(name || fallbackName);
  const receiptId = String(operationId || "").trim().slice(0, 180);
  let suffix = 1;
  while (true) {
    const folderName = suffix === 1 ? base : `${base} ${suffix}`;
    const workspacePath = join(parent, folderName);
    try {
      await mkdir(workspacePath);
      if (receiptId) {
        try {
          const internalRoot = resolveWorkspaceInternalRoot(workspacePath);
          await mkdir(internalRoot, { recursive: true });
          await atomicWriteWithTransientRetry(join(internalRoot, "creation-receipt.json"), JSON.stringify({
            operationId: receiptId,
            workspaceKind,
            createdAt: new Date().toISOString(),
          }, null, 2));
        } catch (error) {
          if (isInside(workspacePath, parent) && normalizeForCompare(workspacePath) !== normalizeForCompare(parent)) {
            await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
          }
          throw error;
        }
      }
      return { name: folderName, workspacePath, creationOperationId: receiptId, resumed: false };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (receiptId) {
        const receipt = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspacePath), "creation-receipt.json"));
        if (receipt?.operationId === receiptId && receipt?.workspaceKind === workspaceKind) {
          return { name: folderName, workspacePath, creationOperationId: receiptId, resumed: true };
        }
      }
      suffix += 1;
    }
  }
};

export const createWorkspaceProject = async ({ appRoot, name, operationId = "" }) => {
  const parent = workspaceParentRoots(appRoot)[0];
  return createWorkspaceDirectory({ parent, name, fallbackName: "未命名作品", operationId, workspaceKind: "project" });
};

export const renameWorkspaceProject = async ({ appRoot, requestedPath, name }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  return enqueueWorkspaceWrite(workspaceRoot, async () => {
    const parent = dirname(workspaceRoot);
    const allowedParents = workspaceParentRoots(appRoot).map(normalizeForCompare);
    if (!allowedParents.includes(normalizeForCompare(parent))) {
      throw new Error("只能重命名作品根目录下的直属作品");
    }
    const nextName = safeName(name);
    const target = join(parent, nextName);
    if (normalizeForCompare(target) !== normalizeForCompare(workspaceRoot)) {
      const targetInfo = await stat(target).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (targetInfo) throw new Error("已经存在同名作品");
      try {
        await renameWithTransientRetry(workspaceRoot, target);
      } catch (error) {
        if (TRANSIENT_RENAME_CODES.has(error.code)) {
          error.code = "WORKSPACE_RENAME_BUSY";
          error.statusCode = 409;
          error.message = "作品目录暂时被其他程序占用，神思已自动重试但仍未完成；原作品未改动，请关闭资源管理器预览或其他编辑器后重试";
        }
        throw error;
      }
    }
    const moved = normalizeForCompare(target) !== normalizeForCompare(workspaceRoot);
    try {
      const statePath = join(target, ".shensi", "current-state.json");
      const currentState = await readJsonIfExists(statePath);
      if (currentState) {
        const migratedState = migrateLegacyBusinessPathsInValue(currentState, {
          workspaceRoot: target,
          aliases: [{ sourceRoot: workspaceRoot, targetRoot: target }],
        }).value;
        migratedState.projectName = nextName;
        migratedState.settings = portableGenerationSettings(migratedState.settings ?? {});
        delete migratedState.settings.workspacePath;
        await atomicWriteWithTransientRetry(statePath, JSON.stringify(migratedState, null, 2));
      }
    } catch (error) {
      if (moved) {
        try {
          await renameWithTransientRetry(target, workspaceRoot);
        } catch (rollbackError) {
          const partial = new Error(`作品目录已移动到“${nextName}”，但名称状态未能同步且自动回滚失败；请关闭占用该目录的程序后重试恢复`);
          partial.code = "WORKSPACE_RENAME_PARTIAL";
          partial.statusCode = 409;
          partial.cause = rollbackError;
          throw partial;
        }
      }
      throw error;
    }
    if (moved) {
      try {
        await persistWorkspaceRenameAlias({ source: workspaceRoot, destination: target });
      } catch (error) {
        error.code = "WORKSPACE_RENAME_PARTIAL";
        error.statusCode = 409;
        error.message = "作品目录和名称已完成移动，但旧路径保护记录未能落盘；当前新目录仍可使用，请关闭占用程序后重试同步保护记录";
        throw error;
      }
    }
    return { name: nextName, workspacePath: target };
  });
};

export const deleteWorkspaceProject = async ({ appRoot, requestedPath }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const parent = dirname(workspaceRoot);
  const allowedParents = workspaceParentRoots(appRoot).map(normalizeForCompare);
  if (!allowedParents.includes(normalizeForCompare(parent))) {
    throw new Error("只能删除作品根目录下的直属作品");
  }
  const deletedAt = Date.now();
  const archiveRoot = join(parent, ".shensi-deleted-projects");
  await mkdir(archiveRoot, { recursive: true });
  const archiveName = `${deletedAt}-${safeName(basename(workspaceRoot))}-${Math.random().toString(36).slice(2, 8)}`;
  const archivedPath = join(archiveRoot, archiveName);
  await renameWithTransientRetry(workspaceRoot, archivedPath);
  return {
    name: basename(workspaceRoot),
    deletedAt: new Date(deletedAt).toISOString(),
    expiresAt: new Date(deletedAt + TRASH_RETENTION_MS).toISOString(),
    archivedPath,
  };
};

const notebookParentRoot = () => persistentNotesRoot();
const workspaceRootIsNotebook = (workspaceRoot) => isInside(normalizeForCompare(workspaceRoot), normalizeForCompare(notebookParentRoot()));

// Low-level callers can create a workspace before the UI has saved its initial
// state. Derive the type from its managed root so a notebook never inherits the
// project document layout merely because it has not been initialized yet.
export const workspaceKindForPath = ({ appRoot, requestedPath } = {}) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  return workspaceRootIsNotebook(workspaceRoot) ? "notebook" : "project";
};

const purgeDeletedNotebooks = async (parent, now = Date.now()) => {
  const archiveRoot = join(parent, ".shensi-deleted-notebooks");
  try {
    const entries = await readdir(archiveRoot, { withFileTypes: true });
    for (const entry of entries) {
      const deletedAt = Number(entry.name.match(/^(\d{13})-/)?.[1]);
      if (!entry.isDirectory() || !Number.isFinite(deletedAt) || now - deletedAt < TRASH_RETENTION_MS) continue;
      const target = resolve(archiveRoot, entry.name);
      if (!isInside(target, archiveRoot)) throw new Error("笔记本回收路径越界");
      await rm(target, { recursive: true, force: true });
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
};

const deletedWorkspaceArchiveSpecs = (appRoot) => [
  ...workspaceParentRoots(appRoot).map((parent) => ({
    workspaceKind: "project",
    kind: "workspace-project",
    parent,
    archiveRoot: join(parent, ".shensi-deleted-projects"),
  })),
  {
    workspaceKind: "notebook",
    kind: "workspace-notebook",
    parent: notebookParentRoot(),
    archiveRoot: join(notebookParentRoot(), ".shensi-deleted-notebooks"),
  },
];

const deletedWorkspaceArchiveParts = (name) => {
  const match = String(name ?? "").match(/^(\d{13})-(.+)-([a-z0-9]{6})$/i);
  if (!match) return null;
  const deletedAt = Number(match[1]);
  if (!Number.isSafeInteger(deletedAt) || deletedAt <= 0) return null;
  return { deletedAt, originalName: safeName(match[2]) };
};

const deletedWorkspaceTrashId = ({ kind, archivedPath }) => `workspace:${createHash("sha256")
  .update(`${kind}\n${normalizeForCompare(archivedPath)}`)
  .digest("hex")
  .slice(0, 24)}`;

const listDeletedWorkspaceArchives = async ({ appRoot, purgeExpired = true } = {}) => {
  const items = [];
  for (const spec of deletedWorkspaceArchiveSpecs(appRoot)) {
    if (purgeExpired) {
      if (spec.workspaceKind === "notebook") await purgeDeletedNotebooks(spec.parent);
      else await purgeDeletedProjects(spec.parent);
    }
    const entries = await readdir(spec.archiveRoot, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const parts = deletedWorkspaceArchiveParts(entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !parts) continue;
      const archivedPath = resolve(spec.archiveRoot, entry.name);
      if (!isInside(archivedPath, spec.archiveRoot)) throw new Error("工作区回收路径越界");
      const currentState = await readJsonIfExists(join(archivedPath, ".shensi", "current-state.json"));
      const title = String(currentState?.projectName ?? parts.originalName).trim() || parts.originalName;
      items.push({
        trashId: deletedWorkspaceTrashId({ kind: spec.kind, archivedPath }),
        kind: spec.kind,
        workspaceKind: spec.workspaceKind,
        title,
        originalName: parts.originalName,
        deletedAtIso: new Date(parts.deletedAt).toISOString(),
        expiresAtIso: new Date(parts.deletedAt + TRASH_RETENTION_MS).toISOString(),
        archivedPath,
        parent: spec.parent,
      });
    }
  }
  return items.sort((left, right) => String(right.deletedAtIso).localeCompare(String(left.deletedAtIso), "zh-CN"));
};

const deletedWorkspaceArchiveById = async ({ appRoot, trashId }) => {
  const normalizedTrashId = String(trashId ?? "").trim();
  if (!/^workspace:[a-f0-9]{24}$/i.test(normalizedTrashId)) throw new Error("工作区回收项无效");
  const entry = (await listDeletedWorkspaceArchives({ appRoot })).find((item) => item.trashId === normalizedTrashId);
  if (!entry) throw new Error("工作区回收项不存在或已过期");
  const archivedPath = resolve(entry.archivedPath);
  const archiveRoot = resolve(dirname(archivedPath));
  if (!isInside(archivedPath, archiveRoot) || normalizeForCompare(dirname(archiveRoot)) !== normalizeForCompare(entry.parent)) {
    throw new Error("工作区回收路径越界");
  }
  const archivedInfo = await lstat(archivedPath).catch(() => null);
  if (!archivedInfo?.isDirectory() || archivedInfo.isSymbolicLink()) throw new Error("工作区回收项不存在或类型异常");
  return entry;
};

const uniqueRestoredWorkspacePath = async ({ parent, originalName }) => {
  const base = safeName(originalName);
  let suffix = 0;
  while (true) {
    const name = suffix === 0 ? base : suffix === 1 ? `${base}（恢复）` : `${base}（恢复${suffix}）`;
    const target = join(parent, name);
    if (!await lstat(target).catch(() => null)) return { name, target };
    suffix += 1;
  }
};

export const listDeletedWorkspaces = async ({ appRoot }) => (await listDeletedWorkspaceArchives({ appRoot }))
  .map(({ archivedPath, parent, originalName, ...entry }) => entry);

export const restoreDeletedWorkspace = async ({ appRoot, trashId }) => {
  const entry = await deletedWorkspaceArchiveById({ appRoot, trashId });
  await mkdir(entry.parent, { recursive: true });
  const { name, target } = await uniqueRestoredWorkspacePath({ parent: entry.parent, originalName: entry.originalName });
  await renameWithTransientRetry(entry.archivedPath, target);
  try {
    const statePath = join(target, ".shensi", "current-state.json");
    const currentState = await readJsonIfExists(statePath);
    if (currentState) {
      currentState.projectName = name;
      currentState.workspaceKind = entry.workspaceKind;
      currentState.settings = portableGenerationSettings(currentState.settings ?? {});
      delete currentState.settings.workspacePath;
      await atomicWriteWithTransientRetry(statePath, JSON.stringify(currentState, null, 2));
    }
  } catch (error) {
    try {
      await renameWithTransientRetry(target, entry.archivedPath);
    } catch (rollbackError) {
      const partial = new Error(`“${name}”已恢复，但状态同步失败且无法自动回滚；请勿重复恢复并检查该工作区`);
      partial.code = "WORKSPACE_RESTORE_PARTIAL";
      partial.statusCode = 409;
      partial.cause = rollbackError;
      throw partial;
    }
    throw error;
  }
  return { kind: entry.kind, workspaceKind: entry.workspaceKind, name, workspacePath: target };
};

export const permanentlyDeleteDeletedWorkspace = async ({ appRoot, trashId }) => {
  const entry = await deletedWorkspaceArchiveById({ appRoot, trashId });
  await rm(entry.archivedPath, { recursive: true, force: false });
  return { trashId: entry.trashId, kind: entry.kind, title: entry.title };
};

export const listWorkspaceNotebooks = async () => {
  const parent = notebookParentRoot();
  await mkdir(parent, { recursive: true });
  await purgeDeletedNotebooks(parent);
  const entries = await readdir(parent, { withFileTypes: true });
  const notebooks = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const workspacePath = join(parent, entry.name);
    const state = await readJsonIfExists(join(workspacePath, ".shensi", "current-state.json"));
    notebooks.push({
      id: createHash("sha1").update(normalizeForCompare(workspacePath)).digest("hex").slice(0, 12),
      name: state?.projectName || entry.name,
      workspacePath,
      managed: Boolean(state),
      savedAt: state?.savedAt ?? "",
    });
  }
  return notebooks.sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt), "zh-CN"));
};

export const createWorkspaceNotebook = async ({ name, operationId = "" }) => {
  const parent = notebookParentRoot();
  return createWorkspaceDirectory({ parent, name, fallbackName: "我的笔记", operationId, workspaceKind: "notebook" });
};

export const renameWorkspaceNotebook = async ({ appRoot, requestedPath, name }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  return enqueueWorkspaceWrite(workspaceRoot, async () => {
    const parent = dirname(workspaceRoot);
    if (normalizeForCompare(parent) !== normalizeForCompare(notebookParentRoot())) {
      throw new Error("只能重命名笔记根目录下的直属笔记本");
    }
    const nextName = safeName(name);
    const target = join(parent, nextName);
    if (normalizeForCompare(target) !== normalizeForCompare(workspaceRoot)) {
      if (await stat(target).catch(() => null)) throw new Error("已经存在同名笔记本");
      try {
        await renameWithTransientRetry(workspaceRoot, target);
      } catch (error) {
        if (TRANSIENT_RENAME_CODES.has(error.code)) {
          error.code = "WORKSPACE_RENAME_BUSY";
          error.statusCode = 409;
          error.message = "笔记本目录暂时被其他程序占用，神思已自动重试但仍未完成；原笔记本未改动，请关闭资源管理器预览或其他编辑器后重试";
        }
        throw error;
      }
    }
    const moved = normalizeForCompare(target) !== normalizeForCompare(workspaceRoot);
    try {
      const statePath = join(target, ".shensi", "current-state.json");
      const currentState = await readJsonIfExists(statePath);
      if (currentState) {
        const migratedState = migrateLegacyBusinessPathsInValue(currentState, {
          workspaceRoot: target,
          aliases: [{ sourceRoot: workspaceRoot, targetRoot: target }],
        }).value;
        migratedState.projectName = nextName;
        migratedState.workspaceKind = "notebook";
        migratedState.settings = portableGenerationSettings(migratedState.settings ?? {});
        delete migratedState.settings.workspacePath;
        await atomicWriteWithTransientRetry(statePath, JSON.stringify(migratedState, null, 2));
      }
    } catch (error) {
      if (moved) {
        try {
          await renameWithTransientRetry(target, workspaceRoot);
        } catch (rollbackError) {
          const partial = new Error(`笔记本目录已移动到“${nextName}”，但名称状态未能同步且自动回滚失败；请关闭占用该目录的程序后重试恢复`);
          partial.code = "WORKSPACE_RENAME_PARTIAL";
          partial.statusCode = 409;
          partial.cause = rollbackError;
          throw partial;
        }
      }
      throw error;
    }
    if (moved) {
      try {
        await persistWorkspaceRenameAlias({ source: workspaceRoot, destination: target });
      } catch (error) {
        error.code = "WORKSPACE_RENAME_PARTIAL";
        error.statusCode = 409;
        error.message = "笔记本目录和名称已完成移动，但旧路径保护记录未能落盘；当前新目录仍可使用，请关闭占用程序后重试同步保护记录";
        throw error;
      }
    }
    return { name: nextName, workspacePath: target };
  });
};

export const deleteWorkspaceNotebook = async ({ appRoot, requestedPath }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const parent = dirname(workspaceRoot);
  if (normalizeForCompare(parent) !== normalizeForCompare(notebookParentRoot())) {
    throw new Error("只能删除笔记根目录下的直属笔记本");
  }
  const deletedAt = Date.now();
  const archiveRoot = join(parent, ".shensi-deleted-notebooks");
  await mkdir(archiveRoot, { recursive: true });
  const archivedPath = join(archiveRoot, `${deletedAt}-${safeName(basename(workspaceRoot))}-${Math.random().toString(36).slice(2, 8)}`);
  await renameWithTransientRetry(workspaceRoot, archivedPath);
  return {
    name: basename(workspaceRoot),
    deletedAt: new Date(deletedAt).toISOString(),
    expiresAt: new Date(deletedAt + TRASH_RETENTION_MS).toISOString(),
    archivedPath,
  };
};

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const positiveByteSetting = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};
const attachmentMimeByExtension = (value) => ({
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif", bmp: "image/bmp",
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogv: "video/ogg", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac", oga: "audio/ogg", opus: "audio/opus", wma: "audio/x-ms-wma",
  md: "text/markdown", skill: "text/markdown", txt: "text/plain", csv: "text/csv", pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
}[String(value).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ""] || "");

export const mediaStoragePolicy = () => ({
  imageFileLimitBytes: positiveByteSetting("SHENSI_IMAGE_FILE_LIMIT_BYTES", 256 * MIB),
  videoFileLimitBytes: positiveByteSetting("SHENSI_VIDEO_FILE_LIMIT_BYTES", 2 * GIB),
  audioFileLimitBytes: positiveByteSetting("SHENSI_AUDIO_FILE_LIMIT_BYTES", 2 * GIB),
  otherFileLimitBytes: positiveByteSetting("SHENSI_OTHER_FILE_LIMIT_BYTES", 2 * GIB),
  workspaceMediaQuotaBytes: positiveByteSetting("SHENSI_MEDIA_DISK_QUOTA_BYTES", 20 * GIB),
  diskReserveBytes: positiveByteSetting("SHENSI_MEDIA_DISK_RESERVE_BYTES", 512 * MIB),
});

export const mediaModelReferencePolicy = () => ({
  imageFileLimitBytes: positiveByteSetting("SHENSI_MODEL_REFERENCE_IMAGE_LIMIT_BYTES", 20 * MIB),
  totalInlineBytes: positiveByteSetting("SHENSI_MODEL_REFERENCE_TOTAL_INLINE_BYTES", 96 * MIB),
});

const attachmentFileLimit = (mimeType) => {
  const policy = mediaStoragePolicy();
  if (String(mimeType).startsWith("image/")) return policy.imageFileLimitBytes;
  if (String(mimeType).startsWith("video/")) return policy.videoFileLimitBytes;
  if (String(mimeType).startsWith("audio/")) return policy.audioFileLimitBytes;
  return policy.otherFileLimitBytes;
};

const attachmentBaseRelativePath = async (workspaceRoot) => {
  const currentState = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "current-state.json"));
  return currentState?.workspaceKind === "notebook" || workspaceRootIsNotebook(workspaceRoot)
    ? "附件"
    : join("08_资料库", "附件");
};

const mediaBatchRelativeDirectory = async (workspaceRoot, mediaBatchId = "") => {
  const normalizedBatchId = String(mediaBatchId || "").trim();
  if (!normalizedBatchId) return "";
  const batchName = safeName(normalizedBatchId).slice(0, 80);
  return join(await attachmentBaseRelativePath(workspaceRoot), "图片生成批次", batchName).replaceAll("\\", "/");
};

const whiteboardMediaIndexHash = (documentId) => createHash("sha256").update(String(documentId || ""), "utf8").digest("hex");
const whiteboardMediaIndexInternalPath = (workspaceRoot, documentId) => join(
  resolveWorkspaceInternalRoot(workspaceRoot),
  "whiteboard-media-indexes",
  `${whiteboardMediaIndexHash(documentId)}.json`,
);
const whiteboardMediaIndexLockPath = (workspaceRoot, documentId) => join(
  resolveWorkspaceInternalRoot(workspaceRoot),
  "whiteboard-media-indexes",
  `${whiteboardMediaIndexHash(documentId)}.lock`,
);
const whiteboardMediaRelativeDirectory = async (workspaceRoot, documentId = "") => {
  const normalizedDocumentId = String(documentId || "").trim();
  if (!normalizedDocumentId) return "";
  const previous = await readJsonIfExists(whiteboardMediaIndexInternalPath(workspaceRoot, normalizedDocumentId)).catch(() => null);
  if (String(previous?.whiteboardMediaDirectory || "").trim()) return String(previous.whiteboardMediaDirectory).replaceAll("\\", "/");
  const currentState = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "current-state.json")).catch(() => null);
  const title = String(currentState?.documents?.[normalizedDocumentId]?.title || "白板").trim() || "白板";
  const folderName = `${safeName(title).slice(0, 64)}-${whiteboardMediaIndexHash(normalizedDocumentId).slice(0, 8)}`;
  return join(await attachmentBaseRelativePath(workspaceRoot), "白板媒体", folderName).replaceAll("\\", "/");
};
const whiteboardMediaKindDirectory = (kind = "") => String(kind || "").toLowerCase() === "video" ? "视频" : "图片";

const attachmentDestination = async (workspaceRoot, name, {
  stableName = false,
  mediaBatchId = "",
  whiteboardDocumentId = "",
  whiteboardMediaKind = "",
} = {}) => {
  const safeFile = safeName(name || "附件");
  const uniqueName = stableName ? safeFile : `${Date.now()}-${randomUUID().slice(0, 8)}-${safeFile}`;
  const batchDirectory = await mediaBatchRelativeDirectory(workspaceRoot, mediaBatchId);
  const whiteboardDirectory = batchDirectory ? "" : await whiteboardMediaRelativeDirectory(workspaceRoot, whiteboardDocumentId);
  const destinationDirectory = batchDirectory
    || (whiteboardDirectory ? join(whiteboardDirectory, whiteboardMediaKindDirectory(whiteboardMediaKind)) : "")
    || await attachmentBaseRelativePath(workspaceRoot);
  const relativePath = join(destinationDirectory, uniqueName);
  const { targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: "附件" });
  return { safeFile, relativePath, targetPath, attachmentRoot: dirname(targetPath) };
};

const mediaBatchIndexHash = (mediaBatchId) => createHash("sha256").update(String(mediaBatchId || ""), "utf8").digest("hex");
const mediaBatchIndexInternalPath = (workspaceRoot, mediaBatchId) => join(
  resolveWorkspaceInternalRoot(workspaceRoot),
  "media-batch-indexes",
  `${mediaBatchIndexHash(mediaBatchId)}.json`,
);
const mediaBatchIndexLockPath = (workspaceRoot, mediaBatchId) => join(
  resolveWorkspaceInternalRoot(workspaceRoot),
  "media-batch-indexes",
  `${mediaBatchIndexHash(mediaBatchId)}.lock`,
);
const waitForMediaBatchIndexLock = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const withMediaBatchIndexLock = async (workspaceRoot, mediaBatchId, task) => {
  const lockPath = mediaBatchIndexLockPath(workspaceRoot, mediaBatchId);
  await mkdir(dirname(lockPath), { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const [lock, lockInfo] = await Promise.all([
        readJsonIfExists(lockPath).catch(() => null),
        stat(lockPath).catch(() => null),
      ]);
      const lockPid = Number(lock?.pid);
      const createdAt = Date.parse(lock?.createdAt || "");
      const lockAgeMs = Date.now() - (Number.isFinite(createdAt) ? createdAt : Number(lockInfo?.mtimeMs || Date.now()));
      const stale = (Number.isInteger(lockPid) && lockPid > 0 && !processIsAlive(lockPid)) || lockAgeMs > 30_000;
      if (stale) {
        await rm(lockPath, { force: true });
        continue;
      }
      await waitForMediaBatchIndexLock(25);
    }
  }
  if (!handle) throw new Error("图片批次索引正在被另一个任务写入，请稍后重试");
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
};

export const upsertWorkspaceMediaBatchIndex = async ({
  appRoot,
  requestedPath,
  mediaBatchId,
  jobId,
  batchIndex = 1,
  batchTotal = 1,
  batchLabel = "",
  prompt = "",
  attachments = [],
  completedAt = "",
} = {}) => {
  const normalizedBatchId = String(mediaBatchId || "").trim();
  if (!normalizedBatchId) return null;
  const landedAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment?.relativePath)
    .map((attachment) => ({
      name: String(attachment.name || basename(attachment.relativePath) || "生成图片"),
      relativePath: String(attachment.relativePath).replaceAll("\\", "/"),
      mimeType: String(attachment.mimeType || "image/png"),
      size: Math.max(0, Number(attachment.size) || 0),
      sha256: String(attachment.sha256 || ""),
    }));
  if (!landedAttachments.length) throw new Error("图片批次索引缺少已落盘图片");
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const batchDirectory = await mediaBatchRelativeDirectory(workspaceRoot, normalizedBatchId);
  const { targetPath: visibleIndexPath } = await secureManagedTarget(
    workspaceRoot,
    join(batchDirectory, "批次索引.json"),
    { label: "图片批次索引" },
  );
  const internalIndexPath = mediaBatchIndexInternalPath(workspaceRoot, normalizedBatchId);
  return withMediaBatchIndexLock(workspaceRoot, normalizedBatchId, async () => {
    const previous = await readJsonIfExists(internalIndexPath).catch(() => null);
    const now = new Date().toISOString();
    const normalizedJobId = String(jobId || `batch-item-${Math.max(1, Number(batchIndex) || 1)}`);
    const item = {
      jobId: normalizedJobId,
      index: Math.max(1, Number(batchIndex) || 1),
      total: Math.max(1, Number(batchTotal) || 1),
      label: String(batchLabel || "").trim(),
      prompt: String(prompt || "").trim(),
      completedAt: String(completedAt || now),
      attachments: landedAttachments,
    };
    const items = [
      ...(Array.isArray(previous?.items) ? previous.items.filter((entry) => String(entry?.jobId || "") !== normalizedJobId) : []),
      item,
    ].sort((left, right) => Number(left?.index || 0) - Number(right?.index || 0)
      || String(left?.jobId || "").localeCompare(String(right?.jobId || "")));
    const expectedTotal = Math.max(1, Number(batchTotal) || 1, ...items.map((entry) => Number(entry?.total) || 1));
    const completedCount = new Set(items.map((entry) => Math.max(1, Number(entry?.index) || 1))).size;
    const index = {
      schemaVersion: 1,
      kind: "shensi-image-generation-batch",
      batchId: normalizedBatchId,
      batchDirectory,
      expectedTotal,
      completedCount,
      status: completedCount >= expectedTotal ? "complete" : "partial",
      createdAt: String(previous?.createdAt || item.completedAt || now),
      updatedAt: now,
      items,
    };
    const serialized = `${JSON.stringify(index, null, 2)}\n`;
    await atomicWrite(internalIndexPath, serialized);
    await atomicWrite(visibleIndexPath, serialized);
    return {
      mediaBatchDirectory: batchDirectory,
      mediaBatchIndexPath: relative(workspaceRoot, visibleIndexPath).replaceAll("\\", "/"),
      expectedTotal,
      completedCount,
      status: index.status,
    };
  });
};

const waitForWhiteboardMediaIndexLock = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const withWhiteboardMediaIndexLock = async (workspaceRoot, documentId, task) => {
  const lockPath = whiteboardMediaIndexLockPath(workspaceRoot, documentId);
  await mkdir(dirname(lockPath), { recursive: true });
  let handle = null;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try {
      handle = await open(lockPath, "wx");
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const [lock, lockInfo] = await Promise.all([
        readJsonIfExists(lockPath).catch(() => null),
        stat(lockPath).catch(() => null),
      ]);
      const lockPid = Number(lock?.pid);
      const createdAt = Date.parse(lock?.createdAt || "");
      const lockAgeMs = Date.now() - (Number.isFinite(createdAt) ? createdAt : Number(lockInfo?.mtimeMs || Date.now()));
      const stale = (Number.isInteger(lockPid) && lockPid > 0 && !processIsAlive(lockPid)) || lockAgeMs > 30_000;
      if (stale) {
        await rm(lockPath, { force: true });
        continue;
      }
      await waitForWhiteboardMediaIndexLock(25);
    }
  }
  if (!handle) throw new Error("白板媒体索引正在被另一个任务写入，请稍后重试");
  await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), "utf8");
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    await rm(lockPath, { force: true });
  }
};

export const upsertWorkspaceWhiteboardMediaIndex = async ({
  appRoot,
  requestedPath,
  documentId,
  nodeId,
  jobId,
  channel,
  prompt = "",
  attachments = [],
  completedAt = "",
} = {}) => {
  const normalizedDocumentId = String(documentId || "").trim();
  const normalizedNodeId = String(nodeId || "").trim();
  const normalizedChannel = String(channel || "").toLowerCase();
  if (!normalizedDocumentId || !normalizedNodeId || !["image", "video"].includes(normalizedChannel)) return null;
  const landedAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter((attachment) => attachment?.relativePath)
    .map((attachment) => ({
      name: String(attachment.name || basename(attachment.relativePath) || (normalizedChannel === "video" ? "生成视频" : "生成图片")),
      relativePath: String(attachment.relativePath).replaceAll("\\", "/"),
      mimeType: String(attachment.mimeType || (normalizedChannel === "video" ? "video/mp4" : "image/png")),
      size: Math.max(0, Number(attachment.size) || 0),
      sha256: String(attachment.sha256 || ""),
    }));
  if (!landedAttachments.length) throw new Error("白板媒体索引缺少已落盘素材");
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const internalIndexPath = whiteboardMediaIndexInternalPath(workspaceRoot, normalizedDocumentId);
  return withWhiteboardMediaIndexLock(workspaceRoot, normalizedDocumentId, async () => {
    const previous = await readJsonIfExists(internalIndexPath).catch(() => null);
    const whiteboardMediaDirectory = await whiteboardMediaRelativeDirectory(workspaceRoot, normalizedDocumentId);
    const { targetPath: visibleIndexPath } = await secureManagedTarget(
      workspaceRoot,
      join(whiteboardMediaDirectory, "白板媒体索引.json"),
      { label: "白板媒体索引" },
    );
    const currentState = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "current-state.json")).catch(() => null);
    const whiteboardTitle = String(currentState?.documents?.[normalizedDocumentId]?.title || previous?.whiteboardTitle || "白板").trim() || "白板";
    const now = new Date().toISOString();
    const normalizedJobId = String(jobId || `${normalizedChannel}-${normalizedNodeId}`);
    const item = {
      jobId: normalizedJobId,
      nodeId: normalizedNodeId,
      channel: normalizedChannel,
      prompt: String(prompt || "").trim(),
      completedAt: String(completedAt || now),
      attachments: landedAttachments,
    };
    const items = [
      ...(Array.isArray(previous?.items) ? previous.items.filter((entry) => String(entry?.jobId || "") !== normalizedJobId) : []),
      item,
    ].sort((left, right) => String(left?.completedAt || "").localeCompare(String(right?.completedAt || ""))
      || String(left?.jobId || "").localeCompare(String(right?.jobId || "")));
    const index = {
      schemaVersion: 1,
      kind: "shensi-whiteboard-media",
      documentId: normalizedDocumentId,
      whiteboardTitle,
      whiteboardMediaDirectory,
      createdAt: String(previous?.createdAt || item.completedAt || now),
      updatedAt: now,
      items,
    };
    const serialized = `${JSON.stringify(index, null, 2)}\n`;
    await atomicWrite(internalIndexPath, serialized);
    await atomicWrite(visibleIndexPath, serialized);
    return {
      whiteboardMediaDirectory,
      whiteboardMediaIndexPath: relative(workspaceRoot, visibleIndexPath).replaceAll("\\", "/"),
      itemCount: items.length,
    };
  });
};

const directoryBytes = async (root, seenFiles = new Set()) => {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(path, seenFiles);
    else if (entry.isFile()) {
      const info = await stat(path);
      const identity = `${info.dev}:${info.ino}`;
      if (info.ino && seenFiles.has(identity)) continue;
      if (info.ino) seenFiles.add(identity);
      total += Number(info.size || 0);
    }
  }
  return total;
};

const mediaObjectPath = (workspaceRoot, hash) => join(resolveWorkspaceInternalRoot(workspaceRoot), "media-objects", hash.slice(0, 2), `${hash}.blob`);
const MEDIA_OBJECT_REFERENCE_INDEX_VERSION = 1;
const mediaObjectReferenceIndexPath = (workspaceRoot) => join(resolveWorkspaceInternalRoot(workspaceRoot), "media-object-references.json");
const normalizeMediaObjectHash = (value) => {
  const hash = String(value ?? "").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(hash) ? hash : "";
};

const fileSha256 = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

const syncCopiedFile = async (path) => {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncParentDirectory = async (path) => {
  const handle = await open(dirname(path), "r").catch((error) => {
    if (["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) return null;
    throw error;
  });
  if (!handle) return;
  try {
    await handle.sync().catch((error) => {
      if (["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(error.code)) return;
      throw error;
    });
  } finally {
    await handle.close();
  }
};

const replaceFileFromCopy = async ({ sourcePath, targetPath, expectedHash }) => {
  const replacementPath = `${targetPath}.replacement-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(sourcePath, replacementPath, fsConstants.COPYFILE_EXCL);
    await syncCopiedFile(replacementPath);
    if (await fileSha256(replacementPath) !== expectedHash) throw new Error("媒体文件安全复制后的内容哈希不一致");
    // replacementPath 与 targetPath 位于同一目录；一次 rename 是唯一提交点。
    // 进程在提交前退出时旧文件仍完整可见，提交后退出时新文件已完整可见，
    // 不再出现先移走 target 再安装 replacement 的“文件缺席”崩溃窗口。
    await renameWithTransientRetry(replacementPath, targetPath);
    await syncParentDirectory(targetPath);
  } finally {
    await rm(replacementPath, { force: true });
  }
};

const detachLegacyHardlink = async ({ path, expectedHash }) => {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("媒体文件不能是符号链接或非普通文件");
  if (Number(info.nlink || 1) <= 1) return false;
  await replaceFileFromCopy({ sourcePath: path, targetPath: path, expectedHash });
  return true;
};

const sanitizeMediaReferenceIndex = (raw) => {
  if (!raw || Number(raw.schemaVersion) !== MEDIA_OBJECT_REFERENCE_INDEX_VERSION || !raw.references || typeof raw.references !== "object" || Array.isArray(raw.references)) return null;
  const references = {};
  for (const [candidatePath, candidate] of Object.entries(raw.references)) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    let relativePath;
    try {
      relativePath = normalizeManagedRelativePath(candidatePath, { label: "媒体引用" });
    } catch {
      return null;
    }
    const objectHash = normalizeMediaObjectHash(candidate?.objectHash);
    if (!objectHash) return null;
    references[relativePath] = {
      objectHash,
      size: Math.max(0, Number(candidate?.size) || 0),
      recordedAt: String(candidate?.recordedAt || ""),
    };
  }
  return {
    schemaVersion: MEDIA_OBJECT_REFERENCE_INDEX_VERSION,
    migratedLegacyHardlinksAt: String(raw.migratedLegacyHardlinksAt || ""),
    updatedAt: String(raw.updatedAt || ""),
    references,
  };
};

const legacyAttachmentFiles = async (workspaceRoot) => {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const candidate = join(directory, entry.name);
      if (!isInside(candidate, workspaceRoot)) throw new Error("媒体引用迁移扫描路径越界");
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && !/\.upload$/i.test(entry.name)) files.push(candidate);
    }
  };
  await visit(join(workspaceRoot, "附件"));
  await visit(join(workspaceRoot, "08_资料库", "附件"));
  return files;
};

const legacyMediaObjectFiles = async (workspaceRoot) => {
  const objectRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "media-objects");
  const rootInfo = await lstat(objectRoot).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!rootInfo) return [];
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("媒体对象仓不能是符号链接或非目录");
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (!isInside(candidate, objectRoot)) throw new Error("媒体对象仓迁移扫描路径越界");
      if (entry.isSymbolicLink()) throw new Error("媒体对象仓不能包含符号链接");
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile() && /^[a-f0-9]{64}\.blob$/i.test(entry.name)) files.push(candidate);
    }
  };
  await visit(objectRoot);
  return files;
};

const migrateMediaReferenceIndex = async (workspaceRoot) => {
  const references = {};
  const legacyAttachments = [];
  for (const path of await legacyAttachmentFiles(workspaceRoot)) {
    const objectHash = await fileSha256(path);
    legacyAttachments.push({ path, objectHash });
    const objectPath = mediaObjectPath(workspaceRoot, objectHash);
    const objectInfo = await lstat(objectPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!objectInfo?.isFile() || objectInfo.isSymbolicLink()) continue;
    const relativePath = relative(workspaceRoot, path).replaceAll("\\", "/");
    const info = await stat(path);
    references[relativePath] = {
      objectHash,
      size: Number(info.size || 0),
      recordedAt: new Date().toISOString(),
    };
  }
  for (const objectPath of await legacyMediaObjectFiles(workspaceRoot)) {
    await detachLegacyHardlink({ path: objectPath, expectedHash: await fileSha256(objectPath) });
  }
  for (const { path, objectHash } of legacyAttachments) {
    await detachLegacyHardlink({ path, expectedHash: objectHash });
  }
  const now = new Date().toISOString();
  const index = {
    schemaVersion: MEDIA_OBJECT_REFERENCE_INDEX_VERSION,
    migratedLegacyHardlinksAt: now,
    updatedAt: now,
    references,
  };
  await atomicWrite(mediaObjectReferenceIndexPath(workspaceRoot), JSON.stringify(index, null, 2));
  return index;
};

const readMediaReferenceIndex = async (workspaceRoot) => {
  const indexPath = mediaObjectReferenceIndexPath(workspaceRoot);
  const raw = await readJsonIfExists(indexPath);
  if (raw) {
    const normalized = sanitizeMediaReferenceIndex(raw);
    if (!normalized) throw new Error("媒体对象引用索引损坏，已停止复用或清理对象");
    return normalized;
  }
  return migrateMediaReferenceIndex(workspaceRoot);
};

const writeMediaReferenceIndex = async (workspaceRoot, index) => {
  const normalized = sanitizeMediaReferenceIndex(index);
  if (!normalized) throw new Error("媒体对象引用索引内容无效");
  normalized.updatedAt = new Date().toISOString();
  await atomicWrite(mediaObjectReferenceIndexPath(workspaceRoot), JSON.stringify(normalized, null, 2));
  return normalized;
};

export const inspectMediaObjectStore = async ({ appRoot, requestedPath, prune = false, minimumAgeMs = 7 * 24 * 60 * 60 * 1000 }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  return enqueueWorkspaceWrite(workspaceRoot, () => withWorkspaceFileLock(workspaceRoot, async () => {
    const objectRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "media-objects");
    const now = Date.now();
    const index = await readMediaReferenceIndex(workspaceRoot);
    const validReferencesByHash = new Map();
    const staleReferencePaths = [];
    const summary = {
      objectCount: 0,
      referencedObjectCount: 0,
      reclaimableObjectCount: 0,
      corruptedObjectCount: 0,
      indexedReferenceCount: 0,
      validReferenceCount: 0,
      staleReferenceCount: 0,
      prunedReferenceCount: 0,
      physicalBytes: 0,
      reclaimableBytes: 0,
      deletedObjectCount: 0,
      deletedBytes: 0,
    };
    for (const [relativePath, reference] of Object.entries(index.references)) {
      summary.indexedReferenceCount += 1;
      let targetPath;
      let valid = false;
      try {
        ({ targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: "媒体引用" }));
        const info = await lstat(targetPath);
        valid = info.isFile() && !info.isSymbolicLink() && await fileSha256(targetPath) === reference.objectHash;
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      }
      if (!valid) {
        staleReferencePaths.push(relativePath);
        summary.staleReferenceCount += 1;
        continue;
      }
      summary.validReferenceCount += 1;
      validReferencesByHash.set(reference.objectHash, (validReferencesByHash.get(reference.objectHash) || 0) + 1);
    }
    const visit = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        const candidate = join(directory, entry.name);
        if (!isInside(candidate, objectRoot)) throw new Error("媒体对象仓扫描路径越界");
        if (entry.isSymbolicLink()) throw new Error("媒体对象仓不能包含符号链接");
        if (entry.isDirectory()) {
          await visit(candidate);
          continue;
        }
        const objectHash = normalizeMediaObjectHash(entry.name.replace(/\.blob$/i, ""));
        if (!entry.isFile() || !objectHash || !/\.blob$/i.test(entry.name)) continue;
        const info = await stat(candidate);
        summary.objectCount += 1;
        summary.physicalBytes += Number(info.size || 0);
        if (await fileSha256(candidate) !== objectHash) summary.corruptedObjectCount += 1;
        if (validReferencesByHash.has(objectHash)) {
          summary.referencedObjectCount += 1;
          continue;
        }
        if (now - Number(info.mtimeMs || now) < Math.max(0, Number(minimumAgeMs) || 0)) continue;
        summary.reclaimableObjectCount += 1;
        summary.reclaimableBytes += Number(info.size || 0);
        if (prune) {
          await rm(candidate, { force: true });
          summary.deletedObjectCount += 1;
          summary.deletedBytes += Number(info.size || 0);
        }
      }
    };
    await visit(objectRoot);
    if (prune) {
      for (const relativePath of staleReferencePaths) delete index.references[relativePath];
      summary.prunedReferenceCount = staleReferencePaths.length;
      if (staleReferencePaths.length) await writeMediaReferenceIndex(workspaceRoot, index);
      await pruneEmptyDirectoryTree(objectRoot);
    }
    return summary;
  }));
};

const installMediaObject = async ({ workspaceRoot, temporaryPath, targetPath, hash }) => {
  return enqueueWorkspaceWrite(workspaceRoot, () => withWorkspaceFileLock(workspaceRoot, async () => {
    const objectHash = normalizeMediaObjectHash(hash);
    if (!objectHash) throw new Error("媒体对象哈希无效");
    const objectPath = mediaObjectPath(workspaceRoot, objectHash);
    const index = await readMediaReferenceIndex(workspaceRoot);
    await mkdir(dirname(objectPath), { recursive: true });
    let reused = false;
    let objectRepaired = false;
    let detachedLegacyHardlink = false;
    let objectInfo = await lstat(objectPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (objectInfo) {
      if (!objectInfo.isFile() || objectInfo.isSymbolicLink()) throw new Error("媒体对象仓包含非普通文件，已停止复用");
      if (await fileSha256(objectPath) !== objectHash) {
        await replaceFileFromCopy({ sourcePath: temporaryPath, targetPath: objectPath, expectedHash: objectHash });
        objectRepaired = true;
      } else {
        reused = true;
        detachedLegacyHardlink = await detachLegacyHardlink({ path: objectPath, expectedHash: objectHash });
      }
    } else {
      try {
        await copyFile(temporaryPath, objectPath, fsConstants.COPYFILE_EXCL);
        await syncCopiedFile(objectPath);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        objectInfo = await lstat(objectPath);
        if (!objectInfo.isFile() || objectInfo.isSymbolicLink() || await fileSha256(objectPath) !== objectHash) {
          throw new Error("媒体对象并发写入后校验失败，已停止保存");
        }
        reused = true;
      }
      if (await fileSha256(objectPath) !== objectHash) {
        await rm(objectPath, { force: true });
        throw new Error("媒体对象写入后的内容哈希不一致");
      }
    }
    const relativePath = normalizeManagedRelativePath(relative(workspaceRoot, targetPath).replaceAll("\\", "/"), { label: "媒体引用" });
    const previousReference = index.references[relativePath];
    const targetBeforeInstall = await lstat(targetPath).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    try {
      const temporaryInfo = await stat(temporaryPath);
      index.references[relativePath] = {
        objectHash,
        size: Number(temporaryInfo.size || 0),
        recordedAt: new Date().toISOString(),
      };
      await writeMediaReferenceIndex(workspaceRoot, index);
      const existingTarget = targetBeforeInstall;
      if (!existingTarget) {
        await renameWithTransientRetry(temporaryPath, targetPath);
      } else if (!existingTarget.isFile() || existingTarget.isSymbolicLink()) {
        throw new Error("可见附件目标不是普通文件，已停止覆盖");
      } else if (await fileSha256(targetPath) === objectHash) {
        await rm(temporaryPath, { force: true });
      } else {
        await replaceFileFromCopy({ sourcePath: temporaryPath, targetPath, expectedHash: objectHash });
        await rm(temporaryPath, { force: true });
      }
      if (await fileSha256(targetPath) !== objectHash) throw new Error("可见附件写入后的内容哈希不一致");
    } catch (error) {
      if (!targetBeforeInstall) await rm(targetPath, { force: true });
      if (previousReference) index.references[relativePath] = previousReference;
      else delete index.references[relativePath];
      await writeMediaReferenceIndex(workspaceRoot, index).catch(() => {});
      throw error;
    }
    return { objectPath, reused, objectRepaired, detachedLegacyHardlink, storageMode: "copy" };
  }));
};

const assertAttachmentCapacity = async ({ attachmentRoot, expectedBytes = 0, limitBytes }) => {
  const size = Number(expectedBytes) || 0;
  if (size < 0 || size > limitBytes) throw new Error(`单个附件超过当前 ${Math.floor(limitBytes / MIB)} MiB 上限`);
  await mkdir(attachmentRoot, { recursive: true });
  const policy = mediaStoragePolicy();
  const used = await directoryBytes(attachmentRoot);
  if (size && used + size > policy.workspaceMediaQuotaBytes) {
    const error = new Error("当前工作区媒体磁盘配额不足，请清理空间或更换保存目录后继续");
    error.code = "MEDIA_QUOTA_EXCEEDED";
    throw error;
  }
  const disk = await statfs(attachmentRoot, { bigint: true }).catch(() => null);
  if (disk && size) {
    const free = disk.bavail * disk.bsize;
    const peakWriteBytes = size * 2;
    if (free < BigInt(peakWriteBytes + policy.diskReserveBytes)) {
      const error = new Error("保存目录可用磁盘空间不足；厂商任务会被保留，可更换目录后继续下载");
      error.code = "MEDIA_DISK_FULL";
      throw error;
    }
  }
};

class HashAndLimitTransform extends Transform {
  constructor(limitBytes) {
    super();
    this.limitBytes = limitBytes;
    this.size = 0;
    this.hash = createHash("sha256");
  }

  _transform(chunk, _encoding, callback) {
    this.size += chunk.length;
    if (this.size > this.limitBytes) return callback(new Error(`单个附件超过当前 ${Math.floor(this.limitBytes / MIB)} MiB 上限`));
    this.hash.update(chunk);
    callback(null, chunk);
  }

  digest() {
    return this.hash.digest("hex");
  }
}

const detectedAttachmentMime = async (path, declaredMimeType, name) => {
  const handle = await open(path, "r");
  const header = Buffer.alloc(32);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(header, 0, header.length, 0));
  } finally {
    await handle.close();
  }
  const bytes = header.subarray(0, bytesRead);
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mimeType: "image/png", signature: "png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { mimeType: "image/jpeg", signature: "jpeg" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WAVE") return { mimeType: "audio/wav", signature: "wav" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { mimeType: "image/webp", signature: "webp" };
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return { mimeType: String(declaredMimeType).startsWith("video/") ? "video/ogg" : "audio/ogg", signature: "ogg" };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return { mimeType: String(declaredMimeType).startsWith("audio/") ? "audio/webm" : "video/webm", signature: "webm" };
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return { mimeType: String(declaredMimeType).startsWith("audio/") ? "audio/mp4" : "video/mp4", signature: "mp4" };
  if (bytes.subarray(0, 3).toString("ascii") === "ID3") return { mimeType: "audio/mpeg", signature: "mp3" };
  return { mimeType: attachmentMimeByExtension(name) || String(declaredMimeType || "application/octet-stream"), signature: "" };
};

const imageValidationError = (message) => Object.assign(new Error(message), { code: "IMAGE_VALIDATION_FAILED" });

const readFileSlice = async (handle, position, length) => {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
};

const PNG_CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

const pngChunkCrc32 = async (handle, position, length) => {
  let crc = 0xffffffff;
  let offset = 0;
  while (offset < length) {
    const chunk = await readFileSlice(handle, position + offset, Math.min(64 * 1024, length - offset));
    if (!chunk.length) throw imageValidationError("PNG 数据块被截断");
    for (const byte of chunk) crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    offset += chunk.length;
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const validatePngStructure = async (handle, size) => {
  if (size < 57) throw imageValidationError("PNG 文件过短");
  let position = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let sawIend = false;
  while (position + 12 <= size) {
    const header = await readFileSlice(handle, position, 8);
    if (header.length !== 8) throw imageValidationError("PNG 数据块头被截断");
    const chunkLength = header.readUInt32BE(0);
    const chunkType = header.subarray(4, 8).toString("ascii");
    const chunkEnd = position + 12 + chunkLength;
    if (!/^[A-Za-z]{4}$/.test(chunkType) || chunkEnd > size) throw imageValidationError("PNG 数据块边界无效");
    const storedCrc = await readFileSlice(handle, position + 8 + chunkLength, 4);
    if (storedCrc.length !== 4 || await pngChunkCrc32(handle, position + 4, 4 + chunkLength) !== storedCrc.readUInt32BE(0)) {
      throw imageValidationError(`PNG ${chunkType} 数据块校验失败`);
    }
    if (position === 8) {
      if (chunkType !== "IHDR" || chunkLength !== 13) throw imageValidationError("PNG 首个数据块不是有效 IHDR");
      const ihdr = await readFileSlice(handle, position + 8, 13);
      width = ihdr.readUInt32BE(0);
      height = ihdr.readUInt32BE(4);
      const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!width || !height || !allowedDepths[ihdr[9]]?.includes(ihdr[8]) || ihdr[10] !== 0 || ihdr[11] !== 0 || ![0, 1].includes(ihdr[12])) {
        throw imageValidationError("PNG IHDR 尺寸或编码参数无效");
      }
    } else if (chunkType === "IHDR") {
      throw imageValidationError("PNG 包含重复 IHDR");
    }
    if (chunkType === "IDAT" && chunkLength > 0) sawIdat = true;
    if (chunkType === "IEND") {
      if (chunkLength !== 0 || chunkEnd !== size) throw imageValidationError("PNG IEND 或文件尾边界无效");
      sawIend = true;
      break;
    }
    position = chunkEnd;
  }
  if (!sawIdat || !sawIend) throw imageValidationError("PNG 缺少图像数据或结束块");
  return { mimeType: "image/png", imageFormat: "png", imageWidth: width, imageHeight: height, imageValidation: "signature+chunks+crc" };
};

const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const validateJpegStructure = async (handle, size) => {
  if (size < 16) throw imageValidationError("JPEG 文件过短");
  const tail = await readFileSlice(handle, size - 2, 2);
  if (tail[0] !== 0xff || tail[1] !== 0xd9) throw imageValidationError("JPEG 缺少完整 EOI 结束标记");
  let position = 2;
  let width = 0;
  let height = 0;
  let sawScan = false;
  while (position < size - 2) {
    let prefix = await readFileSlice(handle, position, 1);
    if (prefix[0] !== 0xff) throw imageValidationError("JPEG 标记流无效");
    while (position < size - 2 && (await readFileSlice(handle, position, 1))[0] === 0xff) position += 1;
    const marker = (await readFileSlice(handle, position, 1))[0];
    position += 1;
    if (marker === undefined || marker === 0x00) throw imageValidationError("JPEG 标记被截断");
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const lengthBytes = await readFileSlice(handle, position, 2);
    if (lengthBytes.length !== 2) throw imageValidationError("JPEG 段长度被截断");
    const segmentLength = lengthBytes.readUInt16BE(0);
    if (segmentLength < 2 || position + segmentLength > size - 2) throw imageValidationError("JPEG 段边界无效");
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (segmentLength < 8) throw imageValidationError("JPEG SOF 段过短");
      const sof = await readFileSlice(handle, position + 2, 6);
      height = sof.readUInt16BE(1);
      width = sof.readUInt16BE(3);
      if (!width || !height || !sof[5]) throw imageValidationError("JPEG SOF 尺寸或分量无效");
    }
    if (marker === 0xda) {
      sawScan = true;
      if (position + segmentLength >= size - 2) throw imageValidationError("JPEG 缺少压缩扫描数据");
      break;
    }
    position += segmentLength;
  }
  if (!width || !height || !sawScan) throw imageValidationError("JPEG 缺少有效 SOF 或 SOS 图像结构");
  return { mimeType: "image/jpeg", imageFormat: "jpeg", imageWidth: width, imageHeight: height, imageValidation: "signature+segments+dimensions+eoi" };
};

const uint24le = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);

const validateWebpStructure = async (handle, size) => {
  if (size < 30) throw imageValidationError("WebP 文件过短");
  const header = await readFileSlice(handle, 0, 12);
  if (header.subarray(0, 4).toString("ascii") !== "RIFF" || header.subarray(8, 12).toString("ascii") !== "WEBP" || header.readUInt32LE(4) + 8 !== size) {
    throw imageValidationError("WebP RIFF 边界无效");
  }
  let position = 12;
  let width = 0;
  let height = 0;
  let sawImagePayload = false;
  while (position + 8 <= size) {
    const chunkHeader = await readFileSlice(handle, position, 8);
    const chunkType = chunkHeader.subarray(0, 4).toString("ascii");
    const chunkLength = chunkHeader.readUInt32LE(4);
    const paddedLength = chunkLength + (chunkLength & 1);
    if (position + 8 + paddedLength > size) throw imageValidationError("WebP 数据块边界无效");
    if (chunkType === "VP8X" && chunkLength >= 10) {
      const payload = await readFileSlice(handle, position + 8, 10);
      width = uint24le(payload, 4) + 1;
      height = uint24le(payload, 7) + 1;
    } else if (chunkType === "VP8 " && chunkLength >= 10) {
      const payload = await readFileSlice(handle, position + 8, 10);
      if (!payload.subarray(3, 6).equals(Buffer.from([0x9d, 0x01, 0x2a]))) throw imageValidationError("WebP VP8 帧头无效");
      width ||= payload.readUInt16LE(6) & 0x3fff;
      height ||= payload.readUInt16LE(8) & 0x3fff;
      sawImagePayload = true;
    } else if (chunkType === "VP8L" && chunkLength >= 5) {
      const payload = await readFileSlice(handle, position + 8, 5);
      if (payload[0] !== 0x2f) throw imageValidationError("WebP VP8L 帧头无效");
      const dimensions = payload.readUInt32LE(1);
      width ||= (dimensions & 0x3fff) + 1;
      height ||= ((dimensions >>> 14) & 0x3fff) + 1;
      sawImagePayload = true;
    }
    position += 8 + paddedLength;
  }
  if (position !== size || !sawImagePayload || !width || !height) throw imageValidationError("WebP 缺少完整图像负载或有效尺寸");
  return { mimeType: "image/webp", imageFormat: "webp", imageWidth: width, imageHeight: height, imageValidation: "signature+riff+dimensions" };
};

const validateGeneratedImage = async (path, detected, declaredMimeType) => {
  const declared = String(declaredMimeType || "").split(";", 1)[0].trim().toLowerCase();
  if (!declared.startsWith("image/")) throw imageValidationError("生成结果声明的 MIME 不是图片");
  const file = await stat(path);
  const handle = await open(path, "r");
  try {
    const metadata = detected.signature === "png"
      ? await validatePngStructure(handle, file.size)
      : detected.signature === "jpeg"
        ? await validateJpegStructure(handle, file.size)
        : detected.signature === "webp"
          ? await validateWebpStructure(handle, file.size)
          : null;
    if (!metadata) throw imageValidationError("生成图片未通过受支持的 PNG、JPEG 或 WebP 签名识别");
    if (metadata.mimeType !== declared) throw imageValidationError(`生成图片声明为 ${declared}，实际结构为 ${metadata.mimeType}`);
    return metadata;
  } finally {
    await handle.close();
  }
};

const FFPROBE_CAPTURE_LIMIT_BYTES = 2 * MIB;
const emptyMediaMetadata = (probeErrorCode = "", probeError = "") => ({
  durationMs: null,
  videoDurationMs: null,
  videoWidth: null,
  videoHeight: null,
  videoCodec: "",
  videoFrameRate: null,
  audioCodec: "",
  videoFrameCount: null,
  videoFrameCountDeclared: null,
  videoFrameCountRead: null,
  probeErrorCode,
  probeError,
});

const ffprobePrefixArgs = () => {
  const encoded = String(process.env.SHENSI_FFPROBE_PREFIX_ARGS || "").trim();
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(encoded);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string") ? parsed : [];
  } catch {
    return [];
  }
};

const bundledFfprobePath = (appRoot = process.cwd()) => {
  const executableName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const candidates = [
    join(dirname(dirname(process.execPath)), "resources", "ffmpeg", executableName),
    join(dirname(process.execPath), "resources", "ffmpeg", executableName),
    join(resolve(appRoot), "resources", "ffmpeg", executableName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
};

const ffprobeLaunch = (appRoot = process.cwd()) => {
  const configured = String(process.env.SHENSI_FFPROBE_PATH || "").trim();
  return {
    executable: configured || bundledFfprobePath(appRoot) || "ffprobe",
    prefixArgs: configured ? ffprobePrefixArgs() : [],
  };
};

const bundledFfmpegPath = (appRoot = process.cwd()) => {
  const executableName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const candidates = [
    join(dirname(dirname(process.execPath)), "resources", "ffmpeg", executableName),
    join(dirname(process.execPath), "resources", "ffmpeg", executableName),
    join(resolve(appRoot), "resources", "ffmpeg", executableName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) || "";
};

const ffmpegLaunch = (appRoot = process.cwd()) => {
  const configured = String(process.env.SHENSI_FFMPEG_PATH || "").trim();
  let prefixArgs = [];
  if (configured) {
    try {
      const parsed = JSON.parse(String(process.env.SHENSI_FFMPEG_PREFIX_ARGS || "[]"));
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) prefixArgs = parsed;
    } catch {
      prefixArgs = [];
    }
  }
  return {
    executable: configured || bundledFfmpegPath(appRoot) || "ffmpeg",
    prefixArgs,
  };
};

const createVideoThumbnail = async ({ appRoot = process.cwd(), workspaceRoot, sourcePath, hash }) => {
  const previewDirectory = join(workspaceRoot, "附件", ".thumbnails");
  const relativePath = join("附件", ".thumbnails", `${hash}.jpg`).replaceAll("\\", "/");
  const targetPath = join(previewDirectory, `${hash}.jpg`);
  const existing = await stat(targetPath).catch(() => null);
  if (existing?.isFile() && existing.size > 2 && existing.size <= 5 * MIB) {
    return { thumbnailRelativePath: relativePath, thumbnailMimeType: "image/jpeg" };
  }
  await mkdir(previewDirectory, { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  const launch = ffmpegLaunch(appRoot);
  try {
    await new Promise((resolveThumbnail, rejectThumbnail) => {
      const child = spawn(launch.executable, [...launch.prefixArgs,
        "-hide_banner",
        "-loglevel", "error",
        "-ss", "0.05",
        "-i", sourcePath,
        "-frames:v", "1",
        "-vf", "thumbnail,scale='min(640,iw)':-2",
        "-q:v", "3",
        "-f", "image2",
        "-y",
        temporaryPath,
      ], {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let settled = false;
      let timer = null;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) rejectThumbnail(error);
        else resolveThumbnail();
      };
      child.stderr.on("data", (chunk) => {
        if (stderr.length < 16_000) stderr += chunk.toString("utf8");
      });
      child.once("error", finish);
      child.once("close", (code) => {
        if (code !== 0) finish(new Error(`FFmpeg 缩略图生成失败（退出码 ${code ?? "unknown"}）：${stderr.slice(0, 500)}`));
        else finish();
      });
      timer = setTimeout(() => {
        child.kill();
        finish(new Error("FFmpeg 缩略图生成超时"));
      }, 60_000);
    });
    const metadata = await stat(temporaryPath);
    if (!metadata.isFile() || metadata.size < 3 || metadata.size > 5 * MIB) throw new Error("视频缩略图文件无效");
    const signature = await readFile(temporaryPath);
    if (signature[0] !== 0xff || signature[1] !== 0xd8) throw new Error("视频缩略图不是有效 JPEG");
    const handle = await open(temporaryPath, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(temporaryPath, targetPath).catch(async (error) => {
      const raced = await stat(targetPath).catch(() => null);
      if (!raced?.isFile() || !raced.size) throw error;
      await rm(temporaryPath, { force: true });
    });
    return { thumbnailRelativePath: relativePath, thumbnailMimeType: "image/jpeg" };
  } catch {
    await rm(temporaryPath, { force: true }).catch(() => {});
    return {};
  }
};

const ffprobeError = (message, code, detail = "") => {
  const error = new Error(message);
  error.code = code;
  if (detail) error.detail = detail.slice(0, 2000);
  return error;
};

const runFfprobe = ({ appRoot = process.cwd(), args, timeoutMs }) => new Promise((resolveProbe, rejectProbe) => {
  const launch = ffprobeLaunch(appRoot);
  let child;
  try {
    child = spawn(launch.executable, [...launch.prefixArgs, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    rejectProbe(ffprobeError(`无法启动 FFprobe：${error.message}`, "FFPROBE_UNAVAILABLE"));
    return;
  }
  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let timer = null;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectProbe(error);
    else resolveProbe(result);
  };
  const append = (current, chunk) => {
    const next = current + chunk.toString("utf8");
    if (Buffer.byteLength(next) > FFPROBE_CAPTURE_LIMIT_BYTES) {
      child.kill();
      finish(ffprobeError("FFprobe 输出超过安全上限", "FFPROBE_OUTPUT_TOO_LARGE"));
      return current;
    }
    return next;
  };
  child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
  child.once("error", (error) => finish(ffprobeError(`无法启动 FFprobe：${error.message}`, "FFPROBE_UNAVAILABLE")));
  child.once("close", (code, signal) => {
    if (timedOut) return finish(ffprobeError(`FFprobe 在 ${Math.ceil(timeoutMs / 1000)} 秒内未完成`, "FFPROBE_TIMEOUT", stderr));
    if (code !== 0) return finish(ffprobeError(`FFprobe 校验失败（退出码 ${code ?? "unknown"}${signal ? `，信号 ${signal}` : ""}）`, "FFPROBE_EXIT_NONZERO", stderr));
    finish(null, { stdout, stderr, executable: launch.executable });
  });
  timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
});

const ffprobeValidationCache = new Map();
const FFPROBE_VALIDATION_CACHE_MS = Math.max(
  5_000,
  Number(process.env.SHENSI_FFPROBE_VALIDATION_CACHE_MS) || 5 * 60_000,
);

export const probeVideoValidationRuntime = async ({ appRoot = process.cwd(), timeoutMs = 20_000, forceFresh = false } = {}) => {
  const launch = ffprobeLaunch(appRoot);
  const cacheKey = JSON.stringify([
    resolve(appRoot),
    launch.executable,
    launch.prefixArgs,
  ]);
  const cached = ffprobeValidationCache.get(cacheKey);
  if (!forceFresh && cached?.promise) return cached.promise;
  if (!forceFresh && cached?.result && Date.now() - cached.checkedAt < FFPROBE_VALIDATION_CACHE_MS) return cached.result;
  const operation = (async () => {
    try {
      const result = await runFfprobe({ appRoot, args: ["-version"], timeoutMs: Math.max(500, Number(timeoutMs) || 20_000) });
      const firstLine = String(result.stdout || result.stderr).split(/\r?\n/).find(Boolean) || "";
      if (!/ffprobe\s+version/i.test(firstLine)) throw ffprobeError("可执行文件未返回 FFprobe 身份信息", "FFPROBE_IDENTITY_INVALID", firstLine);
      return { available: true, executable: result.executable, version: firstLine.slice(0, 240), code: "" };
    } catch (error) {
      return {
        available: false,
        executable: launch.executable,
        version: "",
        code: String(error.code || "FFPROBE_UNAVAILABLE"),
        message: String(error.message || error).slice(0, 500),
      };
    }
  })();
  ffprobeValidationCache.set(cacheKey, { promise: operation, checkedAt: 0 });
  const result = await operation;
  ffprobeValidationCache.set(cacheKey, { result, checkedAt: Date.now() });
  return result;
};

const probeMediaMetadata = async (path, mimeType, appRoot = process.cwd(), { fullVideoScan = false } = {}) => {
  if (!/^(?:audio|video)\//.test(mimeType)) return emptyMediaMetadata();
  const file = await stat(path).catch(() => null);
  const defaultTimeoutMs = Math.min(10 * 60_000, Math.max(30_000, Math.ceil(Number(file?.size || 0) / (8 * MIB)) * 1000));
  const configuredTimeoutMs = Number(process.env.SHENSI_FFPROBE_VALIDATION_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0 ? configuredTimeoutMs : defaultTimeoutMs;
  let result;
  try {
    result = await runFfprobe({
      appRoot,
      args: [
        "-v", "error",
        ...(fullVideoScan && String(mimeType).startsWith("video/") ? ["-count_frames"] : []),
        "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,duration,avg_frame_rate,nb_read_frames,nb_frames",
        "-of", "json",
        path,
      ],
      timeoutMs,
    });
  } catch (error) {
    return emptyMediaMetadata(String(error.code || "FFPROBE_FAILED"), String(error.message || error));
  }
  try {
    const payload = JSON.parse(result.stdout || "{}");
    const streams = Array.isArray(payload.streams) ? payload.streams : [];
    const video = streams.find((stream) => stream.codec_type === "video");
    const audio = streams.find((stream) => stream.codec_type === "audio");
    const formatSeconds = Number(payload.format?.duration);
    const streamSeconds = Math.max(0, ...streams.map((stream) => Number(stream.duration)).filter(Number.isFinite));
    const seconds = Number.isFinite(formatSeconds) && formatSeconds > 0 ? formatSeconds : streamSeconds;
    const videoSeconds = Number(video?.duration);
    const [frameRateNumerator, frameRateDenominator] = String(video?.avg_frame_rate || "").split("/").map(Number);
    const videoFrameRate = Number.isFinite(frameRateNumerator) && Number.isFinite(frameRateDenominator) && frameRateDenominator > 0
      ? frameRateNumerator / frameRateDenominator
      : null;
    const declaredFrameCount = Number(video?.nb_frames);
    const readFrameCount = Number(video?.nb_read_frames);
    const frameCount = Number.isFinite(readFrameCount) && readFrameCount > 0 ? readFrameCount : declaredFrameCount;
    const probeError = String(result.stderr || "").trim();
    return {
      durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null,
      videoDurationMs: Number.isFinite(videoSeconds) && videoSeconds > 0 ? Math.round(videoSeconds * 1000) : null,
      videoWidth: Number(video?.width) > 0 ? Number(video.width) : null,
      videoHeight: Number(video?.height) > 0 ? Number(video.height) : null,
      videoCodec: String(video?.codec_name || ""),
      videoFrameRate: Number.isFinite(videoFrameRate) && videoFrameRate > 0 ? videoFrameRate : null,
      audioCodec: String(audio?.codec_name || ""),
      videoFrameCount: Number.isFinite(frameCount) && frameCount > 0 ? frameCount : null,
      videoFrameCountDeclared: Number.isFinite(declaredFrameCount) && declaredFrameCount > 0 ? declaredFrameCount : null,
      videoFrameCountRead: Number.isFinite(readFrameCount) && readFrameCount > 0 ? readFrameCount : null,
      probeErrorCode: fullVideoScan && probeError ? "FFPROBE_MEDIA_ERROR" : "",
      probeError: fullVideoScan && probeError ? probeError.slice(0, 2_000) : "",
    };
  } catch (error) {
    return emptyMediaMetadata("FFPROBE_OUTPUT_INVALID", `无法解析 FFprobe 输出：${error.message}`);
  }
};

export const saveWorkspaceAttachmentFromStream = async ({ appRoot, requestedPath, name, mimeType, stream, expectedBytes = 0, expectedDurationMs = 0, requirePlayableMedia = false, requireValidImage = false, stableName = false, mediaBatchId = "", whiteboardDocumentId = "", whiteboardMediaKind = "" }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const destination = await attachmentDestination(workspaceRoot, name, { stableName, mediaBatchId, whiteboardDocumentId, whiteboardMediaKind });
  const declaredMimeType = String(mimeType || attachmentMimeByExtension(name) || "application/octet-stream");
  const limitBytes = attachmentFileLimit(declaredMimeType);
  await assertAttachmentCapacity({ attachmentRoot: destination.attachmentRoot, expectedBytes, limitBytes });
  const temporaryPath = `${destination.targetPath}.${process.pid}.${randomUUID()}.upload`;
  const meter = new HashAndLimitTransform(limitBytes);
  try {
    await pipeline(stream, meter, createWriteStream(temporaryPath, { flags: "wx" }));
    if (!meter.size) throw new Error("附件内容为空");
    const declaredBytes = Math.max(0, Number(expectedBytes) || 0);
    if (declaredBytes && meter.size !== declaredBytes) {
      const error = new Error(`媒体下载不完整：响应声明 ${declaredBytes} 字节，实际只收到 ${meter.size} 字节，已拒绝落盘`);
      error.code = "MEDIA_DOWNLOAD_TRUNCATED";
      error.expectedBytes = declaredBytes;
      error.actualBytes = meter.size;
      throw error;
    }
    const handle = await open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const detected = await detectedAttachmentMime(temporaryPath, declaredMimeType, destination.safeFile);
    const imageMetadata = requireValidImage
      ? await validateGeneratedImage(temporaryPath, detected, declaredMimeType)
      : { imageWidth: null, imageHeight: null, imageFormat: "", imageValidation: "" };
    const resolvedMimeType = imageMetadata.mimeType || detected.mimeType;
    const mediaMetadata = await probeMediaMetadata(temporaryPath, resolvedMimeType, appRoot, { fullVideoScan: requirePlayableMedia });
    if (requirePlayableMedia && String(declaredMimeType).startsWith("video/")) {
      if (mediaMetadata.probeErrorCode) {
        const error = new Error(mediaMetadata.probeError || "FFprobe 无法完成视频校验");
        error.code = mediaMetadata.probeErrorCode;
        throw error;
      }
      const validContainer = ["mp4", "webm", "ogg"].includes(detected.signature);
      const validVideoStream = mediaMetadata.durationMs > 0
        && mediaMetadata.videoWidth > 0
        && mediaMetadata.videoHeight > 0
        && mediaMetadata.videoFrameCount > 0
        && Boolean(mediaMetadata.videoCodec);
      const frameScanComplete = !mediaMetadata.videoFrameCountDeclared
        || !mediaMetadata.videoFrameCountRead
        || mediaMetadata.videoFrameCountRead === mediaMetadata.videoFrameCountDeclared;
      if (mediaMetadata.probeErrorCode || !validContainer || !resolvedMimeType.startsWith("video/") || !validVideoStream || !frameScanComplete) {
        const error = new Error("视频结果未通过完整文件校验（容器、视频流、帧计数、时长或画面尺寸无效），已拒绝标记完成");
        error.code = "MEDIA_VALIDATION_FAILED";
        if (mediaMetadata.probeError) error.detail = mediaMetadata.probeError.slice(0, 2_000);
        if (!frameScanComplete) {
          error.expectedFrameCount = mediaMetadata.videoFrameCountDeclared;
          error.actualFrameCount = mediaMetadata.videoFrameCountRead;
        }
        throw error;
      }
      const requestedDurationMs = Math.max(0, Number(expectedDurationMs) || 0);
      if (requestedDurationMs) {
        const durationToleranceMs = Math.max(750, Math.min(2_000, Math.round(requestedDurationMs * 0.1)));
        const minimumDurationMs = Math.max(1_000, requestedDurationMs - durationToleranceMs);
        if (mediaMetadata.durationMs < minimumDurationMs) {
          const error = new Error(`视频结果不完整：请求约 ${(requestedDurationMs / 1000).toFixed(1)} 秒，实际只有 ${(mediaMetadata.durationMs / 1000).toFixed(1)} 秒，已保留厂商任务但拒绝标记完成`);
          error.code = "MEDIA_DURATION_INCOMPLETE";
          error.expectedDurationMs = requestedDurationMs;
          error.minimumDurationMs = minimumDurationMs;
          error.actualDurationMs = mediaMetadata.durationMs;
          throw error;
        }
      }
    }
    const sha256 = meter.digest();
    const installed = await installMediaObject({
      workspaceRoot,
      temporaryPath,
      targetPath: destination.targetPath,
      hash: sha256,
    });
    const thumbnail = resolvedMimeType.startsWith("video/")
      ? await createVideoThumbnail({ appRoot, workspaceRoot, sourcePath: destination.targetPath, hash: sha256 })
      : {};
    const directoryHandle = await open(destination.attachmentRoot, "r").catch(() => null);
    if (directoryHandle) {
      try { await directoryHandle.sync().catch(() => {}); } finally { await directoryHandle.close(); }
    }
    let extracted = { extractionStatus: "preserved", text: "", extractionError: "" };
    if (!/^(?:image|video|audio)\//.test(resolvedMimeType) && meter.size <= 16 * MIB) {
      const bytes = await readFile(destination.targetPath);
      extracted = extractDocumentText({ bytes, name: destination.safeFile, mimeType: resolvedMimeType });
    }
    // Persist the successful storage event on the attachment itself. Callers
    // may use a later domain event (for example, generation completion) as the
    // asset's canonical time, but a restart must never invent an upload time.
    const storedAt = new Date().toISOString();
    return {
      name: destination.safeFile,
      mimeType: resolvedMimeType,
      size: meter.size,
      sha256,
      objectHash: sha256,
      storageMode: installed.storageMode,
      deduplicated: installed.reused,
      objectRepaired: installed.objectRepaired,
      detachedLegacyHardlink: installed.detachedLegacyHardlink,
      durationMs: mediaMetadata.durationMs,
      videoWidth: mediaMetadata.videoWidth,
      videoHeight: mediaMetadata.videoHeight,
      videoCodec: mediaMetadata.videoCodec,
      videoFrameCount: mediaMetadata.videoFrameCount,
      videoFrameCountDeclared: mediaMetadata.videoFrameCountDeclared,
      videoFrameCountRead: mediaMetadata.videoFrameCountRead,
      audioCodec: mediaMetadata.audioCodec,
      ...thumbnail,
      imageWidth: imageMetadata.imageWidth,
      imageHeight: imageMetadata.imageHeight,
      imageFormat: imageMetadata.imageFormat,
      imageValidation: imageMetadata.imageValidation,
      relativePath: destination.relativePath.replaceAll("\\", "/"),
      createdAt: storedAt,
      uploadedAt: storedAt,
      sourceEventAt: storedAt,
      extractionStatus: extracted.extractionStatus,
      extractedCharacters: extracted.text.length,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
};

export const saveWorkspaceAttachmentFromPath = async ({ appRoot, requestedPath, sourcePath, name, mimeType, expectedDurationMs = 0, requirePlayableMedia = false, requireValidImage = false, stableName = false, mediaBatchId = "", whiteboardDocumentId = "", whiteboardMediaKind = "" }) => {
  const source = await stat(sourcePath);
  if (!source.isFile()) throw new Error("生成结果不是可读取文件");
  return saveWorkspaceAttachmentFromStream({
    appRoot,
    requestedPath,
    name: name || basename(sourcePath),
    mimeType: mimeType || attachmentMimeByExtension(sourcePath) || "application/octet-stream",
    stream: createReadStream(sourcePath),
    expectedBytes: source.size,
    expectedDurationMs,
    requirePlayableMedia,
    requireValidImage,
    stableName,
    mediaBatchId,
    whiteboardDocumentId,
    whiteboardMediaKind,
  });
};

const VIDEO_FRAME_POSITIONS = new Set(["first", "last", "current"]);

const videoFrameError = (message, code = "VIDEO_FRAME_EXTRACTION_FAILED") => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
};

const runVideoFrameExtraction = ({ appRoot, sourcePath, outputPath, frameTimeMs }) => new Promise((resolveFrame, rejectFrame) => {
  const launch = ffmpegLaunch(appRoot);
  let child;
  try {
    child = spawn(launch.executable, [...launch.prefixArgs,
      "-hide_banner",
      "-loglevel", "error",
      "-ss", (Math.max(0, frameTimeMs) / 1000).toFixed(3),
      "-i", sourcePath,
      "-map", "0:v:0",
      "-frames:v", "1",
      "-vf", "scale='min(1920,iw)':-2",
      "-c:v", "png",
      "-f", "image2",
      "-y",
      outputPath,
    ], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    rejectFrame(videoFrameError(`无法启动 FFmpeg：${error.message}`, "FFMPEG_UNAVAILABLE"));
    return;
  }
  let stderr = "";
  let settled = false;
  let timer = null;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) rejectFrame(error);
    else resolveFrame();
  };
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 16_000) stderr += chunk.toString("utf8");
  });
  child.once("error", (error) => finish(videoFrameError(`FFmpeg 提取关键帧失败：${error.message}`, "FFMPEG_UNAVAILABLE")));
  child.once("close", (code) => {
    if (code !== 0) finish(videoFrameError(`FFmpeg 提取关键帧失败（退出码 ${code ?? "unknown"}）：${stderr.slice(0, 500)}`, "VIDEO_FRAME_FFMPEG_FAILED"));
    else finish();
  });
  timer = setTimeout(() => {
    child.kill();
    finish(videoFrameError("FFmpeg 提取关键帧超时", "VIDEO_FRAME_TIMEOUT"));
  }, 120_000);
});

const videoFrameAttemptTimes = ({ frameTimeMs, frameIntervalMs = 0, position = "current", videoDurationMs = 0 } = {}) => {
  const initial = Math.max(0, Math.round(Number(frameTimeMs) || 0));
  const nearestFrameStep = Math.max(16, Math.ceil(Number(frameIntervalMs) || 40));
  const durationFallback = position === "last"
    ? Math.max(1_500, Math.min(5_000, Math.round((Number(videoDurationMs) || initial) * 0.05)))
    : 1_500;
  const offsets = [0, nearestFrameStep, nearestFrameStep * 2, 250, 500, 1_000, durationFallback];
  return [...new Set(offsets.map((offset) => Math.max(0, initial - offset)))];
};

const completeExtractedFrame = async (path) => {
  const output = await stat(path).catch(() => null);
  return Boolean(output?.isFile() && output.size >= 57);
};

export const extractWorkspaceVideoFrame = async ({ appRoot = process.cwd(), requestedPath, relativePath, position = "current", currentTimeMs = 0 }) => {
  const normalizedPosition = String(position || "current").trim().toLowerCase();
  if (!VIDEO_FRAME_POSITIONS.has(normalizedPosition)) throw videoFrameError("关键帧位置无效");
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const { targetPath: sourcePath } = await secureManagedTarget(workspaceRoot, relativePath, { label: "视频附件" });
  const sourceInfo = await lstat(sourcePath).catch((error) => {
    if (error.code === "ENOENT") throw videoFrameError("找不到需要提取关键帧的视频", "VIDEO_FRAME_SOURCE_MISSING");
    throw error;
  });
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw videoFrameError("关键帧来源必须是工作区内的普通视频文件", "VIDEO_FRAME_SOURCE_INVALID");
  const declaredMimeType = attachmentMimeByExtension(sourcePath) || "application/octet-stream";
  const detected = await detectedAttachmentMime(sourcePath, declaredMimeType, basename(sourcePath));
  if (!String(detected.mimeType).startsWith("video/") || !["mp4", "webm", "ogg"].includes(detected.signature)) {
    throw videoFrameError("所选附件不是可验证的视频文件", "VIDEO_FRAME_SOURCE_INVALID");
  }
  const metadata = await probeMediaMetadata(sourcePath, detected.mimeType, appRoot);
  if (metadata.probeErrorCode) throw videoFrameError(metadata.probeError || "无法读取视频信息", metadata.probeErrorCode);
  const durationMs = Math.max(0, Number(metadata.durationMs) || 0);
  const videoDurationMs = Math.max(0, Number(metadata.videoDurationMs) || durationMs);
  if (!durationMs || !(Number(metadata.videoWidth) > 0) || !(Number(metadata.videoHeight) > 0) || !metadata.videoCodec) {
    throw videoFrameError("视频缺少可读取的画面流或有效时长", "VIDEO_FRAME_SOURCE_INVALID");
  }
  const frameIntervalMs = Number(metadata.videoFrameRate) > 0
    ? 1_000 / Number(metadata.videoFrameRate)
    : Number(metadata.videoFrameCount) > 0
      ? videoDurationMs / Number(metadata.videoFrameCount)
      : 0;
  const endSafetyMs = Math.max(50, Math.min(1_000, Math.ceil(frameIntervalMs || 0)));
  const maximumFrameTimeMs = Math.max(0, videoDurationMs - endSafetyMs);
  const requestedCurrentTimeMs = Number(currentTimeMs);
  const frameTimeMs = normalizedPosition === "first"
    ? 0
    : normalizedPosition === "last"
      ? maximumFrameTimeMs
      : Math.min(maximumFrameTimeMs, Math.max(0, Number.isFinite(requestedCurrentTimeMs) ? Math.round(requestedCurrentTimeMs) : 0));
  const temporaryDirectory = join(resolveWorkspaceInternalRoot(workspaceRoot), "temporary", "video-frames");
  await mkdir(temporaryDirectory, { recursive: true });
  const temporaryPath = join(temporaryDirectory, `${process.pid}-${randomUUID()}.png`);
  const label = normalizedPosition === "first" ? "首帧" : normalizedPosition === "last" ? "尾帧" : "当前帧";
  const sourceName = safeName(basename(sourcePath, extname(sourcePath)) || "视频");
  try {
    let extractedFrameTimeMs = null;
    let lastExtractionError = null;
    for (const attemptTimeMs of videoFrameAttemptTimes({ frameTimeMs, frameIntervalMs, position: normalizedPosition, videoDurationMs })) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      try {
        await runVideoFrameExtraction({ appRoot, sourcePath, outputPath: temporaryPath, frameTimeMs: attemptTimeMs });
      } catch (error) {
        lastExtractionError = error;
        if (["FFMPEG_UNAVAILABLE", "VIDEO_FRAME_TIMEOUT"].includes(error?.code)) throw error;
        continue;
      }
      if (await completeExtractedFrame(temporaryPath)) {
        extractedFrameTimeMs = attemptTimeMs;
        break;
      }
    }
    if (!Number.isFinite(extractedFrameTimeMs)) {
      throw videoFrameError(`FFmpeg 在当前时间附近未找到可读取的视频帧${lastExtractionError?.message ? `：${lastExtractionError.message}` : ""}`, "VIDEO_FRAME_OUTPUT_INVALID");
    }
    const attachment = await saveWorkspaceAttachmentFromPath({
      appRoot,
      requestedPath,
      sourcePath: temporaryPath,
      name: `${sourceName}-${label}.png`,
      mimeType: "image/png",
      requireValidImage: true,
    });
    return {
      attachment,
      position: normalizedPosition,
      frameTimeMs: extractedFrameTimeMs,
      requestedFrameTimeMs: frameTimeMs,
      sourceDurationMs: videoDurationMs,
      aspectRatio: Number(metadata.videoWidth) / Math.max(1, Number(metadata.videoHeight)),
    };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
};

const runWorkspaceVideoConcat = ({ appRoot, listPath, outputPath }) => new Promise((resolveConcat, rejectConcat) => {
  const launch = ffmpegLaunch(appRoot);
  let child;
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-map", "0:v:0", "-map", "0:a?",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-c:a", "aac", "-movflags", "+faststart", "-y", outputPath,
  ];
  try {
    child = spawn(launch.executable, [...launch.prefixArgs, ...args], {
      shell: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    rejectConcat(videoFrameError(`无法启动 FFmpeg：${error.message}`, "FFMPEG_UNAVAILABLE"));
    return;
  }
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    child.kill();
    if (!settled) {
      settled = true;
      rejectConcat(videoFrameError("超长视频拼接超时", "VIDEO_CONCAT_TIMEOUT"));
    }
  }, 30 * 60_000);
  child.stderr.on("data", (chunk) => { if (stderr.length < 32_000) stderr += chunk.toString("utf8"); });
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectConcat(videoFrameError(`FFmpeg 拼接失败：${error.message}`, "FFMPEG_UNAVAILABLE"));
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) rejectConcat(videoFrameError(`FFmpeg 拼接失败（退出码 ${code ?? "unknown"}）：${stderr.slice(0, 1000)}`, "VIDEO_CONCAT_FAILED"));
    else resolveConcat();
  });
});

export const concatWorkspaceVideos = async ({ appRoot = process.cwd(), requestedPath, relativePaths = [], name = "超长视频.mp4" } = {}) => {
  if (!Array.isArray(relativePaths) || relativePaths.length < 2 || relativePaths.length > 100) {
    throw videoFrameError("超长视频拼接必须包含 2—100 个分段", "VIDEO_CONCAT_INPUT_INVALID");
  }
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const sources = [];
  for (const relativePath of relativePaths) {
    const { targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: "视频分段" });
    const info = await lstat(targetPath).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) throw videoFrameError("超长视频分段不存在或不是普通文件", "VIDEO_CONCAT_SOURCE_INVALID");
    const detected = await detectedAttachmentMime(targetPath, attachmentMimeByExtension(targetPath), basename(targetPath));
    if (!String(detected.mimeType).startsWith("video/")) throw videoFrameError("超长视频分段包含非视频文件", "VIDEO_CONCAT_SOURCE_INVALID");
    sources.push(targetPath);
  }
  const temporaryDirectory = join(resolveWorkspaceInternalRoot(workspaceRoot), "temporary", "video-concat");
  await mkdir(temporaryDirectory, { recursive: true });
  const operationId = `${process.pid}-${randomUUID()}`;
  const listPath = join(temporaryDirectory, `${operationId}.txt`);
  const outputPath = join(temporaryDirectory, `${operationId}.mp4`);
  const ffmpegListPath = (value) => resolve(value).replaceAll("\\", "/").replaceAll("'", "'\\''");
  try {
    await writeFile(listPath, sources.map((path) => `file '${ffmpegListPath(path)}'`).join("\n"), "utf8");
    await runWorkspaceVideoConcat({ appRoot, listPath, outputPath });
    const attachment = await saveWorkspaceAttachmentFromPath({
      appRoot,
      requestedPath,
      sourcePath: outputPath,
      name: String(name || "超长视频.mp4").toLowerCase().endsWith(".mp4") ? name : `${name}.mp4`,
      mimeType: "video/mp4",
      requirePlayableMedia: true,
    });
    return { attachment, segmentCount: sources.length };
  } finally {
    await rm(listPath, { force: true }).catch(() => {});
    await rm(outputPath, { force: true }).catch(() => {});
  }
};

export const saveWorkspaceAttachment = async ({ appRoot, requestedPath, name, mimeType, base64, requireValidImage = false, stableName = false, mediaBatchId = "", whiteboardDocumentId = "", whiteboardMediaKind = "" }) => {
  const bytes = Buffer.from(String(base64 ?? ""), "base64");
  if (!bytes.length) throw new Error("附件内容为空");
  return saveWorkspaceAttachmentFromStream({ appRoot, requestedPath, name, mimeType, stream: (await import("node:stream")).Readable.from(bytes), expectedBytes: bytes.length, requireValidImage, stableName, mediaBatchId, whiteboardDocumentId, whiteboardMediaKind });
};

export const copyWorkspaceAttachment = async ({ appRoot, sourceRequestedPath, targetRequestedPath, relativePath: sourceRelativePath, name, mimeType }) => {
  const sourceRoot = resolveWorkspaceRoot({ appRoot, requestedPath: sourceRequestedPath });
  const { targetPath: sourcePath } = await secureManagedTarget(sourceRoot, sourceRelativePath, { label: "源附件" });
  const requestedName = String(name || basename(sourceRelativePath) || "附件").trim() || "附件";
  const sourceExtension = extname(String(sourceRelativePath || sourcePath));
  const targetName = sourceExtension && !extname(requestedName) ? `${requestedName}${sourceExtension}` : requestedName;
  return saveWorkspaceAttachmentFromPath({
    appRoot,
    requestedPath: targetRequestedPath,
    sourcePath,
    name: targetName,
    mimeType,
  });
};

export const readWorkspaceAttachments = async ({ appRoot, requestedPath, attachments = [] }) => {
  if (attachments.length > MAX_MODEL_MEDIA_REFERENCES) {
    throw new Error(`本轮附件共 ${attachments.length} 项，当前生成链路最多承载 ${MAX_MODEL_MEDIA_REFERENCES} 项；请减少参考后重试`);
  }
  // An empty attachment list grants no filesystem read. In particular, do not
  // feed a virtual/external notebook URI through the managed-workspace write
  // boundary merely because a chat request happens to carry that workspace id.
  if (!attachments.length) return [];
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const result = [];
  const referencePolicy = mediaModelReferencePolicy();
  let inlineBytes = 0;
  for (const item of attachments) {
    const { targetPath: target } = await secureManagedTarget(workspaceRoot, item.relativePath, { label: "附件" });
    const metadata = await stat(target);
    if (!metadata.isFile() || !metadata.size) throw new Error(`${item.name || "附件"} 为空`);
    const mimeType = item.mimeType || attachmentMimeByExtension(item.relativePath) || "application/octet-stream";
    const binaryMedia = /^(?:video|audio)\//.test(mimeType);
    let bytes = null;
    let extracted = { text: "", extractionStatus: binaryMedia ? "preserved" : "unavailable", extractionError: "" };
    if (!binaryMedia) {
      const inlineLimit = String(mimeType).startsWith("image/") ? referencePolicy.imageFileLimitBytes : 50 * MIB;
      if (metadata.size > inlineLimit) throw new Error(`${item.name || "附件"} 超过当前模型内联读取上限`);
      if (inlineBytes + metadata.size > referencePolicy.totalInlineBytes) {
        throw new Error(`本轮模型内联附件总量超过 ${Math.floor(referencePolicy.totalInlineBytes / MIB)} MiB 上限；请减少或压缩参考后重试`);
      }
      inlineBytes += metadata.size;
      bytes = await readFile(target);
      extracted = extractDocumentText({ bytes, name: item.name, mimeType });
    }
    result.push({
      ...item,
      mimeType,
      size: metadata.size,
      absolutePath: target,
      ...(bytes ? { dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` } : {}),
      text: extracted.text,
      extractionStatus: extracted.extractionStatus,
      extractionError: extracted.extractionError,
    });
  }
  return result;
};

// Full-text import is a local, explicit workflow rather than model context.
// It therefore reads one managed attachment with a larger bounded extraction
// limit, while the ordinary attachment path above keeps its model budget.
export const readWorkspaceAttachmentText = async ({ appRoot, requestedPath, attachment, maxCharacters = 4_000_000 }) => {
  if (!attachment || typeof attachment !== "object") throw new Error("全文导入缺少源附件");
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const { targetPath } = await secureManagedTarget(workspaceRoot, attachment.relativePath, { label: "全文源附件" });
  const metadata = await stat(targetPath);
  if (!metadata.isFile() || !metadata.size) throw new Error("全文源附件为空或不可读取");
  if (metadata.size > 64 * MIB) throw new Error("全文源附件不能超过 64 MB；请先拆分或转换为纯文本后重试");
  const mimeType = attachment.mimeType || attachmentMimeByExtension(attachment.relativePath) || "application/octet-stream";
  const bytes = await readFile(targetPath);
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  const extracted = extractDocumentText({
    bytes,
    name: attachment.name || basename(attachment.relativePath),
    mimeType,
    maxCharacters,
  });
  if (!extracted.text || extracted.extractionStatus !== "extracted") {
    throw new Error(extracted.extractionError || "全文源附件不是可提取的文字文档");
  }
  return {
    ...attachment,
    name: attachment.name || basename(attachment.relativePath),
    mimeType,
    size: metadata.size,
    sourceSha256,
    absolutePath: targetPath,
    text: extracted.text,
    extractionStatus: extracted.extractionStatus,
    extractionError: extracted.extractionError || "",
  };
};

const existingPreviewAttachment = async (workspaceRoot, relativePath) => {
  const { targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: "附件" });
  const metadata = await stat(targetPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  return metadata?.isFile() && metadata.size ? { targetPath, metadata } : null;
};

const uniqueWorkspaceAttachmentByName = async (workspaceRoot, fileName, { limit = 5_000 } = {}) => {
  const matches = [];
  const queue = [workspaceRoot];
  let visited = 0;
  while (queue.length && visited < limit && matches.length < 2) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true }).catch((error) => {
      if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) return [];
      throw error;
    })) {
      visited += 1;
      if (visited > limit) break;
      if (entry.isDirectory()) {
        if (!skipImportDirectory(entry.name)) queue.push(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || entry.name.toLowerCase() !== fileName.toLowerCase()) continue;
      const relativePath = relative(workspaceRoot, join(directory, entry.name));
      const candidate = await existingPreviewAttachment(workspaceRoot, relativePath);
      if (candidate) matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0] : null;
};

export const readWorkspaceAttachmentContent = async ({ appRoot, requestedPath, relativePath, documentId = "" }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const safeRelativePath = normalizeManagedRelativePath(relativePath, { label: "附件" });
  const fileName = basename(safeRelativePath);
  let resolved = await existingPreviewAttachment(workspaceRoot, safeRelativePath);
  if (!resolved) {
    const currentState = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "current-state.json"));
    const previousManifest = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "manifest.json"));
    const documentState = currentState?.documents?.[String(documentId || "")];
    const sourceDirectory = documentState?.sourcePath ? dirname(String(documentState.sourcePath)) : "";
    const documentTitle = safeName(documentState?.title || "");
    const candidates = [
      ...(sourceDirectory && sourceDirectory !== "." ? [join(sourceDirectory, fileName)] : []),
      ...(documentTitle && documentTitle !== "未命名" ? [join(sourceDirectory === "." ? "" : sourceDirectory, `${documentTitle}-assets`, fileName)] : []),
    ];
    for (const candidate of [...new Set(candidates)]) {
      resolved = await existingPreviewAttachment(workspaceRoot, candidate);
      if (resolved) break;
    }
    if (!resolved && safeRelativePath === fileName) {
      resolved = await uniqueWorkspaceAttachmentByName(workspaceRoot, fileName);
    }
  }
  if (!resolved) throw new Error("找不到附件");
  const mimeType = attachmentMimeByExtension(resolved.targetPath);
  if (!mimeType) throw new Error("该附件不支持浏览器预览");
  return {
    absolutePath: resolved.targetPath,
    size: resolved.metadata.size,
    mimeType,
    createdAt: new Date(Number(resolved.metadata.birthtimeMs) || Number(resolved.metadata.ctimeMs) || Number(resolved.metadata.mtimeMs)).toISOString(),
    modifiedAt: new Date(Number(resolved.metadata.mtimeMs) || Number(resolved.metadata.ctimeMs) || Date.now()).toISOString(),
  };
};

const DYNAMIC_MODULE_PATHS = {
  outline: join("01_剧情控制", "其他大纲"),
  canon: join("02_正史设定", "其他设定"),
  memory: join("03_状态快照", "其他连续性"),
  reports: join("07_编译报告", "其他报告"),
  library: join("08_资料库", "附件记录"),
  index: join("09_索引", "其他索引"),
};

const scriptDocumentPath = (id, documentState) => {
  const title = `${safeName(documentState.title)}.md`;
  if (id.startsWith("script-episode-")) {
    const episode = episodeHeadingParts(id, documentState.title);
    const fileName = episodeMarkdownFileName(id, episode.title).replace(episode.title, safeName(episode.title));
    return join("04_正文", "短剧", "短剧剧本", fileName);
  }
  if (id.startsWith("prompt-video-")) return join("04_正文", "短剧", "视频提示词", title);
  if (id.startsWith("prompt-visual-")) return join("04_正文", "短剧", "视觉资产提示词", title);
  if (id.startsWith("prompt-panorama-")) return join("04_正文", "短剧", "全景调度图提示词", title);
  if (id.startsWith("script-outline-")) return join("04_正文", "短剧", "剧本大纲", id === "script-outline-series" ? title : join("集纲", title));
  if (id.startsWith("script-canon-")) return join("04_正文", "短剧", "剧本设定", title);
  if (id.startsWith("script-memory-")) return join("04_正文", "短剧", "剧本连续性", title);
  return null;
};

const placementBaseDocumentPath = (id, documentState) => {
  const moduleId = String(documentState.moduleId ?? "");
  const viewId = String(documentState.workspaceView ?? (moduleId === "manuscript" || moduleId === "outline" ? "novel" : "default"));
  const group = String(documentState.treeGroup ?? "");
  const title = `${safeName(documentState.title)}${documentState.documentKind === "whiteboard" ? ".canvas" : ".md"}`;
  const rootPlacement = documentState.rootPlacement === true;
  const structuredGroup = rootPlacement ? null : structuredGroupByKey(moduleId, viewId, group);
  if (structuredGroup) return join(...structuredGroup.workspacePath, title);
  if (moduleId === "manuscript") {
    if (viewId === "script") return join("04_正文", "短剧", "短剧剧本", title);
    if (viewId === "prompts") {
      if (rootPlacement) return join("04_正文", "短剧", "提示词", title);
      const folder = group === "visual" ? "视觉资产提示词" : group === "panorama" ? "全景调度图提示词" : "视频提示词";
      return join("04_正文", "短剧", folder, title);
    }
    const customPath = String(documentState.customFolderPath ?? "").split(/[\\/]+/).map(safeName).filter(Boolean);
    if (customPath.length) return join("04_正文", "小说", ...customPath, title);
    if (rootPlacement) return join("04_正文", "小说", title);
    const volumeFolder = safeName(documentState.volumeFolder || "第001卷-未命名");
    return id.startsWith("chapter-") ? chapterPath(id, documentState) : join("04_正文", "小说", volumeFolder, title);
  }
  if (moduleId === "outline") {
    if (viewId === "script") return group === "episodes"
      ? join("04_正文", "短剧", "剧本大纲", "集纲", title)
      : join("04_正文", "短剧", "剧本大纲", title);
    if (["volumes", "chapters"].includes(group)) return dynamicOutlinePath(id, documentState)
      ?? join("01_剧情控制", group === "volumes" ? "卷纲" : "章纲", title);
    return join("01_剧情控制", title);
  }
  if (moduleId === "canon") return viewId === "script"
    ? join("04_正文", "短剧", "剧本设定", title)
    : rootPlacement ? join("02_正史设定", title) : join("02_正史设定", "其他设定", title);
  if (moduleId === "memory") return viewId === "script"
    ? join("04_正文", "短剧", "剧本连续性", title)
    : rootPlacement ? join("03_状态快照", title) : join("03_状态快照", "其他连续性", title);
  return join(DYNAMIC_MODULE_PATHS[moduleId] ?? "10_其他", title);
};

const placementDocumentPath = (id, documentState) => {
  const basePath = placementBaseDocumentPath(id, documentState);
  const moduleId = String(documentState.moduleId ?? "");
  const viewId = String(documentState.workspaceView ?? (moduleId === "manuscript" || moduleId === "outline" ? "novel" : "default"));
  if (!documentState.customFolderName || (moduleId === "manuscript" && viewId === "novel")) return basePath;
  const customPath = String(documentState.customFolderPath || documentState.customFolderName).split(/[\\/]+/).map(safeName).filter(Boolean);
  return join(dirname(basePath), ...customPath, basename(basePath));
};

const notebookFolderPath = (folder = {}) => String(folder.folderPath || folder.label)
  .split(/[\\/]+/)
  .map(safeName)
  .filter(Boolean);

const customFolderRelativePath = (folder = {}, workspaceKind = "project", structureLanguage = "zh-CN") => {
  if (workspaceKind === "notebook") return join(...notebookFolderPath(folder));
  if (normalizeStructureLanguage(structureLanguage) === "en-US") {
    const group = String(folder.parentOptions?.treeGroup ?? "");
    let basePath = "10_Other";
    if (folder.moduleId === "manuscript") {
      if (folder.viewId === "novel") basePath = join("04_Manuscript", "Novel");
      else if (folder.viewId === "script") basePath = join("04_Manuscript", "Short Drama", "Scripts");
      else basePath = join("04_Manuscript", "Short Drama", group === "visual" ? "Visual Asset Prompts" : group === "panorama" ? "Panorama Staging Prompts" : "Video Prompts");
    } else if (folder.moduleId === "outline") {
      basePath = folder.viewId === "script"
        ? join("04_Manuscript", "Short Drama", "Script Outlines", ...(group === "episodes" ? ["Episode Outlines"] : []))
        : join("01_Plot Control", ...(group === "volumes" ? ["Volume Outlines"] : group === "chapters" ? ["Chapter Outlines"] : []));
    } else if (folder.moduleId === "canon") basePath = folder.viewId === "script" ? join("04_Manuscript", "Short Drama", "Script Canon") : "02_Canon";
    else if (folder.moduleId === "memory") basePath = folder.viewId === "script" ? join("04_Manuscript", "Short Drama", "Script Memory") : "03_Memory";
    else if (folder.moduleId === "reports") basePath = "07_Reports";
    else if (folder.moduleId === "library") basePath = "08_Library";
    else if (folder.moduleId === "index") basePath = "09_Index";
    const folderPath = String(folder.folderPath || folder.label).split(/[\\/]+/).map(safeName).filter(Boolean);
    return join(basePath, ...folderPath);
  }
  const group = String(folder.parentOptions?.treeGroup ?? "");
  const structuredGroup = structuredGroupByKey(folder.moduleId, folder.viewId, group);
  let basePath = structuredGroup ? join(...structuredGroup.workspacePath) : "10_其他";
  if (!structuredGroup && folder.moduleId === "manuscript") {
    if (folder.viewId === "novel") basePath = join("04_正文", "小说");
    else if (folder.viewId === "script") basePath = join("04_正文", "短剧", "短剧剧本");
    else basePath = join("04_正文", "短剧", group === "visual" ? "视觉资产提示词" : group === "panorama" ? "全景调度图提示词" : "视频提示词");
  } else if (!structuredGroup && folder.moduleId === "outline") {
    if (folder.viewId === "script") basePath = join("04_正文", "短剧", "剧本大纲", ...(group === "episodes" ? ["集纲"] : []));
    else basePath = join("01_剧情控制", ...(group === "volumes" ? ["卷纲"] : group === "chapters" ? ["章纲"] : []));
  } else if (!structuredGroup && folder.moduleId === "canon") {
    basePath = folder.viewId === "script" ? join("04_正文", "短剧", "剧本设定") : join("02_正史设定", "其他设定");
  } else if (!structuredGroup && folder.moduleId === "memory") {
    basePath = folder.viewId === "script" ? join("04_正文", "短剧", "剧本连续性") : join("03_状态快照", "其他连续性");
  } else if (!structuredGroup) {
    basePath = DYNAMIC_MODULE_PATHS[folder.moduleId] ?? "10_其他";
  }
  const folderPath = String(folder.folderPath || folder.label).split(/[\\/]+/).map(safeName).filter(Boolean);
  return join(basePath, ...folderPath);
};

const notebookDocumentPath = (documentState = {}) => {
  const extension = documentState.documentKind === "whiteboard" ? ".canvas" : ".md";
  if (documentState.sourceImportTargetPath && (documentState.preserveObsidianMarkdown || documentState.sourceMigration || documentState.sourceMigrationConflict)) {
    const importedPath = normalizeManagedRelativePath(documentState.sourceImportTargetPath, { label: "导入笔记路径" });
    if (extname(importedPath).toLowerCase() === extension) return importedPath;
  }
  const folders = String(documentState.customFolderPath ?? "").split(/[\\/]+/).map((part) => part.trim()).filter(Boolean).map(safeName);
  return join(...folders, `${safeName(documentState.title)}${extension}`);
};

const relativeDocumentPath = (id, documentState, workspaceKind = "project", structureLanguage = "zh-CN") => {
  let path = null;
  if (workspaceKind === "notebook") path = notebookDocumentPath(documentState);
  else if (documentState.sourcePath) path = migrateLegacyManagedPath(documentState.sourcePath);
  else if (normalizeStructureLanguage(structureLanguage) === "en-US") path = englishProjectDocumentPath(id, documentState);
  else if (documentState.placementOverride) path = placementDocumentPath(id, documentState);
  else if (id.startsWith("script-episode-")) path = scriptDocumentPath(id, documentState);
  else if (PATH_MAP[id]) path = PATH_MAP[id];
  const outlinePath = dynamicOutlinePath(id, documentState);
  if (!path && outlinePath) path = outlinePath;
  const scriptPath = scriptDocumentPath(id, documentState);
  if (!path && scriptPath) path = scriptPath;
  if (!path && id.startsWith("chapter-")) path = chapterPath(id, documentState);
  if (!path && id.startsWith("library-deconstruction-")) path = join("08_资料库", "参考资料", `${safeName(documentState.title)}.md`);
  path ??= join(DYNAMIC_MODULE_PATHS[documentState.moduleId] ?? "10_其他", `${safeName(documentState.title)}.md`);
  return normalizeManagedRelativePath(path, { label: `文档“${documentState.title || id}”` });
};

const collisionSafeDocumentPaths = ({ documents = {}, workspaceKind = "project", structureLanguage = "zh-CN", previousManifest = null }) => {
  const records = Object.entries(documents).map(([id, documentState], index) => {
    const previousEntry = previousManifest?.manifest?.[id];
    const rawPreviousPath = typeof previousEntry === "string" ? previousEntry : previousEntry?.path;
    return {
      id,
      index,
      basePath: relativeDocumentPath(id, documentState, workspaceKind, structureLanguage),
      previousPath: rawPreviousPath ? normalizeManagedRelativePath(rawPreviousPath, { label: `文档“${documentState.title || id}”的历史清单` }) : "",
      hasPrevious: Boolean(previousEntry),
    };
  });
  const allocated = new Map();
  const used = new Set();
  const allocationOrder = [...records].sort((left, right) => Number(right.hasPrevious) - Number(left.hasPrevious) || left.index - right.index);
  for (const record of allocationOrder) {
    const candidates = [record.basePath, record.previousPath].filter(Boolean);
    let selected = candidates.find((candidate) => !used.has(normalizedRelative(candidate))) || "";
    if (!selected) {
      const extension = extname(record.basePath) || (workspaceKind === "notebook" ? ".md" : ".md");
      const stem = basename(record.basePath, extension);
      const stableId = safeName(record.id).slice(0, 40) || "duplicate";
      let attempt = 1;
      do {
        const suffix = attempt === 1 ? stableId : `${stableId}-${attempt}`;
        selected = normalizeManagedRelativePath(join(dirname(record.basePath), `${stem}（${suffix}）${extension}`), { label: `同名文档“${record.id}”` });
        attempt += 1;
      } while (used.has(normalizedRelative(selected)));
    }
    allocated.set(record.id, selected);
    used.add(normalizedRelative(selected));
  }
  return allocated;
};

const SHENSI_FRONTMATTER_KEYS = new Set(["shensi_id", "context_status", "shensi_memory"]);

const splitPreservedFrontmatter = (value = "") => {
  const markdown = String(value).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = markdown.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { hasFrontmatter: false, lines: [], body: markdown };
  return {
    hasFrontmatter: true,
    lines: match[1].split("\n"),
    body: markdown.slice(match[0].length),
  };
};

const preserveNonShensiFrontmatterLines = (lines = []) => {
  const preserved = [];
  let skipReservedBlock = false;
  for (const line of lines) {
    const topLevel = line.match(/^([^\s:#][^:]*):(?:\s|$)/);
    if (topLevel) {
      skipReservedBlock = SHENSI_FRONTMATTER_KEYS.has(topLevel[1].trim().toLowerCase());
      if (skipReservedBlock) continue;
    }
    if (!skipReservedBlock) preserved.push(line);
  }
  while (preserved.length && !preserved.at(-1).trim()) preserved.pop();
  return preserved;
};

const shensiFrontmatterLines = ({ id, documentState, preserveOriginal = false }) => [
  `shensi_id: ${id}`,
  ...(!preserveOriginal ? [
    `title: ${JSON.stringify(documentState.title)}`,
    `updated_at: ${JSON.stringify(documentState.updatedAt ?? "")}`,
  ] : []),
  "context_status: current",
  ...(documentState.continuityDelta ? [
    `shensi_memory: ${JSON.stringify({
      schemaVersion: 1,
      ...documentState.continuityDelta,
      syncStatus: documentState.memorySyncStatus ?? "unknown",
      syncedAt: documentState.memorySyncedAt ?? "",
    })}`,
  ] : []),
];

const decodeHtmlOnlyDocumentEntities = (value = "") => String(value)
  .replace(/&nbsp;/gi, " ")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, "&");

// Desktop saves normally provide Markdown, but document transfer, old local
// state and API callers may still provide an HTML-only document. Serializing
// such a record as an empty Markdown file silently destroys copy/paste data.
// Preserve the common editor structures here; the next browser hydration can
// continue using the normal structured Markdown pipeline.
const legacyHtmlToMarkdown = (html = "") => decodeHtmlOnlyDocumentEntities(String(html))
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, body) => `${"#".repeat(Number(level))} ${body}\n\n`)
  .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
  .replace(/<(?:strong|b)[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, "**$1**")
  .replace(/<(?:em|i)[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, "*$1*")
  .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
  .replace(/<\/(?:p|div|blockquote|pre|tr|table)>/gi, "\n\n")
  .replace(/<\/(?:td|th)>/gi, " | ")
  .replace(/<[^>]+>/g, "")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const markdownDocument = ({ id, documentState }) => {
  const sourceMarkdown = typeof documentState.markdown === "string"
    ? documentState.markdown
    : legacyHtmlToMarkdown(documentState.html ?? "");
  const current = splitPreservedFrontmatter(sourceMarkdown);
  const original = splitPreservedFrontmatter(documentState.sourceOriginalFrontmatter ?? "");
  if (documentState.sharedObsidianMarkdown === true) {
    const originalLines = preserveNonShensiFrontmatterLines(current.hasFrontmatter ? current.lines : original.lines);
    return [
      ...(originalLines.length ? ["---", ...originalLines, "---", ""] : []),
      current.body.replace(/\n+$/g, ""),
      "",
    ].join("\n");
  }
  const preserveOriginal = documentState.preserveObsidianMarkdown === true || Boolean(documentState.sourceOriginalFrontmatter);
  const originalLines = preserveOriginal
    ? preserveNonShensiFrontmatterLines(current.hasFrontmatter ? current.lines : original.lines)
    : [];
  const body = preserveOriginal
    ? current.body
    : String(sourceMarkdown.trim() || "");
  return [
    "---",
    ...shensiFrontmatterLines({ id, documentState, preserveOriginal }),
    ...originalLines,
    "---",
    "",
    body.replace(/\n+$/g, ""),
    "",
  ].join("\n");
};

const serializedWorkspaceDocument = ({ id, documentState, workspaceKind = "project" }) => {
  if (documentState.documentKind === "whiteboard") {
    const canvas = documentState.canvas && typeof documentState.canvas === "object"
      ? documentState.canvas
      : { nodes: [], edges: [] };
    return `${JSON.stringify({
      nodes: canvas.nodes ?? [],
      edges: canvas.edges ?? [],
      assets: canvas.assets ?? [],
      viewport: canvas.viewport ?? { x: 0, y: 0, zoom: 1 },
      settings: canvas.settings ?? { snapToGrid: true, gridSize: 20 },
    }, null, 2)}\n`;
  }
  return markdownDocument({ id, documentState });
};

const normalizedSerializedCanvas = (canvas = {}) => ({
  nodes: Array.isArray(canvas.nodes) ? canvas.nodes : [],
  edges: Array.isArray(canvas.edges) ? canvas.edges : [],
  assets: Array.isArray(canvas.assets) ? canvas.assets : [],
  viewport: canvas.viewport ?? { x: 0, y: 0, zoom: 1 },
  settings: canvas.settings ?? { snapToGrid: true, gridSize: 20 },
});

const serializedDocumentSemanticallyMatches = async ({ targetPath, documentState, workspaceKind }) => {
  if (workspaceKind !== "notebook" || documentState.documentKind !== "whiteboard") return false;
  try {
    const currentCanvas = normalizedSerializedCanvas(JSON.parse(await readFile(targetPath, "utf8")));
    const desiredCanvas = normalizedSerializedCanvas(documentState.canvas);
    return JSON.stringify(currentCanvas) === JSON.stringify(desiredCanvas);
  } catch {
    return false;
  }
};

const manifestDocumentReference = (manifest, id) => {
  const entry = manifest?.[id];
  const path = typeof entry === "string" ? entry : entry?.path;
  if (!path) return null;
  return { schemaVersion: 1, path, hash: typeof entry === "object" ? String(entry.hash || "") : "" };
};

const compactCurrentDocuments = (documents = {}, {
  manifest = null,
  externalizeContent = false,
  workspaceKind = "project",
  preserveExternalBaseline = false,
} = {}) => Object.fromEntries(Object.entries(documents).map(([id, documentState]) => {
  if (!documentState) return [id, documentState];
  const compact = { ...documentState };
  if (!preserveExternalBaseline) delete compact.externalContentChanged;
  const contentRef = externalizeContent ? manifestDocumentReference(manifest, id) : null;
  if (documentState.documentKind !== "whiteboard" && typeof documentState.markdown === "string") {
    const htmlMatchesMarkdown = typeof documentState.html !== "string"
      || sanitizeDocumentHtml(documentState.html) === sanitizeDocumentHtml(markdownToHtml(documentState.markdown));
    if (htmlMatchesMarkdown) delete compact.html;
  }
  if (!contentRef) return [id, compact];

  compact.contentRef = contentRef;
  if (documentState.documentKind === "whiteboard" && workspaceKind === "notebook") delete compact.canvas;
  else if (typeof documentState.markdown === "string") delete compact.markdown;
  return [id, compact];
}));

const hydrateCurrentDocuments = (documents = {}) => Object.fromEntries(Object.entries(documents).map(([id, documentState]) => {
  if (!documentState || documentState.documentKind === "whiteboard") return [id, documentState];
  if (documentState.sourceImportPath && typeof documentState.markdown === "string") {
    const markdown = documentState.preserveObsidianMarkdown === true
      ? splitPreservedFrontmatter(documentState.markdown).body
      : cleanObsidianMigrationMarkdown(documentState.markdown, { title: documentState.title });
    return [id, { ...documentState, html: markdownToHtml(markdown) }];
  }
  if (typeof documentState.html === "string") return [id, { ...documentState, html: sanitizeDocumentHtml(documentState.html) }];
  const markdown = documentState.markdown ?? "";
  return [id, { ...documentState, html: sanitizeDocumentHtml(markdownToHtml(markdown)) }];
}));

const markdownStateFromSerializedDocument = (serialized, documentState) => {
  const physical = splitPreservedFrontmatter(serialized);
  if (documentState.sharedObsidianMarkdown === true) return serialized.replace(/\n+$/g, "");
  if (documentState.preserveObsidianMarkdown === true || documentState.sourceOriginalFrontmatter) {
    const originalLines = preserveNonShensiFrontmatterLines(physical.lines);
    return [
      ...(originalLines.length ? ["---", ...originalLines, "---"] : []),
      physical.body.replace(/\n+$/g, ""),
    ].join("\n");
  }
  return physical.body.trim();
};

const legacyDocumentSourceCandidates = (documentState = {}) => {
  const migration = documentState.sourceMigration && typeof documentState.sourceMigration === "object"
    ? documentState.sourceMigration
    : {};
  const sourceRoot = String(migration.sourceRoot || "").trim();
  if (!sourceRoot || !isAbsolute(sourceRoot)) return [];
  const normalizedRoot = resolve(sourceRoot);
  return [...new Set([
    migration.sourcePath,
    documentState.sourceImportPath,
    documentState.importedFrom,
  ].map((value) => String(value || "").trim()).filter(Boolean))]
    .map((value) => resolve(normalizedRoot, value))
    .filter((candidate) => isInside(candidate, normalizedRoot));
};

const restoreMissingManagedDocumentFromLegacySource = async ({ documentState, targetPath }) => {
  for (const sourcePath of legacyDocumentSourceCandidates(documentState)) {
    const sourceInfo = await stat(sourcePath).catch(() => null);
    if (!sourceInfo?.isFile()) continue;
    const serialized = await readFile(sourcePath, "utf8");
    await mkdir(dirname(targetPath), { recursive: true });
    try {
      await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      return { serialized: await readFile(targetPath, "utf8"), sourcePath, copied: false };
    }
    return { serialized, sourcePath, copied: true };
  }
  return null;
};

const decodeLegacyHtmlEntities = (value = "") => String(value)
  .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&nbsp;/gi, " ")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, "&");

const embeddedHtmlToMarkdown = (html = "") => decodeLegacyHtmlEntities(String(html)
  .replace(/<figure\b[^>]*>[\s\S]*?<\/(?:figure)>/gi, (figure) => {
    const attachmentPath = figure.match(/data-attachment-path=["']([^"']+)["']/i)?.[1];
    return attachmentPath ? `\n\n![[${attachmentPath.replaceAll("\\", "/")}]]\n\n` : figure;
  })
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<h1\b[^>]*>/gi, "\n\n# ").replace(/<\/h1>/gi, "\n\n")
  .replace(/<h2\b[^>]*>/gi, "\n\n## ").replace(/<\/h2>/gi, "\n\n")
  .replace(/<h3\b[^>]*>/gi, "\n\n### ").replace(/<\/h3>/gi, "\n\n")
  .replace(/<(?:strong|b)\b[^>]*>/gi, "**").replace(/<\/(?:strong|b)>/gi, "**")
  .replace(/<(?:em|i)\b[^>]*>/gi, "*").replace(/<\/(?:em|i)>/gi, "*")
  .replace(/<li\b[^>]*>/gi, "\n- ").replace(/<\/li>/gi, "")
  .replace(/<\/(?:p|div|section|article|blockquote)>/gi, "\n\n")
  .replace(/<[^>]+>/g, ""))
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const restoreMissingManagedDocumentFromEmbeddedState = async ({ id, documentState, targetPath }) => {
  let serialized = "";
  if (!documentState || typeof documentState !== "object") return null;
  if (documentState.documentKind === "whiteboard") {
    serialized = `${JSON.stringify(normalizedSerializedCanvas(documentState.canvas), null, 2)}\n`;
  } else if (typeof documentState?.markdown === "string") {
    serialized = serializedWorkspaceDocument({ id, documentState });
  } else if (typeof documentState?.html === "string") {
    serialized = serializedWorkspaceDocument({
      id,
      documentState: { ...documentState, markdown: embeddedHtmlToMarkdown(documentState.html) },
    });
  } else {
    // Legacy templates sometimes kept only metadata because their body was
    // intentionally empty. Materialize a valid empty document so subsequent
    // edits have a stable E-drive target instead of remaining permanently
    // flagged as a missing external file.
    serialized = serializedWorkspaceDocument({ id, documentState: { ...documentState, markdown: "" } });
  }
  if (!serialized) return null;
  await mkdir(dirname(targetPath), { recursive: true });
  try {
    await writeFile(targetPath, serialized, { encoding: "utf8", flag: "wx" });
    return { serialized, restoredFromEmbeddedState: true };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { serialized: await readFile(targetPath, "utf8"), restoredFromEmbeddedState: false };
  }
};

const hydrateMissingExternalizedDocumentFallback = (documentState, id) => {
  if (documentState?.documentKind === "whiteboard") {
    return {
      ...documentState,
      canvas: normalizedSerializedCanvas(documentState.canvas),
      externalContentMissing: true,
    };
  }
  if (typeof documentState?.html === "string") {
    return {
      ...documentState,
      html: sanitizeDocumentHtml(documentState.html),
      externalContentMissing: true,
    };
  }
  return hydrateCurrentDocuments({
    [id]: { ...documentState, markdown: String(documentState?.markdown || ""), externalContentMissing: true },
  })[id];
};

const hydrateExternalizedCurrentDocument = async ({ workspaceRoot, id, documentState, manifest, linkValidationCache = null }) => {
  const isWhiteboard = documentState?.documentKind === "whiteboard";
  const contentRef = documentState?.contentRef ?? manifestDocumentReference(manifest, id);
  // A few legacy/imported whiteboards still carry an empty `markdown` field.
  // That compatibility field must never short-circuit Canvas hydration: the
  // external .canvas file remains the single source of truth for cards,
  // edges and the historical asset ledger.
  // Likewise, a compact state may retain embedded markdown/html when their
  // revisions diverged. Once a managed contentRef exists, the physical file is
  // authoritative and must still be read so CLI/Agent edits become visible.
  if (!documentState || (!contentRef?.path && ((!isWhiteboard && typeof documentState.markdown === "string")
    || (isWhiteboard && documentState.canvas)))) {
    return hydrateCurrentDocuments({ [id]: documentState })[id];
  }
  if (!contentRef?.path) throw new Error(`文档“${documentState.title || id}”缺少正文引用，已停止加载以避免空内容覆盖`);
  const { targetPath } = await secureManagedTarget(workspaceRoot, contentRef.path, {
    label: `文档“${documentState.title || id}”的正文引用`,
    linkValidationCache,
  });
  let serialized;
  try {
    serialized = await readFile(targetPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const restored = await restoreMissingManagedDocumentFromLegacySource({ documentState, targetPath })
        ?? await restoreMissingManagedDocumentFromEmbeddedState({ id, documentState, targetPath });
      if (!restored) return hydrateMissingExternalizedDocumentFallback(documentState, id);
      serialized = restored.serialized;
    } else {
      throw error;
    }
  }
  const currentContentHash = hashText(serialized);
  const externalContentChanged = Boolean(contentRef.hash && currentContentHash !== contentRef.hash);
  const currentContentRef = { ...contentRef, schemaVersion: 1, hash: currentContentHash };
  if (documentState.documentKind === "whiteboard") {
    let canvas;
    try {
      canvas = normalizedSerializedCanvas(JSON.parse(serialized));
    } catch {
      throw new Error(`白板“${documentState.title || id}”的本地文件损坏，已停止加载`);
    }
    return {
      ...documentState,
      contentRef: currentContentRef,
      canvas,
      ...(externalContentChanged ? { externalContentChanged: true } : {}),
    };
  }
  const markdown = markdownStateFromSerializedDocument(serialized, documentState);
  return {
    ...hydrateCurrentDocuments({
      [id]: {
        ...documentState,
        contentRef: currentContentRef,
        html: isStructuredMemoryDocumentId(id) ? memoryProjectionMarkdownToHtml(markdown) : undefined,
        markdown,
      },
    })[id],
    ...(externalContentChanged ? { externalContentChanged: true } : {}),
  };
};

const hydrateCurrentDocumentsFromWorkspace = async ({ workspaceRoot, documents = {}, manifest = {} }) => {
  const entries = Object.entries(documents);
  const hydrated = {};
  const linkValidationCache = new Map();
  for (let offset = 0; offset < entries.length; offset += 128) {
    const batch = entries.slice(offset, offset + 128);
    const results = await Promise.all(batch.map(async ([id, documentState]) => {
      try {
        return await hydrateExternalizedCurrentDocument({
          workspaceRoot,
          id,
          documentState,
          manifest,
          linkValidationCache,
        });
      } catch (error) {
        // A damaged external whiteboard must remain visible as a recoverable
        // resource, but it must not make every unrelated document in the work
        // unreadable or unwritable.  Keep the physical file untouched and
        // isolate only that resource until the user restores one of its real
        // history versions.
        if (documentState?.documentKind !== "whiteboard" || !String(error?.message || "").includes("本地文件损坏")) throw error;
        return {
          ...hydrateMissingExternalizedDocumentFallback(documentState, id),
          externalContentCorrupt: true,
          externalContentError: String(error.message || "白板本地文件损坏"),
        };
      }
    }));
    batch.forEach(([id], index) => { hydrated[id] = results[index]; });
  }
  return hydrated;
};

const saveWorkspaceStateCore = async ({ appRoot, requestedPath, state, dirtyDocumentIds = null, transactionRollback = false }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const safeState = scrubConfidentialMetadata(state ?? {});
  for (const [documentId, documentState] of Object.entries(safeState.documents ?? {})) {
    if (!sequencedDocumentKind(documentId) || !documentState) continue;
    const importedStateUnchangedBeforeTitleNormalization = Boolean(
      documentState.importedStateHash
      && documentState.importedStateHash === importedDocumentStateHash(documentState.title, documentState.markdown),
    );
    const freeTitle = freeDocumentTitle({
      documentId,
      title: documentState.title,
      language: documentState.titleLanguage || safeState.structureLanguage,
    });
    documentState.title = freeTitle;
    if (importedStateUnchangedBeforeTitleNormalization) {
      documentState.importedStateHash = importedDocumentStateHash(freeTitle, documentState.markdown);
    }
    for (const items of Object.values(safeState.moduleItems ?? {})) {
      const item = (items ?? []).find(([itemDocumentId]) => itemDocumentId === documentId);
      if (item) item[1] = sequencedDocumentLabel({
        documentId,
        title: freeTitle,
        language: documentState.titleLanguage || safeState.structureLanguage,
        documentState,
      });
    }
  }
  const retiredDocumentIds = new Set(RETIRED_PERSISTED_DOCUMENT_IDS);
  if (Number(safeState.structureWorkspaceVersion ?? 0) >= 5) {
    RETIRED_CANON_DOCUMENT_IDS.forEach((documentId) => retiredDocumentIds.add(documentId));
  }
  for (const documentId of retiredDocumentIds) delete safeState.documents?.[documentId];
  if (safeState.moduleItems?.memory) {
    safeState.moduleItems.memory = safeState.moduleItems.memory.filter(([documentId]) => !retiredDocumentIds.has(documentId));
  }
  if (safeState.moduleItems?.library) {
    safeState.moduleItems.library = safeState.moduleItems.library.filter(([documentId]) => !retiredDocumentIds.has(documentId));
  }
  if (safeState.moduleItems?.canon) {
    safeState.moduleItems.canon = safeState.moduleItems.canon.filter(([documentId]) => !retiredDocumentIds.has(documentId));
  }
  if (retiredDocumentIds.has(safeState.activeDocument)) {
    safeState.activeDocument = Object.keys(safeState.documents ?? {})[0] ?? null;
  }
  const workspaceKind = safeState.workspaceKind === "notebook" ? "notebook" : "project";
  const structureLanguage = normalizeStructureLanguage(safeState.structureLanguage);
  await mkdir(workspaceRoot, { recursive: true });
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  await mkdir(internalRoot, { recursive: true });
  const manifestPath = join(internalRoot, "manifest.json");
  const previousManifest = await readJsonIfExists(manifestPath);
  const previousCurrentState = await readJsonIfExists(join(internalRoot, "current-state.json"));
  const trashRoot = join(internalRoot, "recycle-bin");
  if (workspaceKind === "project") {
    await mergeMoveDirectory(join(workspaceRoot, "08_资料库", "回收站"), trashRoot);
    await pruneEmptyDirectoryTree(join(workspaceRoot, "08_资料库", "回收站"));
  }
  const trashManifestPath = join(internalRoot, "trash-manifest.json");
  const previousTrashManifest = await readJsonIfExists(trashManifestPath);
  const trashRetention = pruneTrashEntries(safeState.trash ?? []);
  safeState.trash = trashRetention.active;
  const activeTrash = new Map(safeState.trash.map((entry) => [entry.trashId, entry]));
  const activeCustomFolderIds = new Set((safeState.customFolders ?? []).map((folder) => folder.id));
  const activeVolumeFolderIds = new Set((safeState.moduleItems?.manuscript ?? [])
    .map(([, , options = {}]) => options.folderId)
    .filter(Boolean));
  const trashManifest = {};
  await mkdir(trashRoot, { recursive: true });
  await purgeLegacyTrash(trashRoot);
  for (const [trashId, archive] of Object.entries(previousTrashManifest?.entries ?? {})) {
    if (activeTrash.has(trashId)) trashManifest[trashId] = archive;
    else if (archive.folder) {
      const restoringFolder = (archive.customFolderIds ?? []).some((folderId) => activeCustomFolderIds.has(folderId))
        || (archive.volumeFolderIds ?? []).some((folderId) => activeVolumeFolderIds.has(folderId));
      if (restoringFolder) {
        const archiveRoot = resolve(trashRoot, archive.folder);
        if (!isInside(archiveRoot, trashRoot)) throw new Error("回收站恢复路径越界");
        const managedPaths = (archive.paths ?? [])
          .map((path) => normalizedRelative(path))
          .filter((path) => path.startsWith(`${normalizedRelative(archive.folder)}/`))
          .map((path) => path.slice(normalizedRelative(archive.folder).length + 1));
        await mergeMoveDirectory(archiveRoot, workspaceRoot, { skipRelativePaths: managedPaths });
      }
      await removeTrashArchive(trashRoot, archive.folder);
    }
  }
  if (!previousManifest && await containsMarkdown(workspaceRoot)) {
    throw new Error("目标作品目录包含尚未接管的 Markdown 文档。为防止覆盖，请先执行作品导入。 ");
  }
  for (const folder of safeState.customFolders ?? []) {
    const { targetPath } = await secureManagedTarget(
      workspaceRoot,
      customFolderRelativePath(folder, workspaceKind, structureLanguage),
      { label: `文件夹“${folder.label || folder.id}”` },
    );
    await mkdir(targetPath, { recursive: true });
  }
  const manifest = {};
  const documentPaths = collisionSafeDocumentPaths({ documents: safeState.documents, workspaceKind, structureLanguage, previousManifest });
  const documentEntries = Object.entries(safeState.documents ?? {});
  if (!previousManifest) {
    const initialSaveConcurrency = 16;
    for (let offset = 0; offset < documentEntries.length; offset += initialSaveConcurrency) {
      const batch = documentEntries.slice(offset, offset + initialSaveConcurrency);
      const saved = await Promise.all(batch.map(async ([id, documentState]) => {
        const relativePath = documentPaths.get(id) ?? relativeDocumentPath(id, documentState, workspaceKind, structureLanguage);
        const { relativePath: normalizedPath, targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: `文档“${documentState.title || id}”` });
        if (await pathHashIfExists(targetPath)) throw new Error(`${documentState.title} 的目标文件已存在但未受神思管理，已停止覆盖`);
        const serialized = serializedWorkspaceDocument({ id, documentState, workspaceKind });
        const desiredHash = hashText(serialized);
        await atomicWrite(targetPath, serialized);
        return [id, { path: normalizedPath, hash: desiredHash }];
      }));
      for (const [id, entry] of saved) manifest[id] = entry;
    }
  } else for (const [id, documentState] of documentEntries) {
    const previousEntry = previousManifest?.manifest?.[id];
    if (dirtyDocumentIds instanceof Set && !dirtyDocumentIds.has(id) && previousEntry) {
      manifest[id] = previousEntry;
      continue;
    }
    const relativePath = documentPaths.get(id) ?? relativeDocumentPath(id, documentState, workspaceKind, structureLanguage);
    const { relativePath: normalizedPath, targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: `文档“${documentState.title || id}”` });
    const rawExpectedPath = typeof previousEntry === "string" ? previousEntry : previousEntry?.path;
    const expectedPath = rawExpectedPath
      ? normalizeManagedRelativePath(rawExpectedPath, { label: `文档“${documentState.title || id}”的历史清单` })
      : null;
    const serialized = serializedWorkspaceDocument({ id, documentState, workspaceKind });
    const desiredHash = hashText(serialized);
    let verifiedCurrentHash;
    if (previousEntry && expectedPath !== normalizedPath) {
      const { targetPath: oldTarget } = await secureManagedTarget(workspaceRoot, expectedPath, { label: `文档“${documentState.title || id}”的旧位置` });
      const [oldHash, targetHash] = await Promise.all([pathHashIfExists(oldTarget), pathHashIfExists(targetPath)]);
      if (targetHash === desiredHash) {
        if (oldHash === previousEntry.hash) await rm(oldTarget, { force: true });
        else if (oldHash && oldHash !== desiredHash) throw new Error(`${documentState.title} 的旧路径出现外部修改，已停止恢复事务`);
      } else if (!oldHash && targetHash === previousEntry.hash) {
        // The previous process moved the file and stopped before replacing its content.
      } else {
        if (oldHash !== previousEntry.hash) {
          throw new Error(`${documentState.title} 已被外部修改，已停止重命名`);
        }
        if (targetHash) throw new Error(`${documentState.title} 的新路径已经存在，已停止重命名`);
        await mkdir(dirname(targetPath), { recursive: true });
        await renameWithTransientRetry(oldTarget, targetPath);
      }
    }
    if (expectedPath === normalizedPath && previousEntry?.hash === desiredHash) {
      verifiedCurrentHash = await pathHashIfExists(targetPath);
      if (verifiedCurrentHash === desiredHash) {
        manifest[id] = { path: normalizedPath, hash: desiredHash };
        continue;
      }
    }
    const currentHash = verifiedCurrentHash === undefined ? await pathHashIfExists(targetPath) : verifiedCurrentHash;
    const acceptedExternalBaseline = documentState.externalContentChanged === true
      && documentState.contentRef?.hash
      && documentState.contentRef.hash === currentHash;
    const importedStateUnchanged = documentState.importedStateHash
      && documentState.importedStateHash === importedDocumentStateHash(documentState.title, documentState.markdown);
    if (expectedPath === normalizedPath && currentHash && currentHash === previousEntry?.hash && importedStateUnchanged) {
      manifest[id] = { path: normalizedPath, hash: currentHash };
      continue;
    }
    const semanticallyMatches = currentHash && currentHash !== desiredHash
      ? await serializedDocumentSemanticallyMatches({ targetPath, documentState, workspaceKind })
      : false;
    if (!transactionRollback && !acceptedExternalBaseline && currentHash && currentHash !== desiredHash && previousEntry?.hash && currentHash !== previousEntry.hash && !semanticallyMatches) {
      throw new Error(`${documentState.title} 已被外部修改，已停止覆盖`);
    }
    if (currentHash && currentHash !== desiredHash && !previousEntry && !semanticallyMatches) {
      throw new Error(`${documentState.title} 的目标文件已存在但未受神思管理，已停止覆盖`);
    }
    if (currentHash !== desiredHash) await atomicWrite(targetPath, serialized);
    manifest[id] = { path: normalizedPath, hash: desiredHash };
  }

  for (const [id, previousEntry] of Object.entries(previousManifest?.manifest ?? {})) {
    if (manifest[id]) continue;
    const rawPreviousPath = typeof previousEntry === "string" ? previousEntry : previousEntry?.path;
    if (!rawPreviousPath) continue;
    const { relativePath: previousPath, targetPath: oldTarget } = await secureManagedTarget(workspaceRoot, rawPreviousPath, { label: `已删除文档“${id}”` });
    const trashEntry = safeState.trash.find((entry) => trashEntryDocumentIds(entry).includes(id));
    const trashId = trashEntry?.trashId ?? `untracked-${id}`;
    const folder = safeName(trashId);
    const recyclePath = resolve(trashRoot, folder, previousPath);
    if (!isInside(recyclePath, trashRoot)) throw new Error("回收站目标路径越界");
    const archivedPath = relative(trashRoot, recyclePath).replaceAll("\\", "/");
    const registerArchive = () => {
      trashManifest[trashId] ??= {
        folder,
        kind: trashEntry?.kind ?? "file",
        title: trashEntry?.title ?? basename(previousPath),
        expiresAtIso: trashEntry?.expiresAtIso ?? new Date(Date.now() + TRASH_RETENTION_MS).toISOString(),
        documentIds: [],
        paths: [],
      };
      if (!trashManifest[trashId].documentIds.includes(id)) trashManifest[trashId].documentIds.push(id);
      if (!trashManifest[trashId].paths.includes(archivedPath)) trashManifest[trashId].paths.push(archivedPath);
    };
    try {
      const content = await readFile(oldTarget);
      if (previousEntry.hash && hashText(content) !== previousEntry.hash) {
        throw new Error(`${basename(previousPath)} 已被外部修改，已停止移入回收区`);
      }
      await mkdir(dirname(recyclePath), { recursive: true });
      await renameWithTransientRetry(oldTarget, recyclePath);
      registerArchive();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (await pathHashIfExists(recyclePath)) registerArchive();
    }
  }

  if (workspaceKind === "project") {
    for (const trashEntry of safeState.trash) {
      const volumeFolders = Array.isArray(trashEntry.volumeFolders) ? trashEntry.volumeFolders : [];
      if (!volumeFolders.length) continue;
      const trashId = trashEntry.trashId;
      const archiveFolder = safeName(trashId);
      const previouslyArchivedVolumeIds = new Set(previousTrashManifest?.entries?.[trashId]?.volumeFolderIds ?? []);
      trashManifest[trashId] ??= {
        folder: archiveFolder,
        kind: trashEntry.kind ?? "tree",
        title: trashEntry.title ?? "正文分卷",
        expiresAtIso: trashEntry.expiresAtIso ?? new Date(Date.now() + TRASH_RETENTION_MS).toISOString(),
        documentIds: trashEntryDocumentIds(trashEntry),
        paths: [],
      };
      for (const volume of volumeFolders) {
        const folderId = String(volume?.id ?? "").trim();
        if (!folderId || previouslyArchivedVolumeIds.has(folderId)) continue;
        const volumeName = safeName(volume?.volumeFolder || volume?.label || "第001卷-未命名");
        const folderPath = structureLanguage === "en-US"
          ? join("04_Manuscript", "Novel", volumeName)
          : join("04_正文", "小说", volumeName);
        const archiveTarget = resolve(trashRoot, archiveFolder, folderPath);
        if (!isInside(archiveTarget, trashRoot)) throw new Error("正文分卷回收路径越界");
        trashManifest[trashId].volumeFolderIds = [...new Set([...(trashManifest[trashId].volumeFolderIds ?? []), folderId])];
        trashManifest[trashId].folderPaths = [...new Set([...(trashManifest[trashId].folderPaths ?? []), folderPath.replaceAll("\\", "/")])];
        await mergeMoveDirectory(join(workspaceRoot, folderPath), archiveTarget);
      }
    }
  }

  for (const [legacyPrefix] of LEGACY_DIRECTORY_MIGRATIONS) {
    await pruneEmptyDirectoryTree(join(workspaceRoot, legacyPrefix));
  }
  const activeCustomFolders = new Map((safeState.customFolders ?? []).map((folder) => [folder.id, folder]));
  const previousCustomFolders = previousCurrentState?.customFolders ?? [];
  const removedFolderIds = new Set(previousCustomFolders.filter((folder) => !activeCustomFolders.has(folder.id)).map((folder) => folder.id));
  for (const folder of previousCustomFolders) {
    const previousPath = customFolderRelativePath(folder, workspaceKind, previousCurrentState?.structureLanguage);
    const currentFolder = activeCustomFolders.get(folder.id);
    if (currentFolder) {
      const currentPath = customFolderRelativePath(currentFolder, workspaceKind, structureLanguage);
      if (normalizedRelative(previousPath) !== normalizedRelative(currentPath)) {
        await mergeMoveDirectory(join(workspaceRoot, previousPath), join(workspaceRoot, currentPath));
      }
      continue;
    }
    if (removedFolderIds.has(folder.parentLocationId)) continue;
    const trashEntry = safeState.trash.find((entry) => (entry.customFolders ?? []).some((record) => record.id === folder.id));
    if (!trashEntry) {
      await pruneEmptyDirectoryTree(join(workspaceRoot, previousPath));
      continue;
    }
    const trashId = trashEntry.trashId;
    const archiveFolder = safeName(trashId);
    trashManifest[trashId] ??= {
      folder: archiveFolder,
      kind: trashEntry.kind ?? "tree",
      title: trashEntry.title ?? folder.label,
      expiresAtIso: trashEntry.expiresAtIso ?? new Date(Date.now() + TRASH_RETENTION_MS).toISOString(),
      documentIds: trashEntryDocumentIds(trashEntry),
      paths: [],
    };
    trashManifest[trashId].customFolderIds = [...new Set([
      ...(trashManifest[trashId].customFolderIds ?? []),
      ...(trashEntry.customFolders ?? []).map((record) => record.id),
    ])];
    trashManifest[trashId].folderPaths = [...new Set([
      ...(trashManifest[trashId].folderPaths ?? []),
      previousPath.replaceAll("\\", "/"),
    ])];
    await mergeMoveDirectory(
      join(workspaceRoot, previousPath),
      resolve(trashRoot, archiveFolder, previousPath),
    );
  }

  const historyRoot = join(internalRoot, "history-isolated");
  const currentConversations = (safeState.conversations ?? []).map(({ snapshots, isolatedBranches, ...conversation }) => scrubConfidentialMetadata(conversation));
  const conversationState = Object.fromEntries((safeState.conversations ?? []).map((conversation) => [conversation.id, {
    snapshots: compactSnapshotStoreForStorage(scrubConfidentialMetadata(conversation.snapshots ?? {})),
    isolatedBranches: scrubConfidentialMetadata(conversation.isolatedBranches ?? []),
  }]));
  const safeSettings = portableGenerationSettings(safeState.settings ?? {});
  delete safeSettings.shensiRoot;
  delete safeSettings.workspacePath;
  const currentState = scrubConfidentialMetadata({
    schemaVersion: 9,
    workspaceKind,
    mediaWorkspaceVersion: safeState.mediaWorkspaceVersion ?? 0,
    structureWorkspaceVersion: safeState.structureWorkspaceVersion ?? 0,
    historyScopeVersion: safeState.historyScopeVersion ?? 0,
    projectName: safeState.projectName,
    sourceMigration: safeState.sourceMigration ?? null,
    theme: safeState.theme,
    layout: safeState.layout ?? null,
    activeModule: safeState.activeModule,
    activeDocument: safeState.activeDocument,
    activeConversationId: safeState.activeConversationId,
    expandedFolders: safeState.expandedFolders ?? [],
    directoryOrders: safeState.directoryOrders ?? {},
    authorCockpitReportOrder: safeState.authorCockpitReportOrder ?? [],
    moduleViews: safeState.moduleViews ?? {},
    moduleLastDocuments: safeState.moduleLastDocuments ?? {},
    moduleItems: safeState.moduleItems,
    customFolders: safeState.customFolders ?? [],
    documents: compactCurrentDocuments(safeState.documents, { manifest, externalizeContent: true, workspaceKind }),
    messages: safeState.messages,
    currentCandidate: safeState.currentCandidate,
    currentCandidateTarget: safeState.currentCandidateTarget ?? null,
    currentCandidateMemoryUpdate: safeState.currentCandidateMemoryUpdate ?? null,
    memoryStore: safeState.memoryStore ?? null,
    pendingInlineEdits: safeState.pendingInlineEdits ?? [],
    workspaceAssets: safeState.workspaceAssets ?? [],
    selectedText: safeState.selectedText,
    currentVersionMeta: safeState.currentVersionMeta ?? { documents: {}, views: {}, volumes: {}, modules: {}, project: null },
    longFormJobs: safeState.longFormJobs ?? [],
    documentTransactionLog: safeState.documentTransactionLog ?? {},
    fullTextImports: safeState.fullTextImports ?? {},
    conversations: currentConversations,
    activities: safeState.activities ?? [],
    trash: safeState.trash ?? [],
    settings: safeSettings,
    savedAt: new Date().toISOString(),
  });
  const isolatedState = scrubConfidentialMetadata({
    histories: safeState.histories ?? {},
    viewHistories: safeState.viewHistories ?? {},
    volumeHistories: safeState.volumeHistories ?? {},
    moduleHistories: safeState.moduleHistories ?? {},
    moduleHistoriesDeferred: safeState.moduleHistoriesDeferred === true,
    moduleHistoryScopesLoaded: safeState.moduleHistoryScopesLoaded ?? [],
    projectHistories: (safeState.projectHistories ?? []).map(compactProjectVersionForStorage),
    snapshots: compactSnapshotStoreForStorage(safeState.snapshots ?? {}),
    isolatedBranches: safeState.isolatedBranches ?? [],
    conversationState,
    rollbackDocumentObjects: safeState.rollbackDocumentObjects ?? {},
  });

  await atomicWrite(manifestPath, JSON.stringify({ schemaVersion: 2, manifest }, null, 2));
  await atomicWrite(trashManifestPath, JSON.stringify({ schemaVersion: 1, entries: trashManifest }, null, 2));
  await atomicWrite(join(internalRoot, "current-state.json"), JSON.stringify(currentState, null, workspaceKind === "notebook" ? 0 : 2));
  await saveIsolatedHistoryState({ historyRoot, isolatedState });
  return {
    workspaceRoot,
    documentCount: Object.keys(manifest).length,
    manifest,
    savedAt: currentState.savedAt,
  };
};

const transactionStatePayload = (state) => {
  const payload = scrubConfidentialMetadata(state ?? {});
  payload.settings = portableGenerationSettings(payload.settings ?? {});
  delete payload.settings.shensiRoot;
  delete payload.settings.workspacePath;
  // Keep the loader-verified external baseline through optimistic-lock
  // validation and the transaction journal. saveWorkspaceStateCore compacts
  // it again before current-state persistence, so this transient marker never
  // becomes a durable bypass for a later unrelated edit.
  payload.documents = compactCurrentDocuments(payload.documents, { preserveExternalBaseline: true });
  return payload;
};

const workspaceExternalModification = (message) => Object.assign(new Error(message), {
  code: "WORKSPACE_STATE_CONFLICT",
  statusCode: 409,
});

const validateWorkspaceSavePreconditions = async ({ workspaceRoot, state, dirtyDocumentIds = null }) => {
  const previousManifest = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "manifest.json"));
  if (!previousManifest) {
    if (await containsMarkdown(workspaceRoot)) {
      throw new Error("目标作品目录包含尚未接管的 Markdown 文档。为防止覆盖，请先执行作品导入。 ");
    }
    return;
  }
  const desiredIds = new Set(Object.keys(state.documents ?? {}));
  const workspaceKind = state.workspaceKind === "notebook" ? "notebook" : "project";
  const structureLanguage = normalizeStructureLanguage(state.structureLanguage);
  const documentPaths = collisionSafeDocumentPaths({ documents: state.documents, workspaceKind, structureLanguage, previousManifest });
  for (const [id, documentState] of Object.entries(state.documents ?? {})) {
    if (dirtyDocumentIds instanceof Set && !dirtyDocumentIds.has(id) && previousManifest.manifest?.[id]) continue;
    const relativePath = documentPaths.get(id) ?? relativeDocumentPath(id, documentState, workspaceKind, structureLanguage);
    const { relativePath: normalizedPath, targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: `文档“${documentState.title || id}”` });
    const desiredHash = hashText(serializedWorkspaceDocument({ id, documentState, workspaceKind }));
    const previousEntry = previousManifest.manifest?.[id];
    const rawExpectedPath = typeof previousEntry === "string" ? previousEntry : previousEntry?.path;
    const expectedPath = rawExpectedPath
      ? normalizeManagedRelativePath(rawExpectedPath, { label: `文档“${documentState.title || id}”的历史清单` })
      : null;
    if (!previousEntry) {
      const targetHash = await pathHashIfExists(targetPath);
      if (targetHash && targetHash !== desiredHash) throw new Error(`${documentState.title} 的目标文件已存在但未受神思管理，已停止写入`);
      continue;
    }
    if (expectedPath === normalizedPath && previousEntry.hash === desiredHash) {
      const currentHash = await pathHashIfExists(targetPath);
      const acceptedExternalBaseline = documentState.externalContentChanged === true
        && documentState.contentRef?.hash
        && documentState.contentRef.hash === currentHash;
      const semanticallyMatches = currentHash && currentHash !== desiredHash
        ? await serializedDocumentSemanticallyMatches({ targetPath, documentState, workspaceKind })
        : false;
      if (currentHash && currentHash !== previousEntry.hash && !acceptedExternalBaseline && !semanticallyMatches) {
        throw workspaceExternalModification(`${documentState.title} 已被外部修改，正在合并磁盘版本与本地草稿`);
      }
      continue;
    }
    if (expectedPath !== normalizedPath) {
      const { targetPath: oldTarget } = await secureManagedTarget(workspaceRoot, expectedPath, { label: `文档“${documentState.title || id}”的旧位置` });
      const [oldHash, targetHash] = await Promise.all([
        pathHashIfExists(oldTarget),
        pathHashIfExists(targetPath),
      ]);
      if (oldHash !== previousEntry.hash) throw workspaceExternalModification(`${documentState.title} 已被外部修改，正在合并磁盘版本与本地草稿`);
      if (targetHash && targetHash !== desiredHash) throw new Error(`${documentState.title} 的新路径已经存在，已停止重命名`);
      continue;
    }
    const currentHash = await pathHashIfExists(targetPath);
    const acceptedExternalBaseline = documentState.externalContentChanged === true
      && documentState.contentRef?.hash
      && documentState.contentRef.hash === currentHash;
    const semanticallyMatches = currentHash && currentHash !== desiredHash
      ? await serializedDocumentSemanticallyMatches({ targetPath, documentState, workspaceKind })
      : false;
    if (currentHash && currentHash !== previousEntry.hash && currentHash !== desiredHash && !acceptedExternalBaseline && !semanticallyMatches) {
      throw workspaceExternalModification(`${documentState.title} 已被外部修改，正在合并磁盘版本与本地草稿`);
    }
  }
  for (const [id, previousEntry] of Object.entries(previousManifest.manifest ?? {})) {
    if (desiredIds.has(id)) continue;
    const previousPath = typeof previousEntry === "string" ? previousEntry : previousEntry?.path;
    const { targetPath } = await secureManagedTarget(workspaceRoot, previousPath, { label: `已删除文档“${id}”` });
    const currentHash = await pathHashIfExists(targetPath);
    if (currentHash && previousEntry.hash && currentHash !== previousEntry.hash) {
      throw workspaceExternalModification(`${basename(previousPath)} 已被外部修改，正在保留磁盘版本并合并本地状态`);
    }
  }
};

const transactionDirectories = async (transactionsRoot) => {
  try {
    return (await readdir(transactionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(transactionsRoot, entry.name))
      .sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

const readWorkspaceStateForRollback = async (workspaceRoot) => {
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  const [currentState, manifestState] = await Promise.all([
    readJsonIfExists(join(internalRoot, "current-state.json")),
    readJsonIfExists(join(internalRoot, "manifest.json")),
  ]);
  if (!currentState) return null;
  const isolatedState = await loadIsolatedHistoryState(join(internalRoot, "history-isolated"));
  const safeCurrent = scrubConfidentialMetadata(currentState);
  safeCurrent.settings = portableGenerationSettings(safeCurrent.settings ?? {});
  delete safeCurrent.settings.workspacePath;
  safeCurrent.documents = await hydrateCurrentDocumentsFromWorkspace({
    workspaceRoot,
    documents: safeCurrent.documents ?? {},
    manifest: manifestState?.manifest ?? {},
  });
  const safeIsolated = scrubConfidentialMetadata(isolatedState ?? {});
  const conversations = (safeCurrent.conversations ?? []).map((conversation) => ({
    ...conversation,
    ...(safeIsolated.conversationState?.[conversation.id] ?? {}),
  }));
  return { ...safeCurrent, ...safeIsolated, conversations };
};

const rollbackFreshWorkspaceTransaction = async ({ workspaceRoot, directory }) => {
  const desiredState = await readTransactionJson(directory, "desired-state");
  if (!desiredState) throw new Error("首次落盘事务缺少目标快照");
  const workspaceKind = desiredState.workspaceKind === "notebook" ? "notebook" : "project";
  const structureLanguage = normalizeStructureLanguage(desiredState.structureLanguage);
  const createdDocumentDirectories = new Set();
  for (const [id, documentState] of Object.entries(desiredState.documents ?? {})) {
    const relativePath = relativeDocumentPath(id, documentState, workspaceKind, structureLanguage);
    const { targetPath } = await secureManagedTarget(workspaceRoot, relativePath, { label: `首次落盘回滚文档“${documentState.title || id}”` });
    await rm(targetPath, { force: true });
    createdDocumentDirectories.add(dirname(targetPath));
  }
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  for (const name of ["manifest.json", "trash-manifest.json", "current-state.json", "history-isolated", "recycle-bin"]) {
    await rm(join(internalRoot, name), { recursive: true, force: true });
  }
  for (const directoryPath of createdDocumentDirectories) await pruneEmptyDirectoryTree(directoryPath);
};

const rollbackWorkspaceTransaction = async ({ appRoot, workspaceRoot, directory, journal }) => {
  const rollbackState = await readTransactionJson(directory, "rollback-state");
  if (!rollbackState) throw new Error(`事务 ${journal.id} 缺少回滚快照，拒绝自动前滚`);
  if (rollbackState.rollbackKind === "workspace-absent") {
    await rollbackFreshWorkspaceTransaction({ workspaceRoot, directory });
    return;
  }
  await saveWorkspaceStateCore({ appRoot, requestedPath: workspaceRoot, state: rollbackState, transactionRollback: true });
};

const recoverPendingWorkspaceTransactions = async ({ appRoot, workspaceRoot }) => {
  const transactionsRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "transactions");
  const directories = await transactionDirectories(transactionsRoot);
  let recovered = 0;
  for (const directory of directories) {
    const journalPath = join(directory, "journal.json");
    const journal = await readJsonIfExists(journalPath);
    if (!journal) {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    if (journal.status === "committed") {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    if (journal.status === "prepared" && Number(journal.schemaVersion) >= 2) {
      await rm(directory, { recursive: true, force: true });
      continue;
    }
    if (!["applying", "rollback_pending", "pending", "recovering"].includes(journal.status)) {
      throw new Error(`未完成事务 ${journal.id} 状态未知，已停止自动处理`);
    }
    await atomicWrite(journalPath, JSON.stringify({
      ...journal,
      status: "rollback_pending",
      recoveryStartedAt: new Date().toISOString(),
    }, null, 2));
    try {
      await rollbackWorkspaceTransaction({ appRoot, workspaceRoot, directory, journal });
      await atomicWrite(journalPath, JSON.stringify({
        ...journal,
        status: "rolled_back",
        rolledBackDuringRecovery: true,
        rolledBackAt: new Date().toISOString(),
      }, null, 2));
      await rm(directory, { recursive: true, force: true });
      recovered += 1;
    } catch (error) {
      await atomicWrite(journalPath, JSON.stringify({
        ...journal,
        status: "rollback_pending",
        lastError: error.message,
        updatedAt: new Date().toISOString(),
      }, null, 2));
      throw new Error(`失败事务 ${journal.id} 无法安全回滚：${error.message}`);
    }
  }
  return recovered;
};

const workspaceStateConflict = (message = "作品已在另一个窗口或任务中更新，请重新加载后再保存") => Object.assign(new Error(message), {
  code: "WORKSPACE_STATE_CONFLICT",
  statusCode: 409,
});

export const saveWorkspaceState = async ({ appRoot, requestedPath, state, expectedStateStamp = "", workspaceLockToken = "", operationDocumentIds = null, operationVerification = null }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  return enqueueWorkspaceWrite(workspaceRoot, async () => {
    // A stale window may queue a save with the pre-rename path. Resolve the
    // alias again after earlier queue work completes so it cannot recreate the
    // old directory after a successful rename.
    const canonicalWorkspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
    if (normalizeForCompare(canonicalWorkspaceRoot) !== normalizeForCompare(workspaceRoot)) {
      return saveWorkspaceState({
        appRoot,
        requestedPath: canonicalWorkspaceRoot,
        state,
        expectedStateStamp,
        workspaceLockToken,
        operationDocumentIds,
        operationVerification,
      });
    }
    return withWorkspaceFileLock(workspaceRoot, async () => {
    const recoveredTransactions = await recoverPendingWorkspaceTransactions({ appRoot, workspaceRoot });
    if (expectedStateStamp) {
      const currentStateStamp = await workspaceStateStampForRoot(workspaceRoot);
      if (currentStateStamp !== expectedStateStamp) throw workspaceStateConflict();
    }
    const currentState = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "current-state.json"));
    if (currentState?.savedAt && state?.savedAt && currentState.savedAt !== state.savedAt) {
      throw workspaceStateConflict();
    }
    let requestedState = state ?? {};
    if (requestedState.statePatch?.mode === "preserve-current-v1") {
      if (!currentState) throw new Error("增量状态保存缺少工作区基线，请重新加载后重试");
      const completeCurrentState = await readWorkspaceStateForRollback(workspaceRoot) ?? currentState;
      requestedState = {
        ...completeCurrentState,
        ...requestedState,
        documents: requestedState.documents ?? {},
      };
      delete requestedState.statePatch;
    }
    requestedState = await mergeDeferredRollbackObjects({ workspaceRoot, state: requestedState });
    let dirtyDocumentIds = null;
    if (requestedState.documentPatch?.mode === "delta-v1") {
      if (!currentState) throw new Error("增量保存缺少工作区基线，请重新加载后重试");
      const desiredIds = new Set((requestedState.documentPatch.documentIds ?? []).map(String));
      const changedDocuments = requestedState.documents ?? {};
      dirtyDocumentIds = new Set(Object.keys(changedDocuments));
      requestedState = {
        ...requestedState,
        documents: Object.fromEntries([...desiredIds].map((id) => [id, changedDocuments[id] ?? currentState.documents?.[id]]).filter(([, value]) => value)),
      };
      delete requestedState.documentPatch;
    }
    const transactionId = `tx-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID()}`;
    const transactionRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "transactions", transactionId);
    const journalPath = join(transactionRoot, "journal.json");
    const desiredState = transactionStatePayload(requestedState);
    const rollbackState = await readWorkspaceStateForRollback(workspaceRoot);
    const previousManifest = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "manifest.json"));
    const changedDocumentIds = Object.entries(desiredState.documents || {}).filter(([id, document]) => {
      if (!rollbackState?.documents?.[id] || document?.kind === "canvas" || document?.documentKind === "whiteboard" || (dirtyDocumentIds && !dirtyDocumentIds.has(id))) return false;
      const previous = previousManifest?.manifest?.[id];
      return previous && hashText(serializedWorkspaceDocument({ id, documentState: document, workspaceKind: desiredState.workspaceKind })) !== previous.hash;
    }).map(([id]) => id);
    const prewriteHistory = await prepareFullPrewriteHistory({ currentState: rollbackState, nextState: desiredState, changedDocumentIds, transactionId });
    if (rollbackState && prewriteHistory.length) {
      // Preserve these before-images even if the write must roll back.
      rollbackState.histories ??= {};
      for (const { documentId } of prewriteHistory) rollbackState.histories[documentId] = desiredState.histories[documentId];
    }
    const verifiedResult = async (result) => {
      const committedAt = new Date().toISOString();
      const batchLandingReceipt = await verifyCommittedWorkspaceDocuments({
        workspaceRoot,
        transactionId,
        manifest: result.manifest,
        previousManifest,
        desiredState,
        dirtyDocumentIds,
        operationDocumentIds,
        operationVerification,
        committedAt,
      });
      return { ...result, batchLandingReceipt, prewriteHistory, verificationStatus: "passed", verifiedAt: committedAt };
    };
    await validateWorkspaceSavePreconditions({ workspaceRoot, state: desiredState, dirtyDocumentIds });
    await mkdir(transactionRoot, { recursive: true });
    await Promise.all([
      writeTransactionJson(transactionRoot, "desired-state", desiredState),
      writeTransactionJson(transactionRoot, "rollback-state", rollbackState
        ? transactionStatePayload(rollbackState)
        : { schemaVersion: 2, rollbackKind: "workspace-absent" }),
    ]);
    const journal = {
      schemaVersion: 3,
      id: transactionId,
      status: "prepared",
      workspaceRoot,
      createdAt: new Date().toISOString(),
      desiredStateHash: hashText(JSON.stringify(desiredState)),
      snapshotFormat: "gzip-json",
    };
    await atomicWrite(journalPath, JSON.stringify(journal, null, 2));
    if (prewriteHistory.length) {
      const historyRoot = join(resolveWorkspaceInternalRoot(workspaceRoot), "history-isolated");
      maybeInjectWorkspaceTestFault("before-prewrite-history");
      await saveIsolatedHistoryState({ historyRoot, isolatedState: rollbackState });
      const savedHistory = await loadIsolatedHistoryState(historyRoot);
      await verifyFullPrewriteHistory({ histories: savedHistory?.histories, receipts: prewriteHistory });
      maybeInjectWorkspaceTestFault("after-prewrite-history");
    }
    await atomicWrite(journalPath, JSON.stringify({ ...journal, status: "applying", applyingAt: new Date().toISOString() }, null, 2));
    maybeInjectWorkspaceTestFault("after-journal-applying");
    try {
      maybeInjectWorkspaceTestFault("before-save-core");
      const result = await verifiedResult(await saveWorkspaceStateCore({ appRoot, requestedPath: workspaceRoot, state: desiredState, dirtyDocumentIds }));
      await atomicWrite(journalPath, JSON.stringify({ ...journal, status: "committed", committedAt: new Date().toISOString() }, null, 2));
      await rm(transactionRoot, { recursive: true, force: true });
      const stateStamp = await workspaceStateStampForRoot(workspaceRoot);
      return { ...result, transactionId, recoveredTransactions, stateStamp };
    } catch (firstError) {
      try {
        maybeInjectWorkspaceTestFault("before-save-core");
        const result = await verifiedResult(await saveWorkspaceStateCore({ appRoot, requestedPath: workspaceRoot, state: desiredState, dirtyDocumentIds }));
        await atomicWrite(journalPath, JSON.stringify({
          ...journal,
          status: "committed",
          recoveredDuringRequest: true,
          firstError: firstError.message,
          committedAt: new Date().toISOString(),
        }, null, 2));
        await rm(transactionRoot, { recursive: true, force: true });
        const stateStamp = await workspaceStateStampForRoot(workspaceRoot);
        return { ...result, transactionId, recoveredTransactions, recoveredDuringRequest: true, stateStamp };
      } catch (retryError) {
        await atomicWrite(journalPath, JSON.stringify({
          ...journal,
          status: "rollback_pending",
          firstError: firstError.message,
          retryError: retryError.message,
          updatedAt: new Date().toISOString(),
        }, null, 2));
        try {
          await rollbackWorkspaceTransaction({ appRoot, workspaceRoot, directory: transactionRoot, journal });
          await atomicWrite(journalPath, JSON.stringify({ ...journal, status: "rolled_back", rolledBackAt: new Date().toISOString() }, null, 2));
          await rm(transactionRoot, { recursive: true, force: true });
          const rolledBackError = new Error(`落盘事务失败且已回滚：${firstError.message}`);
          if (firstError.code) rolledBackError.code = firstError.code;
          if (firstError.statusCode) rolledBackError.statusCode = firstError.statusCode;
          throw rolledBackError;
        } catch (rollbackError) {
          if (rollbackError.message.startsWith("落盘事务失败且已回滚：")) throw rollbackError;
          await atomicWrite(journalPath, JSON.stringify({
            ...journal,
            status: "rollback_pending",
            firstError: firstError.message,
            retryError: retryError.message,
            rollbackError: rollbackError.message,
            updatedAt: new Date().toISOString(),
          }, null, 2));
          throw new Error(`落盘失败且回滚尚未完成：${firstError.message}；${rollbackError.message}`);
        }
      }
    }
    }, { workspaceLockToken });
  });
};

const workspaceStampPart = async (path) => {
  const info = await stat(path).catch(() => null);
  return info ? `${info.size}:${Math.trunc(info.mtimeMs)}` : "-";
};

const workspaceContentStampForRoot = async (workspaceRoot) => {
  const manifestState = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "manifest.json"));
  const entries = Object.entries(manifestState?.manifest ?? {})
    .map(([id, entry]) => [id, typeof entry === "string" ? entry : entry?.path])
    .filter(([, path]) => Boolean(path))
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  if (!entries.length) return "-";
  const parts = [];
  // Reuse link validation results for every managed document in this stamp.
  // The checks remain per-path and still reject links escaping the workspace;
  // sharing the cache only avoids repeating identical realpath/lstat work for
  // large manifests.
  const linkValidationCache = new Map();
  for (let offset = 0; offset < entries.length; offset += 200) {
    const batch = entries.slice(offset, offset + 200);
    const batchParts = await Promise.all(batch.map(async ([id, path]) => {
      try {
        const { targetPath } = await secureManagedTarget(workspaceRoot, path, {
          label: `清单文档“${id}”`,
          linkValidationCache,
        });
        return `${id}:${await workspaceStampPart(targetPath)}`;
      } catch {
        return `${id}:invalid`;
      }
    }));
    parts.push(...batchParts);
  }
  return createHash("sha256").update(parts.join("\n")).digest("hex");
};

const workspaceStateStampForRoot = async (workspaceRoot) => {
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  const parts = await Promise.all([
    workspaceStampPart(join(internalRoot, "current-state.json")),
    workspaceStampPart(join(internalRoot, "history-isolated")),
    workspaceStampPart(join(internalRoot, "history-isolated", "index.json")),
    workspaceStampPart(join(internalRoot, "transactions")),
    workspaceContentStampForRoot(workspaceRoot),
  ]);
  return parts.join("|");
};

export const getWorkspaceStateStamp = async ({ appRoot, requestedPath }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  return { workspaceRoot, stateStamp: await workspaceStateStampForRoot(workspaceRoot) };
};

export const loadWorkspaceState = async ({ appRoot, requestedPath }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  try {
    const pendingTransactions = await transactionDirectories(join(internalRoot, "transactions"));
    const recoveredTransactions = pendingTransactions.length
      ? await enqueueWorkspaceWrite(workspaceRoot, () => withWorkspaceFileLock(
        workspaceRoot,
        () => recoverPendingWorkspaceTransactions({ appRoot, workspaceRoot }),
      ))
      : 0;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const beforeStamp = await workspaceStateStampForRoot(workspaceRoot);
      const [currentText, isolatedText, manifestState] = await Promise.all([
        readFile(join(internalRoot, "current-state.json"), "utf8"),
        loadIsolatedHistoryState(join(internalRoot, "history-isolated"), { deferModuleHistories: true, deferRollbackObjects: true }),
        readJsonIfExists(join(internalRoot, "manifest.json")),
      ]);
      const parsedCurrentState = JSON.parse(currentText);
      const migratedPaths = migrateLegacyBusinessPathsInValue(parsedCurrentState, {
        workspaceRoot,
        aliases: registeredWorkspaceAliasesForTarget(workspaceRoot),
      });
      if (migratedPaths.changed) {
        await atomicWrite(
          join(internalRoot, "current-state.json"),
          JSON.stringify(migratedPaths.value, null, parsedCurrentState.workspaceKind === "notebook" ? 0 : 2),
        );
        continue;
      }
      const currentState = scrubConfidentialMetadata(parsedCurrentState);
      currentState.settings = portableGenerationSettings(currentState.settings ?? {});
      delete currentState.settings.workspacePath;
      currentState.documents = await hydrateCurrentDocumentsFromWorkspace({
        workspaceRoot,
        documents: currentState.documents ?? {},
        manifest: manifestState?.manifest ?? {},
      });
      const afterStamp = await workspaceStateStampForRoot(workspaceRoot);
      if (beforeStamp !== afterStamp) {
        if (attempt === 0) continue;
        throw new Error("工作区正在由另一个任务更新，请稍后重试");
      }
      currentState.trash = pruneTrashEntries(currentState.trash ?? []).active;
      const isolatedState = scrubConfidentialMetadata(isolatedText ?? {});
      const conversations = (currentState.conversations ?? []).map((conversation) => ({
        ...conversation,
        ...(isolatedState.conversationState?.[conversation.id] ?? {}),
      }));
      const rollbackObjectCount = Math.max(
        Number(isolatedState.rollbackDocumentObjectCount) || 0,
        Object.keys(isolatedState.rollbackDocumentObjects ?? {}).length,
      );
      const {
        conversationState: _mergedConversationState,
        rollbackDocumentObjectCount: _rollbackDocumentObjectCount,
        rollbackDocumentObjectsDeferred: _rollbackDocumentObjectsDeferred,
        ...isolatedStateWithoutConversationIndex
      } = isolatedState;
      const lightweightIsolatedState = {
        ...isolatedStateWithoutConversationIndex,
        // Conversation snapshots retain stable object keys. The corresponding
        // document bodies are fetched only when the author actually rolls a
        // message back, instead of transferring every historical document on
        // each project/notebook switch.
        rollbackDocumentObjects: {},
        rollbackDocumentObjectsDeferred: _rollbackDocumentObjectsDeferred === true || rollbackObjectCount > 0,
      };
      return {
        workspaceRoot,
        state: { ...currentState, ...lightweightIsolatedState, conversations },
        sharedObsidian: false,
        recovery: { recoveredTransactions },
        stateStamp: afterStamp,
      };
    }
  } catch (error) {
    if (error.code === "ENOENT") return {
      workspaceRoot,
      state: null,
      sharedObsidian: false,
      stateStamp: await workspaceStateStampForRoot(workspaceRoot),
    };
    throw error;
  }
};

export const loadWorkspaceCurrentContent = async ({ appRoot, requestedPath }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  const [currentState, manifestState] = await Promise.all([
    readJsonIfExists(join(internalRoot, "current-state.json")),
    readJsonIfExists(join(internalRoot, "manifest.json")),
  ]);
  if (!currentState) return { workspaceRoot, projectName: basename(workspaceRoot), documents: {} };
  const safeState = scrubConfidentialMetadata(currentState);
  return {
    workspaceRoot,
    projectName: safeState.projectName || basename(workspaceRoot),
    workspaceKind: safeState.workspaceKind === "notebook" ? "notebook" : "project",
    workspaceAssets: Array.isArray(safeState.workspaceAssets) ? safeState.workspaceAssets : [],
    savedAt: String(safeState.savedAt || ""),
    documents: await hydrateCurrentDocumentsFromWorkspace({
      workspaceRoot,
      documents: safeState.documents ?? {},
      manifest: manifestState?.manifest ?? {},
    }),
  };
};

// Directory pickers need placement metadata, never full document bodies.
// Reading hundreds of externalized Markdown/whiteboard files here made a
// simple move operation scale with the size of every workspace on the machine.
export const loadWorkspaceDirectoryState = async ({ appRoot, requestedPath }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  const currentState = await readJsonIfExists(join(internalRoot, "current-state.json"));
  if (!currentState) return { workspaceRoot, state: null };
  const safeState = scrubConfidentialMetadata(currentState);
  safeState.settings = portableGenerationSettings(safeState.settings ?? {});
  delete safeState.settings.workspacePath;
  return { workspaceRoot, state: safeState };
};

export const importWorkspaceState = async ({ appRoot, requestedPath, refresh = false }) => {
  const workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
  const existing = await loadWorkspaceState({ appRoot, requestedPath });
  if (existing.state && !refresh) return { workspaceRoot, mode: "managed", state: existing.state };

  const previousManifest = await readJsonIfExists(join(resolveWorkspaceInternalRoot(workspaceRoot), "manifest.json"));
  const preferredIdsByPath = new Map();
  for (const [id, documentState] of Object.entries(existing.state?.documents ?? {})) {
    if (documentState.sourcePath) preferredIdsByPath.set(normalizedRelative(documentState.sourcePath), id);
  }
  for (const [id, entry] of Object.entries(previousManifest?.manifest ?? {})) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (path && !preferredIdsByPath.has(normalizedRelative(path))) preferredIdsByPath.set(normalizedRelative(path), id);
  }
  const hashOwners = new Map();
  for (const [id, entry] of Object.entries(previousManifest?.manifest ?? {})) {
    const hash = typeof entry === "object" ? String(entry?.hash || "") : "";
    if (!hash) continue;
    hashOwners.set(hash, hashOwners.has(hash) ? null : id);
  }
  const preferredIdsByHash = new Map([...hashOwners].filter(([, id]) => Boolean(id)));
  const preservedDocumentsById = new Map(Object.entries(existing.state?.documents ?? {}));
  const scanned = await scanWorkspaceDocuments({ appRoot, requestedPath, preferredIdsByPath, preferredIdsByHash, preservedDocumentsById });
  const { documents } = scanned;
  const manifest = { ...(previousManifest?.manifest ?? {}), ...scanned.manifest };
  if (!Object.keys(documents).length) {
    throw new Error("作品目录中没有可导入的 Markdown 文档");
  }
  const internalRoot = resolveWorkspaceInternalRoot(workspaceRoot);
  await atomicWrite(join(internalRoot, "manifest.json"), JSON.stringify({ schemaVersion: 2, manifest }, null, 2));
  return {
    workspaceRoot,
    mode: existing.state ? "refreshed" : "imported",
    state: existing.state,
    documents,
    importedCount: Object.keys(documents).length,
  };
};
