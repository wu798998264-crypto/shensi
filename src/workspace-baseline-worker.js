import { contentRevision } from "./workspace-operations.js";
import { portableGenerationSettings } from "./generation-profiles.js";
import { verifyHistoryEntryIntegrity } from "./version-integrity.js";

const workspaceValueHash = (value) => {
  if (value === undefined) return "";
  const serialized = JSON.stringify(value);
  return `${contentRevision(serialized)}:${serialized.length}`;
};

const historyIntegrityResults = (state = {}) => {
  const results = [];
  const collect = (collection, scope, entries) => {
    for (const entry of Array.isArray(entries) ? entries : []) {
      const verification = verifyHistoryEntryIntegrity(entry);
      results.push({ collection, scope, id: String(entry?.id || ""), ok: verification.ok === true });
    }
  };
  for (const collection of ["histories", "viewHistories", "volumeHistories", "moduleHistories"]) {
    for (const [scope, entries] of Object.entries(state?.[collection] ?? {})) collect(collection, scope, entries);
  }
  collect("projectHistories", "project", state?.projectHistories);
  return results;
};

self.addEventListener("message", async (event) => {
  const { type, target, key, value, workspacePath, stateStamp, sessionToken } = event.data ?? {};
  if (type === "load-metadata") {
    try {
      const response = await fetch("/api/workspace/load", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(sessionToken ? { "X-Shensi-Session": sessionToken } : {}),
        },
        body: JSON.stringify({ workspacePath }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok || !payload?.state) throw new Error(payload?.message || "工作区基线读取失败");
      if (String(payload.stateStamp || "") !== String(stateStamp || "")) throw new Error("工作区基线已变化");
      const metadata = { ...payload.state, settings: { ...(payload.state.settings ?? {}) } };
      delete metadata.localCacheMode;
      delete metadata.theme;
      metadata.settings = portableGenerationSettings(metadata.settings);
      delete metadata.settings.shensiRoot;
      delete metadata.settings.workspacePath;
      delete metadata.documents;
      const hashes = Object.entries(metadata)
        .filter(([metadataKey]) => metadataKey !== "savedAt")
        .map(([metadataKey, metadataValue]) => [metadataKey, workspaceValueHash(metadataValue)]);
      self.postMessage({
        type: "metadata-batch",
        stateStamp: payload.stateStamp,
        hashes,
        historyIntegrity: historyIntegrityResults(payload.state),
      });
    } catch (error) {
      self.postMessage({ type: "error", message: error?.message || "工作区基线读取失败" });
    }
    return;
  }
  if (!key || target !== "document") return;
  self.postMessage({ type: "hash", target, key, hash: workspaceValueHash(value) });
});
