import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { getAgentWorkspaceSearchIndex } from "./agent-workspace-search-index.mjs";
const DEFAULT_EXCLUDES = new Set([".git", ".shensi", "node_modules", "dist", "build", "release", "out", "recycle-bin", "回收站", "历史版本"]);
const HISTORY_STORAGE = /(?:^|\/)[.]shensi\/history-isolated(?:\/|$)/i;
const FORBIDDEN_CREATIVE_STORAGE = /(?:^|\/)(?:[.]shensi|recycle-bin|回收站|历史版本)(?:\/|$)/i;
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".html", ".yaml", ".yml", ".toml", ".csv"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const inside = (root, target) => {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const normalizedRelative = (root, target) => relative(root, target).replaceAll("\\", "/") || ".";
const estimateTokens = (text = "") => Math.max(1, Math.ceil(String(text).length / 2.5));
const contentHash = (buffer) => createHash("sha256").update(buffer).digest("hex");
const revisionFor = ({ size = 0, mtimeMs = 0, hash = "" } = {}) => `${Math.trunc(mtimeMs)}-${size}${hash ? `-${hash.slice(0, 16)}` : ""}`;
const canonLevelFor = (relativePath = "") => /(?:^|\/)[.]shensi\/history-isolated(?:\/|$)/i.test(relativePath)
  ? "historical_non_canon"
  : "ordinary_reference";

const authorizationError = (message) => Object.assign(new Error(message), { code: "WORKSPACE_ROOT_AUTHORIZATION_REQUIRED" });

export const createAgentWorkspaceReadBroker = async ({
  root,
  workspaceKind = "project",
  authorizedRoots = [],
  authorizedRootGrants = [],
  documentIndex = {},
  baselineRevisions = {},
  allowHistory = false,
  historyAuthorization = null,
  softBudgets = {},
  auditLogger = null,
} = {}) => {
  const requestedRoot = resolve(String(root || ""));
  const rootActual = await realpath(requestedRoot);
  if (Array.isArray(authorizedRoots) && authorizedRoots.length) {
    throw authorizationError("External workspace roots require a server-verified persisted grant or current permission receipt.");
  }
  const grants = Array.isArray(authorizedRootGrants) ? authorizedRootGrants : [];
  const verifiedExternalRoots = grants
    .filter((grant) => grant?.verifiedByServer === true
      && ["persisted_grant", "permission_receipt"].includes(String(grant?.source || ""))
      && String(grant?.grantId || grant?.receiptId || "").trim())
    .map((grant) => grant.root || grant.path)
    .filter(Boolean);
  if (grants.length !== verifiedExternalRoots.length) {
    throw authorizationError("One or more external workspace roots do not have a server-verified authorization grant.");
  }
  const roots = [];
  for (const candidate of [rootActual, ...verifiedExternalRoots]) {
    const actual = await realpath(resolve(String(candidate || ""))).catch(() => "");
    if (actual && !roots.some((entry) => entry.toLowerCase() === actual.toLowerCase())) roots.push(actual);
  }
  const budgets = {
    singleReadChars: Math.max(1_000, Number(softBudgets.singleReadChars) || 40_000),
    turnReadChars: Math.max(5_000, Number(softBudgets.turnReadChars) || 160_000),
    searchResults: Math.max(1, Math.min(100, Number(softBudgets.searchResults) || 24)),
    rangeChars: Math.max(1_000, Number(softBudgets.rangeChars) || 20_000),
    searchFiles: Math.max(1, Math.min(100_000, Number(softBudgets.searchFiles) || 10_000)),
    searchBytes: Math.max(1_000_000, Number(softBudgets.searchBytes) || 64 * 1024 * 1024),
    searchDurationMs: Math.max(100, Math.min(60_000, Number(softBudgets.searchDurationMs) || 2_000)),
  };
  const searchIndex = getAgentWorkspaceSearchIndex(rootActual, {
    maxFiles: budgets.searchFiles,
    maxScanBytes: budgets.searchBytes,
    maxDurationMs: budgets.searchDurationMs,
  });
  let turnReadChars = 0;
  const defaultHistoryAuthorization = historyAuthorization?.allowed === true
    && historyAuthorization?.readOnly === true
    && historyAuthorization?.commitBaselineEligible === false
    ? { ...historyAuthorization, canonLevel: "historical_non_canon" }
    : null;
  const audit = (entry = {}) => {
    if (typeof auditLogger !== "function") return;
    auditLogger({
      operation: String(entry.operation || ""),
      pathSummary: String(entry.pathSummary || ".").replaceAll("\\", "/").slice(0, 500),
      revision: String(entry.revision || "").slice(0, 200),
      characters: Math.max(0, Number(entry.characters) || 0),
      reason: String(entry.reason || "").slice(0, 500),
    });
  };

  const authorize = async (value = ".", { historyReason = "", historyGapId = "" } = {}) => {
    const raw = String(value || ".").trim();
    const candidates = isAbsolute(raw) ? [resolve(raw)] : roots.map((entry) => resolve(entry, raw));
    for (const candidate of candidates) {
      const actual = await realpath(candidate).catch(() => "");
      const containingRoot = actual ? roots.find((entry) => inside(entry, actual)) : "";
      if (!actual || !containingRoot) continue;
      const relativePath = normalizedRelative(containingRoot, actual);
      if (HISTORY_STORAGE.test(relativePath)) {
        throw Object.assign(new Error("历史版本不能作为普通文件遍历；请使用指定版本只读工具。"), { code: "HISTORY_READ_SEMANTIC_TOOL_REQUIRED" });
      }
      if (FORBIDDEN_CREATIVE_STORAGE.test(relativePath)) {
        throw Object.assign(new Error("回收站、退回记录与历史版本不属于模型上下文；只允许读取正式文档当前版本。"), { code: "HISTORY_READ_NOT_AUTHORIZED" });
      }
      return { actual, root: containingRoot, relativePath, historyAuthorization: null };
    }
    throw Object.assign(new Error("目标不在当前 Agent 获得授权的工作区范围内。"), { code: "WORKSPACE_READ_SCOPE_DENIED" });
  };

  const metadata = async (authorized, { includeHash = false } = {}) => {
    const fileStat = await stat(authorized.actual);
    let hash = "";
    if (includeHash && fileStat.isFile() && fileStat.size <= MAX_FILE_BYTES) hash = contentHash(await readFile(authorized.actual));
    return {
      name: authorized.relativePath.split("/").at(-1) || ".",
      path: authorized.relativePath,
      type: fileStat.isDirectory() ? "directory" : extname(authorized.actual).slice(1).toLowerCase() || "file",
      size: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
      revision: revisionFor({ size: fileStat.size, mtimeMs: fileStat.mtimeMs, hash }),
      contentHash: hash,
      workspaceKind,
      canonLevel: canonLevelFor(authorized.relativePath),
      commitBaselineEligible: canonLevelFor(authorized.relativePath) !== "historical_non_canon",
      ...(authorized.historyAuthorization?.allowed ? {
        historyReadReason: authorized.historyAuthorization.reason,
        historyGapId: authorized.historyAuthorization.gapId,
      } : {}),
    };
  };

  const structure = async () => ({
    workspaceKind,
    root: rootActual,
    modules: [...new Set(Object.values(documentIndex).map((item) => item?.moduleId).filter(Boolean))],
    documentCount: Object.keys(documentIndex).length,
    readableRoots: roots,
    permissions: { read: true, write: false, historyRead: defaultHistoryAuthorization?.allowed === true },
    softBudgets: budgets,
  });

  const collect = async ({ path = ".", depth = 1, maxRows = 10_000, historyReason = "", historyGapId = "" } = {}) => {
    const start = await authorize(path, { historyReason, historyGapId });
    const startStat = await stat(start.actual);
    if (!startStat.isDirectory()) throw Object.assign(new Error("workspace.list target must be a directory."), { code: "WORKSPACE_LIST_DIRECTORY_REQUIRED" });
    const boundedDepth = Math.max(0, Math.min(32, Number(depth) || 0));
    const boundedRows = Math.max(1, Math.min(100_000, Number(maxRows) || 10_000));
    const rows = [];
    const queue = [{ ...start, depth: 0 }];
    while (queue.length && rows.length < boundedRows) {
      const current = queue.shift();
      const children = await readdir(current.actual, { withFileTypes: true });
      for (const child of children) {
        if (child.isDirectory() && DEFAULT_EXCLUDES.has(child.name)) continue;
        const childAuth = await authorize(resolve(current.actual, child.name), { historyReason, historyGapId }).catch((error) => {
          if (["HISTORY_READ_NOT_AUTHORIZED", "WORKSPACE_READ_SCOPE_DENIED"].includes(error?.code)) return null;
          throw error;
        });
        if (!childAuth) continue;
        rows.push(await metadata(childAuth));
        if (rows.length >= boundedRows) break;
        if (child.isDirectory() && current.depth < boundedDepth) queue.push({ ...childAuth, depth: current.depth + 1 });
      }
    }
    return { rows, softBudgetExceeded: queue.length > 0 || rows.length >= boundedRows };
  };

  const list = async ({ path = ".", depth = 1, page = 1, pageSize = 100, fileTypes = [], name = "", historyReason = "", historyGapId = "" } = {}) => {
    const collected = await collect({ path, depth, maxRows: 10_000, historyReason, historyGapId });
    const rows = collected.rows.filter((row) => (
      (!fileTypes.length || fileTypes.includes(row.type))
      && (!name || row.name.toLowerCase().includes(String(name).toLowerCase()))
    ));
    const size = Math.max(1, Math.min(500, Number(pageSize) || 100));
    const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * size);
    return { items: rows.slice(offset, offset + size), page: Math.max(1, Number(page) || 1), pageSize: size, total: rows.length, hasMore: offset + size < rows.length, softBudgetExceeded: collected.softBudgetExceeded };
  };

  const search = async ({ query = "", path = ".", page = 1, pageSize = budgets.searchResults, fileTypes = [], pathFilter = "", signal = null, historyReason = "", historyGapId = "" } = {}) => {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) throw Object.assign(new Error("workspace.search requires a query."), { code: "WORKSPACE_SEARCH_QUERY_REQUIRED" });
    const collected = await collect({ path, depth: 32, maxRows: budgets.searchFiles, historyReason, historyGapId });
    const entries = collected.rows
      .filter((row) => row.type !== "directory" && row.size <= MAX_FILE_BYTES
        && (!fileTypes.length || fileTypes.includes(row.type))
        && (!pathFilter || row.path.includes(pathFilter)))
      .map((row) => ({ ...row, textEligible: TEXT_EXTENSIONS.has(`.${row.type}`) }));
    const indexed = await searchIndex.search({
      entries,
      query: needle,
      signal,
      budgets: { maxFiles: budgets.searchFiles, maxScanBytes: budgets.searchBytes, maxDurationMs: budgets.searchDurationMs },
      loadText: async (entry) => {
        if (entry.textEligible !== true) return "";
        const authorized = await authorize(entry.path, { historyReason, historyGapId });
        return await readFile(authorized.actual, "utf8").catch(() => "");
      },
    });
    const results = indexed.matches.map(({ entry, matchOffset, snippet }) => {
      const { textEligible, ...row } = entry;
      return { ...row, matchOffset, snippet, tokenEstimate: estimateTokens(snippet), source: "agent_workspace_search_index", explicit: false, discoveredByAgent: true };
    });
    const size = Math.max(1, Math.min(100, Number(pageSize) || budgets.searchResults));
    const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * size);
    const softBudgetExceeded = collected.softBudgetExceeded || indexed.softBudgetExceeded;
    audit({ operation: "search", pathSummary: path, characters: results.reduce((sum, item) => sum + item.snippet.length, 0), reason: softBudgetExceeded ? "soft_budget_exceeded" : "query_completed" });
    return { items: results.slice(offset, offset + size), total: results.length, page: Math.max(1, Number(page) || 1), pageSize: size, hasMore: offset + size < results.length, softBudgetExceeded, telemetry: indexed.telemetry };
  };

  const readRange = async ({ path, startLine = 0, endLine = 0, start = 0, end = 0, explicit = false, historyReason = "", historyGapId = "" } = {}) => {
    const authorized = await authorize(path, { historyReason, historyGapId });
    const fileStat = await stat(authorized.actual);
    if (!fileStat.isFile()) throw Object.assign(new Error("workspace.read target must be a file."), { code: "WORKSPACE_READ_FILE_REQUIRED" });
    if (fileStat.size > MAX_FILE_BYTES) throw Object.assign(new Error("File is too large for the workspace text reader."), { code: "WORKSPACE_READ_FILE_TOO_LARGE" });
    const text = await readFile(authorized.actual, "utf8");
    const hash = contentHash(text);
    let rangeStart = Math.max(0, Number(start) || 0);
    let rangeEnd = Number(end) > rangeStart ? Math.min(text.length, Number(end)) : Math.min(text.length, rangeStart + budgets.singleReadChars);
    if (Number(startLine) > 0 || Number(endLine) > 0) {
      const lines = text.split(/\r?\n/);
      const from = Math.max(1, Number(startLine) || 1);
      const to = Math.max(from, Math.min(lines.length, Number(endLine) || from + 199));
      rangeStart = lines.slice(0, from - 1).join("\n").length + (from > 1 ? 1 : 0);
      rangeEnd = rangeStart + lines.slice(from - 1, to).join("\n").length;
    }
    rangeEnd = Math.min(rangeEnd, rangeStart + budgets.rangeChars);
    const content = text.slice(rangeStart, rangeEnd);
    turnReadChars += content.length;
    const result = {
      ...(await metadata(authorized)),
      content,
      actualRange: { start: rangeStart, end: rangeEnd },
      truncated: rangeStart > 0 || rangeEnd < text.length,
      remaining: Math.max(0, text.length - rangeEnd),
      revision: revisionFor({ size: fileStat.size, mtimeMs: fileStat.mtimeMs, hash }),
      contentHash: hash,
      characters: content.length,
      tokenEstimate: estimateTokens(content),
      source: "agent_workspace_read",
      explicit: explicit === true,
      discoveredByAgent: explicit !== true,
      softBudgetExceeded: turnReadChars > budgets.turnReadChars,
    };
    audit({ operation: "read", pathSummary: result.path, revision: result.revision, characters: result.characters, reason: result.truncated ? "bounded_range" : "complete_file" });
    return result;
  };

  const read = async ({ path, explicit = false, historyReason = "", historyGapId = "" } = {}) => readRange({ path, start: 0, end: budgets.singleReadChars, explicit, historyReason, historyGapId });
  const resolveReference = async ({ reference = "", currentTarget = "", historyReason = "", historyGapId = "" } = {}) => {
    const value = String(reference || currentTarget || "").replace(/^shensi:\/\/document\//, "");
    const indexed = documentIndex[value];
    const target = indexed?.path || indexed?.sourcePath || value;
    const authorized = await authorize(target, { historyReason, historyGapId });
    return { ...(await metadata(authorized)), documentId: indexed ? value : "", registered: Boolean(indexed), source: indexed ? "document_index" : "workspace_path" };
  };
  const documentRevision = async ({ path = "", documentId = "", expectedRevision = "", historyReason = "", historyGapId = "" } = {}) => {
    const resolved = await resolveReference({ reference: documentId || path, historyReason, historyGapId });
    const authorized = await authorize(resolved.path, { historyReason, historyGapId });
    const current = await metadata(authorized, { includeHash: true });
    const baseline = String(expectedRevision || baselineRevisions[documentId || resolved.path] || "");
    const commitBaselineEligible = current.canonLevel !== "historical_non_canon";
    return { ...current, expectedRevision: commitBaselineEligible ? baseline : "", matchesExpected: commitBaselineEligible && (!baseline || baseline === current.revision), concurrentlyModified: commitBaselineEligible && Boolean(baseline && baseline !== current.revision), commitBaselineEligible };
  };

  const readHistoryVersion = async ({ documentId = "", versionSelector = "" } = {}) => {
    if (!defaultHistoryAuthorization?.allowed) {
      throw Object.assign(new Error("历史版本默认不主动读取；需要用户在当前任务中明确授权指定版本。"), { code: "HISTORY_READ_NOT_AUTHORIZED" });
    }
    const normalizedDocumentId = String(documentId || "").trim();
    const selector = String(versionSelector || "").trim();
    if (!normalizedDocumentId || !documentIndex[normalizedDocumentId]) {
      throw Object.assign(new Error("指定历史版本不属于当前作品已登记文档。"), { code: "HISTORY_DOCUMENT_NOT_AUTHORIZED" });
    }
    const allowedDocuments = new Set((defaultHistoryAuthorization.allowedDocumentIds ?? []).map(String).filter(Boolean));
    if (!allowedDocuments.size || !allowedDocuments.has(normalizedDocumentId)) {
      throw Object.assign(new Error("该文档没有获得本轮历史读取授权。"), { code: "HISTORY_DOCUMENT_NOT_AUTHORIZED" });
    }
    const allowedSelectors = new Set((defaultHistoryAuthorization.allowedVersionSelectors ?? []).map((item) => String(item).trim().toLowerCase()).filter(Boolean));
    if (!selector || (allowedSelectors.size && !allowedSelectors.has(selector.toLowerCase()))) {
      throw Object.assign(new Error("该历史版本选择器没有获得本轮用户授权。"), { code: "HISTORY_VERSION_NOT_AUTHORIZED" });
    }
    const historyRoot = resolve(rootActual, ".shensi", "history-isolated");
    const readJson = async (target) => {
      if (!inside(historyRoot, target)) throw Object.assign(new Error("历史版本路径越界。"), { code: "HISTORY_READ_SCOPE_DENIED" });
      return JSON.parse(await readFile(target, "utf8"));
    };
    const index = await readJson(resolve(historyRoot, "index.json")).catch(() => null);
    const relativeShard = index?.documents?.[normalizedDocumentId];
    if (!relativeShard) throw Object.assign(new Error("指定文档没有可读取的历史版本。"), { code: "HISTORY_VERSION_NOT_FOUND" });
    const shardPath = resolve(historyRoot, String(relativeShard));
    const shard = await readJson(shardPath);
    if (shard?.scopeType !== "document" || shard?.scopeId !== normalizedDocumentId || !Array.isArray(shard.entries)) {
      throw Object.assign(new Error("历史版本分片校验失败。"), { code: "HISTORY_VERSION_SHARD_INVALID" });
    }
    const candidates = shard.entries.filter((entry) => entry && typeof entry === "object");
    const normalizedSelector = selector.toLowerCase();
    const nonCurrent = candidates.filter((entry) => entry.current !== true);
    const stored = normalizedSelector === "oldest"
      ? nonCurrent.at(-1) || candidates.at(-1)
      : ["previous", "latest"].includes(normalizedSelector)
        ? nonCurrent[0] || candidates[0]
        : candidates.find((entry) => [entry.id, entry.version, entry.title, entry.name]
          .some((value) => String(value || "").trim().toLowerCase() === normalizedSelector));
    if (!stored) throw Object.assign(new Error("没有找到用户指定的历史版本。"), { code: "HISTORY_VERSION_NOT_FOUND" });
    const readObject = async (hash) => {
      const normalizedHash = String(hash || "");
      if (!/^[a-f0-9]{64}$/u.test(normalizedHash)) throw Object.assign(new Error("历史对象哈希无效。"), { code: "HISTORY_VERSION_OBJECT_INVALID" });
      return readJson(resolve(historyRoot, "objects", normalizedHash.slice(0, 2), `${normalizedHash}.json`));
    };
    let document = stored.document && typeof stored.document === "object" ? stored.document : null;
    if (!document && stored.storageDocumentRef) document = await readObject(stored.storageDocumentRef);
    if (!document && stored.storageDocumentContentRef) document = await readObject(stored.storageDocumentContentRef);
    if (!document && stored.storageDocumentRefs?.[normalizedDocumentId]) document = await readObject(stored.storageDocumentRefs[normalizedDocumentId]);
    if (!document && stored.state?.storageDocumentRefs?.[normalizedDocumentId]) document = await readObject(stored.state.storageDocumentRefs[normalizedDocumentId]);
    if (!document && stored.documents?.[normalizedDocumentId]) document = stored.documents[normalizedDocumentId];
    if (!document && stored.state?.documents?.[normalizedDocumentId]) document = stored.state.documents[normalizedDocumentId];
    if (!document && ["html", "markdown", "continuityDelta"].some((field) => Object.hasOwn(stored, field))) {
      document = Object.fromEntries(["html", "markdown", "continuityDelta"].filter((field) => Object.hasOwn(stored, field)).map((field) => [field, stored[field]]));
    }
    if (!document) throw Object.assign(new Error("指定历史版本正文对象缺失。"), { code: "HISTORY_VERSION_CONTENT_MISSING" });
    const serialized = JSON.stringify(document);
    if (serialized.length > budgets.singleReadChars) {
      throw Object.assign(new Error("指定历史版本超过单次读取预算，请改用历史预览或缩小读取目标。"), { code: "HISTORY_VERSION_TOO_LARGE" });
    }
    turnReadChars += serialized.length;
    const result = {
      documentId: normalizedDocumentId,
      versionId: String(stored.id || selector),
      version: String(stored.version || ""),
      title: String(stored.title || stored.name || ""),
      time: String(stored.time || stored.createdAt || ""),
      document,
      canonLevel: "historical_non_canon",
      readOnly: true,
      commitBaselineEligible: false,
      historyReadReason: String(defaultHistoryAuthorization.reason || "user_explicit_history_request"),
      characters: serialized.length,
      tokenEstimate: estimateTokens(serialized),
      softBudgetExceeded: turnReadChars > budgets.turnReadChars,
    };
    audit({ operation: "read_history_version", pathSummary: `${normalizedDocumentId}@${result.versionId}`, characters: serialized.length, reason: result.historyReadReason });
    return result;
  };

  return { structure, list, search, read, read_range: readRange, resolve_reference: resolveReference, document_revision: documentRevision, read_history_version: readHistoryVersion };
};
