import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname } from "node:path";
import { normalizeNutstoreEndpoint, publicSyncError } from "./contracts.mjs";

const MAX_XML_BYTES = 4 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const encodePath = (path) => {
  const source = String(path || "").replace(/\\/g, "/");
  const encoded = source.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return encoded && source.endsWith("/") ? `${encoded}/` : encoded;
};
const decodeXml = (value) => String(value || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const webDavExceptionName = (xml) => decodeXml(String(xml || "").match(/<(?:[A-Za-z0-9_-]+:)?exception\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?exception>/iu)?.[1]?.trim() || "");

const boundedText = async (response, maxBytes = MAX_XML_BYTES) => {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw Object.assign(new Error("WebDAV 响应超过安全大小"), { code: "WEBDAV_RESPONSE_TOO_LARGE" });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw Object.assign(new Error("WebDAV 响应超过安全大小"), { code: "WEBDAV_RESPONSE_TOO_LARGE" });
  return buffer.toString("utf8");
};

export const parseWebDavMultiStatus = (xml) => {
  const source = String(xml || "");
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw Object.assign(new Error("WebDAV XML 包含不允许的实体声明"), { code: "WEBDAV_UNSAFE_XML" });
  const responses = [];
  for (const match of source.matchAll(/<(?:[A-Za-z0-9_-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?response>/gi)) {
    const block = match[1];
    const pick = (name) => decodeXml(block.match(new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}\\b[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_-]+:)?${name}>`, "i"))?.[1]?.trim() || "");
    responses.push({
      href: decodeURIComponent(pick("href")),
      etag: pick("getetag").replace(/^W\//, "").replace(/^"|"$/g, ""),
      size: Number(pick("getcontentlength") || 0),
      contentType: pick("getcontenttype"),
      modifiedAt: pick("getlastmodified"),
      collection: /<(?:[A-Za-z0-9_-]+:)?collection\b/i.test(block),
      status: pick("status"),
    });
  }
  return responses;
};

export class WebDavError extends Error {
  constructor(message, { code = "WEBDAV_FAILED", status = 0, retryAfterMs = 0 } = {}) {
    super(message);
    this.name = "WebDavError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.safeMessage = message;
  }
}

const retryAfterMilliseconds = (response) => {
  const value = response.headers.get("retry-after");
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Math.min(60 * 60 * 1000, Number(value) * 1000);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(60 * 60 * 1000, parsed - Date.now())) : 0;
};

const waitMilliseconds = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const normalizedCollectionPath = (value, base) => {
  try {
    const pathname = new URL(String(value || ""), base).pathname;
    return decodeURIComponent(pathname).normalize("NFC").replace(/\/+$/u, "/");
  } catch {
    return "";
  }
};

export const createWebDavClient = ({ endpoint, account, password, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) => {
  const officialEndpoint = normalizeNutstoreEndpoint(endpoint);
  if (!account || !password) throw Object.assign(new Error("请输入坚果云账号和第三方应用密码"), { code: "WAITING_CREDENTIALS" });
  if (typeof fetchImpl !== "function") throw new Error("当前运行时缺少 fetch 能力");
  const auth = `Basic ${Buffer.from(`${String(account)}:${String(password)}`, "utf8").toString("base64")}`;
  const endpointUrl = new URL(officialEndpoint);
  const confirmedCollections = new Set();

  const urlFor = (remotePath = "") => new URL(encodePath(remotePath), officialEndpoint).toString();
  const requestOnce = async (remotePath, { method = "GET", headers = {}, body = undefined, expected = [200, 201, 204, 207], signal = null } = {}) => {
    const controller = signal ? null : new AbortController();
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      let currentUrl = urlFor(remotePath);
      for (let redirect = 0; redirect <= 2; redirect += 1) {
        const current = new URL(currentUrl);
        if (current.origin !== endpointUrl.origin || current.protocol !== "https:") throw new WebDavError("坚果云重定向离开官方 HTTPS 主机，已阻止凭据转发", { code: "WEBDAV_UNSAFE_REDIRECT" });
        const response = await fetchImpl(currentUrl, {
          method,
          headers: { Authorization: auth, "User-Agent": "ShensiCreativeEngine/1.0", ...headers },
          body,
          redirect: "manual",
          signal: signal || controller.signal,
          ...(body && typeof body.pipe === "function" ? { duplex: "half" } : {}),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new WebDavError("坚果云返回了无目标重定向", { code: "WEBDAV_BAD_REDIRECT", status: response.status });
          const next = new URL(location, currentUrl);
          if (next.origin !== endpointUrl.origin || next.protocol !== "https:") throw new WebDavError("坚果云重定向离开官方 HTTPS 主机，已阻止凭据转发", { code: "WEBDAV_UNSAFE_REDIRECT", status: response.status });
          currentUrl = next.toString();
          continue;
        }
        if (expected.includes(response.status)) return response;
        const retryAfterMs = retryAfterMilliseconds(response);
        if (response.status === 401) throw new WebDavError("坚果云账号或第三方应用密码无效", { code: "WAITING_CREDENTIALS", status: response.status });
        if (response.status === 403) {
          const exception = webDavExceptionName(await boundedText(response, 64 * 1024).catch(() => ""));
          if (/^AccountExpired$/iu.test(exception)) throw new WebDavError("坚果云账号服务已到期，请恢复账号服务后重试", { code: "NUTSTORE_ACCOUNT_EXPIRED", status: response.status });
          throw new WebDavError("坚果云拒绝了本次 WebDAV 操作，请检查写入条件或目录权限", { code: "WEBDAV_FORBIDDEN", status: response.status });
        }
        if ([429, 503].includes(response.status)) throw new WebDavError("坚果云暂时繁忙，任务将按服务端要求重试", { code: "RETRY_WAIT", status: response.status, retryAfterMs });
        throw new WebDavError(`坚果云 WebDAV 请求失败（HTTP ${response.status}）`, { code: `WEBDAV_HTTP_${response.status}`, status: response.status });
      }
      throw new WebDavError("坚果云重定向次数过多", { code: "WEBDAV_TOO_MANY_REDIRECTS" });
    } catch (error) {
      if (error?.name === "AbortError") throw new WebDavError("坚果云请求超时", { code: "WEBDAV_TIMEOUT" });
      if (error instanceof WebDavError) {
        // Keep only the protocol operation (never the URL or credentials) so
        // diagnostics can distinguish MKCOL conflicts from PUT/MOVE conflicts.
        if (!error.operation) error.operation = String(method || "GET").toUpperCase();
        throw error;
      }
      const safe = publicSyncError(error);
      const wrapped = new WebDavError(safe.message === "fetch failed" ? "无法连接坚果云，请检查网络后重试" : safe.message, { code: "WEBDAV_NETWORK" });
      wrapped.operation = String(method || "GET").toUpperCase();
      throw wrapped;
    } finally { if (timer) clearTimeout(timer); }
  };

  const request = async (remotePath, optionsValue = {}) => {
    const method = String(optionsValue.method || "GET").toUpperCase();
    const expected = optionsValue.expected || [200, 201, 204, 207];
    const retryableMethod = ["OPTIONS", "PROPFIND", "GET", "HEAD"].includes(method)
      || (method === "DELETE" && expected.includes(404));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await requestOnce(remotePath, optionsValue);
      } catch (error) {
        const transient = ["WEBDAV_NETWORK", "WEBDAV_TIMEOUT", "RETRY_WAIT"].includes(error?.code);
        if (!retryableMethod || !transient || optionsValue.signal?.aborted || attempt === 4) throw error;
        const delay = Math.min(10_000, Math.max(Number(error?.retryAfterMs) || 0, 500 * (2 ** attempt)));
        await waitMilliseconds(delay);
      }
    }
    throw new WebDavError("坚果云请求重试未完成", { code: "WEBDAV_NETWORK" });
  };

  const options = async () => {
    const response = await request("", { method: "OPTIONS", expected: [200, 204] });
    return { dav: response.headers.get("dav") || "", allow: response.headers.get("allow") || "" };
  };
  const propfind = async (remotePath, depth = 1) => {
    const response = await request(remotePath, {
      method: "PROPFIND",
      headers: { Depth: String(depth), "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>`,
      expected: [207],
    });
    return parseWebDavMultiStatus(await boundedText(response));
  };
  const inspectCollection = async (remotePath, { includeParent = false } = {}) => {
    const expectedPath = normalizedCollectionPath(urlFor(remotePath), officialEndpoint);
    const inspectListing = (listing, { direct = false } = {}) => {
      const matching = listing.find((item) => normalizedCollectionPath(item.href, officialEndpoint) === expectedPath);
      // A Depth: 0 response describes the requested resource even when a
      // provider canonicalizes the href differently from the request URL.
      if (!matching && direct && listing.length === 1) return listing[0].collection === true ? "collection" : "resource";
      if (!matching) return "missing";
      return matching.collection === true ? "collection" : "resource";
    };
    try {
      const direct = inspectListing(await propfind(remotePath, 0), { direct: true });
      if (direct !== "missing") return direct;
    } catch (error) {
      if (error?.code !== "WEBDAV_HTTP_404") throw error;
    }
    if (!includeParent) return "missing";
    const segments = String(remotePath || "").split("/").filter(Boolean);
    const parent = segments.slice(0, -1).join("/");
    try {
      return inspectListing(await propfind(parent ? `${parent}/` : "", 1));
    } catch (error) {
      if (error?.code === "WEBDAV_HTTP_404") return "missing";
      throw error;
    }
  };
  const mkcol = async (remotePath) => {
    try {
      // Some WebDAV gateways reject an otherwise empty MKCOL when the HTTP
      // client omits Content-Length. Node's fetch does omit it for body-less
      // custom methods, so make the zero-length body explicit.
      return await request(remotePath, { method: "MKCOL", headers: { "Content-Length": "0" }, expected: [201] });
    } catch (error) {
      // 坚果云对已存在的集合可能返回 405 或 409。
      // 只有只读 PROPFIND 确认它确实是集合时才忽略，避免吞掉父目录缺失或权限冲突。
      if (!["WEBDAV_HTTP_405", "WEBDAV_HTTP_409"].includes(error?.code)) throw error;
      const state = await inspectCollection(remotePath, { includeParent: true });
      if (state === "collection") return { status: error.status, existed: true };
      if (state === "resource") {
        const conflict = new WebDavError("坚果云远程路径已存在但不是目录", { code: "WEBDAV_REMOTE_PATH_NOT_COLLECTION", status: error.status });
        conflict.operation = "MKCOL";
        throw conflict;
      }
      const conflict = new WebDavError("坚果云远程目录尚未可见，且父目录可能不存在", { code: "WEBDAV_COLLECTION_CREATE_CONFLICT", status: error.status });
      conflict.operation = "MKCOL";
      throw conflict;
    }
  };
  const ensureCollections = async (remotePath) => {
    const segments = String(remotePath || "").split("/").filter(Boolean);
    let current = "";
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      current += `${segment}/`;
      if (confirmedCollections.has(current)) continue;
      let created = false;
      let lastConflict = null;
      // Nutstore can return 409 while a just-created parent collection is
      // still propagating. Re-issuing MKCOL is required: only rechecking the
      // target can never create it after the first rejected request.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const before = await inspectCollection(current, { includeParent: true });
          if (before === "collection") {
            created = true;
            confirmedCollections.add(current);
            break;
          }
          if (before === "resource") {
            throw new WebDavError("坚果云远程路径已存在但不是目录", { code: "WEBDAV_REMOTE_PATH_NOT_COLLECTION", status: 409 });
          }
          await mkcol(current);
          const after = await inspectCollection(current, { includeParent: true });
          if (after === "collection") {
            created = true;
            confirmedCollections.add(current);
            break;
          }
          lastConflict = new WebDavError("坚果云已接受目录创建，但目录尚未对后续请求可见", { code: "WEBDAV_COLLECTION_CREATE_CONFLICT", status: 409 });
        } catch (error) {
          if (error?.code !== "WEBDAV_COLLECTION_CREATE_CONFLICT") throw error;
          lastConflict = error;
          const parent = segments.slice(0, index).join("/");
          try {
            const parentListing = await propfind(parent ? `${parent}/` : "", 0);
            if (parentListing.length && !parentListing.some((item) => item.collection === true)) {
              throw new WebDavError("坚果云远程父路径不是目录", { code: "WEBDAV_REMOTE_PATH_NOT_COLLECTION", status: 409 });
            }
          } catch (parentError) {
            if (parentError?.code !== "WEBDAV_HTTP_404") throw parentError;
          }
        }
        if (attempt < 5) await waitMilliseconds(Math.min(2_000, 100 * (2 ** attempt)));
      }
      if (!created) {
        throw new WebDavError(
          index > 0 ? "坚果云远程父目录创建后仍不可见，无法创建目标目录" : "坚果云远程根目录创建后仍不可见",
          { code: index > 0 ? "WEBDAV_PARENT_COLLECTION_MISSING" : "WEBDAV_COLLECTION_CREATE_CONFLICT", status: lastConflict?.status || 409 },
        );
      }
    }
  };
  const getBuffer = async (remotePath, maxBytes = MAX_JSON_BYTES) => {
    const response = await request(remotePath, { method: "GET", expected: [200, 206] });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new WebDavError("远程元数据超过安全大小", { code: "WEBDAV_RESPONSE_TOO_LARGE" });
    return { buffer, etag: (response.headers.get("etag") || "").replace(/^W\//, "").replace(/^"|"$/g, ""), contentType: response.headers.get("content-type") || "" };
  };
  const downloadToFile = async (remotePath, temporaryPath, { expectedSize = -1 } = {}) => {
    await mkdir(dirname(temporaryPath), { recursive: true });
    const response = await request(remotePath, { method: "GET", expected: [200] });
    const declared = Number(response.headers.get("content-length") || -1);
    if (expectedSize >= 0 && declared >= 0 && declared !== expectedSize) throw new WebDavError("远程文件大小与清单不一致", { code: "REMOTE_SIZE_MISMATCH" });
    if (!response.body) throw new WebDavError("坚果云未返回文件内容", { code: "WEBDAV_EMPTY_BODY" });
    await pipeline(Readable.fromWeb(response.body), (await open(temporaryPath, "wx", 0o600)).createWriteStream());
    const info = await stat(temporaryPath);
    if (expectedSize >= 0 && info.size !== expectedSize) throw new WebDavError("远程文件下载不完整", { code: "REMOTE_SIZE_MISMATCH" });
    return { size: info.size, etag: (response.headers.get("etag") || "").replace(/^W\//, "").replace(/^"|"$/g, "") };
  };
  const putBuffer = async (remotePath, buffer, { contentType = "application/octet-stream", ifMatch = "", ifNoneMatch = false } = {}) => {
    const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    const response = await request(remotePath, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Content-Length": String(payload.length), ...(ifMatch ? { "If-Match": `"${ifMatch}"` } : {}), ...(ifNoneMatch ? { "If-None-Match": "*" } : {}) },
      body: payload,
      expected: [200, 201, 204],
    });
    return { etag: (response.headers.get("etag") || "").replace(/^W\//, "").replace(/^"|"$/g, "") };
  };
  const putFile = async (remotePath, localPath, optionsValue = {}) => {
    const info = await stat(localPath);
    const response = await request(remotePath, {
      method: "PUT",
      headers: { "Content-Type": optionsValue.contentType || "application/octet-stream", "Content-Length": String(info.size), ...(optionsValue.ifMatch ? { "If-Match": `"${optionsValue.ifMatch}"` } : {}), ...(optionsValue.ifNoneMatch ? { "If-None-Match": "*" } : {}) },
      body: createReadStream(localPath), expected: [200, 201, 204],
    });
    return { etag: (response.headers.get("etag") || "").replace(/^W\//, "").replace(/^"|"$/g, "") };
  };
  const remove = async (remotePath, { ifMatch = "", allowMissing = true } = {}) => {
    const response = await request(remotePath, {
      method: "DELETE", headers: ifMatch ? { "If-Match": `"${ifMatch}"` } : {}, expected: allowMissing ? [200, 204, 404] : [200, 204],
    });
    const removedPrefix = String(remotePath || "").replace(/^\/+|\/+$/gu, "");
    if (removedPrefix) {
      for (const path of confirmedCollections) {
        if (path === `${removedPrefix}/` || path.startsWith(`${removedPrefix}/`)) confirmedCollections.delete(path);
      }
    }
    return response;
  };
  const move = async (sourcePath, destinationPath, { overwrite = false, ifMatch = "", destinationEtag = "" } = {}) => request(sourcePath, {
    method: "MOVE",
    headers: { Destination: urlFor(destinationPath), Overwrite: overwrite ? "T" : "F", ...(ifMatch ? { "If-Match": `"${ifMatch}"` } : {}), ...(destinationEtag ? { If: `<${urlFor(destinationPath)}> ([\"${destinationEtag}\"])` } : {}) },
    expected: [201, 204],
  });
  const head = async (remotePath) => {
    const response = await request(remotePath, { method: "HEAD", expected: [200, 204, 404] });
    const exists = response.status !== 404;
    const declaredSize = response.headers.get("content-length");
    const headerEtag = (response.headers.get("etag") || "").replace(/^W\//, "").replace(/^"|"$/g, "");
    const acceptRanges = response.headers.get("accept-ranges") || "";
    // Nutstore can answer HEAD 200 while omitting both Content-Length and
    // ETag. Treat those values as unknown instead of a zero-byte file and use
    // a read-only Depth:0 PROPFIND to obtain authoritative metadata.
    if (exists && (declaredSize === null || !headerEtag)) {
      try {
        const [metadata] = await propfind(remotePath, 0);
        if (metadata && !metadata.collection) {
          return {
            exists: true,
            size: Number(metadata.size || 0),
            etag: metadata.etag || headerEtag,
            acceptRanges,
          };
        }
      } catch (error) {
        if (!["WEBDAV_HTTP_404", "WEBDAV_HTTP_405"].includes(error?.code)) throw error;
      }
    }
    return { exists, size: Number(declaredSize || 0), etag: headerEtag, acceptRanges };
  };

  return { endpoint: officialEndpoint, options, propfind, mkcol, ensureCollections, getBuffer, downloadToFile, putBuffer, putFile, remove, move, head, urlFor };
};

export const replaceDownloadedFile = async (temporaryPath, targetPath) => {
  await mkdir(dirname(targetPath), { recursive: true });
  await rename(temporaryPath, targetPath).catch(async (error) => {
    if (process.platform !== "win32") throw error;
    const backup = `${targetPath}.sync-previous`;
    await rm(backup, { force: true }).catch(() => {});
    await rename(targetPath, backup).catch((moveError) => { if (moveError?.code !== "ENOENT") throw moveError; });
    try { await rename(temporaryPath, targetPath); }
    catch (moveError) { await rename(backup, targetPath).catch(() => {}); throw moveError; }
    await rm(backup, { force: true }).catch(() => {});
  });
};
