import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { createNutstoreLocalState } from "./local-state.mjs";
import { createLocalInventory, hashFile } from "./inventory.mjs";
import { normalizeLogicalPath, normalizeNutstoreEndpoint, normalizeRemoteRoot, publicSyncError } from "./contracts.mjs";
import { createWebDavClient, replaceDownloadedFile } from "./webdav-client.mjs";
import { probeWebDavCapabilities } from "./capability-probe.mjs";
import { createNutstoreRemoteRepository } from "./remote-repository.mjs";
import { planThreeWaySync } from "./three-way-compare.mjs";
import { mergeTextThreeWay } from "./text-merge.mjs";
import { enqueueOutboxOperation, updateOutboxOperation } from "./outbox.mjs";
import { addConflict, resolveConflictRecord } from "./conflict-store.mjs";
import { mergeStructuredData } from "./structured-merge.mjs";

const now = () => new Date().toISOString();
const isText = (path) => /\.(?:md|txt)$/i.test(path);
const isBinary = (path) => /\.(?:png|jpe?g|gif|webp|mp4|mov|webm|mp3|wav|m4a|pdf)$/i.test(path);
const structuredKind = (path) => /(?:^|\/)experience-store\/experience-v3\.json$/i.test(path) ? "experience-store" : /\.canvas$/i.test(path) ? "whiteboard" : "";
const jitter = (attempt) => Math.min(15 * 60_000, Math.round((2 ** Math.min(10, attempt)) * 1000 * (0.75 + Math.random() * 0.5)));

const safeLocalPath = (dataRoot, logicalPath) => {
  const normalized = normalizeLogicalPath(logicalPath);
  const target = resolve(dataRoot, ...normalized.split("/"));
  const root = resolve(dataRoot);
  if (!target.startsWith(`${root}${sep}`)) throw Object.assign(new Error("同步目标逃逸出数据目录"), { code: "LOCAL_PATH_ESCAPE" });
  return target;
};

const publicFile = (item = {}) => { const value = item || {}; return { logicalPath: value.logicalPath || "", hash: value.hash || value.baseHash || "", size: value.size || 0, contentType: value.contentType || "", etag: value.etag || value.remoteEtag || "", deleted: value.deleted === true }; };
const summary = (items) => items.reduce((value, item) => {
  const key = ({ upload: "upload", download: "download", delete_remote: "delete", delete_local: "delete", conflict: "conflict", skip: "skip", baseline: "skip" })[item.action] || "skip";
  value[key] += 1;
  if (["upload", "download"].includes(key)) value.bytes += Number((key === "upload" ? item.local : item.remote)?.size || 0);
  return value;
}, { upload: 0, download: 0, delete: 0, conflict: 0, skip: 0, bytes: 0 });

export const createNutstoreSyncEngine = ({ dataRoot, machineRoot, desktopRuntime = false, repositoryFactory = null, clientFactory = createWebDavClient, capabilityProbe = probeWebDavCapabilities } = {}) => {
  let resolvedDataRoot = resolve(dataRoot);
  const stateStore = createNutstoreLocalState({ machineRoot });
  let sessionCredentials = null;
  let running = null;
  let previewCache = null;
  let autoTimer = null;
  let sessionConnection = null;
  let credentialRevision = 0;

  const log = async (event, details = {}) => stateStore.update((state) => {
    const safe = JSON.parse(JSON.stringify(details, (key, value) => /password|authorization|credential|token/i.test(key) ? "[REDACTED]" : value));
    state.logs.push({ at: now(), event: String(event), details: safe });
  });
  const status = async () => {
    const state = await stateStore.load();
    const unresolved = state.conflicts.filter((item) => item.status === "unresolved");
    const pending = state.outbox.filter((item) => !["completed", "cancelled"].includes(item.status));
    return {
      schemaVersion: state.schemaVersion, protocolVersion: state.protocolVersion, desktopRuntime,
      activeMode: state.activeMode, enabled: state.enabled, paused: state.paused, connected: state.enabled && Boolean(state.endpoint),
      credentialAvailable: Boolean(sessionCredentials?.password), deviceId: state.deviceId, deviceName: state.deviceName,
      endpoint: state.endpoint || "https://dav.jianguoyun.com/dav/", account: state.account || "", remoteRoot: state.remoteRoot,
      capabilityLevel: state.capabilityLevel, capability: state.capability || null, autoSync: state.autoSync === true,
      lastSuccessfulSyncAt: state.lastSuccessfulSyncAt, lastAttemptAt: state.lastAttemptAt, lastErrorCode: state.lastErrorCode,
      phase: state.phase || (state.paused ? "paused" : "idle"), progress: state.progress || { completed: 0, total: 0 },
      pendingUpload: pending.filter((item) => item.action === "upload").length,
      pendingDownload: pending.filter((item) => item.action === "download").length,
      pendingDelete: pending.filter((item) => item.action === "delete").length,
      conflictCount: unresolved.length, pendingCount: pending.length,
    };
  };
  const setSessionCredentials = async ({ account = "", password = "" } = {}) => {
    if (!String(account).trim() || !String(password)) {
      sessionCredentials = null;
      sessionConnection = null;
      credentialRevision += 1;
      return { available: false };
    }
    const next = { account: String(account).trim(), password: String(password) };
    if (sessionCredentials?.account !== next.account || sessionCredentials?.password !== next.password) {
      sessionConnection = null;
      credentialRevision += 1;
    }
    sessionCredentials = next;
    await stateStore.update((state) => {
      if (state.phase === "waiting_credentials") state.phase = "idle";
      if (state.lastErrorCode === "WAITING_CREDENTIALS") state.lastErrorCode = "";
      for (const item of state.outbox) if (item.status === "waiting_credentials") { item.status = "pending"; item.retryAt = ""; item.errorCode = ""; }
    });
    scheduleAutoSync(500);
    return { available: true, account: sessionCredentials.account };
  };
  const clearSessionCredentials = () => { sessionCredentials = null; sessionConnection = null; credentialRevision += 1; };
  const credentialsFor = (input = {}) => {
    const account = String(input.account || sessionCredentials?.account || "").trim();
    const password = String(input.password || sessionCredentials?.password || "");
    if (!account || !password) throw Object.assign(new Error("请重新输入坚果云账号和第三方应用密码"), { code: "WAITING_CREDENTIALS" });
    return { account, password };
  };
  const connection = async (input = {}, stateValue = null) => {
    const state = stateValue || await stateStore.load();
    const credentials = credentialsFor(input);
    const endpoint = normalizeNutstoreEndpoint(input.endpoint || state.endpoint);
    const remoteRoot = normalizeRemoteRoot(input.remoteRoot || state.remoteRoot);
    const connectionKey = JSON.stringify({
      endpoint,
      remoteRoot,
      account: credentials.account,
      credentialRevision,
      deviceId: state.deviceId,
      capability: state.capability || null,
    });
    if (sessionConnection?.key === connectionKey) return sessionConnection.value;
    const client = clientFactory({ endpoint, ...credentials });
    const repository = repositoryFactory ? await repositoryFactory({ client, remoteRoot, deviceId: state.deviceId, state, capability: state.capability || null }) : createNutstoreRemoteRepository({ client, remoteRoot, deviceId: state.deviceId, capability: state.capability || null });
    const value = { credentials, endpoint, remoteRoot, client, repository };
    sessionConnection = { key: connectionKey, value };
    return value;
  };
  const testConnection = async (input = {}) => {
    try {
      const state = await stateStore.load();
      const connected = await connection(input, state);
      const capability = await capabilityProbe({ client: connected.client, remoteRoot: connected.remoteRoot });
      await log("connection-probed", { capabilityLevel: capability.capabilityLevel, cleanup: capability.cleanup });
      return { ok: capability.capabilityLevel !== "unsupported", endpoint: connected.endpoint, remoteRoot: connected.remoteRoot, capability };
    } catch (error) {
      const safe = publicSyncError(error);
      await log("connection-probe-failed", {
        code: safe.code,
        status: Number(error?.status || 0),
        operation: String(error?.operation || "").replace(/[^A-Z]/gu, "").slice(0, 12),
      });
      throw error;
    }
  };
  const configure = async (input = {}) => {
    if (!desktopRuntime) throw Object.assign(new Error("浏览器预览模式不能启用坚果云直连；请使用 Windows 桌面版"), { code: "DESKTOP_REQUIRED" });
    const credentials = credentialsFor(input);
    const tested = await testConnection(input);
    if (tested.capability.capabilityLevel === "unsupported") throw Object.assign(new Error("该 WebDAV 连接不满足安全同步条件"), { code: "WEBDAV_UNSUPPORTED" });
    await setSessionCredentials(credentials);
    const configured = await stateStore.update((state) => {
      state.endpoint = tested.endpoint;
      state.account = credentials.account;
      state.remoteRoot = tested.remoteRoot;
      state.deviceName = String(input.deviceName || state.deviceName || "Windows 电脑").trim().slice(0, 80);
      state.capabilityLevel = tested.capability.capabilityLevel;
      state.capability = tested.capability;
      state.autoSync = input.autoSync === true && tested.capability.capabilityLevel === "safe_auto";
      state.autoSyncIntervalMinutes = Math.max(2, Math.min(120, Number(input.autoSyncIntervalMinutes) || 10));
      state.lastErrorCode = "";
    });
    sessionConnection = null;
    return configured;
  };
  const inventories = async (state, connected, onProgress = null) => {
    await connected.repository.initialize({ deviceName: state.deviceName, platform: "windows" });
    const [local, remote] = await Promise.all([
      createLocalInventory({ dataRoot: resolvedDataRoot, baseline: state.baseline, includeSourcePaths: true, onProgress }),
      connected.repository.inventory(),
    ]);
    return { local, remote };
  };
  const firstSyncPreview = async (input = {}) => {
    const state = await stateStore.load();
    const connected = await connection(input, state);
    const values = await inventories(state, connected);
    const plan = planThreeWaySync({ baseline: state.baseline, local: values.local.files, remote: values.remote });
    const previewToken = randomBytes(24).toString("base64url");
    previewCache = { previewToken, createdAt: Date.now(), config: { endpoint: connected.endpoint, remoteRoot: connected.remoteRoot, account: connected.credentials.account }, plan, local: values.local.files, remote: values.remote };
    const mode = values.local.files.length && values.remote.length ? "both" : values.local.files.length ? "local_only" : values.remote.length ? "remote_only" : "empty";
    return { previewToken, mode, summary: summary(plan), items: plan.map((item) => ({ logicalPath: item.logicalPath, action: item.action, reason: item.reason, local: publicFile(item.local), remote: publicFile(item.remote) })).slice(0, 2000), expiresInSeconds: 600 };
  };
  const basePath = (hash) => join(stateStore.paths.stateRoot, "bases", `${hash}.base`);
  const retainBase = async (sourcePath, hash) => {
    if (!hash) return;
    const target = basePath(hash);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(sourcePath, target).catch((error) => { if (error?.code !== "EEXIST") throw error; });
  };
  const setBaseline = (state, item, localEntry, remoteEntry) => {
    if (item.deleted === true) { delete state.baseline[item.logicalPath]; return; }
    state.baseline[item.logicalPath] = {
      logicalPath: item.logicalPath, baseHash: item.hash, localHash: item.hash, remoteHash: item.hash,
      remoteEtag: remoteEntry?.etag || "", size: item.size || 0, contentType: item.contentType || "application/octet-stream",
      mtimeMs: localEntry?.mtimeMs || 0, deleted: false, lastSyncedAt: now(),
    };
  };
  const operationStart = async (action, logicalPath) => stateStore.update((state) => {
    const op = { id: randomUUID(), action, logicalPath, status: action === "upload" ? "uploading" : action === "download" ? "downloading" : "applying", progress: 0, size: 0, errorCode: "", createdAt: now(), updatedAt: now() };
    state.operations.push(op); return state;
  }).then((state) => state.operations.at(-1));
  const operationFinish = async (id, statusValue, patch = {}) => stateStore.update((state) => { const op = state.operations.find((item) => item.id === id); if (op) Object.assign(op, patch, { status: statusValue, progress: statusValue === "completed" ? 100 : op.progress, updatedAt: now() }); });
  const moveToTrash = async (logicalPath) => {
    const source = safeLocalPath(resolvedDataRoot, logicalPath);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) return null;
    const target = join(resolvedDataRoot, "回收站", "坚果云同步", `${Date.now()}-${basename(logicalPath)}`);
    await mkdir(dirname(target), { recursive: true });
    await rename(source, target);
    return target;
  };
  const applyDownload = async ({ repository, remoteEntry, state }) => {
    const target = safeLocalPath(resolvedDataRoot, remoteEntry.logicalPath);
    const temporary = join(stateStore.paths.stateRoot, "downloads", `${randomUUID()}.pending`);
    await mkdir(dirname(temporary), { recursive: true });
    try {
      await repository.download({ entry: remoteEntry, temporaryPath: temporary });
      const downloadedHash = await hashFile(temporary);
      if (downloadedHash !== remoteEntry.hash) throw Object.assign(new Error("下载文件 SHA-256 与远程清单不一致"), { code: "REMOTE_HASH_MISMATCH" });
      await replaceDownloadedFile(temporary, target);
      const info = await stat(target);
      const localEntry = { ...remoteEntry, sourcePath: target, mtimeMs: info.mtimeMs, deleted: false };
      setBaseline(state, remoteEntry, localEntry, remoteEntry);
      await retainBase(target, remoteEntry.hash);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  };
  const tryTextMerge = async ({ item, repository, state }) => {
    const baseline = state.baseline[item.logicalPath];
    if (!baseline?.baseHash || !isText(item.logicalPath)) return false;
    const baseFile = basePath(baseline.baseHash);
    const localPath = safeLocalPath(resolvedDataRoot, item.logicalPath);
    const remoteTemp = join(stateStore.paths.stateRoot, "downloads", `${randomUUID()}.merge`);
    try {
      const [baseText, localText] = await Promise.all([readFile(baseFile, "utf8"), readFile(localPath, "utf8")]);
      await repository.download({ entry: item.remote, temporaryPath: remoteTemp });
      if (await hashFile(remoteTemp) !== item.remote.hash) return false;
      const remoteText = await readFile(remoteTemp, "utf8");
      const merged = mergeTextThreeWay({ base: baseText, local: localText, remote: remoteText });
      if (merged.conflict) return false;
      const mergeTemp = `${localPath}.${randomUUID()}.merge`;
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(mergeTemp, merged.text, "utf8");
      await replaceDownloadedFile(mergeTemp, localPath);
      const info = await stat(localPath);
      const localEntry = { logicalPath: item.logicalPath, sourcePath: localPath, hash: await hashFile(localPath), size: info.size, mtimeMs: info.mtimeMs, contentType: item.local.contentType || item.remote.contentType };
      const remoteMeta = await repository.upload({ entry: localEntry, expectedRemoteEtag: item.remote.etag || "", expectedRemoteExists: true });
      setBaseline(state, localEntry, localEntry, remoteMeta);
      await retainBase(localPath, localEntry.hash);
      return true;
    } catch { return false; }
    finally { await rm(remoteTemp, { force: true }).catch(() => {}); }
  };
  const tryStructuredMerge = async ({ item, repository, state }) => {
    const baseline = state.baseline[item.logicalPath];
    const kind = structuredKind(item.logicalPath);
    if (!baseline?.baseHash || !kind) return false;
    const baseFile = basePath(baseline.baseHash);
    const localPath = safeLocalPath(resolvedDataRoot, item.logicalPath);
    const remoteTemp = join(stateStore.paths.stateRoot, "downloads", `${randomUUID()}.structured`);
    try {
      const [baseValue, localValue] = await Promise.all([readFile(baseFile, "utf8").then(JSON.parse), readFile(localPath, "utf8").then(JSON.parse)]);
      await repository.download({ entry: item.remote, temporaryPath: remoteTemp });
      if (await hashFile(remoteTemp) !== item.remote.hash) return false;
      const remoteValue = JSON.parse(await readFile(remoteTemp, "utf8"));
      const merged = mergeStructuredData({ kind, base: baseValue, local: localValue, remote: remoteValue });
      if (merged.conflict) return false;
      const mergeTemp = `${localPath}.${randomUUID()}.merge`;
      await mkdir(dirname(localPath), { recursive: true });
      await writeFile(mergeTemp, `${JSON.stringify(merged.value, null, 2)}\n`, "utf8");
      await replaceDownloadedFile(mergeTemp, localPath);
      const info = await stat(localPath);
      const localEntry = { logicalPath: item.logicalPath, sourcePath: localPath, hash: await hashFile(localPath), size: info.size, mtimeMs: info.mtimeMs, contentType: item.local.contentType || item.remote.contentType };
      const remoteMeta = await repository.upload({ entry: localEntry, expectedRemoteEtag: item.remote.etag || "", expectedRemoteExists: true });
      setBaseline(state, localEntry, localEntry, remoteMeta);
      await retainBase(localPath, localEntry.hash);
      return true;
    } catch { return false; }
    finally { await rm(remoteTemp, { force: true }).catch(() => {}); }
  };
  const executePlan = async ({ plan, local, repository }) => {
    const localMap = new Map(local.map((item) => [item.logicalPath, item]));
    const executed = [];
    let completed = 0;
    for (const item of plan) {
      const latest = await stateStore.load();
      if (latest.paused) break;
      await stateStore.update((state) => { state.phase = item.action; state.progress = { completed, total: plan.length, logicalPath: item.logicalPath }; });
      if (["skip", "baseline"].includes(item.action)) {
        if (!item.local?.deleted && item.local) await stateStore.update((state) => setBaseline(state, item.local, localMap.get(item.logicalPath), item.remote));
        else {
          if (item.remote?.tombstone && typeof repository.acknowledgeDeletion === "function") await repository.acknowledgeDeletion({ entry: item.remote });
          await stateStore.update((state) => { delete state.baseline[item.logicalPath]; });
        }
        executed.push(item);
        completed += 1; continue;
      }
      const op = await operationStart(item.action, item.logicalPath);
      let executedAction = item.action;
      try {
        let finalOperationStatus = "completed";
        if (item.action === "upload") {
          const entry = localMap.get(item.logicalPath) || item.local;
          if (!entry?.sourcePath) throw Object.assign(new Error(`待上传文件在扫描后消失：${item.logicalPath}`), { code: "LOCAL_FILE_CHANGED_DURING_SYNC" });
          const metadata = await repository.upload({ entry, expectedRemoteEtag: item.remote?.etag || "", expectedRemoteExists: Boolean(item.remote && !item.remote.deleted) });
          await retainBase(entry.sourcePath, entry.hash);
          await stateStore.update((state) => setBaseline(state, entry, entry, metadata));
        } else if (item.action === "download") {
          await stateStore.update(async (state) => { await applyDownload({ repository, remoteEntry: item.remote, state }); });
        } else if (item.action === "delete_remote") {
          await repository.remove({ entry: item.base || item.remote, baseHash: item.base?.baseHash || item.base?.hash || "", expectedRemoteEtag: item.remote?.etag || "", expectedRemoteExists: Boolean(item.remote && !item.remote.deleted) });
          await stateStore.update((state) => { delete state.baseline[item.logicalPath]; });
        } else if (item.action === "delete_local") {
          await moveToTrash(item.logicalPath);
          if (item.remote?.tombstone && typeof repository.acknowledgeDeletion === "function") await repository.acknowledgeDeletion({ entry: item.remote });
          await stateStore.update((state) => { delete state.baseline[item.logicalPath]; });
        } else if (item.action === "conflict") {
          let merged = false;
          if (!item.local.deleted && !item.remote.deleted) merged = await stateStore.update(async (state) => {
            await (isText(item.logicalPath) ? tryTextMerge({ item, repository, state }) : tryStructuredMerge({ item, repository, state }));
            return state;
          }).then(async () => {
            const current = await stateStore.load(); return current.baseline[item.logicalPath]?.baseHash && current.baseline[item.logicalPath].baseHash !== item.base?.baseHash;
          });
          if (!merged) {
            if (isBinary(item.logicalPath) && !item.remote.deleted) {
              const short = String(item.remote.hash || "remote").slice(0, 8);
              const original = safeLocalPath(resolvedDataRoot, item.logicalPath);
              const extension = extname(original); const copy = `${original.slice(0, extension ? -extension.length : undefined)}.conflict-${latest.deviceId.slice(0, 8)}-${short}${extension}`;
              const temporary = join(stateStore.paths.stateRoot, "downloads", `${randomUUID()}.conflict`);
              await repository.download({ entry: item.remote, temporaryPath: temporary });
              if (await hashFile(temporary) === item.remote.hash) await replaceDownloadedFile(temporary, copy); else await rm(temporary, { force: true });
            }
            await stateStore.update((state) => { addConflict(state, { logicalPath: item.logicalPath, kind: isBinary(item.logicalPath) ? "binary" : isText(item.logicalPath) ? "text" : "structured", reason: item.reason, base: publicFile(item.base), local: publicFile(item.local), remote: publicFile(item.remote) }); });
            finalOperationStatus = "conflict";
          }
        }
        await operationFinish(op.id, finalOperationStatus);
      } catch (error) {
        if (error?.code === "REMOTE_CHANGED_DURING_SYNC") {
          await stateStore.update((state) => { addConflict(state, { logicalPath: item.logicalPath, kind: isBinary(item.logicalPath) ? "binary" : isText(item.logicalPath) ? "text" : "structured", reason: error.message, base: publicFile(item.base), local: publicFile(item.local), remote: publicFile(item.remote) }); });
          await operationFinish(op.id, "conflict", { errorCode: error.code });
          executedAction = "conflict";
        } else {
          await operationFinish(op.id, "failed", { errorCode: publicSyncError(error).code });
          throw error;
        }
      }
      executed.push(executedAction === item.action ? item : { ...item, action: executedAction });
      completed += 1;
    }
    await stateStore.update((state) => { state.progress = { completed, total: plan.length }; });
    return executed;
  };
  const performRun = async ({ reason = "manual" } = {}) => {
    let state = await stateStore.update((draft) => { draft.lastAttemptAt = now(); draft.lastErrorCode = ""; draft.phase = "scanning"; draft.progress = { completed: 0, total: 0 }; });
    if (!state.enabled || state.activeMode !== "nutstore_direct") throw Object.assign(new Error("坚果云直连尚未启用"), { code: "NUTSTORE_NOT_ENABLED" });
    if (state.paused) return { ok: true, paused: true, status: await status() };
    try {
      const connected = await connection({}, state);
      const values = await inventories(state, connected, ({ scanned, total, logicalPath }) => { void stateStore.update((draft) => { draft.phase = "scanning"; draft.progress = { completed: scanned, total, logicalPath }; }); });
      state = await stateStore.load();
      const plan = planThreeWaySync({ baseline: state.baseline, local: values.local.files, remote: values.remote });
      const executedPlan = await executePlan({ plan, local: values.local.files, repository: connected.repository });
      const runSummary = summary(executedPlan);
      const completedAt = now();
      await stateStore.update((draft) => {
        draft.phase = draft.conflicts.some((item) => item.status === "unresolved") ? "conflict" : "completed";
        draft.lastSuccessfulSyncAt = completedAt; draft.lastErrorCode = ""; draft.localCursor += 1;
        for (const item of draft.outbox) if (!["conflict", "failed"].includes(item.status)) item.status = "completed";
      });
      await log("sync-completed", { reason, summary: runSummary });
      return { ok: true, summary: runSummary, status: await status() };
    } catch (error) {
      const safe = publicSyncError(error);
      await stateStore.update((draft) => {
        draft.lastErrorCode = safe.code;
        draft.phase = safe.code === "WAITING_CREDENTIALS" ? "waiting_credentials" : safe.code === "RETRY_WAIT" ? "retry_wait" : "failed";
        const pending = draft.outbox.find((item) => !["completed", "cancelled"].includes(item.status));
        if (pending) { pending.attempt = Number(pending.attempt || 0) + 1; pending.status = draft.phase; pending.errorCode = safe.code; pending.retryAt = new Date(Date.now() + Math.max(error?.retryAfterMs || 0, jitter(pending.attempt))).toISOString(); }
      });
      await log("sync-failed", safe);
      throw Object.assign(new Error(safe.message), {
        code: safe.code,
        status: Math.max(0, Number(error?.status || 0)),
        operation: String(error?.operation || "").replace(/[^A-Z]/gu, "").slice(0, 12),
        retryAfterMs: Math.max(0, Number(error?.retryAfterMs || 0)),
      });
    }
  };
  const performRunWithTransientRetry = async (options = {}) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await performRun(options);
      } catch (error) {
        if (error?.code !== "RETRY_WAIT" || attempt === 2) throw error;
        const delay = Math.min(15_000, Math.max(Number(error?.retryAfterMs) || 0, 1_000 * (2 ** attempt)));
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
      }
    }
    throw Object.assign(new Error("坚果云暂时繁忙，已保留本次同步任务"), { code: "RETRY_WAIT" });
  };
  const run = (options = {}) => {
    if (running) return running;
    running = performRunWithTransientRetry(options).finally(() => { running = null; });
    return running;
  };
  const enable = async ({ previewToken, ...input } = {}) => {
    if (!desktopRuntime) throw Object.assign(new Error("坚果云直连只在 Windows 桌面版启用"), { code: "DESKTOP_REQUIRED" });
    if (!previewCache || previewCache.previewToken !== previewToken || Date.now() - previewCache.createdAt > 600000) throw Object.assign(new Error("首次同步预览已失效，请重新预览"), { code: "FIRST_SYNC_PREVIEW_REQUIRED" });
    if (input.account || input.password) await setSessionCredentials(credentialsFor(input));
    await stateStore.update((state) => { state.activeMode = "nutstore_direct"; state.enabled = true; state.paused = false; enqueueOutboxOperation(state, { logicalPath: "*", action: "scan", idempotencyKey: `first:${previewToken}` }); });
    previewCache = null;
    scheduleAutoSync();
    return run({ reason: "first_sync" });
  };
  const pause = async () => stateStore.update((state) => { state.paused = true; state.phase = "paused"; }).then(status);
  const resume = async () => { await stateStore.update((state) => { state.paused = false; state.phase = "idle"; }); scheduleAutoSync(); return run({ reason: "resume" }); };
  const disconnect = async () => { clearTimeout(autoTimer); autoTimer = null; clearSessionCredentials(); await stateStore.update((state) => { state.enabled = false; state.paused = false; state.activeMode = "none"; state.phase = "disconnected"; }); return status(); };
  const setAutoSync = async ({ autoSync = false } = {}) => {
    const state = await stateStore.load();
    if (!state.enabled || state.activeMode !== "nutstore_direct") {
      throw Object.assign(new Error("坚果云直连尚未启用"), { code: "NUTSTORE_NOT_ENABLED" });
    }
    const requested = autoSync === true;
    if (requested && state.capabilityLevel !== "safe_auto") {
      throw Object.assign(new Error("当前坚果云连接不满足安全自动同步条件，只允许手动同步"), { code: "NUTSTORE_AUTO_SYNC_UNSUPPORTED" });
    }
    clearTimeout(autoTimer);
    autoTimer = null;
    await stateStore.update((draft) => { draft.autoSync = requested; });
    if (requested) scheduleAutoSync(500);
    return status();
  };
  const switchAccount = async () => {
    clearTimeout(autoTimer);
    autoTimer = null;
    // Finish an in-flight run before clearing its account-bound baseline. This
    // prevents a late WebDAV response from repopulating the previous account.
    const activeRun = running;
    if (activeRun) await activeRun.catch(() => {});
    clearSessionCredentials();
    previewCache = null;
    sessionConnection = null;
    await stateStore.update((state) => {
      state.enabled = false;
      state.paused = false;
      state.activeMode = "none";
      state.account = "";
      state.capabilityLevel = "unsupported";
      state.capability = null;
      state.autoSync = false;
      state.lastSuccessfulSyncAt = "";
      state.lastAttemptAt = "";
      state.lastErrorCode = "";
      state.remoteCursor = "";
      state.baseline = {};
      state.outbox = [];
      state.conflicts = [];
      state.operations = [];
      state.retry = {};
      state.migration = null;
      state.phase = "disconnected";
      state.progress = { completed: 0, total: 0 };
      state.logs = [{ at: now(), event: "account-switched", details: {} }];
    });
    return status();
  };
  const noteLocalChange = async (logicalPath = "*") => {
    const current = await stateStore.load();
    if (!current.enabled || current.activeMode !== "nutstore_direct") return { queued: false, reason: "sync_disabled" };
    await stateStore.update((state) => {
      state.localCursor += 1;
      enqueueOutboxOperation(state, { logicalPath, action: logicalPath === "*" ? "scan" : "upload" });
    });
    scheduleAutoSync(1500);
    return { queued: true };
  };
  const setBaiduMode = async (enabled) => {
    if (enabled) { clearTimeout(autoTimer); autoTimer = null; clearSessionCredentials(); }
    return stateStore.update((state) => { state.activeMode = enabled ? "baidu_local_folder" : "none"; state.enabled = enabled ? false : state.enabled; state.paused = enabled ? true : state.paused; state.phase = enabled ? "baidu_local_folder" : state.phase; });
  };
  const assertStorageTargetAllowed = async (targetPath, { baidu = false } = {}) => {
    const state = await stateStore.load();
    if (baidu && state.activeMode === "nutstore_direct" && state.enabled) throw Object.assign(new Error("启用百度网盘本地文件夹前，请先断开坚果云直连"), { code: "SYNC_MODE_CONFLICT" });
    const suspectedCloud = /(?:坚果云|Nutstore|Nutshell|百度网盘|BaiduNetdisk|BaiduSyncdisk)/i.test(String(targetPath || ""));
    if (!baidu && suspectedCloud && state.activeMode === "nutstore_direct" && state.enabled) throw Object.assign(new Error("坚果云直连启用期间不能把神思数据目录迁入云盘客户端目录"), { code: "SYNC_MODE_CONFLICT" });
    return true;
  };
  const operations = async ({ status: filter = "", type = "", query = "" } = {}) => {
    const state = await stateStore.load();
    return state.operations.filter((item) => (!filter || item.status === filter) && (!type || item.action === type) && (!query || item.logicalPath.includes(query))).map((item) => ({ ...item }));
  };
  const conflicts = async () => (await stateStore.load()).conflicts.filter((item) => item.status === "unresolved").map((item) => ({ ...item }));
  const resolveConflict = async ({ conflictId, resolution, content = "" } = {}) => {
    const state = await stateStore.load(); const conflict = state.conflicts.find((item) => item.id === conflictId && item.status === "unresolved");
    if (!conflict) throw Object.assign(new Error("待处理冲突不存在"), { code: "SYNC_CONFLICT_NOT_FOUND" });
    if (!["use_local", "use_remote", "keep_both", "manual"].includes(resolution)) throw Object.assign(new Error("冲突处理方式无效"), { code: "SYNC_RESOLUTION_INVALID" });
    if (resolution === "manual") {
      if (!isText(conflict.logicalPath)) throw Object.assign(new Error("仅文本冲突支持手动内容"), { code: "SYNC_MANUAL_TEXT_ONLY" });
      const target = safeLocalPath(resolvedDataRoot, conflict.logicalPath); await mkdir(dirname(target), { recursive: true }); await writeFile(target, String(content), "utf8");
    }
    const connected = await connection({}, state);
    const remoteEntries = await connected.repository.inventory();
    const remoteEntry = remoteEntries.find((item) => item.logicalPath === conflict.logicalPath);
    if (resolution === "use_remote") {
      if (!remoteEntry || remoteEntry.deleted) await moveToTrash(conflict.logicalPath);
      else await stateStore.update(async (draft) => { await applyDownload({ repository: connected.repository, remoteEntry, state: draft }); });
    } else if (["use_local", "manual"].includes(resolution)) {
      const localInventory = await createLocalInventory({ dataRoot: resolvedDataRoot, baseline: state.baseline, includeSourcePaths: true });
      const localEntry = localInventory.files.find((item) => item.logicalPath === conflict.logicalPath);
      if (!localEntry) await connected.repository.remove({ entry: { logicalPath: conflict.logicalPath, hash: conflict.local?.hash || "" }, baseHash: conflict.base?.hash || "", expectedRemoteEtag: remoteEntry?.etag || "", expectedRemoteExists: Boolean(remoteEntry && !remoteEntry.deleted), manualOverwriteConfirmed: true });
      else {
        const metadata = await connected.repository.upload({ entry: localEntry, expectedRemoteEtag: remoteEntry?.etag || "", expectedRemoteExists: Boolean(remoteEntry && !remoteEntry.deleted), manualOverwriteConfirmed: true });
        await retainBase(localEntry.sourcePath, localEntry.hash);
        await stateStore.update((draft) => setBaseline(draft, localEntry, localEntry, metadata));
      }
    } else if (resolution === "keep_both" && remoteEntry && !remoteEntry.deleted) {
      const original = safeLocalPath(resolvedDataRoot, conflict.logicalPath); const extension = extname(original); const short = String(remoteEntry.hash || "remote").slice(0, 8);
      const target = `${original.slice(0, extension ? -extension.length : undefined)}.conflict-remote-${short}${extension}`;
      const temporary = join(stateStore.paths.stateRoot, "downloads", `${randomUUID()}.keep-both`);
      await connected.repository.download({ entry: remoteEntry, temporaryPath: temporary });
      if (await hashFile(temporary) !== remoteEntry.hash) throw Object.assign(new Error("远程冲突副本校验失败"), { code: "REMOTE_HASH_MISMATCH" });
      await replaceDownloadedFile(temporary, target);
      const localInventory = await createLocalInventory({ dataRoot: resolvedDataRoot, baseline: state.baseline, includeSourcePaths: true });
      const localEntry = localInventory.files.find((item) => item.logicalPath === conflict.logicalPath);
      if (localEntry) {
        const metadata = await connected.repository.upload({ entry: localEntry, expectedRemoteEtag: remoteEntry.etag || "", expectedRemoteExists: true, manualOverwriteConfirmed: true });
        await retainBase(localEntry.sourcePath, localEntry.hash);
        await stateStore.update((draft) => setBaseline(draft, localEntry, localEntry, metadata));
      } else {
        await connected.repository.remove({ entry: remoteEntry, baseHash: conflict.base?.hash || "", expectedRemoteEtag: remoteEntry.etag || "", expectedRemoteExists: true, manualOverwriteConfirmed: true });
        await stateStore.update((draft) => { delete draft.baseline[conflict.logicalPath]; });
      }
    }
    await stateStore.update((draft) => { resolveConflictRecord(draft, conflictId, resolution); enqueueOutboxOperation(draft, { logicalPath: conflict.logicalPath, action: "scan", idempotencyKey: `resolve:${conflictId}:${resolution}` }); });
    return run({ reason: "conflict_resolution" });
  };
  const retry = async () => { await stateStore.update((state) => { for (const item of state.outbox) if (["failed", "retry_wait"].includes(item.status)) { item.status = "pending"; item.retryAt = ""; } state.lastErrorCode = ""; }); return run({ reason: "retry" }); };
  const logs = async () => (await stateStore.load()).logs.slice(-200).map((item) => ({ ...item }));
  const scheduleAutoSync = (delayMs = null) => {
    clearTimeout(autoTimer); autoTimer = null;
    void stateStore.load().then((state) => {
      if (!state.enabled || state.paused || !state.autoSync || state.capabilityLevel !== "safe_auto") return;
      if (state.phase === "waiting_credentials" || state.lastErrorCode === "WAITING_CREDENTIALS") return;
      const retryTimes = state.outbox
        .filter((item) => item.status === "retry_wait" && item.retryAt)
        .map((item) => Date.parse(item.retryAt))
        .filter(Number.isFinite);
      const retryDelay = retryTimes.length ? Math.max(0, Math.min(...retryTimes) - Date.now()) : 0;
      const requestedDelay = delayMs ?? state.autoSyncIntervalMinutes * 60_000;
      autoTimer = setTimeout(() => { void run({ reason: "automatic" }).catch(() => {}).finally(() => scheduleAutoSync()); }, Math.max(requestedDelay, retryDelay));
      autoTimer.unref?.();
    });
  };
  const startup = async () => {
    // Persist the sanitized form once so legacy save storms are repaired even
    // before the user opens sync settings.
    const state = await stateStore.update((draft) => draft);
    if (state.enabled) {
      enqueueOutboxOperation(state, { logicalPath: "*", action: "scan", idempotencyKey: `startup:${Date.now()}` });
      await stateStore.update(() => state);
      scheduleAutoSync(2000);
    }
    return status();
  };
  const setDataRoot = (value) => { resolvedDataRoot = resolve(value); sessionConnection = null; return resolvedDataRoot; };

  return { status, setSessionCredentials, clearSessionCredentials, testConnection, configure, firstSyncPreview, enable, run, pause, resume, disconnect, setAutoSync, switchAccount, noteLocalChange, setBaiduMode, assertStorageTargetAllowed, operations, conflicts, resolveConflict, retry, logs, startup, setDataRoot, stateStore };
};
