import { createHash, randomUUID } from "node:crypto";

export const NUTSTORE_PROTOCOL_VERSION = 1;
export const NUTSTORE_STATE_SCHEMA_VERSION = 1;
export const NUTSTORE_OFFICIAL_ORIGIN = "https://dav.jianguoyun.com";
export const NUTSTORE_DEFAULT_ENDPOINT = `${NUTSTORE_OFFICIAL_ORIGIN}/dav/`;
export const NUTSTORE_DEFAULT_REMOTE_ROOT = "/神思同步/";
export const SYNC_MODES = Object.freeze(["none", "nutstore_direct", "baidu_local_folder"]);
export const CAPABILITY_LEVELS = Object.freeze(["safe_auto", "safe_manual", "unsupported"]);
export const OPERATION_STATES = Object.freeze([
  "pending", "scanning", "comparing", "uploading", "downloading", "verifying", "applying",
  "conflict", "retry_wait", "waiting_credentials", "paused", "completed", "cancelled", "failed",
]);

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CONTROL_OR_FORBIDDEN = /[\u0000-\u001f<>:"|?*]/u;

export const normalizeNutstoreEndpoint = (value = NUTSTORE_DEFAULT_ENDPOINT) => {
  let url;
  try { url = new URL(String(value || NUTSTORE_DEFAULT_ENDPOINT).trim()); }
  catch { throw new Error("坚果云 WebDAV URL 无效"); }
  if (url.protocol !== "https:") throw new Error("坚果云直连只允许 HTTPS");
  if (url.origin !== NUTSTORE_OFFICIAL_ORIGIN) throw new Error("当前版本只允许坚果云官方 WebDAV 主机");
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = `${url.pathname.replace(/\/{2,}/g, "/").replace(/\/?$/, "/")}`;
  if (!url.pathname.startsWith("/dav/")) throw new Error("坚果云官方 WebDAV URL 必须位于 /dav/");
  return url.toString();
};

const normalizedSegment = (segment) => {
  const value = String(segment || "").normalize("NFC");
  if (!value || value === "." || value === "..") throw new Error("同步逻辑路径包含空段或路径穿越");
  if (CONTROL_OR_FORBIDDEN.test(value) || /[. ]$/u.test(value)) throw new Error("同步逻辑路径包含 Windows 不安全字符");
  if (WINDOWS_RESERVED.test(value)) throw new Error("同步逻辑路径包含 Windows 保留名称");
  return value;
};

export const normalizeLogicalPath = (input) => {
  const raw = String(input || "").trim().replace(/\\/g, "/").normalize("NFC");
  if (!raw) throw new Error("同步逻辑路径不能为空");
  if (/^(?:\/|[a-z]:\/)/i.test(raw)) throw new Error("同步逻辑路径不能是机器绝对路径");
  const segments = raw.split("/").map(normalizedSegment);
  return segments.join("/");
};

export const normalizeRemoteRoot = (input = NUTSTORE_DEFAULT_REMOTE_ROOT) => {
  const raw = String(input || NUTSTORE_DEFAULT_REMOTE_ROOT).trim().replace(/\\/g, "/").normalize("NFC");
  if (/^[a-z]:/i.test(raw) || raw.includes("..")) throw new Error("远程目录不能包含本机路径或路径穿越");
  const segments = raw.split("/").filter(Boolean).map(normalizedSegment);
  if (!segments.length) throw new Error("远程目录不能是 WebDAV 根目录");
  return `/${segments.join("/")}/`;
};

export const logicalPathKey = (value) => normalizeLogicalPath(value).normalize("NFC").toLocaleLowerCase("en-US");
export const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const stableIdempotencyKey = ({ action, logicalPath, hash = "", deleted = false }) => (
  sha256(`${NUTSTORE_PROTOCOL_VERSION}\n${action}\n${normalizeLogicalPath(logicalPath)}\n${hash}\n${deleted ? 1 : 0}`)
);
export const createTransactionId = (deviceId = "device") => `${String(deviceId).slice(0, 12)}-${Date.now()}-${randomUUID()}`;

export const publicSyncError = (error) => ({
  code: String(error?.code || "NUTSTORE_SYNC_FAILED").replace(/[^A-Z0-9_:-]/gi, "_").slice(0, 80),
  message: String(error?.safeMessage || error?.message || "同步失败")
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(/(password|authorization|应用密码)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500),
});

