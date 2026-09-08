import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DREAMINA_CLI_PROFILES, normalizeDreaminaCliProfileId, validDreaminaCliProfileId } from "../media-cli-presets.js";
import { appDataRoot } from "./app-data.mjs";
import { dreaminaCliRuntime } from "./dreamina-cli-profile.mjs";
import {
  claimDreaminaProfileIdentity,
  credentialFileFingerprint,
  readDreaminaProfileIdentityStore,
  saveDreaminaProfileIdentity,
} from "./dreamina-profile-identity-store.mjs";
import { dreaminaMembershipFromPayload } from "../dreamina-membership.js";
import { dreaminaAuthRefreshSessionRejectedMessage, isDreaminaAuthRefreshSessionRejected, isDreaminaAuthRequiredResponse } from "../dreamina-auth-recovery.js";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(moduleRoot, "../..");
const runnerPath = join(sourceRoot, "scripts", "windows", "dreamina-profile-runner.ps1");
const powershellPath = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const pendingRoot = () => join(appDataRoot(), "config", "dreamina-oauth-pending");
const oauthProfileQueues = new Map();
const OAUTH_BROWSER_TRANSACTION_FALLBACK_MS = 10 * 60_000;
const OAUTH_APPROVAL_FINALIZATION_GRACE_MS = 10 * 60_000;

const AUTH_BROWSERS = Object.freeze({
  edge: Object.freeze({ id: "edge", label: "Microsoft Edge", args: ["--new-window"], candidates: [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ] }),
  "360": Object.freeze({ id: "360", label: "360 浏览器", args: ["--new-window"], candidates: [
    "E:\\360\\360se6\\Application\\360se.exe",
    join(homedir(), "AppData", "Local", "360Chrome", "Chrome", "Application", "360chrome.exe"),
  ] }),
  quark: Object.freeze({ id: "quark", label: "夸克浏览器", args: ["--new-window"], candidates: [
    join(homedir(), "AppData", "Local", "Programs", "Quark", "quark.exe"),
  ] }),
  qq: Object.freeze({ id: "qq", label: "QQ 浏览器", args: ["--new-window"], candidates: [
    "C:\\Program Files\\Tencent\\QQBrowser\\QQBrowser.exe",
    "C:\\Program Files (x86)\\Tencent\\QQBrowser\\QQBrowser.exe",
  ] }),
  chrome: Object.freeze({ id: "chrome", label: "Google Chrome", args: ["--new-window"], candidates: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    join(homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
  ] }),
  uc: Object.freeze({ id: "uc", label: "UC 浏览器", args: ["--new-window"], candidates: [
    join(homedir(), "AppData", "Local", "Programs", "UC浏览器", "uc.exe"),
    "C:\\Program Files\\UCBrowser\\Application\\UCBrowser.exe",
    "C:\\Program Files (x86)\\UCBrowser\\Application\\UCBrowser.exe",
  ] }),
  sogou: Object.freeze({ id: "sogou", label: "搜狗浏览器", args: ["--new-window"], candidates: [
    "E:\\腾讯电脑管家软件搬家\\软件搬家\\搜狗高速浏览器\\SogouExplorer.exe",
    "C:\\Program Files\\Sogou\\SogouExplorer\\SogouExplorer.exe",
    "C:\\Program Files (x86)\\SogouExplorer\\SogouExplorer.exe",
    join(homedir(), "AppData", "Roaming", "Sogou", "SogouExplorer", "SogouExplorer.exe"),
  ] }),
});

const PROFILE_DEFAULT_BROWSER_IDS = Object.freeze({
  default: "edge",
  chenan: "360",
  xiaoyujie: "quark",
  "tashuo-juyougeng": "qq",
  "duanju-zuiqianxian": "chrome",
  "yinou-shijie": "uc",
  guobazai: "sogou",
});

const profileRemark = (profileId) => DREAMINA_CLI_PROFILES.find((item) => item.id === profileId)?.remarkName || profileId;
const requestedProfileIdValue = (value) => {
  if (!String(value || "").trim()) {
    throw Object.assign(new Error("请选择需要核验的即梦配置"), { statusCode: 422, code: "DREAMINA_PROFILE_REQUIRED" });
  }
  if (!validDreaminaCliProfileId(value)) {
    throw Object.assign(new Error("即梦配置 ID 无效，已阻止回退到默认账号"), { statusCode: 422, code: "DREAMINA_PROFILE_ID_INVALID" });
  }
  return normalizeDreaminaCliProfileId(value);
};
const browserForProfile = (profileId, requestedBrowserId = "") => {
  const browserId = String(requestedBrowserId || PROFILE_DEFAULT_BROWSER_IDS[profileId] || "").trim().toLowerCase();
  return AUTH_BROWSERS[browserId] || { id: "", label: "尚未指定", args: [], candidates: [] };
};
const pendingPath = (profileId) => join(pendingRoot(), `${profileId}.json`);
const pendingBackupPath = (profileId) => `${pendingPath(profileId)}.backup`;
const completionPath = (profileId) => `${pendingPath(profileId)}.completed`;
const completionBackupPath = (profileId) => `${completionPath(profileId)}.backup`;
let pendingWriteVersion = Date.now() * 1_000;

const replaceFile = async (path, temporary) => {
  try {
    await rename(temporary, path);
    return;
  } catch (error) {
    if (process.platform !== "win32" || !existsSync(path)) throw error;
  }
  const previous = `${path}.${process.pid}.${Date.now()}.previous`;
  try {
    await rename(path, previous);
    await rename(temporary, path);
    await rm(previous, { force: true });
  } catch (error) {
    await rename(previous, path).catch(() => {});
    throw error;
  }
};

const writePendingCopy = async (path, serialized) => {
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, serialized, "utf8");
  try {
    await replaceFile(path, temporary);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

const writePendingOAuth = async (profileId, pending) => {
  const path = pendingPath(profileId);
  const backup = pendingBackupPath(profileId);
  await mkdir(pendingRoot(), { recursive: true });
  pendingWriteVersion = Math.max(pendingWriteVersion + 1, Date.now() * 1_000);
  const persisted = {
    ...pending,
    pendingWriteVersion,
    pendingUpdatedAt: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
  let primaryError = null;
  try {
    await writePendingCopy(path, serialized);
  } catch (error) {
    primaryError = error;
  }
  try {
    await writePendingCopy(backup, serialized);
  } catch (backupError) {
    if (primaryError) throw Object.assign(primaryError, { backupError });
  }
};

const readPendingOAuth = async (profileId, { allowMissing = false } = {}) => {
  const candidates = [];
  const errors = [];
  for (const path of [pendingPath(profileId), pendingBackupPath(profileId)]) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value && typeof value === "object") candidates.push(value);
      else errors.push(new SyntaxError(`Invalid pending OAuth payload: ${path}`));
    } catch (error) {
      if (error?.code !== "ENOENT") errors.push(error);
    }
  }
  if (candidates.length) {
    return candidates.sort((left, right) => {
      const versionDelta = Number(right.pendingWriteVersion || 0) - Number(left.pendingWriteVersion || 0);
      if (versionDelta) return versionDelta;
      return Date.parse(String(right.pendingUpdatedAt || right.startedAt || ""))
        - Date.parse(String(left.pendingUpdatedAt || left.startedAt || ""));
    })[0];
  }
  if (!errors.length) {
    if (allowMissing) return null;
    throw Object.assign(new Error("没有待确认的即梦授权"), { statusCode: 409, code: "DREAMINA_OAUTH_NOT_STARTED" });
  }
  const corrupt = errors.some((error) => error instanceof SyntaxError);
  throw Object.assign(new Error(corrupt
    ? "即梦待确认授权记录及其安全副本均无法读取；原凭据和已核验身份保持不变"
    : "读取即梦待确认授权状态失败；原凭据和已核验身份保持不变，请稍后重试"), {
    statusCode: corrupt ? 500 : 503,
    code: corrupt ? "DREAMINA_OAUTH_PENDING_CORRUPT" : "DREAMINA_OAUTH_PENDING_READ_FAILED",
    cause: errors[0],
  });
};

const removePendingOAuth = async (profileId) => {
  // Delete the backup first so an interrupted cleanup cannot resurrect a
  // completed or cancelled OAuth transaction on the next launch.
  await rm(pendingBackupPath(profileId), { force: true });
  await rm(pendingPath(profileId), { force: true });
};

const writeOAuthCompletion = async (profileId, completion) => {
  const persisted = { ...completion, completedAt: completion.completedAt || new Date().toISOString() };
  const serialized = `${JSON.stringify(persisted, null, 2)}\n`;
  let primaryError = null;
  try {
    await writePendingCopy(completionPath(profileId), serialized);
  } catch (error) {
    primaryError = error;
  }
  try {
    await writePendingCopy(completionBackupPath(profileId), serialized);
  } catch (backupError) {
    if (primaryError) throw Object.assign(primaryError, { backupError });
  }
  return persisted;
};

const readOAuthCompletion = async (profileId) => {
  const candidates = [];
  for (const path of [completionPath(profileId), completionBackupPath(profileId)]) {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value?.complete === true && value.profileId === profileId) candidates.push(value);
    } catch {}
  }
  const completion = candidates.sort((left, right) => Date.parse(String(right.completedAt || "")) - Date.parse(String(left.completedAt || "")))[0] || null;
  if (!completion || !profileCredentialExists(profileId)) return null;
  const identity = (await readDreaminaProfileIdentityStore()).profiles[profileId] || {};
  return identity.expectedUserId && identity.expectedUserId === completion.userId ? completion : null;
};

const removeOAuthCompletion = async (profileId) => {
  await rm(completionBackupPath(profileId), { force: true });
  await rm(completionPath(profileId), { force: true });
};

const terminateProcessTree = (child) => new Promise((resolveTermination) => {
  const pid = Number(child?.pid) || 0;
  if (!pid) return resolveTermination();
  if (process.platform !== "win32") {
    try { child.kill("SIGKILL"); } catch {}
    return resolveTermination();
  }
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  const finish = () => resolveTermination();
  killer.once("error", finish);
  killer.once("close", finish);
});

const run = (executable, args, { env = process.env, timeoutMs = 60_000 } = {}) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(executable, args, { env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };
  const timer = setTimeout(() => {
    finish(() => {
      terminateProcessTree(child).finally(() => {
        rejectRun(Object.assign(new Error("即梦 OAuth 命令超时"), { code: "DREAMINA_OAUTH_TIMEOUT" }));
      });
    });
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", (error) => finish(() => rejectRun(error)));
  child.once("close", (code) => finish(() => resolveRun({ code: Number(code), stdout: stdout.trim(), stderr: stderr.trim() })));
});

const runnerArgs = (profileId, executable, cliArgs, { freshLogin = false, probeOnly = false } = {}) => [
  "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", runnerPath,
  "-ProfileId", profileId,
  "-Executable", executable,
  ...(freshLogin ? ["-FreshLogin"] : []),
  ...(probeOnly ? ["-ProbeOnly"] : []),
  ...cliArgs,
];

const invokeProfile = async (profileId, cliArgs, { freshLogin = false, timeoutMs = 60_000 } = {}) => {
  const runtime = dreaminaCliRuntime({ dreaminaCliProfile: profileId });
  const env = {
    ...process.env,
    HOME: runtime.profileHome,
    USERPROFILE: runtime.profileHome,
    SHENSI_DREAMINA_PROFILE_HOME: runtime.profileHome,
  };
  return run(powershellPath, runnerArgs(profileId, runtime.executable, cliArgs, { freshLogin }), { env, timeoutMs });
};

// Probe the real Windows broker without touching credentials or invoking the
// Dreamina CLI. A successful response proves the shared mutex is available.
export const probeDreaminaCredentialLock = async (profileId) => {
  const runtime = dreaminaCliRuntime({ dreaminaCliProfile: profileId });
  const env = {
    ...process.env,
    HOME: runtime.profileHome,
    USERPROFILE: runtime.profileHome,
    SHENSI_DREAMINA_PROFILE_HOME: runtime.profileHome,
  };
  const result = await run(
    powershellPath,
    runnerArgs(runtime.profileId, runtime.executable, [], { probeOnly: true }),
    { env, timeoutMs: 10_000 },
  );
  return {
    released: result.code === 0 && /DREAMINA_PROFILE_LOCK_ACQUIRED/u.test(`${result.stdout}\n${result.stderr}`),
    code: result.code,
    error: result.code === 0 ? "" : String(result.stderr || result.stdout || "即梦本机凭证锁仍未释放").trim(),
  };
};

const parsedJson = (source) => {
  try { return JSON.parse(String(source || "").trim()); } catch { return {}; }
};

export const dreaminaProfileCommandFailure = (result = {}) => {
  const detail = String(result.stderr || result.stdout || `退出码 ${result.code}`).trim();
  const markedCode = detail.match(/\[(DREAMINA_[A-Z0-9_]+)\]/u)?.[1] || "";
  const refreshSessionRejected = isDreaminaAuthRefreshSessionRejected(detail);
  const explicitLoggedOut = isDreaminaAuthRequiredResponse(detail);
  const brokerBusy = Number(result.code) === 75 || markedCode === "DREAMINA_PROFILE_BROKER_BUSY" || /credential slot is busy/i.test(detail);
  const transient = brokerBusy
    || ["DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED", "DREAMINA_CREDIT_QUERY_TIMEOUT", "DREAMINA_CONTROL_PLANE_TRANSIENT"].includes(markedCode)
    || /(?:protocol transport|do request|network|connection|timeout|timed out|temporar|socket)/iu.test(detail);
  return {
    ok: false,
    transient,
    code: markedCode || (brokerBusy ? "DREAMINA_PROFILE_BROKER_BUSY" : explicitLoggedOut ? "DREAMINA_AUTH_REQUIRED" : ""),
    error: brokerBusy
      ? "即梦账号通道正被生成、找回或其他账号核验占用，本次在线核验已延后；已保存的核验状态保持有效"
      : refreshSessionRejected
        ? dreaminaAuthRefreshSessionRejectedMessage()
      : transient
        ? "即梦账号通道或网络暂时不可用，本次在线核验已延后；已保存的核验状态保持有效"
      : detail,
  };
};

const oauthRecoverableFailure = (error = {}) => {
  const code = String(error?.code || "").trim().toUpperCase();
  const detail = String(error?.message || error || "").trim();
  if (isDreaminaAuthRefreshSessionRejected(detail)) return {
    transient: false,
    code: "DREAMINA_AUTH_REQUIRED",
    message: dreaminaAuthRefreshSessionRejectedMessage(),
  };
  if (code === "DREAMINA_OAUTH_TIMEOUT") return {
    transient: true,
    code,
    message: "即梦账号通道响应超时，已保留当前核验状态并等待自动重试",
  };
  if (/^(?:DREAMINA_(?:PROFILE_BROKER_BUSY|AUTH_REFRESH_TRANSPORT_FAILED|CREDIT_QUERY_TIMEOUT|CONTROL_PLANE_TRANSIENT)|DRIVER_TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)$/u.test(code)
    || /(?:protocol transport|do request|network|connection|timeout|timed out|temporar|socket)/iu.test(detail)) {
    return {
      transient: true,
      code: code || "DREAMINA_OAUTH_TRANSPORT_DEFERRED",
      message: "即梦账号通道或网络暂时不可用，已保留当前核验状态并等待自动重试",
    };
  }
  return { transient: false, code, message: detail };
};

const commandResultRecovery = (result = {}, fallback = "即梦账号核验暂时无法继续") => {
  const failure = dreaminaProfileCommandFailure(result);
  if (failure.transient) return {
    transient: true,
    code: failure.code || "DREAMINA_OAUTH_TRANSPORT_DEFERRED",
    message: failure.error,
  };
  const detail = String(result.stderr || result.stdout || fallback).trim();
  const transport = oauthRecoverableFailure({ message: detail });
  return transport.transient ? transport : { transient: false, code: "", message: detail };
};

const withOAuthProfileQueue = (profileId, operation) => {
  const id = normalizeDreaminaCliProfileId(profileId);
  const previous = oauthProfileQueues.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  oauthProfileQueues.set(id, current);
  return current.finally(() => {
    if (oauthProfileQueues.get(id) === current) oauthProfileQueues.delete(id);
  });
};

const liveIdentity = async (profileId) => {
  let result;
  try {
    // The official control plane routinely takes longer than 15 seconds even
    // when a generation has succeeded. The profile broker itself fails fast
    // when another account owns the credential slot, so this timeout can cover
    // one real user_credit request without blocking unrelated profiles.
    result = await invokeProfile(profileId, ["user_credit"], { timeoutMs: 60_000 });
  } catch (error) {
    const recovery = oauthRecoverableFailure(error);
    if (recovery.transient) {
      return {
        ok: false,
        transient: true,
        error: recovery.message,
      };
    }
    return { ok: false, transient: false, code: String(error?.code || ""), error: error?.message || "即梦账号在线核验失败" };
  }
  if (result.code !== 0) return dreaminaProfileCommandFailure(result);
  const payload = parsedJson(result.stdout);
  const nestedValue = (keys) => {
    const queue = [payload];
    const visited = new Set();
    while (queue.length) {
      const value = queue.shift();
      if (!value || typeof value !== "object" || visited.has(value)) continue;
      visited.add(value);
      for (const key of keys) {
        if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) return value[key];
      }
      Object.values(value).forEach((child) => { if (child && typeof child === "object") queue.push(child); });
    }
    return "";
  };
  const userId = String(nestedValue(["user_id", "userId", "uid"]) || "").trim();
  if (!userId) return { ok: false, code: "DREAMINA_ACCOUNT_ID_MISSING", error: "即梦没有返回 user_id" };
  const membership = dreaminaMembershipFromPayload(payload);
  return {
    ok: true,
    userId,
    credit: Number.isFinite(Number(nestedValue(["total_credit", "totalCredit", "credit", "credits"])))
      ? Number(nestedValue(["total_credit", "totalCredit", "credit", "credits"])) : null,
    vipLevel: membership.rawLevel,
    vipExpiresAt: membership.expiresAt,
    membershipTier: membership.tier,
    membershipLabel: membership.label,
  };
};

const creditSnapshot = (saved = {}, live = {}) => {
  const current = Number.isFinite(Number(live.credit)) ? Number(live.credit) : null;
  const previous = Number.isFinite(Number(saved.lastCredit)) ? Number(saved.lastCredit) : null;
  const delta = current !== null && previous !== null ? Math.max(0, previous - current) : 0;
  const consumed = Math.max(0, Number(saved.consumedCredit) || 0) + delta;
  const trackedTotal = current === null
    ? (Number.isFinite(Number(saved.trackedCreditTotal)) ? Number(saved.trackedCreditTotal) : null)
    : Math.max(current + consumed, Number(saved.trackedCreditTotal) || 0);
  return {
    lastCredit: current,
    trackedCreditTotal: trackedTotal,
    consumedCredit: consumed,
    lastConsumedCredit: delta > 0 ? delta : Math.max(0, Number(saved.lastConsumedCredit) || 0),
    creditUpdatedAt: new Date().toISOString(),
    vipLevel: live.vipLevel || saved.vipLevel || "",
    vipExpiresAt: live.vipExpiresAt || saved.vipExpiresAt || "",
    membershipTier: live.membershipTier && live.membershipTier !== "unknown"
      ? live.membershipTier : saved.membershipTier || "unknown",
    membershipLabel: live.membershipTier && live.membershipTier !== "unknown"
      ? live.membershipLabel : saved.membershipLabel || "会员等级待核验",
  };
};

const profileCredentialExists = (profileId) => existsSync(dreaminaCliRuntime({ dreaminaCliProfile: profileId }).credentialPath);

const parsedOAuthTimestamp = (value) => {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const oauthApprovalFinalizationIsWithinGrace = (pending = null, nowMs = Date.now()) => {
  const providerApprovedAt = parsedOAuthTimestamp(pending?.providerApprovedAt);
  return Boolean(providerApprovedAt
    && nowMs >= providerApprovedAt
    && nowMs - providerApprovedAt < OAUTH_APPROVAL_FINALIZATION_GRACE_MS);
};

// Browser approval and local identity verification are two separate commits.
// The official CLI can briefly report auth-required while its process-local
// authsdk cache catches up with the newly persisted profile snapshot. Only an
// explicit auth failure outside the bounded approval grace may roll back the
// new credential; transport/broker failures must remain retryable.
export const dreaminaOAuthFinalizationDisposition = ({ pending = null, live = {}, nowMs = Date.now() } = {}) => {
  if (live?.ok) return "complete";
  if (live?.transient) return "defer";
  if (String(live?.code || "").trim() === "DREAMINA_AUTH_REQUIRED") {
    return oauthApprovalFinalizationIsWithinGrace(pending, nowMs) ? "defer" : "rollback";
  }
  return "defer";
};

// A browser authorization URL is backed by one provider device code. Provider
// approval is useful evidence while we finish the local identity write, but it
// must never make an expired device code reusable: reopening that URL produces
// the provider's misleading “数据不存在” page.
export const dreaminaOAuthBrowserTransactionIsReusable = (pending = null, nowMs = Date.now()) => {
  if (!pending || typeof pending !== "object") return false;
  if (!String(pending.verificationUri || "").trim() || !String(pending.deviceCode || "").trim()) return false;
  const expiresAt = parsedOAuthTimestamp(pending.expiresAt);
  if (expiresAt) return expiresAt > nowMs;
  const startedAt = parsedOAuthTimestamp(pending.startedAt);
  return Boolean(startedAt && nowMs - startedAt < OAUTH_BROWSER_TRANSACTION_FALLBACK_MS);
};

const pendingOAuthTransactionIsActive = (pending = null, nowMs = Date.now()) => {
  if (!pending || typeof pending !== "object") return false;
  if (String(pending.verifiedUserId || "").trim()) return true;
  if (oauthApprovalFinalizationIsWithinGrace(pending, nowMs)) return true;
  return dreaminaOAuthBrowserTransactionIsReusable(pending, nowMs);
};

const duplicateIdentity = async (profileId, userId) => {
  const store = await readDreaminaProfileIdentityStore();
  return Object.values(store.profiles).find((item) => item.profileId !== profileId && item.expectedUserId === userId) || null;
};

const clearConnectionCaches = async (profileId) => {
  const base = profileId === "default"
    ? join(appDataRoot(), "provider-state")
    : join(appDataRoot(), "provider-state", "dreamina-profiles", profileId);
  await Promise.all(["dreamina-image", "dreamina-video"].map((channel) => rm(join(base, channel, "connection-check.json"), { force: true }).catch(() => {})));
};

export const listDreaminaProfileAccountStatuses = async ({ verifyLive = false, profileId = "" } = {}) => {
  if (verifyLive && !String(profileId || "").trim()) {
    throw Object.assign(new Error("实时核验必须指定即梦配置"), { statusCode: 422, code: "DREAMINA_PROFILE_REQUIRED" });
  }
  if (profileId && !validDreaminaCliProfileId(profileId)) {
    throw Object.assign(new Error("即梦配置 ID 无效，已阻止读取默认账号状态"), { statusCode: 422, code: "DREAMINA_PROFILE_ID_INVALID" });
  }
  const store = await readDreaminaProfileIdentityStore();
  const statuses = [];
  const profiles = [
    ...DREAMINA_CLI_PROFILES,
    ...Object.entries(store.profiles)
      .filter(([id]) => !DREAMINA_CLI_PROFILES.some((profile) => profile.id === id))
      .map(([id, record]) => ({ id, remarkName: record.remarkName || id })),
  ].filter((profile) => !profileId || profile.id === normalizeDreaminaCliProfileId(profileId));
  for (const profile of profiles) {
    const saved = store.profiles[profile.id] || {};
    const runtime = dreaminaCliRuntime({ dreaminaCliProfile: profile.id });
    const credentialExists = profileCredentialExists(profile.id);
    const currentCredentialFingerprint = credentialExists ? credentialFileFingerprint(runtime.credentialPath) : "";
    const completedOAuth = await readOAuthCompletion(profile.id);
    let pendingOAuth = null;
    try { pendingOAuth = await readPendingOAuth(profile.id, { allowMissing: true }); } catch {}
    const pendingFilesExist = existsSync(pendingPath(profile.id)) || existsSync(pendingBackupPath(profile.id));
    // A crashed renderer can leave an old pending file after the same profile
    // has already been verified successfully. Only an unexpired transaction
    // (or one with provider approval evidence) is an active pending state.
    // Otherwise it must not downgrade a durable identity to "网页已打开".
    const oauthPending = !completedOAuth && (pendingOAuth
      ? pendingOAuthTransactionIsActive(pendingOAuth)
      : pendingFilesExist);
    // Status and credit reads are observational. They must never start
    // `login --headless`: the official CLI owns one global Windows credential
    // slot, so an automatic recovery for one stale account can otherwise block
    // every other verified profile for up to a minute. Explicit OAuth
    // completion below is the only path allowed to restore the session.
    const live = verifyLive && credentialExists && !oauthPending
      ? await liveIdentity(profile.id)
      : null;
    let expected = (await readDreaminaProfileIdentityStore()).profiles[profile.id] || saved;
    let credentialChanged = Boolean(expected.credentialFingerprint
      && !String(expected.credentialFingerprint).startsWith("user:")
      && currentCredentialFingerprint
      && expected.credentialFingerprint !== currentCredentialFingerprint);
    if (live?.ok && expected.expectedUserId && live.userId === expected.expectedUserId) {
      expected = await saveDreaminaProfileIdentity({
        ...expected,
        profileId: profile.id,
        verifiedUserId: live.userId,
        ...(currentCredentialFingerprint ? { credentialFingerprint: currentCredentialFingerprint } : {}),
        verifiedAt: new Date().toISOString(),
        ...creditSnapshot(expected, live),
      });
      credentialChanged = false;
    }
    const actualUserId = live?.ok ? live.userId : expected.verifiedUserId || expected.expectedUserId || "";
    const duplicate = actualUserId ? await duplicateIdentity(profile.id, actualUserId) : null;
    const liveRequiresReverification = live?.code === "DREAMINA_AUTH_REQUIRED";
    const liveAccountIdMissing = live?.code === "DREAMINA_ACCOUNT_ID_MISSING";
    const state = !credentialExists ? "unbound"
      : live && !live.ok && liveRequiresReverification ? "invalid"
        : !expected.expectedUserId ? (oauthPending ? "pending" : "unverified")
          // The official CLI may rotate refresh material and rewrite auth.reg
          // after a normal command. A changed file hash is therefore not proof
          // that the account changed. Paid submission still reads the real
          // user_id and rejects a mismatch before creating a task.
          : actualUserId && actualUserId !== expected.expectedUserId ? "mismatch"
            : duplicate ? "duplicate"
              // Durable identity wins over a stale/pending OAuth marker. A
              // successful prior verification remains usable while a new
              // explicit rebind transaction is waiting or being cleaned up.
              : expected.expectedUserId ? "verified"
                : oauthPending ? "pending" : "verified";
    statuses.push({
      profileId: profile.id,
      remarkName: profile.remarkName,
      browser: browserForProfile(profile.id, expected.browser),
      credentialExists,
      oauthPending,
      state,
      expectedUserId: expected.expectedUserId || "",
      actualUserId,
      credentialChanged,
      duplicateProfileId: duplicate?.profileId || "",
      duplicateRemarkName: duplicate?.remarkName || "",
      credit: live?.ok ? live.credit : expected.lastCredit ?? null,
      trackedCreditTotal: expected.trackedCreditTotal ?? null,
      consumedCredit: expected.consumedCredit ?? 0,
      lastConsumedCredit: expected.lastConsumedCredit ?? 0,
      creditEstimates: Array.isArray(expected.creditEstimates) ? expected.creditEstimates : [],
      creditUpdatedAt: expected.creditUpdatedAt || "",
      vipLevel: live?.ok ? live.vipLevel : expected.vipLevel || "",
      vipExpiresAt: live?.ok ? live.vipExpiresAt || expected.vipExpiresAt || "" : expected.vipExpiresAt || "",
      membershipTier: live?.ok && live.membershipTier !== "unknown" ? live.membershipTier : expected.membershipTier || "unknown",
      membershipLabel: live?.ok && live.membershipTier !== "unknown" ? live.membershipLabel : expected.membershipLabel || "会员等级待核验",
      verifiedAt: live?.ok ? new Date().toISOString() : expected.verifiedAt || "",
      liveVerified: live?.ok === true,
      creditSource: live?.ok ? "live" : "saved",
      creditRefreshDeferred: live?.transient === true,
      statusReadUnavailable: Boolean(live && !live.ok && !live.transient && !liveRequiresReverification && !liveAccountIdMissing),
      error: live && !live.ok && !(expected.expectedUserId && live.code === "DREAMINA_ACCOUNT_ID_MISSING") ? live.error : "",
    });
  }
  return statuses;
};

export const parseDreaminaOAuthMaterial = (text) => {
  const value = String(text || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/^\uFEFF/u, "");
  const jsonValues = [];
  for (const candidate of [value.trim(), ...value.split(/\r?\n/gu).map((line) => line.trim())]) {
    if (!candidate || !/^[\[{]/u.test(candidate)) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") jsonValues.push(parsed);
    } catch {}
  }
  const field = (...names) => {
    for (const source of jsonValues) {
      for (const name of names) {
        const found = source[name];
        if (typeof found === "string" || typeof found === "number") return String(found).trim();
      }
    }
    const aliases = names
      .map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
      .join("|");
    const match = value.match(new RegExp(
      `(?:^|[^A-Za-z0-9_])(?:${aliases})\\s*[:=：]\\s*(?:"([^"\\r\\n]*)"|'([^'\\r\\n]*)'|([^\\s,}\\]\\r\\n]+))`,
      "iu",
    ));
    return String(match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  };
  return {
    verificationUri: field("verification_uri", "verificationUri"),
    userCode: field("user_code", "userCode"),
    deviceCode: field("device_code", "deviceCode"),
    expiresAt: field("expires_at", "expiresAt"),
  };
};

const launchProfileBrowser = async (profileId, url, browserId = "") => {
  const browser = browserForProfile(profileId, browserId);
  const executable = browser.candidates.find((candidate) => existsSync(candidate));
  if (!executable) return {
    opened: false,
    executable: "",
    browser: browser.label,
    openError: `未找到${browser.label}可执行文件`,
  };
  return new Promise((resolveLaunch) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveLaunch(result);
    };
    let child;
    try {
      child = spawn(executable, [...(browser.args || []), url], { detached: true, windowsHide: false, stdio: "ignore" });
    } catch (error) {
      finish({ opened: false, executable, browser: browser.label, openError: error?.message || "浏览器启动失败" });
      return;
    }
    child.once("error", (error) => finish({
      opened: false,
      executable,
      browser: browser.label,
      openError: error?.message || "浏览器启动失败",
    }));
    child.once("spawn", () => finish({ opened: true, executable, browser: browser.label }));
    child.unref();
    // A successful detached browser emits `spawn`; retain a bounded fallback
    // for platform-specific child implementations that omit that event.
    setTimeout(() => finish({ opened: true, executable, browser: browser.label }), 500).unref?.();
  });
};

export const startDreaminaProfileOAuth = async ({ requestedProfileId, requestedBrowserId = "" } = {}) => {
  const id = requestedProfileIdValue(requestedProfileId);
  return withOAuthProfileQueue(id, async () => {
  const store = await readDreaminaProfileIdentityStore();
  const savedBrowserId = store.profiles[id]?.browser || "";
  const browser = browserForProfile(id, requestedBrowserId || savedBrowserId);
  if (!browser.id) throw Object.assign(new Error("首次核验前请选择授权浏览器"), { statusCode: 422, code: "DREAMINA_BROWSER_REQUIRED" });
  const runtime = dreaminaCliRuntime({ dreaminaCliProfile: id });
  await mkdir(runtime.profileHome, { recursive: true });
  // Starting an explicit new verification supersedes any idempotency receipt
  // left by the previous successful transaction for this same profile only.
  const previousCompletion = await readOAuthCompletion(id);
  if (previousCompletion) {
    // If the success response was persisted but cleanup was interrupted, the
    // old pending transaction must be removed before its receipt. Otherwise a
    // new explicit verification can accidentally reopen the completed flow.
    await removePendingOAuth(id);
    await removeOAuthCompletion(id);
  }
  // Reuse an existing, unexpired OAuth transaction for this exact profile.
  // Starting a second relogin would discard the browser approval that may
  // already be in flight and can make a successful verification look lost.
  const previousPending = await readPendingOAuth(id, { allowMissing: true });
  if (previousPending) {
    if (dreaminaOAuthBrowserTransactionIsReusable(previousPending)) {
      return {
        profileId: id,
        remarkName: previousPending.remarkName || profileRemark(id),
        browser: browserForProfile(id, previousPending.browser).label,
        expiresAt: previousPending.expiresAt || "",
        userCode: previousPending.userCode || "",
        reusedPending: true,
        ...(await launchProfileBrowser(id, previousPending.verificationUri, previousPending.browser)),
      };
    }
    try {
      await restoreCredentialBackup(id, previousPending);
    } catch (error) {
      throw Object.assign(new Error("清理过期即梦授权前无法恢复原凭据；当前核验状态保持不变，请稍后重试"), { statusCode: 503, code: "DREAMINA_OAUTH_BACKUP_RESTORE_FAILED", cause: error });
    }
    if (previousPending.backupPath) await rm(previousPending.backupPath, { force: true }).catch(() => {});
    try {
      await removePendingOAuth(id);
    } catch (error) {
      throw Object.assign(new Error("清理过期即梦授权状态失败；原凭据已恢复，请稍后重试"), { statusCode: 503, code: "DREAMINA_OAUTH_PENDING_CLEANUP_FAILED", cause: error });
    }
  }
  const backupPath = join(runtime.profileHome, `auth.before-rebind.${Date.now()}.reg`);
  const hadCredential = existsSync(runtime.credentialPath);
  if (hadCredential) await copyFile(runtime.credentialPath, backupPath);
  let result;
  try {
    result = await invokeProfile(id, ["relogin", "--headless"], { freshLogin: true, timeoutMs: 60_000 });
  } catch (error) {
    const recovery = oauthRecoverableFailure(error);
    if (recovery.transient) {
      await restoreCredentialBackup(id, { backupPath: hadCredential ? backupPath : "" });
      if (hadCredential) await rm(backupPath, { force: true }).catch(() => {});
      return { profileId: id, remarkName: profileRemark(id), startDeferred: true, retryable: true, code: recovery.code, message: recovery.message };
    }
    await restoreCredentialBackup(id, { backupPath: hadCredential ? backupPath : "" });
    if (hadCredential) await rm(backupPath, { force: true }).catch(() => {});
    throw error;
  }
  if (result.code !== 0) {
    const recovery = commandResultRecovery(result, "即梦 OAuth 启动失败");
    if (recovery.transient) {
      await restoreCredentialBackup(id, { backupPath: hadCredential ? backupPath : "" });
      if (hadCredential) await rm(backupPath, { force: true }).catch(() => {});
      return { profileId: id, remarkName: profileRemark(id), startDeferred: true, retryable: true, code: recovery.code, message: recovery.message };
    }
    await restoreCredentialBackup(id, { backupPath: hadCredential ? backupPath : "" });
    if (hadCredential) await rm(backupPath, { force: true }).catch(() => {});
    throw Object.assign(new Error(recovery.message), { statusCode: 502, code: "DREAMINA_OAUTH_START_FAILED" });
  }
  const material = parseDreaminaOAuthMaterial(`${result.stdout}\n${result.stderr}`);
  if (!material.verificationUri || !material.deviceCode) {
    await restoreCredentialBackup(id, { backupPath: hadCredential ? backupPath : "" });
    if (hadCredential) await rm(backupPath, { force: true }).catch(() => {});
    throw Object.assign(new Error("即梦 OAuth 没有返回授权链接或设备码"), { statusCode: 502, code: "DREAMINA_OAUTH_MATERIAL_MISSING" });
  }
  const pending = {
    profileId: id,
    remarkName: profileRemark(id),
    browser: browser.id,
    ...material,
    backupPath: hadCredential ? backupPath : "",
    startedAt: new Date().toISOString(),
  };
  await writePendingOAuth(id, pending);
  return {
    ...pending,
    backupPath: undefined,
    deviceCode: undefined,
    ...(await launchProfileBrowser(id, material.verificationUri, browser.id)),
  };
  });
};

export const reopenDreaminaProfileOAuth = async ({ requestedProfileId } = {}) => {
  const id = requestedProfileIdValue(requestedProfileId);
  let pending;
  try { pending = await readPendingOAuth(id); } catch (error) {
    if (error?.code !== "DREAMINA_OAUTH_NOT_STARTED") throw error;
    throw Object.assign(new Error("没有等待确认的即梦授权，请重新发起核验"), { statusCode: 409, code: "DREAMINA_OAUTH_NOT_STARTED" });
  }
  if (!pending.verificationUri) {
    throw Object.assign(new Error("已保存的即梦授权链接无效，请重新发起核验"), { statusCode: 409, code: "DREAMINA_OAUTH_URI_MISSING" });
  }
  if (!dreaminaOAuthBrowserTransactionIsReusable(pending)) {
    // A second click must stay useful. Replace only this profile's expired
    // OAuth transaction and launch a fresh provider URL; credentials are first
    // restored by startDreaminaProfileOAuth's guarded cleanup path.
    return {
      ...(await startDreaminaProfileOAuth({ requestedProfileId: id, requestedBrowserId: pending.browser })),
      replacedExpiredTransaction: true,
    };
  }
  return {
    profileId: id,
    remarkName: pending.remarkName || profileRemark(id),
    browser: browserForProfile(id, pending.browser).label,
    expiresAt: pending.expiresAt || "",
    userCode: pending.userCode || "",
    ...(await launchProfileBrowser(id, pending.verificationUri, pending.browser)),
  };
};

const restoreCredentialBackup = async (profileId, pending) => {
  const runtime = dreaminaCliRuntime({ dreaminaCliProfile: profileId });
  if (pending.backupPath && existsSync(pending.backupPath)) await copyFile(pending.backupPath, runtime.credentialPath);
  else await rm(runtime.credentialPath, { force: true });
};

export const completeDreaminaProfileOAuth = async ({ requestedProfileId, pollSeconds = 30 } = {}) => {
  const id = requestedProfileIdValue(requestedProfileId);
  return withOAuthProfileQueue(id, async () => {
  let pending;
  try { pending = await readPendingOAuth(id); } catch (error) {
    if (error?.code === "DREAMINA_OAUTH_NOT_STARTED") {
      const completed = await readOAuthCompletion(id);
      if (completed) return completed;
    }
    if (error?.code !== "DREAMINA_OAUTH_NOT_STARTED") throw error;
    throw Object.assign(new Error("没有待完成的即梦授权"), { statusCode: 409, code: "DREAMINA_OAUTH_NOT_STARTED" });
  }
  const poll = Math.max(0, Math.min(30, Number(pollSeconds) || 0));
  // `relogin --headless` persists an OAuth transaction in this profile's
  // isolated keychain. `checklogin` must resume that same transaction. Running
  // it with FreshLogin clears the transaction first and makes the official CLI
  // report `authsdk: not logged in` even after the user approved in-browser.
  let live = null;
  // If provider approval was already observed but the local ledger write was
  // interrupted, finish from the durable evidence instead of consuming the
  // device code a second time.
  const evidenceUserId = String(pending.verifiedUserId || "").trim();
  const providerApprovalObserved = Boolean(evidenceUserId || String(pending.providerApprovedAt || "").trim());
  if (!providerApprovalObserved) {
    let result;
    try {
      result = await invokeProfile(id, ["login", "checklogin", `--device_code=${pending.deviceCode}`, `--poll=${poll}`], { freshLogin: false, timeoutMs: Math.max(15_000, (poll + 15) * 1_000) });
    } catch (error) {
      const recovery = oauthRecoverableFailure(error);
      if (recovery.transient) return { complete: false, profileId: id, verificationDeferred: true, retryable: true, code: recovery.code, message: recovery.message };
      throw error;
    }
    if (result.code !== 0) {
      const recovery = commandResultRecovery(result, "等待浏览器确认授权");
      if (recovery.transient) return { complete: false, profileId: id, verificationDeferred: true, retryable: true, code: recovery.code, message: recovery.message };
      return { complete: false, profileId: id, message: recovery.message };
    }
    try {
      pending = { ...pending, providerApprovedAt: new Date().toISOString() };
      await writePendingOAuth(id, pending);
    } catch (error) {
      return {
        complete: false,
        profileId: id,
        verificationDeferred: true,
        persistenceDeferred: true,
        authorizationAccepted: true,
        message: `浏览器授权已经通过，但本地待确认状态暂时无法保存，将自动重试：${error?.message || "本地存储暂时不可用"}`,
      };
    }
    live = await liveIdentity(id);
  } else {
    live = await liveIdentity(id);
    if (evidenceUserId && live.ok && live.userId !== evidenceUserId) {
      await restoreCredentialBackup(id, pending);
      if (pending.backupPath) await rm(pending.backupPath, { force: true }).catch(() => {});
      await removePendingOAuth(id).catch(() => {});
      throw Object.assign(new Error(`授权返回的账号身份已变化（user_id=${live.userId}），已恢复原凭据，请重新核验`), { statusCode: 409, code: "DREAMINA_ACCOUNT_MISMATCH" });
    }
  }
  if (!live.ok) {
    const finalizationDisposition = dreaminaOAuthFinalizationDisposition({ pending, live });
    if (finalizationDisposition === "defer") {
      // Browser approval already wrote the new isolated credential snapshot.
      // A concurrent generation may briefly own the one Windows registry
      // broker before user_credit can read its user_id. Keep the new snapshot
      // and the pending OAuth transaction intact so the renderer can poll
      // again; restoring the old backup here would turn a successful browser
      // authorization into an apparent later logout.
      return {
        complete: false,
        profileId: id,
        verificationDeferred: true,
        retryable: true,
        authorizationAccepted: true,
        code: String(live.code || "DREAMINA_OAUTH_FINALIZATION_DEFERRED"),
        ...(oauthApprovalFinalizationIsWithinGrace(pending) ? {
          graceExpiresAt: new Date(parsedOAuthTimestamp(pending.providerApprovedAt) + OAUTH_APPROVAL_FINALIZATION_GRACE_MS).toISOString(),
        } : {}),
        message: live.error || "授权已接收，正在等待即梦账号通道释放后确认身份",
      };
    }
    await restoreCredentialBackup(id, pending);
    if (pending.backupPath) await rm(pending.backupPath, { force: true }).catch(() => {});
    await removePendingOAuth(id).catch(() => {});
    throw Object.assign(new Error(`授权返回后无法核验账号：${live.error}`), { statusCode: 502, code: "DREAMINA_OAUTH_VERIFY_FAILED" });
  }
  if (!evidenceUserId) {
    try {
      pending = {
        ...pending,
        verifiedUserId: live.userId,
        verifiedCredit: live.credit,
        verifiedVipLevel: live.vipLevel || "",
        verifiedAt: new Date().toISOString(),
      };
      await writePendingOAuth(id, pending);
    } catch (error) {
      return {
        complete: false,
        profileId: id,
        verificationDeferred: true,
        persistenceDeferred: true,
        authorizationAccepted: true,
        message: `账号授权已接收，但本地核验中间状态暂时无法保存，将自动重试：${error?.message || "本地存储暂时不可用"}`,
      };
    }
  }
  const runtime = dreaminaCliRuntime({ dreaminaCliProfile: id });
  let claimed;
  try {
    claimed = await claimDreaminaProfileIdentity({
      profileId: id,
      remarkName: profileRemark(id),
      expectedUserId: live.userId,
      verifiedUserId: live.userId,
      credentialFingerprint: credentialFileFingerprint(runtime.credentialPath),
      browser: browserForProfile(id, pending.browser).id,
      boundAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      lastCredit: live.credit,
      trackedCreditTotal: live.credit,
      consumedCredit: 0,
      lastConsumedCredit: 0,
      creditUpdatedAt: new Date().toISOString(),
      vipLevel: live.vipLevel,
      vipExpiresAt: live.vipExpiresAt || "",
    });
  } catch (error) {
    // The provider has accepted the browser authorization, but the local
    // identity ledger could not be committed. Keep the new credential and the
    // pending transaction so the next poll can finish the same verification;
    // never restore the old account or report a false authorization failure.
    return {
      complete: false,
      profileId: id,
      verificationDeferred: true,
      persistenceDeferred: true,
      authorizationAccepted: true,
      message: `账号授权已接收，但本地核验记录暂时无法保存，将自动重试：${error?.message || "本地存储暂时不可用"}`,
    };
  }
  if (claimed.duplicate) {
    await restoreCredentialBackup(id, pending);
    if (pending.backupPath) await rm(pending.backupPath, { force: true }).catch(() => {});
    await removePendingOAuth(id).catch(() => {});
    await clearConnectionCaches(id);
    throw Object.assign(new Error(`授权账号与“${claimed.duplicate.remarkName || claimed.duplicate.profileId}”重复（user_id=${live.userId}），已恢复原凭据，请在${browserForProfile(id, pending.browser).label}切换到正确账号后重试`), { statusCode: 409, code: "DREAMINA_ACCOUNT_DUPLICATE" });
  }
  const saved = claimed.saved;
  const completion = {
    complete: true,
    profileId: id,
    remarkName: saved.remarkName,
    userId: live.userId,
    credit: live.credit,
    vipLevel: live.vipLevel,
    completedAt: new Date().toISOString(),
  };
  let completionPersisted = false;
  try {
    await writeOAuthCompletion(id, completion);
    completionPersisted = true;
  } catch {}
  if (completionPersisted) {
    if (pending.backupPath) await rm(pending.backupPath, { force: true }).catch(() => {});
    await removePendingOAuth(id).catch(() => {});
  }
  await clearConnectionCaches(id);
  return completion;
  });
};
