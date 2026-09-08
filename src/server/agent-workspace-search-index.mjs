const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 10_000,
  maxScanBytes: 64 * 1024 * 1024,
  maxDurationMs: 2_000,
});

const sharedIndexes = new Map();

const positiveInteger = (value, fallback, maximum = Number.MAX_SAFE_INTEGER) => (
  Math.max(1, Math.min(maximum, Math.trunc(Number(value) || fallback)))
);

const cancelledError = () => Object.assign(new Error("Workspace search was cancelled."), {
  name: "AbortError",
  code: "WORKSPACE_SEARCH_CANCELLED",
});

export const createAgentWorkspaceSearchIndex = ({
  maxFiles = DEFAULT_LIMITS.maxFiles,
  maxScanBytes = DEFAULT_LIMITS.maxScanBytes,
  maxDurationMs = DEFAULT_LIMITS.maxDurationMs,
  now = () => Date.now(),
} = {}) => {
  const cache = new Map();
  const limits = {
    maxFiles: positiveInteger(maxFiles, DEFAULT_LIMITS.maxFiles, 100_000),
    maxScanBytes: positiveInteger(maxScanBytes, DEFAULT_LIMITS.maxScanBytes),
    maxDurationMs: positiveInteger(maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 60_000),
  };

  const search = async ({ entries = [], query = "", loadText, signal = null, budgets = {} } = {}) => {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) throw Object.assign(new Error("workspace.search requires a query."), { code: "WORKSPACE_SEARCH_QUERY_REQUIRED" });
    if (typeof loadText !== "function") throw new TypeError("Workspace search requires a text loader.");
    const active = {
      maxFiles: positiveInteger(budgets.maxFiles, limits.maxFiles, 100_000),
      maxScanBytes: positiveInteger(budgets.maxScanBytes, limits.maxScanBytes),
      maxDurationMs: positiveInteger(budgets.maxDurationMs, limits.maxDurationMs, 60_000),
    };
    const startedAt = now();
    const matches = [];
    const seen = new Set();
    const entryPaths = new Set(entries.map((entry) => String(entry?.path || "")).filter(Boolean));
    let scannedFiles = 0;
    let scannedBytes = 0;
    let loadedFiles = 0;
    let cacheHits = 0;
    let softBudgetExceeded = false;

    for (const entry of entries) {
      if (signal?.aborted) throw cancelledError();
      if (scannedFiles >= active.maxFiles || scannedBytes + Math.max(0, Number(entry?.size) || 0) > active.maxScanBytes || now() - startedAt >= active.maxDurationMs) {
        softBudgetExceeded = true;
        break;
      }
      const path = String(entry?.path || "");
      if (!path) continue;
      seen.add(path);
      scannedFiles += 1;
      scannedBytes += Math.max(0, Number(entry?.size) || 0);
      const nameMatch = String(entry?.name || "").toLowerCase().includes(needle);
      let text = "";
      let lower = "";
      if (entry?.textEligible === true) {
        const signature = `${path}\u0000${String(entry?.modifiedAt || "")}\u0000${Number(entry?.size) || 0}`;
        const cached = cache.get(path);
        if (cached?.signature === signature) {
          text = cached.text;
          lower = cached.lower;
          cacheHits += 1;
        } else {
          if (signal?.aborted) throw cancelledError();
          text = String(await loadText(entry, { signal }) || "");
          lower = text.toLowerCase();
          cache.set(path, { signature, text, lower });
          loadedFiles += 1;
        }
      }
      const matchOffset = lower.indexOf(needle);
      if (!nameMatch && matchOffset < 0) continue;
      const snippetStart = Math.max(0, matchOffset - 120);
      matches.push({
        entry,
        matchOffset,
        snippet: matchOffset >= 0 ? text.slice(snippetStart, matchOffset + needle.length + 180) : "",
      });
    }

    for (const cachedPath of cache.keys()) {
      if (!seen.has(cachedPath) && !entryPaths.has(cachedPath)) cache.delete(cachedPath);
    }

    return {
      matches,
      softBudgetExceeded,
      cancelled: false,
      telemetry: {
        scannedFiles,
        scannedBytes,
        loadedFiles,
        cacheHits,
        elapsedMs: Math.max(0, now() - startedAt),
      },
    };
  };

  return {
    search,
    clear: () => cache.clear(),
    stats: () => ({ cachedFiles: cache.size, limits: { ...limits } }),
  };
};

export const getAgentWorkspaceSearchIndex = (key, options = {}) => {
  const normalizedKey = String(key || "").trim().toLowerCase();
  if (!normalizedKey) return createAgentWorkspaceSearchIndex(options);
  if (!sharedIndexes.has(normalizedKey)) sharedIndexes.set(normalizedKey, createAgentWorkspaceSearchIndex(options));
  return sharedIndexes.get(normalizedKey);
};

export const clearAgentWorkspaceSearchIndex = (key = "") => {
  const normalizedKey = String(key || "").trim().toLowerCase();
  if (normalizedKey) sharedIndexes.delete(normalizedKey);
  else sharedIndexes.clear();
};
