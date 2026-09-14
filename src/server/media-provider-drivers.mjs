import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { dirname, extname, join, resolve } from "node:path";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { DREAMINA_IMAGE_CLI_ALIAS, DREAMINA_VIDEO_CLI_ALIAS, LIBTV_CLI_ALIAS } from "../media-cli-presets.js";
import { isDreaminaAuthRefreshRetryableFailure, isDreaminaAuthRefreshSessionRejected, isDreaminaAuthRequiredResponse } from "../dreamina-auth-recovery.js";
import { sanitizeMediaProviderPrompt } from "../media-prompt.js";
import { dreaminaCliEnvironment } from "./dreamina-cli-profile.mjs";

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const DREAMINA_IMAGE_BRIDGE_PATH = resolve(moduleRoot, "../cli/dreamina-image-cli.mjs");
const DREAMINA_VIDEO_BRIDGE_PATH = resolve(moduleRoot, "../cli/dreamina-video-cli.mjs");

const asError = (message, code = "") => {
  const error = new Error(message);
  if (code) error.providerErrorCode = code;
  return error;
};

const providerPrompt = (job = {}) => sanitizeMediaProviderPrompt(
  job.request?.executionPrompt || job.request?.prompt || "",
  { referenceTokens: job.request?.providerPromptReferenceTokens || [], preserveReferenceTokens: job.channel === "video" && String(job.request?.settings?.provider || "") === "即梦" && String(job.request?.settings?.adapter || "") === "cli" && job.request?.preserveReferenceTokens === true },
);

const parsedJson = (source) => {
  const text = String(source || "").trim();
  try { return JSON.parse(text); } catch {}
  const start = text.lastIndexOf("{");
  if (start >= 0) {
    try { return JSON.parse(text.slice(start)); } catch {}
  }
  return {};
};

const PLACEHOLDER_PROVIDER_TASK_IDS = new Set([
  "",
  "0",
  "-",
  "none",
  "null",
  "undefined",
  "unknown",
  "missing",
  "n/a",
  "na",
]);

const normalizeProviderTaskId = (value) => {
  const normalized = String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
  return PLACEHOLDER_PROVIDER_TASK_IDS.has(normalized.toLowerCase()) ? "" : normalized;
};

const providerTaskIdFromOutput = (source = "") => {
  const text = String(source || "");
  const payload = parsedJson(text);
  const direct = payload?.providerTaskId || payload?.submit_id || payload?.submitId || payload?.task_id || payload?.taskId
    || payload?.data?.submit_id || payload?.data?.submitId || payload?.data?.task_id || payload?.data?.taskId;
  const directId = normalizeProviderTaskId(direct);
  if (directId) return directId;
  const matches = text.matchAll(/(?:^|[\r\n{,])\s*["']?(?:providerTaskId|submit_id|submitId|task_id|taskId)["']?\s*[=:]\s*["']?([^\s,"'}]+)["']?/gim);
  for (const match of matches) {
    const candidate = normalizeProviderTaskId(match?.[1]);
    if (candidate) return candidate;
  }
  return "";
};

const terminateSpawnTree = (child, timeoutMs = 5_000) => new Promise((resolveKill) => {
  const pid = Number(child?.pid) || 0;
  if (!pid) return resolveKill();
  if (process.platform !== "win32") {
    try { child.kill("SIGKILL"); } catch {}
    return resolveKill();
  }
  const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    windowsHide: true,
    stdio: "ignore",
  });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    resolveKill();
  };
  const timer = setTimeout(() => {
    try { killer.kill(); } catch {}
    finish();
  }, timeoutMs);
  killer.once("error", finish);
  killer.once("close", finish);
});

const spawnJson = ({ executable, args, cwd, env = process.env, timeoutMs = 60_000, extractDreaminaTaskId = false }) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(async () => {
    if (settled) return;
    settled = true;
    await terminateSpawnTree(child);
    rejectRun(asError(`媒体驱动命令超过 ${Math.ceil(timeoutMs / 1000)} 秒未响应`, "DRIVER_TIMEOUT"));
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectRun(asError(`媒体驱动无法启动：${error.message}`, error.code || "DRIVER_START_FAILED"));
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) {
      const message = extractDreaminaTaskId
        ? [stdout.trim(), stderr.trim()].filter(Boolean).join("\n") || `媒体驱动退出码 ${code}`
        : stderr.trim() || stdout.trim() || `媒体驱动退出码 ${code}`;
      const providerTaskId = extractDreaminaTaskId ? providerTaskIdFromOutput(message) : "";
      const rawMarkedCode = message.match(/(?:^|\r?\n)\[(DREAMINA_[A-Z0-9_]+)\]\s*/)?.[1] || "";
      const markedCode = extractDreaminaTaskId && providerTaskId && rawMarkedCode === "DREAMINA_AUTH_REQUIRED"
        ? "DREAMINA_PROVIDER_TASK_AUTH_FAILURE"
        : rawMarkedCode;
      const refreshCode = !markedCode
        ? isDreaminaAuthRequiredResponse(message)
          ? extractDreaminaTaskId && providerTaskId ? "DREAMINA_PROVIDER_TASK_AUTH_FAILURE" : "DREAMINA_AUTH_REQUIRED"
          : isDreaminaAuthRefreshRetryableFailure(message)
            ? "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED"
            : ""
        : "";
      const providerCode = markedCode || refreshCode || "DRIVER_EXIT_FAILED";
      const error = asError(message.replace(/(?:^|\r?\n)\[DREAMINA_[A-Z0-9_]+\]\s*/, "\n").trim(), providerCode);
      if ([
        "DREAMINA_PROFILE_BROKER_BUSY",
        "DREAMINA_AUTH_REQUIRED",
        "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED",
        "DREAMINA_REFERENCE_UPLOAD_NO_TASK",
        "DREAMINA_REFERENCE_INVALID",
        "DREAMINA_TASK_RESOURCE_UNVERIFIED",
      ].includes(providerCode)) error.submissionOutcomeKnown = true;
      error.stdout = stdout.trim();
      error.stderr = stderr.trim();
      if (providerTaskId) {
        error.providerTaskId = providerTaskId;
        error.submissionOutcomeKnown = true;
      }
      return rejectRun(error);
    }
    resolveRun(parsedJson(stdout));
  });
});

const spawnRaw = ({ executable, args, cwd, env = process.env, timeoutMs = 60_000 }) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(async () => {
    if (settled) return;
    settled = true;
    await terminateSpawnTree(child);
    rejectRun(asError(`媒体驱动命令超过 ${Math.ceil(timeoutMs / 1000)} 秒未响应`, "DRIVER_TIMEOUT"));
  }, timeoutMs);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectRun(asError(`媒体驱动无法启动：${error.message}`, error.code || "DRIVER_START_FAILED"));
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) {
      const message = stderr.trim() || stdout.trim() || `媒体驱动退出码 ${code}`;
      rejectRun(asError(message, "DRIVER_EXIT_FAILED"));
      return;
    }
    resolveRun({ stdout, stderr });
  });
});

const providerStatus = (value) => {
  const status = String(value || "").toLowerCase();
  if (["completed", "complete", "succeeded", "succeed", "success", "done"].includes(status)) return "completed";
  if (["failed", "fail", "error", "unknown", "expired", "not_found"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["queued", "pending", "created", "waiting"].includes(status)) return "queued";
  return "running";
};

const cachedDreaminaCapability = ({ settings = {}, error, channel }) => {
  const code = String(error?.providerErrorCode || error?.code || "").toUpperCase();
  if (!["DRIVER_TIMEOUT", "DREAMINA_PROFILE_BROKER_BUSY", "DREAMINA_CONTROL_PLANE_TRANSIENT", "DREAMINA_CREDIT_QUERY_TIMEOUT", "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED"].includes(code)) return null;
  const env = dreaminaCliEnvironment(settings, process.env);
  const profileId = String(env.SHENSI_DREAMINA_PROFILE_ID || "").trim();
  const expectedUserId = String(env.SHENSI_DREAMINA_EXPECTED_USER_ID || "").trim();
  const credentialFingerprint = String(env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT || "").trim();
  if (!profileId || !expectedUserId || !credentialFingerprint || credentialFingerprint === "unverified") return null;
  return {
    available: true,
    generationReady: false,
    taskResourceChecked: false,
    userId: expectedUserId,
    profileId,
    credentialFingerprint,
    verificationLevel: "cached_verified_profile",
    visibilityChecked: false,
    controlPlaneDeferred: true,
    taskResourceErrorCode: code,
    controlPlaneWarning: String(error?.message || error || ""),
    models: channel === "image"
      ? ["5.0Pro", "5.0", "4.7", "4.6", "4.5", "4.1", "4.0", "3.1", "3.0"]
      : ["seedance2.5", "seedance2.0fast", "seedance2.0", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance1.5pro", "seedance1.0fast", "seedance1.0"],
    inputTypes: channel === "image" ? ["text", "image"] : ["text", "image", "video", "audio"],
  };
};

const jsonResponse = async (response) => {
  const text = await response.text();
  const payload = parsedJson(text);
  if (!response.ok) {
    const error = asError(payload.error?.message || payload.message || `媒体服务请求失败（HTTP ${response.status}）`, payload.error?.code || `HTTP_${response.status}`);
    const retryAfter = String(response.headers.get("retry-after") || "").trim();
    const seconds = Number(retryAfter);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    error.retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Number.isFinite(dateDelay) && dateDelay > 0 ? dateDelay : 0;
    throw error;
  }
  return payload;
};

const httpBaseUrl = (value, fallback) => {
  const url = new URL(String(value || fallback));
  if (!/^https?:$/.test(url.protocol)) throw new Error("媒体服务 Base URL 仅支持 HTTP 或 HTTPS");
  return url.toString().replace(/\/$/, "");
};

const openAiHeaders = (settings, { json = false, idempotencyKey = "" } = {}) => ({
  Authorization: `Bearer ${settings.apiKey}`,
  ...(json ? { "Content-Type": "application/json" } : {}),
  ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
});

const videoSize = (aspectRatio, resolution) => {
  if (resolution === "1080p") return aspectRatio === "9:16" ? "1080x1920" : "1920x1080";
  if (resolution === "4k") return aspectRatio === "9:16" ? "2160x3840" : "3840x2160";
  return aspectRatio === "9:16" ? "720x1280" : "1280x720";
};

const expiryAfterHours = (hours = 24) => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

const resultUrlFrom = (payload = {}) => String(
  payload.result_url
  || payload.video_url
  || payload.url
  || payload.content?.video_url
  || payload.content?.url
  || payload.output?.video_url
  || payload.output?.url
  || payload.output?.results?.find?.((item) => item?.url)?.url
  || payload.output?.choices?.flatMap?.((choice) => choice?.message?.content ?? []).find?.((item) => item?.image)?.image
  || payload.data?.find?.((item) => item?.url)?.url
  || payload.task_result?.videos?.find?.((item) => item?.url)?.url
  || payload.task_result?.images?.find?.((item) => item?.url)?.url
  || payload.data?.task_result?.videos?.find?.((item) => item?.url)?.url
  || payload.data?.task_result?.images?.find?.((item) => item?.url)?.url
  || payload.data?.task_result?.video?.url
  || payload.data?.task_result?.image?.url
  || "",
);

const providerErrorFrom = (payload = {}) => ({
  error: String(payload.error?.message || payload.output?.message || payload.data?.task_status_msg || payload.message || ""),
  errorCode: String(payload.error?.code || payload.output?.code || payload.code || ""),
});

const unsafeIpv4 = (hostname) => {
  const parts = String(hostname || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 168)
    || (a === 192 && b === 88 && c === 99)
    || (a === 198 && [18, 19].includes(b))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
};

export const isUnsafeMediaNetworkAddress = (address) => {
  const value = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!value) return true;
  const family = isIP(value);
  if (family === 4) return unsafeIpv4(value);
  if (family === 6) {
    if (value.startsWith("::ffff:")) return unsafeIpv4(value.slice(7));
    // Only globally routable unicast IPv6 is accepted. Documentation, local,
    // multicast, transition and reserved ranges remain blocked by default.
    return !/^[23][0-9a-f]{0,3}:/.test(value) || value.startsWith("2001:db8:")
      || value.startsWith("3fff:") || value.startsWith("2001:0:") || value.startsWith("2001:0000:")
      || value.startsWith("2001:2:") || value.startsWith("2001:10:") || value.startsWith("2001:20:")
      || value.startsWith("2002:");
  }
  return true;
};

const allowedPrivateProviderIpv4 = (address) => {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

export const isAllowedPrivateMediaProviderAddress = (address) => {
  const value = String(address || "").replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(value);
  if (family === 4) return allowedPrivateProviderIpv4(value);
  if (family === 6) {
    if (value === "::1") return true;
    if (value.startsWith("::ffff:")) return allowedPrivateProviderIpv4(value.slice(7));
    return value.startsWith("fc") || value.startsWith("fd");
  }
  return false;
};

const normalizedNetworkHostname = (hostname) => String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();

const explicitlyAllowedPrivateProviderHostnames = () => new Set(
  String(process.env.SHENSI_MEDIA_PRIVATE_PROVIDER_HOSTS || "")
    .split(",")
    .map((hostname) => normalizedNetworkHostname(hostname.trim()))
    .filter((hostname) => hostname && (isIP(hostname) || /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(hostname))),
);

export const assertSafeMediaDownloadUrl = (value, { privateProviderHostname = "" } = {}) => {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { throw asError("媒体厂商返回了无效下载地址", "INVALID_RESULT_URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw asError("媒体结果下载地址必须是无内嵌凭据的 HTTP(S) URL", "UNSAFE_RESULT_URL");
  }
  const hostname = normalizedNetworkHostname(parsed.hostname);
  const expectedPrivateHostname = normalizedNetworkHostname(privateProviderHostname);
  if (expectedPrivateHostname && hostname !== expectedPrivateHostname) {
    throw asError("私网媒体厂商只能下载与 Base URL 完全同主机的结果，已阻止跨主机访问", "PRIVATE_RESULT_HOST_MISMATCH");
  }
  if (isIP(hostname) && (expectedPrivateHostname
    ? !isAllowedPrivateMediaProviderAddress(hostname)
    : isUnsafeMediaNetworkAddress(hostname))) {
    throw asError("远程媒体厂商返回了本机或私有网络下载地址，已阻止潜在内网访问", "UNSAFE_RESULT_URL");
  }
  return parsed;
};

export const assertSafeMediaResolvedAddresses = (addresses, { privateProvider = false } = {}) => {
  const values = Array.isArray(addresses)
    ? addresses.map((entry) => typeof entry === "string" ? entry : entry?.address)
    : [];
  if (!values.length || values.some((address) => privateProvider
    ? !isAllowedPrivateMediaProviderAddress(address)
    : isUnsafeMediaNetworkAddress(address))) {
    throw asError("远程媒体结果域名解析到私有或保留网络地址，已阻止潜在内网访问", "UNSAFE_RESULT_URL");
  }
};

const remainingDownloadTime = (deadlineAt) => Math.max(0, Number(deadlineAt || 0) - Date.now());

const awaitBeforeDownloadDeadline = async (operation, deadlineAt) => {
  const remaining = remainingDownloadTime(deadlineAt);
  if (!remaining) throw asError("媒体结果下载超时", "RESULT_DOWNLOAD_TIMEOUT");
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(asError("媒体结果下载超时", "RESULT_DOWNLOAD_TIMEOUT")), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const resolveMediaHostname = async (hostname, dnsLookup = lookup, deadlineAt = Date.now() + 10 * 60_000) => {
  const normalized = normalizedNetworkHostname(hostname);
  if (isIP(normalized)) return [{ address: normalized, family: isIP(normalized) }];
  let addresses;
  try {
    addresses = await awaitBeforeDownloadDeadline(
      Promise.resolve().then(() => dnsLookup(normalized, { all: true, verbatim: true })),
      deadlineAt,
    );
  } catch (error) {
    if (error?.providerErrorCode === "RESULT_DOWNLOAD_TIMEOUT") throw error;
    throw asError(`媒体结果下载地址无法完成 DNS 校验：${error.message}`, "RESULT_URL_DNS_FAILED");
  }
  return addresses;
};

const resolvePrivateProviderHostname = async (providerBaseUrl, dnsLookup, deadlineAt) => {
  if (!providerBaseUrl) return "";
  let parsed;
  try { parsed = new URL(providerBaseUrl); } catch { return ""; }
  const hostname = normalizedNetworkHostname(parsed.hostname);
  if (!explicitlyAllowedPrivateProviderHostnames().has(hostname)) return "";
  const addresses = await resolveMediaHostname(hostname, dnsLookup, deadlineAt);
  return addresses.length && addresses.every((entry) => isAllowedPrivateMediaProviderAddress(typeof entry === "string" ? entry : entry?.address)) ? hostname : "";
};

const assertResolvedMediaDownloadUrl = async (parsed, { privateProviderHostname = "", dnsLookup = lookup, deadlineAt } = {}) => {
  const hostname = normalizedNetworkHostname(parsed.hostname);
  const addresses = await resolveMediaHostname(hostname, dnsLookup, deadlineAt);
  assertSafeMediaResolvedAddresses(addresses, { privateProvider: Boolean(privateProviderHostname) });
  return addresses.map((entry) => {
    const address = normalizedNetworkHostname(typeof entry === "string" ? entry : entry?.address);
    return { address, family: Number(typeof entry === "string" ? isIP(address) : entry?.family || isIP(address)) };
  }).filter((entry) => entry.family === 4 || entry.family === 6);
};

const nodeResponseHeaders = (headers = {}) => ({
  get(name) {
    const value = headers[String(name || "").toLowerCase()];
    if (Array.isArray(value)) return value.join(", ");
    return value == null ? null : String(value);
  },
});

const normalizedRequestHeaders = (headers = {}) => Object.fromEntries(
  Object.entries(headers || {}).filter(([name]) => String(name).toLowerCase() !== "host"),
);

const stripCrossOriginCredentials = (headers = {}) => Object.fromEntries(
  Object.entries(headers || {}).filter(([name]) => !["authorization", "cookie", "proxy-authorization"].includes(String(name).toLowerCase())),
);

const singlePinnedRequest = ({ parsed, headers, address, deadlineAt }) => new Promise((resolveRequest, rejectRequest) => {
  const remaining = remainingDownloadTime(deadlineAt);
  if (!remaining) return rejectRequest(asError("媒体结果下载超时", "RESULT_DOWNLOAD_TIMEOUT"));
  const hostname = normalizedNetworkHostname(parsed.hostname);
  const signal = AbortSignal.timeout(remaining);
  const pinnedLookup = (requestedHostname, options, callback) => {
    if (normalizedNetworkHostname(requestedHostname) !== hostname) {
      callback(asError("媒体下载连接尝试解析了未校验主机", "RESULT_URL_DNS_REBIND_BLOCKED"));
      return;
    }
    if (typeof options === "object" && options?.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const requester = parsed.protocol === "https:" ? httpsRequest : httpRequest;
  const request = requester(parsed, {
    method: "GET",
    headers: normalizedRequestHeaders(headers),
    lookup: pinnedLookup,
    agent: false,
    autoSelectFamily: false,
    signal,
    ...(parsed.protocol === "https:" ? {
      rejectUnauthorized: true,
      ...(isIP(hostname) ? {} : { servername: hostname }),
    } : {}),
  }, (response) => {
    const abortResponse = () => response.destroy(asError("媒体结果下载超时", "RESULT_DOWNLOAD_TIMEOUT"));
    if (signal.aborted) abortResponse();
    else signal.addEventListener("abort", abortResponse, { once: true });
    response.once("close", () => signal.removeEventListener("abort", abortResponse));
    resolveRequest({
      status: Number(response.statusCode) || 0,
      ok: Number(response.statusCode) >= 200 && Number(response.statusCode) < 300,
      headers: nodeResponseHeaders(response.headers),
      body: response,
    });
  });
  request.once("error", rejectRequest);
  request.end();
});

export const pinnedMediaRequest = async ({ url, headers = {}, addresses = [], timeoutMs = 10 * 60_000, deadlineAt = Date.now() + timeoutMs } = {}) => {
  const parsed = url instanceof URL ? url : new URL(String(url || ""));
  const pinnedAddresses = addresses.map((entry) => {
    const address = normalizedNetworkHostname(typeof entry === "string" ? entry : entry?.address);
    return { address, family: Number(typeof entry === "string" ? isIP(address) : entry?.family || isIP(address)) };
  }).filter((entry) => entry.address && (entry.family === 4 || entry.family === 6));
  if (!pinnedAddresses.length) throw asError("媒体结果下载缺少已校验的目标地址", "RESULT_URL_DNS_FAILED");
  let lastError;
  for (const address of pinnedAddresses) {
    try {
      return await singlePinnedRequest({ parsed, headers, address, deadlineAt });
    } catch (error) {
      lastError = error;
      if (!remainingDownloadTime(deadlineAt) || error?.name === "AbortError" || error?.name === "TimeoutError") break;
    }
  }
  if (!remainingDownloadTime(deadlineAt) || lastError?.name === "AbortError" || lastError?.name === "TimeoutError") {
    throw asError("媒体结果下载超时", "RESULT_DOWNLOAD_TIMEOUT");
  }
  throw asError(`媒体结果下载连接失败：${lastError?.message || "未知连接错误"}`, lastError?.code || "RESULT_DOWNLOAD_CONNECT_FAILED");
};

const discardResponseBody = (body) => {
  if (!body) return;
  if (typeof body.resume === "function") body.resume();
  else if (typeof body.cancel === "function") Promise.resolve(body.cancel()).catch(() => {});
  else if (typeof body.destroy === "function") body.destroy();
};

const responseBodyAsNodeStream = (body) => {
  if (body instanceof Readable) return body;
  if (body && typeof body.getReader === "function") return Readable.fromWeb(body);
  if (body && typeof body[Symbol.asyncIterator] === "function") return Readable.from(body);
  return null;
};

export const secureMediaDownload = async ({
  url,
  headers = {},
  timeoutMs = 10 * 60_000,
  providerBaseUrl = "",
  dnsLookup = lookup,
  networkRequest = pinnedMediaRequest,
}) => {
  if (!url) throw asError("媒体厂商没有返回可下载的结果地址", "MISSING_RESULT_URL");
  const deadlineAt = Date.now() + timeoutMs;
  const privateProviderHostname = await resolvePrivateProviderHostname(providerBaseUrl, dnsLookup, deadlineAt);
  let current = assertSafeMediaDownloadUrl(url, { privateProviderHostname });
  let currentHeaders = headers;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const addresses = await assertResolvedMediaDownloadUrl(current, { privateProviderHostname, dnsLookup, deadlineAt });
    const response = await networkRequest({ url: current, headers: currentHeaders, addresses, timeoutMs, deadlineAt });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      discardResponseBody(response.body);
      if (!location || redirects >= 5) throw asError("媒体结果下载重定向无效或超过 5 次", "UNSAFE_RESULT_REDIRECT");
      const next = assertSafeMediaDownloadUrl(new URL(location, current).href, { privateProviderHostname });
      if (next.origin !== current.origin) currentHeaders = stripCrossOriginCredentials(currentHeaders);
      current = next;
      continue;
    }
    const stream = responseBodyAsNodeStream(response.body);
    if (!response.ok || !stream) {
      discardResponseBody(response.body);
      throw asError(`媒体结果下载失败（HTTP ${response.status}）`, `HTTP_${response.status}`);
    }
    return {
      stream,
      expectedBytes: Number(response.headers.get("content-length") || 0),
      mimeType: response.headers.get("content-type")?.split(";")[0] || "video/mp4",
    };
  }
  throw asError("媒体结果下载重定向未能收敛", "UNSAFE_RESULT_REDIRECT");
};

const downloadUrl = secureMediaDownload;

const referenceDataUrl = async (reference, maxBytes = 20 * 1024 * 1024) => {
  if (!String(reference?.mimeType || "").startsWith("image/")) return "";
  if (String(reference.dataUrl || "").startsWith("data:image/")) {
    const encoded = String(reference.dataUrl).split(",", 2)[1] || "";
    if (Math.floor(encoded.length * 0.75) > maxBytes) throw asError(`参考图片超过厂商 ${Math.floor(maxBytes / 1024 / 1024)} MiB 上限`, "REFERENCE_TOO_LARGE");
    return reference.dataUrl;
  }
  if (!reference.absolutePath) return "";
  const metadata = await stat(reference.absolutePath);
  if (metadata.size > maxBytes) throw asError(`参考图片超过厂商 ${Math.floor(maxBytes / 1024 / 1024)} MiB 上限`, "REFERENCE_TOO_LARGE");
  const bytes = await readFile(reference.absolutePath);
  return `data:${reference.mimeType || "image/png"};base64,${bytes.toString("base64")}`;
};

const normalizedCatalogModels = (payload = {}, pattern = /video|sora|seedance|kling|wan|happyhorse/i) => {
  const source = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
  return [...new Set(source.map((item) => String(typeof item === "string" ? item : item?.id || item?.name || "").replace(/^models\//, "")).filter((id) => id && pattern.test(id)))];
};

const selectedModelFallback = (settings = {}) => String(settings.model || "").trim() ? [String(settings.model).trim()] : [];

const targetFirstReferences = (references = []) => (Array.isArray(references) ? references : [])
  .map((reference, index) => ({ reference, index, priority: reference?.referenceRole === "target" ? 0 : 1 }))
  .sort((left, right) => left.priority - right.priority || left.index - right.index)
  .map(({ reference }) => reference);

const targetFirstImageReferences = (references = []) => targetFirstReferences(references)
  .filter((item) => String(item?.mimeType || "").startsWith("image/"));

const bearerHeaders = (settings, extra = {}) => ({ Authorization: `Bearer ${settings.apiKey}`, ...extra });

const jsonHeaders = (settings, extra = {}) => bearerHeaders(settings, { "Content-Type": "application/json", ...extra });

const base64Url = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const klingToken = (settings = {}) => {
  const raw = String(settings.apiKey || "").trim();
  if (raw.split(".").length === 3) return raw;
  let accessKey = "";
  let secretKey = "";
  try {
    const parsed = JSON.parse(raw);
    accessKey = String(parsed.accessKey || parsed.access_key || parsed.ak || "");
    secretKey = String(parsed.secretKey || parsed.secret_key || parsed.sk || "");
  } catch {
    const separator = raw.indexOf(":");
    if (separator > 0) {
      accessKey = raw.slice(0, separator);
      secretKey = raw.slice(separator + 1);
    }
  }
  if (!accessKey || !secretKey) throw asError("可灵凭证需填写 JWT，或按 AccessKey:SecretKey 格式填写", "MISSING_CREDENTIALS");
  const now = Math.floor(Date.now() / 1000);
  const head = base64Url({ alg: "HS256", typ: "JWT" });
  const body = base64Url({ iss: accessKey, exp: now + 1800, nbf: now - 5 });
  const signature = createHmac("sha256", secretKey).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${signature}`;
};

export class MediaProviderDriver {
  constructor(id) {
    this.id = id;
  }

  async probeCapabilities() { throw new Error(`${this.id} 未实现 probeCapabilities`); }
  async submit() { throw new Error(`${this.id} 未实现 submit`); }
  async getStatus() { throw new Error(`${this.id} 未实现 getStatus`); }
  async cancel() { throw new Error(`${this.id} 未实现 cancel`); }
  async download() { throw new Error(`${this.id} 未实现 download`); }
  async reconcileSubmission() { return null; }
  async resume(context) { return this.getStatus(context); }
}

export class DreaminaImageDriver extends MediaProviderDriver {
  constructor() {
    super("dreamina-image-cli");
  }

  environment(settings = {}) {
    return dreaminaCliEnvironment(settings, process.env);
  }

  async invoke(operation, args, timeoutMs = 60_000, settings = {}) {
    return spawnJson({
      executable: process.execPath,
      args: [DREAMINA_IMAGE_BRIDGE_PATH, operation, ...args],
      cwd: process.cwd(),
      env: this.environment(settings),
      timeoutMs,
    });
  }

  async probeCapabilities({ settings = {}, forceFresh = false } = {}) {
    let result;
    try {
      result = await spawnJson({
        executable: process.execPath,
        args: [DREAMINA_IMAGE_BRIDGE_PATH, "--check"],
        cwd: process.cwd(),
        env: {
          ...this.environment(settings),
          ...(forceFresh ? { SHENSI_DREAMINA_CONNECTION_CACHE_MS: "0" } : {}),
        },
        timeoutMs: 150_000,
      });
    } catch (error) {
      const cached = cachedDreaminaCapability({ settings, error, channel: "image" });
      if (cached) return cached;
      throw error;
    }
    const requestedProfileId = String(settings.dreaminaCliProfile || "").trim();
    const profileId = String(result.profileId || requestedProfileId).trim();
    if (!profileId || !requestedProfileId) throw asError("即梦图片 CLI 未返回明确配置 ID", "DREAMINA_PROFILE_REQUIRED");
    if (profileId !== requestedProfileId) throw asError("即梦图片 CLI 回执与当前配置不一致，已阻止串号", "DREAMINA_PROFILE_ID_MISMATCH");
    return {
      available: result.ok === true,
      generationReady: result.ok === true && result.taskResourceChecked === true,
      taskResourceChecked: result.taskResourceChecked === true,
      userId: String(result.userId || ""),
      profileId,
      credentialFingerprint: String(result.credentialFingerprint || ""),
      credit: Number.isFinite(Number(result.credit)) ? Number(result.credit) : null,
      vipLevel: String(result.vipLevel || ""),
      verificationLevel: result.taskResourceChecked === true ? "task_resource" : "connection",
      visibilityChecked: false,
      models: ["5.0Pro", "5.0", "4.7", "4.6", "4.5", "4.1", "4.0", "3.1", "3.0"],
      inputTypes: ["text", "image"],
      resolutions: ["1k", "2k", "4k"],
      raw: result,
    };
  }

  async submit({ job, references = [], workRoot }) {
    await mkdir(workRoot, { recursive: true });
    const promptFile = join(workRoot, "prompt.txt");
    const referencesFile = join(workRoot, "references.json");
    await writeFile(promptFile, providerPrompt(job), "utf8");
    await writeFile(referencesFile, JSON.stringify(targetFirstImageReferences(references).map((item) => item.absolutePath).filter(Boolean)), "utf8");
    return this.invoke("submit", [
      "--prompt-file", promptFile,
      "--reference-images-file", referencesFile,
      "--model", job.request.settings?.model || "5.0Pro",
      "--aspect-ratio", job.request.aspectRatio || "1:1",
      "--resolution", job.request.quality || job.request.resolution || "1k",
      "--count", String(Math.max(1, Math.min(4, Number(job.request.imageCount) || 1))),
      "--idempotency-key", job.idempotencyKey,
    // The official CLI can spend several minutes creating and then querying a
    // paid task before it prints the provider id. Killing the bridge at three
    // minutes turns a valid submission into an "unknown result" and prevents a
    // safe retry. Keep the watchdog outside the CLI's own ten-minute ceiling.
    ], Math.max(Number(job.request.settings?.timeoutMs) || 0, 12 * 60_000), job.request.settings || {});
  }

  async getStatus({ job, workRoot }) {
    const pollCount = Math.max(0, Number(job.pollCount || 0));
    // query_result already targets the durable provider task ID. list_task is
    // only a sparse reconciliation fallback; using it on every plateau can
    // block the global Dreamina credential broker for minutes or hours.
    const verifyWithExactTaskList = (pollCount + 1) % 120 === 0;
    return this.invoke("status", [
      "--provider-task-id", job.providerTaskId,
      "--download-dir", join(workRoot, "provider-download"),
      ...(verifyWithExactTaskList ? ["--verify-list"] : []),
    ], 180_000, job.request.settings || {});
  }

  async reconcileSubmission({ job, workRoot }) {
    await mkdir(workRoot, { recursive: true });
    const promptFile = join(workRoot, "prompt.txt");
    await writeFile(promptFile, providerPrompt(job), "utf8");
    const hasImageReference = (job.request.referenceMedia || []).some((item) => String(item?.mimeType || "").startsWith("image/"));
    return this.invoke("reconcile", [
      "--prompt-file", promptFile,
      "--task-type", hasImageReference ? "image2image" : "text2image",
      "--idempotency-key", job.idempotencyKey || "",
    ], 180_000, job.request.settings || {});
  }

  async cancel({ job }) {
    return this.invoke("cancel", ["--provider-task-id", job.providerTaskId], 60_000, job.request.settings || {});
  }

  async download({ job, workRoot, outputPath, forceRedownload = false }) {
    return this.invoke("download", [
      "--provider-task-id", job.providerTaskId,
      "--download-dir", join(workRoot, "provider-download"),
      "--output", outputPath,
      ...(forceRedownload ? ["--force-redownload"] : []),
    ], 10 * 60_000, job.request.settings || {});
  }
}

export class DreaminaVideoDriver extends MediaProviderDriver {
  constructor() {
    super("dreamina-video-cli");
  }

  environment(settings = {}) {
    return dreaminaCliEnvironment(settings, process.env);
  }

  async invoke(operation, args, timeoutMs = 60_000, settings = {}) {
    return spawnJson({
      executable: process.execPath,
      args: [DREAMINA_VIDEO_BRIDGE_PATH, operation, ...args],
      cwd: process.cwd(),
      env: this.environment(settings),
      timeoutMs,
      extractDreaminaTaskId: true,
    });
  }

  async probeCapabilities({ settings = {}, forceFresh = false } = {}) {
    let result;
    try {
      result = await spawnJson({
        executable: process.execPath,
        args: [DREAMINA_VIDEO_BRIDGE_PATH, "--check"],
        cwd: process.cwd(),
        env: {
          ...this.environment(settings),
          ...(forceFresh ? { SHENSI_DREAMINA_CONNECTION_CACHE_MS: "0" } : {}),
        },
        timeoutMs: 150_000,
      });
    } catch (error) {
      const cached = cachedDreaminaCapability({ settings, error, channel: "video" });
      if (cached) return cached;
      throw error;
    }
    const seedance25 = result.capabilities?.seedance25 || {};
    const requestedProfileId = String(settings.dreaminaCliProfile || "").trim();
    const profileId = String(result.profileId || requestedProfileId).trim();
    if (!profileId || !requestedProfileId) throw asError("即梦视频 CLI 未返回明确配置 ID", "DREAMINA_PROFILE_REQUIRED");
    if (profileId !== requestedProfileId) throw asError("即梦视频 CLI 回执与当前配置不一致，已阻止串号", "DREAMINA_PROFILE_ID_MISMATCH");
    return {
      available: result.ok === true,
      generationReady: result.ok === true && result.taskResourceChecked === true,
      taskResourceChecked: result.taskResourceChecked === true,
      userId: String(result.userId || ""),
      profileId,
      credentialFingerprint: String(result.credentialFingerprint || ""),
      credit: Number.isFinite(Number(result.credit)) ? Number(result.credit) : null,
      vipLevel: String(result.vipLevel || ""),
      verificationLevel: result.taskResourceChecked === true ? "task_resource" : "connection",
      visibilityChecked: false,
      models: ["seedance2.5", "seedance2.0fast", "seedance2.0", "seedance2.0_vip", "seedance2.0fast_vip", "seedance2.0mini", "seedance1.5pro", "seedance1.0fast", "seedance1.0"],
      inputTypes: ["text", "image", "video", "audio"],
      durationSeconds: Array.isArray(seedance25.durationSeconds) && seedance25.durationSeconds.length
        ? seedance25.durationSeconds
        : Array.from({ length: 27 }, (_, index) => index + 4),
      resolutions: Array.isArray(seedance25.resolutions) && seedance25.resolutions.length
        ? seedance25.resolutions
        : ["480p", "720p"],
      modelCapabilities: { seedance25 },
      longVideoAvailable: seedance25.longVideoAvailable === true,
      longVideoReason: String(seedance25.longVideoReason || ""),
      raw: result,
    };
  }

  async submit({ job, references = [], workRoot }) {
    await mkdir(workRoot, { recursive: true });
    const promptFile = join(workRoot, "prompt.txt");
    const referencesFile = join(workRoot, "references.json");
    const transitionsFile = join(workRoot, "multiframe-transitions.json");
    await writeFile(promptFile, providerPrompt(job), "utf8");
    await writeFile(referencesFile, JSON.stringify(targetFirstReferences(references).map((item) => ({
      absolutePath: item.absolutePath,
      mimeType: item.mimeType,
      durationSeconds: Number(item.durationSeconds) > 0
        ? Number(item.durationSeconds)
        : Number(item.durationMs) > 0 ? Number(item.durationMs) / 1000 : 0,
    })).filter((item) => item.absolutePath)), "utf8");
    await writeFile(transitionsFile, JSON.stringify(job.request.multiframeTransitions || []), "utf8");
    return this.invoke("submit", [
      "--prompt-file", promptFile,
      "--reference-media-file", referencesFile,
      "--transitions-file", transitionsFile,
      "--model", job.request.settings?.model || "doubao-seedance-2-0-260128",
      "--aspect-ratio", job.request.aspectRatio || "16:9",
      "--duration", String(job.request.duration || 4),
      "--resolution", job.request.resolution || "720p",
      "--mode", job.request.generationMode || "smart_params",
      "--idempotency-key", job.idempotencyKey,
    ], Math.max(Number(job.request.settings?.timeoutMs) || 0, 12 * 60_000), job.request.settings || {});
  }

  async getStatus({ job, workRoot }) {
    const pollCount = Math.max(0, Number(job.pollCount || 0));
    const verifyWithExactTaskList = (pollCount + 1) % 120 === 0;
    return this.invoke("status", [
      "--provider-task-id", job.providerTaskId,
      "--idempotency-key", job.idempotencyKey || "",
      "--download-dir", join(workRoot, "provider-download"),
      ...(verifyWithExactTaskList ? ["--verify-list"] : []),
    ], 180_000, job.request.settings || {});
  }

  async reconcileSubmission({ job, workRoot }) {
    await mkdir(workRoot, { recursive: true });
    const promptFile = join(workRoot, "prompt.txt");
    await writeFile(promptFile, providerPrompt(job), "utf8");
    const references = Array.isArray(job.request.referenceMedia) ? job.request.referenceMedia : [];
    const images = references.filter((item) => String(item?.mimeType || "").startsWith("image/"));
    const hasVideoOrAudio = references.some((item) => /^(?:video|audio)\//.test(String(item?.mimeType || "")));
    const mode = String(job.request.generationMode || "smart_params");
    const model = String(job.request.settings?.model || "");
    const taskType = mode === "long_video"
      ? "longvideo"
      : hasVideoOrAudio || (images.length && mode === "smart_params" && /seedance2\.(?:0|5)|doubao-seedance-2-0/i.test(model))
      ? "multimodal2video"
      : mode === "first_last_frame" && images.length >= 2
        ? "frames2video"
        : images.length >= 2
          ? "multiframe2video"
          : images.length === 1 ? "image2video" : "text2video";
    return this.invoke("reconcile", [
      "--prompt-file", promptFile,
      "--task-type", taskType,
      "--idempotency-key", job.idempotencyKey || "",
    ], 180_000, job.request.settings || {});
  }

  async cancel({ job }) {
    return this.invoke("cancel", ["--provider-task-id", job.providerTaskId], 60_000, job.request.settings || {});
  }

  async download({ job, workRoot, outputPath, forceRedownload = false }) {
    return this.invoke("download", [
      "--provider-task-id", job.providerTaskId,
      "--idempotency-key", job.idempotencyKey || "",
      "--download-dir", join(workRoot, "provider-download"),
      "--output", outputPath,
      ...(forceRedownload ? ["--force-redownload"] : []),
    ], 10 * 60_000, job.request.settings || {});
  }
}

const LIBTV_IMAGE_NAMES = Object.freeze({
  "lib-image-2": "Lib Image",
  "nebula-ultra": "General image Pro",
  "nebula-2-flash": "General image V2",
  "doubao-seedream-5-0-pro": "Seedream 5.0 Pro",
  "qwen-image-3": "Qwen image 3.0",
  "mj-v8.2": "Style Image V8.2",
  "mj-v8.1": "Style Image V8.1",
  "mj-v7": "Style Image V7",
  "mj-niji7": "Style Image Niji 7",
  "jimeng-4.6": "Seedream 4.6",
  "seedream-5": "Seedream 5.0 Lite",
  "seedream-4.5": "Seedream 4.5",
  "z-image": "Z-image Turbo",
  "nebula-core": "General image",
  qwen: "Qwen Image",
  "qwen-edit": "Qwen Edit",
  "seedream-4": "Seedream 4.0",
});
const LIBTV_VIDEO_NAMES = Object.freeze({
  "star-video2.5": "Seedance 2.5",
  "star-video2": "Seedance 2.0 VIP",
  "MiniMax-Hailuo-H3-Max": "Minimax H3 Max",
  "MiniMax-Hailuo-H3": "Minimax H3",
  "star-video2-fast": "Seedance 2.0 Fast VIP",
  "star-video2-mini": "Seedance 2.0 Mini",
  "wanx3.0-prime": "Wan 3.0 Prime",
  "wanx3.0": "Wan 3.0",
  "happy-horse-1.1": "Happy Horse 1.1",
  "happy-horse-1": "Happy Horse 1.0",
  "kling-v3-omni": "Kling O3",
  "kling-v3-turbo": "Kling 3.0 Turbo",
  "kling-video-o3": "Kling 3.0",
  "wanx2.7-video": "Wan 2.7",
  "kling-video-o1": "Kling O1",
  "wanxiang-v2-6": "Wan 2.6",
  "MiniMax-Hailuo-2.3-Fast": "Hailuo 2.3 Fast",
  "MiniMax-Hailuo-2.3": "Hailuo 2.3",
  "seedance-1.5-pro": "Seedance1.5 Pro",
  "doubao-seedance-pro": "Seedance 1.0 Pro",
  "doubao-seedance-lite": "Seedance 1.0 Lite",
  "kling-v2-6": "Kling 2.6",
  "kling-v3-motion-control": "Kling3.0 动作迁移",
  "midjourney-video": "Style Video",
  "MiniMax-Hailuo-o2": "Hailuo 02",
  viduq2: "Vidu Q2",
  "viduq2-pro": "Vidu Q2 Pro",
  "viduq2-turbo": "Vidu Q2 Turbo",
  "viduq3-pro": "Vidu Q3 Pro",
  "omnihuman-1.5": "OmniHuman 1.5",
  "kling-v2-5-turbo-pro": "Kling 2.5",
  "kling-2.1": "Kling 2.1",
  "wanxiang-plus": "Wan 2.2",
  "wanxiang-preview": "Wan 2.5",
  "pixverse-v5.5": "Pixverse V5.5",
  "pixverse-v5": "Pixverse V5",
});
const LIBTV_AUDIO_NAMES = Object.freeze({
  "seed-audio-1.0": "Seed Audio 1.0",
  "speech-2.8-hd": "Minimax-speech-2.8-hd",
  "speech-2.8-turbo": "Minimax-speech-2.8-turbo",
  "vocal-v3": "Eleven V3",
  "vocal-music": "Eleven Music V3",
  "mureka-8": "Mureka V8",
});

const libtvExecutable = (settings = {}) => {
  const configured = String(settings.cliPath || process.env.SHENSI_LIBTV_CLI_PATH || "").trim();
  if (configured && configured !== LIBTV_CLI_ALIAS) return configured;
  if (process.platform === "win32") return join(process.env.USERPROFILE || process.env.HOMEDRIVE || "", ".libtv", "libtv.exe") || LIBTV_CLI_ALIAS;
  return configured || LIBTV_CLI_ALIAS;
};

const libtvStatus = (value) => {
  const numeric = Number(value);
  if (numeric === 2) return "completed";
  if (numeric === 3) return "failed";
  if (numeric === 4 || numeric === 5) return "cancelled";
  const normalized = String(value || "").toLowerCase();
  if (["completed", "complete", "success", "succeeded", "done"].includes(normalized)) return "completed";
  if (["failed", "fail", "error"].includes(normalized)) return "failed";
  if (["cancelled", "canceled"].includes(normalized)) return "cancelled";
  return ["queued", "pending", "created", "waiting"].includes(normalized) ? "queued" : "running";
};

const libtvTaskFromPayload = (payload = {}) => {
  const data = payload.data || payload;
  const info = data.taskInfo || data.task_info || {};
  const taskId = String(payload.taskId || payload.task_id || info.taskId || info.task_id || "").trim();
  const statusValue = info.status ?? info.taskStatus ?? data.status ?? payload.status ?? "queued";
  const status = libtvStatus(statusValue);
  const urls = Array.isArray(data.url) ? data.url : [data.url || data.resultUrl || data.result_url].filter(Boolean);
  const error = String(info.failedReason || info.error || data.failedReason || payload.message || "");
  const progress = Number(info.progressPercent ?? info.progress ?? data.progressPercent);
  return {
    providerTaskId: taskId,
    providerStatus: status,
    rawStatus: String(statusValue),
    ...(urls[0] ? { resultUrl: String(urls[0]) } : {}),
    ...(error ? { error, errorCode: status === "failed" ? "LIBTV_PROVIDER_FAILED" : "" } : {}),
    ...(Number.isFinite(progress) ? { progressPercent: progress } : {}),
    raw: payload,
  };
};

const LIBTV_MODEL_SCHEMA_CACHE_TTL_MS = 15 * 60_000;
const libTvModelCatalogCache = new Map();
const libTvModelSchemaCache = new Map();

const libTvCacheKey = (settings = {}, suffix = "") => `${libtvExecutable(settings)}\0${suffix}`;

const libTvEnumValues = (property = {}) => (Array.isArray(property?.enum) ? property.enum : [])
  .map((item) => (item && typeof item === "object" ? item.value : item))
  .filter((value) => value !== undefined && value !== null);

const libTvNumericValues = (property = {}) => {
  const enumerated = libTvEnumValues(property)
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (enumerated.length) return [...new Set(enumerated)].sort((left, right) => left - right);
  const minimum = Number(property?.min);
  const maximum = Number(property?.max);
  const step = Math.max(0.001, Number(property?.step) || 1);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || maximum < minimum) return [];
  const values = [];
  for (let value = minimum; value <= maximum + step / 1000 && values.length < 300; value += step) {
    values.push(Number(value.toFixed(6)));
  }
  return values;
};

const normalizedLibTvUiValue = (value) => {
  const source = String(value ?? "").trim();
  if (!source || ["adaptive", "auto"].includes(source.toLowerCase())) return "auto";
  return source.toLowerCase();
};

const libTvStringValues = (property = {}) => [...new Set(libTvEnumValues(property)
  .map(normalizedLibTvUiValue)
  .filter(Boolean))];

const libTvSettingsForMode = (schema = {}, mode = "") => {
  const settings = schema?.config?.settings;
  if (Array.isArray(settings)) return settings.map(String);
  if (!settings || typeof settings !== "object") return [];
  const exact = Array.isArray(settings[mode]) ? settings[mode] : [];
  return exact.map(String);
};

const libTvModeTypes = (schema = {}) => {
  const modeItems = schema?.properties?.modeType?.items;
  const settings = schema?.config?.settings;
  const rules = Array.isArray(schema?.rules) ? schema.rules : schema?.rules ? [schema.rules] : [];
  const ruleModes = rules.flatMap((rule) => Array.isArray(rule?.forModeTypes) ? rule.forModeTypes : []);
  return [...new Set([
    ...(modeItems && typeof modeItems === "object" ? Object.keys(modeItems) : []),
    ...(settings && !Array.isArray(settings) && typeof settings === "object" ? Object.keys(settings) : []),
    ...ruleModes,
  ].map(String).filter(Boolean))];
};

const libTvParameterForMode = (schema = {}, mode = "", semantic = "") => {
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const modeKeys = libTvSettingsForMode(schema, mode);
  const candidateKeys = modeKeys.length ? modeKeys : Object.keys(properties);
  const matchingOriginalFields = semantic === "resolution" ? ["resolution", "quality"] : [semantic];
  const exact = candidateKeys.find((key) => matchingOriginalFields.includes(String(properties[key]?.originalField || key)));
  const fallback = candidateKeys.find((key) => {
    const normalized = String(key).toLowerCase();
    if (semantic === "resolution") return normalized.includes("resolution") || normalized.includes("quality");
    const normalizedSemantic = String(semantic).toLowerCase();
    return normalized === normalizedSemantic || normalized.startsWith(`${normalizedSemantic}_`);
  });
  const key = exact || fallback || "";
  if (!key || !properties[key] || typeof properties[key] !== "object") return null;
  const property = properties[key];
  return {
    key,
    originalField: String(property.originalField || key),
    default: property.default,
    values: semantic === "duration" ? libTvNumericValues(property) : libTvStringValues(property),
  };
};

export const summarizeLibTvModelSchema = ({ modelKey = "", modelName = "", schema = {} } = {}) => {
  const modes = libTvModeTypes(schema);
  const parameterModes = modes.length ? modes : ["text2video"];
  const collect = (semantic) => [...new Set(parameterModes.flatMap((mode) => {
    const parameter = libTvParameterForMode(schema, mode, semantic);
    return parameter?.values || [];
  }))];
  const modeItems = schema?.properties?.modeType?.items;
  const modeLimits = Object.fromEntries(Object.entries(modeItems && typeof modeItems === "object" ? modeItems : {})
    .filter(([, range]) => Array.isArray(range) && range.length >= 2)
    .map(([mode, range]) => [mode, [Math.max(0, Number(range[0]) || 0), Math.max(0, Number(range[1]) || 0)]]));
  const mixedConfig = schema?.properties?.modeType?.mixed2videoConfig;
  const rawRules = Array.isArray(schema?.rules) ? schema.rules : schema?.rules ? [schema.rules] : [];
  const validationRules = rawRules.filter((rule) => rule && typeof rule === "object" && Array.isArray(rule.require)).map((rule) => ({
    require: rule.require.map(String).filter((item) => ["prompt", "image", "video", "audio", "media"].includes(item)),
    mode: rule.mode === "any" ? "any" : "all",
    forModeTypes: Array.isArray(rule.forModeTypes) ? rule.forModeTypes.map(String) : [],
  }));
  return {
    modelKey: String(modelKey || "").trim(),
    modelName: String(modelName || modelKey || "").trim(),
    durationSeconds: collect("duration").map(Number).filter((value) => Number.isFinite(value) && value > 0).sort((left, right) => left - right),
    resolutions: collect("resolution"),
    aspectRatios: collect("ratio"),
    modeTypes: modes,
    modeLimits,
    validationRules,
    durationDerivedFromReference: schema?.properties?.derivesDurationFromVideo === true,
    ...(mixedConfig && typeof mixedConfig === "object" ? { mixedModeLimits: Object.fromEntries(Object.entries(mixedConfig)
      .filter(([, value]) => Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Math.max(0, Number(value))])) } : {}),
  };
};

const libTvCachedValue = (cache, key) => {
  const entry = cache.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.value : null;
};

const loadLibTvModelSchema = async ({ modelKey, settings = {} } = {}) => {
  const key = libTvCacheKey(settings, `schema:${modelKey}`);
  const cached = libTvCachedValue(libTvModelSchemaCache, key);
  if (cached) return cached;
  const payload = await spawnJson({
    executable: libtvExecutable(settings),
    args: ["model", String(modelKey || "").trim()],
    cwd: process.cwd(),
    timeoutMs: 12_000,
  });
  libTvModelSchemaCache.set(key, { value: payload, expiresAt: Date.now() + LIBTV_MODEL_SCHEMA_CACHE_TTL_MS });
  return payload;
};

const mapWithConcurrency = async (items, worker, concurrency = 4) => {
  const results = new Array(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
};

export const listLibTvModels = async ({ channel = "image", settings = {} } = {}) => {
  if (!['image', 'video', 'audio'].includes(channel)) return [];
  const cacheKey = libTvCacheKey(settings, `catalog:${channel}`);
  const cached = libTvCachedValue(libTvModelCatalogCache, cacheKey);
  if (cached) return cached;
  const payload = await spawnJson({
    executable: libtvExecutable(settings),
    args: ["model", "search", "--type", channel],
    cwd: process.cwd(),
    timeoutMs: 45_000,
  });
  const models = (Array.isArray(payload.matches) ? payload.matches : []).map((item) => ({
    slug: String(item.modelKey || "").trim(),
    label: String(item.modelName || item.modelKey || "").trim(),
    description: String(item.description || "").trim(),
  })).filter((item) => item.slug);
  libTvModelCatalogCache.set(cacheKey, { value: models, expiresAt: Date.now() + LIBTV_MODEL_SCHEMA_CACHE_TTL_MS });
  return models;
};

export const listLibTvModelCapabilities = async ({ channel = "video", settings = {} } = {}) => {
  const models = await listLibTvModels({ channel, settings });
  if (channel !== "video") return { models, modelCapabilities: {}, schemaErrors: {} };
  const records = await mapWithConcurrency(models, async (model) => {
    try {
      const payload = await loadLibTvModelSchema({ modelKey: model.slug, settings });
      return { model, capability: summarizeLibTvModelSchema({
        modelKey: model.slug,
        modelName: model.label,
        schema: payload.schema || {},
      }) };
    } catch (error) {
      return { model, error: String(error?.message || "模型 Schema 读取失败").slice(0, 300) };
    }
  }, 6);
  return {
    models,
    modelCapabilities: Object.fromEntries(records.filter((item) => item.capability).map((item) => [item.model.slug, item.capability])),
    schemaErrors: Object.fromEntries(records.filter((item) => item.error).map((item) => [item.model.slug, item.error])),
  };
};

const libTvModeReferenceCount = (mode, counts) => {
  if (["singleImage2video", "frames2video", "image2video"].includes(mode)) return counts.image;
  if (["video2video", "videoEdit2video"].includes(mode)) return counts.video;
  if (mode === "audio2video") return counts.audio;
  if (mode === "mixed2video") return counts.total;
  return counts.total;
};

const libTvModeAcceptsReferences = (capability, mode, counts) => {
  const range = capability?.modeLimits?.[mode];
  const count = libTvModeReferenceCount(mode, counts);
  if (Array.isArray(range) && range.length >= 2 && (count < Number(range[0]) || count > Number(range[1]))) return false;
  if (mode === "mixed2video" && capability?.mixedModeLimits) {
    const limits = capability.mixedModeLimits;
    if (Number(limits.videoMax) >= 0 && counts.video > Number(limits.videoMax)) return false;
    const imageLimit = counts.video > 0 && Number.isFinite(Number(limits.imageMaxWithVideo))
      ? Number(limits.imageMaxWithVideo) : Number(limits.imageMax);
    if (Number.isFinite(imageLimit) && counts.image > imageLimit) return false;
    if (Number.isFinite(Number(limits.audioMax)) && counts.audio > Number(limits.audioMax)) return false;
  }
  return true;
};

const libTvModePassesValidationRules = (capability, mode, counts, hasPrompt) => (capability?.validationRules || []).every((rule) => {
  if (rule.forModeTypes?.length && !rule.forModeTypes.includes(mode)) return true;
  const satisfied = (required) => required === "prompt" ? hasPrompt
    : required === "image" ? counts.image > 0
      : required === "video" ? counts.video > 0
        : required === "audio" ? counts.audio > 0
          : required === "media" ? counts.total > 0
            : false;
  return rule.mode === "any" ? rule.require.some(satisfied) : rule.require.every(satisfied);
});

export const resolveLibTvVideoMode = ({ capability = {}, references = [], generationMode = "smart_params", hasPrompt = true } = {}) => {
  const counts = (Array.isArray(references) ? references : []).reduce((result, reference) => {
    const type = String(reference?.mimeType || "").split("/", 1)[0];
    if (["image", "video", "audio"].includes(type)) result[type] += 1;
    result.total += 1;
    return result;
  }, { image: 0, video: 0, audio: 0, total: 0 });
  const supported = new Set(Array.isArray(capability?.modeTypes) ? capability.modeTypes : []);
  if (!counts.total) return supported.has("text2video") && libTvModePassesValidationRules(capability, "text2video", counts, hasPrompt) ? "text2video" : "";
  const mixedKinds = [counts.image > 0, counts.video > 0, counts.audio > 0].filter(Boolean).length > 1;
  let candidates;
  if (generationMode === "first_last_frame" && counts.image > 0 && !counts.video && !counts.audio) {
    candidates = ["frames2video", "image2video", "mixed2video"];
  } else if (generationMode === "smart_edit" && counts.video > 0) {
    candidates = ["videoEdit2video", "video2video", "mixed2video"];
  } else if (mixedKinds) {
    candidates = counts.audio > 0 && counts.image > 0 && !counts.video
      ? ["audio2video", "mixed2video"]
      : counts.video > 0 && counts.image > 0
        ? ["mixed2video", "videoEdit2video", "video2video"]
        : ["mixed2video"];
  } else if (counts.video) {
    candidates = ["video2video", "videoEdit2video", "mixed2video"];
  } else if (counts.audio) {
    candidates = ["audio2video", "mixed2video"];
  } else if (counts.image === 1) {
    candidates = ["singleImage2video", "image2video", "frames2video", "mixed2video"];
  } else {
    candidates = generationMode === "smart_multiframe"
      ? ["image2video", "frames2video", "mixed2video"]
      : ["image2video", "frames2video", "mixed2video"];
  }
  return candidates.find((mode) => supported.has(mode)
    && libTvModeAcceptsReferences(capability, mode, counts)
    && libTvModePassesValidationRules(capability, mode, counts, hasPrompt)) || "";
};

const libTvActualParameterValue = (parameter, requested) => {
  if (!parameter || requested === undefined || requested === null || requested === "") return null;
  if (parameter.originalField === "duration") {
    const numeric = Number(requested);
    return parameter.values.some((value) => Number(value) === numeric) ? numeric : null;
  }
  const source = normalizedLibTvUiValue(requested);
  const rawValues = libTvEnumValues(parameter.property || {});
  if (source === "auto") {
    const automatic = rawValues.find((value) => ["", " ", "auto", "adaptive"].includes(String(value).toLowerCase()));
    return automatic !== undefined ? automatic : parameter.default;
  }
  const exact = rawValues.find((value) => normalizedLibTvUiValue(value) === source);
  if (exact !== undefined) return exact;
  if (parameter.originalField === "quality") {
    const qualityAlias = source === "4k" ? "4k" : source === "1080p" ? "high" : source === "720p" ? "low" : "";
    const aliased = rawValues.find((value) => normalizedLibTvUiValue(value) === qualityAlias);
    if (aliased !== undefined) return aliased;
  }
  return null;
};

const appendLibTvVideoParameter = (args, schema, mode, semantic, requested, { required = false } = {}) => {
  const parameter = libTvParameterForMode(schema, mode, semantic);
  if (!parameter) return;
  const withProperty = { ...parameter, property: schema?.properties?.[parameter.key] };
  const value = libTvActualParameterValue(withProperty, requested);
  if (value === null) {
    if (required && requested !== undefined && requested !== null && requested !== "") {
      throw asError(`LibTV 当前模型的 ${mode} 模式不支持参数 ${semantic}=${requested}`, "LIBTV_PARAMETER_UNSUPPORTED");
    }
    return;
  }
  args.push("-s", `${parameter.originalField}=${value}`);
};

export class LibTvMediaDriver extends MediaProviderDriver {
  constructor() { super("libtv-cli"); }

  executable(settings = {}) { return libtvExecutable(settings); }

  async invoke(args, { cwd, timeoutMs = 60_000, raw = false } = {}) {
    const request = { executable: this.executable(), args, cwd, timeoutMs };
    return raw ? spawnRaw(request) : spawnJson(request);
  }

  async project(workRoot) {
    const metadataPath = join(workRoot, "libtv-project.json");
    await mkdir(join(workRoot, ".libtv"), { recursive: true });
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      if (metadata.projectUuid) {
        await this.invoke(["project", "use", metadata.projectUuid], { cwd: workRoot, timeoutMs: 30_000 });
        return metadata;
      }
    } catch {}
    const created = await this.invoke(["project", "create", `神思-${Date.now()}`, "--team-id", "0"], { cwd: workRoot, timeoutMs: 60_000 });
    const projectUuid = String(created.projectMeta?.uuid || created.uuid || "").trim();
    if (!projectUuid) throw asError("LibTV 创建临时画布未返回 UUID", "LIBTV_PROJECT_CREATE_FAILED");
    await this.invoke(["project", "use", projectUuid], { cwd: workRoot, timeoutMs: 30_000 });
    const metadata = { projectUuid };
    await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
    return metadata;
  }

  async probeCapabilities({ settings = {} } = {}) {
    const channel = settings.channel
      || (settings.imageChannel ? "image" : settings.videoChannel ? "video" : settings.audioChannel ? "audio" : "image");
    const catalog = await listLibTvModelCapabilities({ channel, settings });
    const models = catalog.models;
    const names = models.map((item) => item.slug);
    return {
      available: true,
      connected: true,
      verificationLevel: "model_visibility",
      visibilityChecked: true,
      softwareIntegrated: true,
      generationPermissionChecked: false,
      models: names,
      modelNames: Object.fromEntries(models.map((item) => [item.slug, item.label])),
      ...(channel === "video" ? {
        modelCapabilities: catalog.modelCapabilities,
        schemaErrors: catalog.schemaErrors,
      } : {}),
      inputTypes: ["text", "image", "video", "audio"],
    };
  }

  async submit({ job, references = [], workRoot }) {
    await mkdir(workRoot, { recursive: true });
    const metadataPath = join(workRoot, "libtv-node.json");
    const modelKey = String(job.request.settings?.model || "").trim();
    let libTvVideoSchema = null;
    let libTvVideoCapability = null;
    let libTvVideoMode = "";
    if (job.channel === "video") {
      const schemaPayload = await loadLibTvModelSchema({ modelKey, settings: job.request.settings || {} });
      libTvVideoSchema = schemaPayload.schema || {};
      libTvVideoCapability = summarizeLibTvModelSchema({ modelKey, schema: libTvVideoSchema });
      libTvVideoMode = resolveLibTvVideoMode({
        capability: libTvVideoCapability,
        references,
        generationMode: job.request.generationMode,
        hasPrompt: Boolean(providerPrompt(job).trim()),
      });
      if (!libTvVideoMode) {
        const referenceKinds = [...new Set(references.map((item) => String(item?.mimeType || "").split("/", 1)[0]).filter(Boolean))];
        throw asError(
          `LibTV 当前模型 ${modelKey} 不支持本次参考组合${referenceKinds.length ? `（${referenceKinds.join("、")}）` : ""}；请选择支持该输入模式的模型`,
          "LIBTV_REFERENCE_MODE_UNSUPPORTED",
        );
      }
    }
    const project = await this.project(workRoot);
    let node;
    try { node = JSON.parse(await readFile(metadataPath, "utf8")); } catch {}
    const nodeName = `神思-${job.channel}-${job.id}`;
    if (!node?.nodeKey) {
      const names = job.channel === "image" ? LIBTV_IMAGE_NAMES : job.channel === "video" ? LIBTV_VIDEO_NAMES : LIBTV_AUDIO_NAMES;
      const args = ["node", "create", nodeName, "-t", job.channel, "--prompt", providerPrompt(job), "-s", `model=${names[modelKey] || modelKey}`];
      if (job.channel === "image") {
        if (job.request.aspectRatio) args.push("-s", `ratio=${job.request.aspectRatio}`);
        if (job.request.quality) args.push("-s", `quality=${String(job.request.quality).toLowerCase()}`);
        if (job.request.resolution) args.push("-s", `resolution=${String(job.request.resolution).replace(/p$/i, "K")}`);
        args.push("-s", `count=${Math.max(1, Math.min(4, Number(job.request.imageCount) || 1))}`);
      } else if (job.channel === "video") {
        appendLibTvVideoParameter(args, libTvVideoSchema, libTvVideoMode, "ratio", job.request.aspectRatio);
        appendLibTvVideoParameter(args, libTvVideoSchema, libTvVideoMode, "duration", job.request.duration, { required: true });
        appendLibTvVideoParameter(args, libTvVideoSchema, libTvVideoMode, "resolution", job.request.resolution, { required: true });
        appendLibTvVideoParameter(args, libTvVideoSchema, libTvVideoMode, "enableSound", job.request.generateAudio === false ? "off" : "on");
        args.push("-s", `modeType=${libTvVideoMode}`);
      } else {
        if (/^speech-|^vocal-v3$/i.test(modelKey)) {
          args.push(
            "-s", `scene=${String(job.request.scene || "Text-to-Speech")}`,
            "-s", `voice_setting_voice_id=${String(job.request.voiceId || "female-shaonv")}`,
          );
          const speed = Number(job.request.speed);
          if (Number.isFinite(speed) && speed > 0 && speed !== 1) args.push("-s", `voice_setting_speed=${speed}`);
        } else {
          args.push(
            "-s", "modeType=text2audio",
            "-s", `language=${String(job.request.language || "zh")}`,
            "-s", `sample_rate=${Math.max(8000, Number(job.request.sampleRate) || 24000)}`,
            "-s", `format=${String(job.request.format || "wav").toLowerCase()}`,
          );
        }
      }
      const leftNodes = [];
      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        if (!reference?.absolutePath) continue;
        const uploaded = await this.invoke(["upload", `神思参考-${index + 1}-${job.id}`, "--resource", reference.absolutePath, "-t", String(reference.mimeType || "").split("/")[0]], { cwd: workRoot, timeoutMs: 5 * 60_000 });
        if (uploaded.nodeKey) {
          args.push("--left", String(uploaded.nodeKey));
          leftNodes.push(uploaded.nodeKey);
        }
      }
      const created = await this.invoke(args, { cwd: workRoot, timeoutMs: 90_000 });
      node = { projectUuid: project.projectUuid, nodeKey: String(created.nodeKey || "").trim(), nodeName, leftNodes };
      if (!node.nodeKey) throw asError("LibTV 创建节点未返回节点 ID", "LIBTV_NODE_CREATE_FAILED");
      await writeFile(metadataPath, JSON.stringify(node), "utf8");
    }
    const run = await this.invoke(["node", node.nodeKey, "-p", project.projectUuid, "--run"], { cwd: workRoot, timeoutMs: Math.max(Number(job.request.settings?.timeoutMs) || 0, 30 * 60_000) });
    return { ...libtvTaskFromPayload(run), providerTaskId: libtvTaskFromPayload(run).providerTaskId || node.nodeKey };
  }

  async getStatus({ job, workRoot }) {
    let node;
    try { node = JSON.parse(await readFile(join(workRoot, "libtv-node.json"), "utf8")); } catch { node = {}; }
    if (!node.nodeKey) return { providerTaskId: job.providerTaskId, providerStatus: "queued", rawStatus: "queued" };
    const payload = await this.invoke(["node", node.nodeKey, "-p", node.projectUuid], { cwd: workRoot, timeoutMs: 45_000 });
    return { ...libtvTaskFromPayload(payload), providerTaskId: libtvTaskFromPayload(payload).providerTaskId || job.providerTaskId || node.nodeKey };
  }

  async reconcileSubmission({ job, workRoot }) { return this.getStatus({ job, workRoot }); }

  async cancel({ job }) {
    return {
      providerTaskId: job.providerTaskId,
      providerStatus: "running",
      rawStatus: "cancel_unsupported",
      cancellationUnsupported: true,
      cancellationMessage: "LibTV CLI 当前不支持远程取消；神思已停止等待，不会重复提交或误报取消成功。",
    };
  }

  async download({ job, workRoot, outputPath }) {
    let node;
    try { node = JSON.parse(await readFile(join(workRoot, "libtv-node.json"), "utf8")); } catch { node = {}; }
    if (!node.nodeKey || !node.projectUuid) throw asError("LibTV 下载缺少节点或画布 ID", "LIBTV_DOWNLOAD_METADATA_MISSING");
    const outputDir = join(workRoot, "libtv-download");
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
    await this.invoke(["download", "-n", node.nodeKey, "-p", node.projectUuid, "-o", outputDir], { cwd: workRoot, timeoutMs: 10 * 60_000, raw: true });
    const files = (await readdir(outputDir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => join(outputDir, entry.name));
    if (!files.length) throw asError("LibTV 任务已完成但没有下载到结果文件", "MISSING_RESULT_FILE");
    const sourcePath = files[0];
    const extension = extname(sourcePath).toLowerCase();
    const mimeType = extension === ".png" ? "image/png" : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : extension === ".wav" ? "audio/wav" : extension === ".m4a" ? "audio/mp4" : extension === ".ogg" ? "audio/ogg" : extension === ".mp3" ? "audio/mpeg" : extension === ".webm" ? "video/webm" : extension === ".mov" ? "video/quicktime" : "video/mp4";
    return { path: sourcePath, mimeType, providerTaskId: job.providerTaskId };
  }
}

export class OpenAIVideosDriver extends MediaProviderDriver {
  constructor() {
    super("openai-videos");
  }

  async probeCapabilities({ settings, paid = false } = {}) {
    if (!settings?.apiKey) return { available: false, reason: "missing_credentials", models: [] };
    const baseUrl = httpBaseUrl(settings.baseUrl, "https://api.openai.com/v1");
    const models = await jsonResponse(await fetch(`${baseUrl}/models`, { headers: openAiHeaders(settings), signal: AbortSignal.timeout(20_000) }));
    const available = (models.data || []).map((item) => item.id).filter((id) => /sora|video|seedance|veo|kling|wan|hailuo|vidu|runway/i.test(id));
    return { available: available.length > 0, models: available, visibilityChecked: true, paidSmokeTest: paid };
  }

  async submit({ job, settings, references = [] }) {
    if (!settings?.apiKey) throw asError("OpenAI 视频任务需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const baseUrl = httpBaseUrl(settings.baseUrl, "https://api.openai.com/v1");
    const form = new FormData();
    form.set("model", settings.model || job.request.settings?.model || "sora-2");
    form.set("prompt", providerPrompt(job));
    form.set("seconds", String(job.request.duration || 4));
    form.set("size", videoSize(job.request.aspectRatio || "16:9", job.request.resolution || "720p"));
    const reference = targetFirstImageReferences(references)[0];
    if (reference?.absolutePath) {
      const { openAsBlob } = await import("node:fs");
      form.set("input_reference", await openAsBlob(reference.absolutePath, { type: reference.mimeType || "image/png" }), reference.name || "reference.png");
    }
    const payload = await jsonResponse(await fetch(`${baseUrl}/videos`, {
      method: "POST",
      headers: openAiHeaders(settings, { idempotencyKey: job.idempotencyKey }),
      body: form,
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 120_000)),
    }));
    if (!payload.id) throw asError("OpenAI 视频服务没有返回任务 ID", "MISSING_PROVIDER_TASK_ID");
    return { providerTaskId: payload.id, providerStatus: providerStatus(payload.status), rawStatus: payload.status || "", raw: payload };
  }

  async getStatus({ job, settings }) {
    if (!settings?.apiKey) throw asError("OpenAI 视频续查需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const baseUrl = httpBaseUrl(settings.baseUrl, "https://api.openai.com/v1");
    const payload = await jsonResponse(await fetch(`${baseUrl}/videos/${encodeURIComponent(job.providerTaskId)}`, {
      headers: openAiHeaders(settings),
      signal: AbortSignal.timeout(30_000),
    }));
    return {
      providerTaskId: job.providerTaskId,
      providerStatus: providerStatus(payload.status),
      rawStatus: payload.status || "",
      error: payload.error?.message || "",
      errorCode: payload.error?.code || "",
      resultUrl: payload.result_url || "",
      resultUrlExpiresAt: payload.result_url_expires_at || "",
      raw: payload,
    };
  }

  async cancel({ job, settings }) {
    if (!settings?.apiKey) throw asError("OpenAI 视频取消需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const baseUrl = httpBaseUrl(settings.baseUrl, "https://api.openai.com/v1");
    const payload = await jsonResponse(await fetch(`${baseUrl}/videos/${encodeURIComponent(job.providerTaskId)}/cancel`, {
      method: "POST",
      headers: openAiHeaders(settings, { json: true }),
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    }));
    const rawStatus = payload.status || "cancellation_requested";
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }

  async download({ job, settings }) {
    if (!settings?.apiKey) throw asError("OpenAI 视频下载需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const baseUrl = httpBaseUrl(settings.baseUrl, "https://api.openai.com/v1");
    const response = await fetch(`${baseUrl}/videos/${encodeURIComponent(job.providerTaskId)}/content`, {
      headers: openAiHeaders(settings),
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 10 * 60_000)),
    });
    if (!response.ok || !response.body) throw asError(`OpenAI 视频下载失败（HTTP ${response.status}）`, `HTTP_${response.status}`);
    return {
      stream: Readable.fromWeb(response.body),
      expectedBytes: Number(response.headers.get("content-length") || 0),
      mimeType: response.headers.get("content-type")?.split(";")[0] || "video/mp4",
    };
  }
}

export class VolcArkVideoDriver extends MediaProviderDriver {
  constructor() {
    super("volc-ark-video");
  }

  baseUrl(settings) {
    return httpBaseUrl(settings.baseUrl, "https://ark.cn-beijing.volces.com/api/v3");
  }

  async probeCapabilities({ settings } = {}) {
    if (!settings?.apiKey) return { available: false, reason: "missing_credentials", models: [] };
    const baseUrl = this.baseUrl(settings);
    let models = [];
    let visibilityChecked = false;
    const catalogResponse = await fetch(`${baseUrl}/models`, {
      headers: bearerHeaders(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (catalogResponse?.ok) {
      models = normalizedCatalogModels(await catalogResponse.json().catch(() => ({})), /seedance|video/i);
      visibilityChecked = true;
    }
    const taskResponse = await fetch(`${baseUrl}/contents/generations/tasks?page_num=1&page_size=1`, {
      headers: bearerHeaders(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!taskResponse.ok) await jsonResponse(taskResponse);
    if (!models.length && !visibilityChecked) models = selectedModelFallback(settings);
    return {
      available: true,
      verificationLevel: visibilityChecked ? "model_visibility" : "permission",
      visibilityChecked,
      models,
      inputTypes: ["text", "image"],
      durationSeconds: [4, 5, 8, 10],
      resolutions: ["720p", "1080p"],
    };
  }

  async submit({ job, settings, references = [] }) {
    if (!settings?.apiKey) throw asError("火山方舟视频任务需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const ratio = job.request.aspectRatio || "16:9";
    const duration = Number(job.request.duration) || 5;
    const resolution = job.request.resolution || "720p";
    const prompt = `${providerPrompt(job)}\n--ratio ${ratio} --dur ${duration} --resolution ${resolution}`.trim();
    const content = [{ type: "text", text: prompt }];
    const imageReferences = targetFirstImageReferences(references);
    for (let index = 0; index < imageReferences.length; index += 1) {
      const role = job.request.generationMode === "first_last_frame"
        ? index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference_image"
        : index === 0 ? "first_frame" : "reference_image";
      content.push({ type: "image_url", image_url: { url: await referenceDataUrl(imageReferences[index]) }, role });
    }
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/contents/generations/tasks`, {
      method: "POST",
      headers: jsonHeaders(settings, { "X-Idempotency-Key": job.idempotencyKey }),
      body: JSON.stringify({
        model: settings.model || job.request.settings?.model,
        content,
        duration,
        resolution,
        ratio,
        return_last_frame: true,
      }),
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 120_000)),
    }));
    if (!payload.id) throw asError("火山方舟没有返回任务 ID", "MISSING_PROVIDER_TASK_ID");
    return { providerTaskId: payload.id, providerStatus: providerStatus(payload.status || "queued"), rawStatus: payload.status || "queued", raw: payload };
  }

  async getStatus({ job, settings }) {
    if (!settings?.apiKey) throw asError("火山方舟视频续查需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/contents/generations/tasks/${encodeURIComponent(job.providerTaskId)}`, {
      headers: bearerHeaders(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(30_000),
    }));
    const resultUrl = resultUrlFrom(payload);
    return {
      providerTaskId: job.providerTaskId,
      providerStatus: providerStatus(payload.status),
      rawStatus: payload.status || "",
      ...providerErrorFrom(payload),
      resultUrl,
      resultUrlExpiresAt: resultUrl ? expiryAfterHours(24) : "",
      raw: payload,
    };
  }

  async cancel({ job, settings }) {
    if (!settings?.apiKey) throw asError("火山方舟视频取消需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const response = await fetch(`${this.baseUrl(settings)}/contents/generations/tasks/${encodeURIComponent(job.providerTaskId)}`, {
      method: "DELETE",
      headers: bearerHeaders(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await jsonResponse(response);
    const rawStatus = payload.status || payload.task_status || "cancellation_requested";
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }

  async download({ job, settings, dnsLookup, networkRequest }) {
    return downloadUrl({ url: job.providerResultUrl, providerBaseUrl: settings.baseUrl, dnsLookup, networkRequest, timeoutMs: Math.max(Number(settings.timeoutMs) || 0, 10 * 60_000) });
  }
}

export class DashScopeVideoDriver extends MediaProviderDriver {
  constructor() {
    super("dashscope-video");
  }

  baseUrl(settings) {
    return httpBaseUrl(settings.baseUrl, "https://dashscope.aliyuncs.com/api/v1");
  }

  async probeCapabilities({ settings } = {}) {
    if (!settings?.apiKey) return { available: false, reason: "missing_credentials", models: [] };
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/tasks/?page_no=1&page_size=1`, {
      headers: bearerHeaders(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(20_000),
    }));
    const observed = Array.isArray(payload.data) ? payload.data.map((item) => item.model_name).filter(Boolean) : [];
    return {
      available: true,
      verificationLevel: "permission",
      visibilityChecked: false,
      models: [...new Set([...selectedModelFallback(settings), ...observed])],
      inputTypes: ["text", "image", "video", "audio"],
      durationSeconds: Array.from({ length: 14 }, (_, index) => index + 2),
      resolutions: ["480p", "720p", "1080p"],
    };
  }

  async submit({ job, settings, references = [] }) {
    if (!settings?.apiKey) throw asError("阿里云百炼视频任务需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const model = String(settings.model || job.request.settings?.model || "");
    const prioritizedReferences = targetFirstReferences(references);
    const imageReferences = prioritizedReferences.filter((item) => String(item.mimeType || "").startsWith("image/"));
    const nonImageReferences = prioritizedReferences.filter((item) => !String(item.mimeType || "").startsWith("image/"));
    if (nonImageReferences.some((item) => !/^https?:|^oss:/i.test(String(item.sourceUrl || item.url || "")))) {
      throw asError("百炼的视频或音频参考必须先上传为厂商可访问的临时 URL；本地大媒体不会转为 Base64", "REFERENCE_UPLOAD_REQUIRED");
    }
    const input = { prompt: providerPrompt(job) };
    if (imageReferences.length) {
      const images = await Promise.all(imageReferences.map((item) => referenceDataUrl(item)));
      if (/2\.7|r2v|videoedit|happyhorse/i.test(model)) {
        input.media = images.map((url, index) => ({
          type: job.request.generationMode === "first_last_frame" ? index === 0 ? "first_frame" : index === 1 ? "last_frame" : "reference_image" : index === 0 ? "first_frame" : "reference_image",
          url,
        }));
      } else {
        input.img_url = images[0];
        if (images[1]) input.last_frame_url = images[1];
      }
    }
    for (const item of nonImageReferences) {
      const url = String(item.sourceUrl || item.url || "");
      if (String(item.mimeType || "").startsWith("audio/")) input.audio_url = url;
      else {
        input.media ||= [];
        input.media.push({ type: "reference_video", url });
      }
    }
    const resolution = String(job.request.resolution || "720p").toUpperCase();
    const body = {
      model,
      input,
      parameters: {
        resolution,
        duration: Number(job.request.duration) || 5,
        ratio: job.request.aspectRatio || "16:9",
        prompt_extend: true,
        watermark: false,
      },
    };
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/services/aigc/video-generation/video-synthesis`, {
      method: "POST",
      headers: jsonHeaders(settings, { "X-DashScope-Async": "enable", "X-Idempotency-Key": job.idempotencyKey }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 120_000)),
    }));
    const taskId = payload.output?.task_id || payload.task_id;
    if (!taskId) throw asError("阿里云百炼没有返回任务 ID", "MISSING_PROVIDER_TASK_ID");
    const rawStatus = payload.output?.task_status || payload.task_status || "PENDING";
    return { providerTaskId: taskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }

  async getStatus({ job, settings }) {
    if (!settings?.apiKey) throw asError("阿里云百炼视频续查需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/tasks/${encodeURIComponent(job.providerTaskId)}`, {
      headers: bearerHeaders(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(30_000),
    }));
    const rawStatus = payload.output?.task_status || payload.task_status || "UNKNOWN";
    const resultUrl = resultUrlFrom(payload);
    return {
      providerTaskId: job.providerTaskId,
      providerStatus: providerStatus(rawStatus),
      rawStatus,
      ...providerErrorFrom(payload),
      resultUrl,
      resultUrlExpiresAt: resultUrl ? expiryAfterHours(24) : "",
      raw: payload,
    };
  }

  async cancel({ job, settings }) {
    if (!settings?.apiKey) throw asError("阿里云百炼视频取消需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/tasks/${encodeURIComponent(job.providerTaskId)}/cancel`, {
      method: "POST",
      headers: bearerHeaders(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(30_000),
    }));
    const rawStatus = payload.output?.task_status || payload.task_status || "cancellation_requested";
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }

  async download({ job, settings, dnsLookup, networkRequest }) {
    return downloadUrl({ url: job.providerResultUrl, providerBaseUrl: settings.baseUrl, dnsLookup, networkRequest, timeoutMs: Math.max(Number(settings.timeoutMs) || 0, 10 * 60_000) });
  }
}

const KLING_MODEL_MAP = Object.freeze({
  "kling-video-3.0-omni": "kling-v3-omni",
  "kling-video-3.0": "kling-v3",
  "kling-video-o1": "kling-o1",
  "kling-video-2.6": "kling-v2-6",
  "kling-video-2.5-turbo": "kling-v2-5-turbo",
  "kling-video-2.1": "kling-v2-1-master",
  "kling-video-2.0": "kling-v2-master",
  "kling-video-1.6": "kling-v1-6",
  "kling-video-1.5": "kling-v1-5",
});

export class KlingVideoDriver extends MediaProviderDriver {
  constructor() {
    super("kling-video");
  }

  baseUrl(settings) {
    return httpBaseUrl(settings.baseUrl, "https://api-singapore.klingai.com");
  }

  headers(settings, extra = {}) {
    return { Authorization: `Bearer ${klingToken(settings)}`, ...extra };
  }

  async probeCapabilities({ settings } = {}) {
    if (!settings?.apiKey) return { available: false, reason: "missing_credentials", models: [] };
    const response = await fetch(`${this.baseUrl(settings)}/v1/videos/text2video?pageNum=1&pageSize=1`, {
      headers: this.headers(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(20_000),
    });
    await jsonResponse(response);
    return {
      available: true,
      verificationLevel: "permission",
      visibilityChecked: false,
      models: selectedModelFallback(settings),
      inputTypes: ["text", "image"],
      durationSeconds: Array.from({ length: 13 }, (_, index) => index + 3),
      resolutions: ["720p", "1080p"],
    };
  }

  async submit({ job, settings, references = [] }) {
    if (!settings?.apiKey) throw asError("可灵视频任务需要在当前会话重新填写 API 凭证", "MISSING_CREDENTIALS");
    const image = targetFirstImageReferences(references)[0];
    const route = image ? "image2video" : "text2video";
    const body = {
      model_name: KLING_MODEL_MAP[settings.model] || settings.model,
      prompt: providerPrompt(job),
      duration: String(Number(job.request.duration) || 5),
      aspect_ratio: job.request.aspectRatio || "16:9",
      mode: String(job.request.resolution || "720p").toLowerCase() === "720p" ? "std" : "pro",
      external_task_id: job.idempotencyKey,
    };
    if (image) body.image = await referenceDataUrl(image, 10 * 1024 * 1024);
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/v1/videos/${route}`, {
      method: "POST",
      headers: this.headers(settings, { "Content-Type": "application/json", "X-Idempotency-Key": job.idempotencyKey }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 120_000)),
    }));
    const taskId = payload.data?.task_id || payload.task_id;
    if (!taskId) throw asError("可灵没有返回任务 ID", "MISSING_PROVIDER_TASK_ID");
    const rawStatus = payload.data?.task_status || payload.task_status || "submitted";
    return { providerTaskId: taskId, providerStatus: providerStatus(rawStatus), rawStatus, providerRoute: route, raw: payload };
  }

  async getStatus({ job, settings }) {
    if (!settings?.apiKey) throw asError("可灵视频续查需要在当前会话重新填写 API 凭证", "MISSING_CREDENTIALS");
    const route = job.request?.referenceMedia?.some((item) => String(item.mimeType || "").startsWith("image/")) ? "image2video" : "text2video";
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/v1/videos/${route}/${encodeURIComponent(job.providerTaskId)}`, {
      headers: this.headers(settings, { Accept: "application/json" }),
      signal: AbortSignal.timeout(30_000),
    }));
    const rawStatus = payload.data?.task_status || payload.task_status || "unknown";
    const resultUrl = resultUrlFrom(payload);
    return {
      providerTaskId: job.providerTaskId,
      providerStatus: providerStatus(rawStatus),
      rawStatus,
      ...providerErrorFrom(payload),
      resultUrl,
      resultUrlExpiresAt: resultUrl ? expiryAfterHours(24) : "",
      raw: payload,
    };
  }

  async cancel({ job, settings }) {
    if (!settings?.apiKey) throw asError("可灵视频取消需要在当前会话重新填写 API 凭证", "MISSING_CREDENTIALS");
    const route = job.request?.referenceMedia?.some((item) => String(item.mimeType || "").startsWith("image/")) ? "image2video" : "text2video";
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/v1/videos/${route}/${encodeURIComponent(job.providerTaskId)}/cancel`, {
      method: "POST",
      headers: this.headers(settings, { "Content-Type": "application/json" }),
      body: "{}",
      signal: AbortSignal.timeout(30_000),
    }));
    const rawStatus = payload.data?.task_status || payload.task_status || "cancellation_requested";
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }

  async download({ job, settings, dnsLookup, networkRequest }) {
    return downloadUrl({ url: job.providerResultUrl, providerBaseUrl: settings.baseUrl, dnsLookup, networkRequest, timeoutMs: Math.max(Number(settings.timeoutMs) || 0, 10 * 60_000) });
  }
}

export class VolcArkImageDriver extends MediaProviderDriver {
  constructor() { super("volc-ark-image"); }
  baseUrl(settings) { return httpBaseUrl(settings.baseUrl, "https://ark.cn-beijing.volces.com/api/v3"); }

  async probeCapabilities({ settings } = {}) {
    if (!settings?.apiKey) return { available: false, reason: "missing_credentials", models: [] };
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/models`, { headers: bearerHeaders(settings, { Accept: "application/json" }), signal: AbortSignal.timeout(20_000) }));
    const models = normalizedCatalogModels(payload, /seedream|image/i);
    return { available: true, verificationLevel: "model_visibility", visibilityChecked: true, models, inputTypes: ["text", "image"], resolutions: ["standard", "high", "2k", "4k"] };
  }

  async submit({ job, settings, references = [] }) {
    if (!settings?.apiKey) throw asError("火山方舟图片任务需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const images = await Promise.all(targetFirstImageReferences(references).map((item) => referenceDataUrl(item)));
    const body = {
      model: settings.model || job.request.settings?.model,
      prompt: providerPrompt(job),
      response_format: "url",
      size: job.request.quality === "high" ? "2048x2048" : "1024x1024",
      ...(images.length ? { image: images.length === 1 ? images[0] : images } : {}),
    };
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/images/generations`, {
      method: "POST",
      headers: jsonHeaders(settings, { "X-Idempotency-Key": job.idempotencyKey }),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 180_000)),
    }));
    const resultUrl = resultUrlFrom(payload);
    if (!resultUrl) throw asError("火山方舟图片响应没有可下载 URL", "MISSING_RESULT_URL");
    return { providerTaskId: String(payload.id || payload.request_id || job.idempotencyKey), providerStatus: "completed", rawStatus: "completed", resultUrl, resultUrlExpiresAt: expiryAfterHours(24), raw: payload };
  }

  async getStatus({ job }) { return { providerTaskId: job.providerTaskId, providerStatus: "completed", rawStatus: "completed", resultUrl: job.providerResultUrl, resultUrlExpiresAt: job.resultUrlExpiresAt }; }
  async cancel({ job }) { return { providerTaskId: job.providerTaskId, providerStatus: job.providerStatus === "completed" ? "completed" : "cancelled", rawStatus: job.providerStatus || "cancelled" }; }
  async download({ job, settings, dnsLookup, networkRequest }) { return downloadUrl({ url: job.providerResultUrl, providerBaseUrl: settings.baseUrl, dnsLookup, networkRequest, timeoutMs: Math.max(Number(settings.timeoutMs) || 0, 10 * 60_000) }); }
}

export class DashScopeImageDriver extends MediaProviderDriver {
  constructor() { super("dashscope-image"); }
  baseUrl(settings) { return httpBaseUrl(settings.baseUrl, "https://dashscope.aliyuncs.com/api/v1"); }

  async probeCapabilities({ settings } = {}) {
    if (!settings?.apiKey) return { available: false, reason: "missing_credentials", models: [] };
    await jsonResponse(await fetch(`${this.baseUrl(settings)}/tasks/?page_no=1&page_size=1`, { headers: bearerHeaders(settings, { Accept: "application/json" }), signal: AbortSignal.timeout(20_000) }));
    return { available: true, verificationLevel: "permission", visibilityChecked: false, models: selectedModelFallback(settings), inputTypes: ["text", "image"], resolutions: ["1k", "2k", "4k"] };
  }

  async submit({ job, settings, references = [] }) {
    if (!settings?.apiKey) throw asError("阿里云百炼图片任务需要在当前会话重新填写 API Key", "MISSING_CREDENTIALS");
    const content = [];
    for (const reference of targetFirstImageReferences(references)) content.push({ image: await referenceDataUrl(reference) });
    content.push({ text: providerPrompt(job) });
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/services/aigc/image-generation/generation`, {
      method: "POST",
      headers: jsonHeaders(settings, { "X-DashScope-Async": "enable", "X-Idempotency-Key": job.idempotencyKey }),
      body: JSON.stringify({ model: settings.model || job.request.settings?.model, input: { messages: [{ role: "user", content }] }, parameters: { size: job.request.quality === "high" ? "2K" : "1K", n: 1, watermark: false } }),
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 120_000)),
    }));
    const taskId = payload.output?.task_id || payload.task_id;
    if (!taskId) throw asError("阿里云百炼图片任务没有返回任务 ID", "MISSING_PROVIDER_TASK_ID");
    const rawStatus = payload.output?.task_status || payload.task_status || "PENDING";
    return { providerTaskId: taskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }

  async getStatus({ job, settings }) {
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/tasks/${encodeURIComponent(job.providerTaskId)}`, { headers: bearerHeaders(settings, { Accept: "application/json" }), signal: AbortSignal.timeout(30_000) }));
    const rawStatus = payload.output?.task_status || payload.task_status || "UNKNOWN";
    const resultUrl = resultUrlFrom(payload);
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, ...providerErrorFrom(payload), resultUrl, resultUrlExpiresAt: resultUrl ? expiryAfterHours(24) : "", raw: payload };
  }

  async cancel({ job, settings }) {
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/tasks/${encodeURIComponent(job.providerTaskId)}/cancel`, { method: "POST", headers: bearerHeaders(settings, { Accept: "application/json" }), signal: AbortSignal.timeout(30_000) }));
    const rawStatus = payload.output?.task_status || payload.task_status || "cancellation_requested";
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }
  async download({ job, settings, dnsLookup, networkRequest }) { return downloadUrl({ url: job.providerResultUrl, providerBaseUrl: settings.baseUrl, dnsLookup, networkRequest, timeoutMs: Math.max(Number(settings.timeoutMs) || 0, 10 * 60_000) }); }
}

export class KlingImageDriver extends MediaProviderDriver {
  constructor() { super("kling-image"); }
  baseUrl(settings) { return httpBaseUrl(settings.baseUrl, "https://api-singapore.klingai.com"); }
  headers(settings, extra = {}) { return { Authorization: `Bearer ${klingToken(settings)}`, ...extra }; }

  async probeCapabilities({ settings } = {}) {
    if (!settings?.apiKey) return { available: false, reason: "missing_credentials", models: [] };
    const response = await fetch(`${this.baseUrl(settings)}/v1/images/generations?pageNum=1&pageSize=1`, { headers: this.headers(settings, { Accept: "application/json" }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) await jsonResponse(response);
    return { available: true, verificationLevel: "permission", visibilityChecked: false, models: selectedModelFallback(settings), inputTypes: ["text", "image"], resolutions: ["standard", "high"] };
  }

  async submit({ job, settings, references = [] }) {
    const image = targetFirstImageReferences(references)[0];
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/v1/images/generations`, {
      method: "POST",
      headers: this.headers(settings, { "Content-Type": "application/json", "X-Idempotency-Key": job.idempotencyKey }),
      body: JSON.stringify({ model_name: settings.model || job.request.settings?.model, prompt: providerPrompt(job), ...(image ? { image: await referenceDataUrl(image, 10 * 1024 * 1024) } : {}) }),
      signal: AbortSignal.timeout(Math.max(Number(settings.timeoutMs) || 0, 120_000)),
    }));
    const taskId = payload.data?.task_id || payload.task_id;
    if (!taskId) throw asError("可灵图片任务没有返回任务 ID", "MISSING_PROVIDER_TASK_ID");
    const rawStatus = payload.data?.task_status || payload.task_status || "submitted";
    return { providerTaskId: taskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }

  async getStatus({ job, settings }) {
    const payload = await jsonResponse(await fetch(`${this.baseUrl(settings)}/v1/images/generations/${encodeURIComponent(job.providerTaskId)}`, { headers: this.headers(settings, { Accept: "application/json" }), signal: AbortSignal.timeout(30_000) }));
    const rawStatus = payload.data?.task_status || payload.task_status || "unknown";
    const resultUrl = resultUrlFrom(payload.data || payload);
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, ...providerErrorFrom(payload), resultUrl, resultUrlExpiresAt: resultUrl ? expiryAfterHours(24) : "", raw: payload };
  }

  async cancel({ job, settings }) {
    const response = await fetch(`${this.baseUrl(settings)}/v1/images/generations/${encodeURIComponent(job.providerTaskId)}`, { method: "DELETE", headers: this.headers(settings, { Accept: "application/json" }), signal: AbortSignal.timeout(30_000) });
    const payload = await jsonResponse(response);
    const rawStatus = payload.data?.task_status || payload.task_status || "cancellation_requested";
    return { providerTaskId: job.providerTaskId, providerStatus: providerStatus(rawStatus), rawStatus, raw: payload };
  }
  async download({ job, settings, dnsLookup, networkRequest }) { return downloadUrl({ url: job.providerResultUrl, providerBaseUrl: settings.baseUrl, dnsLookup, networkRequest, timeoutMs: Math.max(Number(settings.timeoutMs) || 0, 10 * 60_000) }); }
}

export const mediaProviderDrivers = Object.freeze({
  dreaminaImage: new DreaminaImageDriver(),
  dreamina: new DreaminaVideoDriver(),
  openai: new OpenAIVideosDriver(),
  volcArk: new VolcArkVideoDriver(),
  kling: new KlingVideoDriver(),
  dashscope: new DashScopeVideoDriver(),
  volcArkImage: new VolcArkImageDriver(),
  klingImage: new KlingImageDriver(),
  dashscopeImage: new DashScopeImageDriver(),
  libtv: new LibTvMediaDriver(),
});

export const resolveMediaProviderDriver = ({ channel, settings = {} } = {}) => {
  const provider = String(settings.provider || "").trim().toLowerCase();
  const adapter = String(settings.adapter || "").trim().toLowerCase();
  const isProvider = (...aliases) => aliases.some((alias) => provider === alias.toLowerCase());
  if (channel === "image") {
    if (adapter === "cli") {
      if (settings.cliPath === LIBTV_CLI_ALIAS && isProvider("libtv")) return mediaProviderDrivers.libtv;
      return settings.cliPath === DREAMINA_IMAGE_CLI_ALIAS && isProvider("即梦", "dreamina")
        ? mediaProviderDrivers.dreaminaImage
        : null;
    }
    if (adapter !== "api") return null;
    if (isProvider("即梦", "dreamina", "火山方舟", "volc ark", "volcark")) return mediaProviderDrivers.volcArkImage;
    if (isProvider("可灵", "kling")) return mediaProviderDrivers.klingImage;
    if (isProvider("阿里云百炼", "百炼", "dashscope", "wanx")) return mediaProviderDrivers.dashscopeImage;
    return null;
  }
  if (channel === "audio") {
    return adapter === "cli" && settings.cliPath === LIBTV_CLI_ALIAS && isProvider("libtv")
      ? mediaProviderDrivers.libtv : null;
  }
  if (channel !== "video") return null;
  if (adapter === "cli") {
    if (settings.cliPath === LIBTV_CLI_ALIAS && isProvider("libtv")) return mediaProviderDrivers.libtv;
    return settings.cliPath === DREAMINA_VIDEO_CLI_ALIAS && isProvider("即梦", "dreamina")
      ? mediaProviderDrivers.dreamina
      : null;
  }
  if (adapter !== "api") return null;
  if (isProvider("openai", "自定义兼容接口") && (!settings.protocol || String(settings.protocol).toLowerCase() === "videos")) return mediaProviderDrivers.openai;
  if (isProvider("即梦", "dreamina", "火山方舟", "volc ark", "volcark")) return mediaProviderDrivers.volcArk;
  if (isProvider("可灵", "kling")) return mediaProviderDrivers.kling;
  if (isProvider("阿里云百炼", "百炼", "dashscope", "wanx")) return mediaProviderDrivers.dashscope;
  return null;
};
