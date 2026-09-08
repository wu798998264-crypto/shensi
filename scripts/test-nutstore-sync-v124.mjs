import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NUTSTORE_DEFAULT_ENDPOINT,
  normalizeLogicalPath,
  normalizeNutstoreEndpoint,
  publicSyncError,
} from "../src/server/nutstore-sync/contracts.mjs";
import { createWebDavClient, parseWebDavMultiStatus } from "../src/server/nutstore-sync/webdav-client.mjs";
import { probeWebDavCapabilities } from "../src/server/nutstore-sync/capability-probe.mjs";
import { createNutstoreRemoteRepository } from "../src/server/nutstore-sync/remote-repository.mjs";
import { createNutstoreSyncEngine } from "../src/server/nutstore-sync/sync-engine.mjs";
import { enqueueOutboxOperation } from "../src/server/nutstore-sync/outbox.mjs";

assert.equal(normalizeNutstoreEndpoint(), NUTSTORE_DEFAULT_ENDPOINT);
assert.equal(normalizeLogicalPath("作品/幻烬/第一章.md"), "作品/幻烬/第一章.md");
assert.throws(() => normalizeNutstoreEndpoint("http://dav.jianguoyun.com/dav/"), /HTTPS/u);
assert.throws(() => normalizeNutstoreEndpoint("https://example.com/dav/"), /官方/u);
assert.throws(() => normalizeLogicalPath("../用户数据"), /穿越/u);
assert.doesNotMatch(publicSyncError(new Error("authorization=secret-value")).message, /secret-value/u);

const calls = [];
const client = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response(null, { status: 204, headers: { dav: "1,2", allow: "OPTIONS, PROPFIND" } });
  },
});
const capability = await client.options();
assert.equal(capability.dav, "1,2");
assert.match(calls[0].options.headers.Authorization, /^Basic /u);
assert.equal(calls[0].url.startsWith(NUTSTORE_DEFAULT_ENDPOINT), true);

let transientOptionsCalls = 0;
const transientOptionsClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async () => {
    transientOptionsCalls += 1;
    if (transientOptionsCalls === 1) throw new TypeError("fetch failed");
    return new Response(null, { status: 204, headers: { dav: "1,2" } });
  },
});
assert.equal((await transientOptionsClient.options()).dav, "1,2", "只读连接探针遇到瞬时网络错误必须安全重试");
assert.equal(transientOptionsCalls, 2);

let existingCollectionProbeCalls = 0;
const existingCollectionUrls = [];
const existingCollectionClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (url, options) => {
    existingCollectionUrls.push({ url, method: options.method });
    if (options.method === "MKCOL") return new Response(null, { status: 409 });
    if (options.method === "PROPFIND") {
      existingCollectionProbeCalls += 1;
      return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/existing/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    }
    return new Response(null, { status: 204 });
  },
});
await existingCollectionClient.ensureCollections("existing/path");
assert.equal(existingCollectionProbeCalls, 2, "HTTP 409 for existing collections must be verified with read-only PROPFIND");
await existingCollectionClient.ensureCollections("existing/path");
assert.equal(existingCollectionProbeCalls, 2, "同一 WebDAV 会话内已确认的目录不得重复探测");
assert.equal(existingCollectionUrls.filter((item) => ["MKCOL", "PROPFIND"].includes(item.method)).every((item) => new URL(item.url).pathname.endsWith("/")), true, "WebDAV collection requests must preserve the trailing slash required by Nutstore");
assert.equal(decodeURIComponent(new URL(existingCollectionClient.urlFor("神思同步/")).pathname).endsWith("/dav/神思同步/"), true, "Unicode remote collection URLs must preserve both encoding and collection semantics");

let createdCollectionVisible = false;
let createdCollectionLength = "";
const createdCollectionClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => {
    if (options.method === "MKCOL") {
      createdCollectionLength = options.headers["Content-Length"];
      createdCollectionVisible = true;
      return new Response(null, { status: 201 });
    }
    if (options.method === "PROPFIND" && createdCollectionVisible) {
      return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/new/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    }
    return new Response(null, { status: 404 });
  },
});
await createdCollectionClient.ensureCollections("new");
assert.equal(createdCollectionLength, "0", "MKCOL must explicitly declare a zero-length body for Nutstore-compatible gateways");

let delayedCreationAccepted = false;
let delayedVisibilityProbes = 0;
const delayedVisibleCollectionClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => {
    if (options.method === "MKCOL") { delayedCreationAccepted = true; return new Response(null, { status: 201 }); }
    if (options.method === "PROPFIND" && delayedCreationAccepted) {
      delayedVisibilityProbes += 1;
      if (delayedVisibilityProbes >= 3) {
        return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/delayed/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
      }
    }
    return new Response(null, { status: 404 });
  },
});
await delayedVisibleCollectionClient.ensureCollections("delayed");
assert.equal(delayedVisibilityProbes >= 3, true, "an accepted MKCOL must be confirmed visible before child creation can continue");

let methodNotAllowedVisible = false;
const methodNotAllowedCollectionClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => {
    if (options.method === "MKCOL") { methodNotAllowedVisible = true; return new Response(null, { status: 405 }); }
    if (options.method === "PROPFIND" && methodNotAllowedVisible) {
      return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/existing-405/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    }
    return new Response(null, { status: 404 });
  },
});
await methodNotAllowedCollectionClient.ensureCollections("existing-405");

const missingParentClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => options.method === "MKCOL"
    ? new Response(null, { status: 409 })
    : new Response(null, { status: 404 }),
});
await assert.rejects(missingParentClient.ensureCollections("missing/path"), (error) => error?.code === "WEBDAV_COLLECTION_CREATE_CONFLICT", "a missing root directory must remain a typed directory failure");

const operationTaggedClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => new Response(null, { status: options.method === "PROPFIND" ? 404 : 409 }),
});
await assert.rejects(operationTaggedClient.mkcol("conflict"), (error) => error?.code === "WEBDAV_COLLECTION_CREATE_CONFLICT" && error?.operation === "MKCOL", "safe WebDAV failures must retain the protocol operation without exposing request URLs");

const nestedMissingParentClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: (() => {
    let baseCreated = false;
    return async (url, options) => {
      const pathname = decodeURIComponent(new URL(url).pathname);
      if (options.method === "MKCOL" && pathname.endsWith("/base/")) { baseCreated = true; return new Response(null, { status: 201 }); }
      if (options.method === "MKCOL") return new Response(null, { status: 409 });
      if (options.method === "PROPFIND" && pathname.endsWith("/base/") && baseCreated) {
        return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/base/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
      }
      return new Response(null, { status: 404 });
    };
  })(),
});
await assert.rejects(nestedMissingParentClient.ensureCollections("base/missing"), (error) => error?.code === "WEBDAV_PARENT_COLLECTION_MISSING", "a missing nested parent must remain a typed parent-directory failure");

let transientCollectionProbeCalls = 0;
const transientCollectionClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => {
    if (options.method === "MKCOL") return new Response(null, { status: 409 });
    if (options.method === "PROPFIND") {
      transientCollectionProbeCalls += 1;
      if (transientCollectionProbeCalls === 1) return new Response(null, { status: 404 });
      return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/race/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    }
    return new Response(null, { status: 204 });
  },
});
await transientCollectionClient.ensureCollections("race");
assert.equal(transientCollectionProbeCalls, 2, "a transiently missing collection must be rechecked before failing");

let propagatedChildMkcolCalls = 0;
const propagatedParentClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (url, options) => {
    const pathname = decodeURIComponent(new URL(url).pathname);
    if (options.method === "MKCOL" && pathname.endsWith("/base/")) return new Response(null, { status: 201 });
    if (options.method === "MKCOL" && pathname.endsWith("/base/child/")) {
      propagatedChildMkcolCalls += 1;
      return new Response(null, { status: propagatedChildMkcolCalls === 1 ? 409 : 201 });
    }
    if (options.method === "PROPFIND" && pathname.endsWith("/base/child/") && propagatedChildMkcolCalls >= 2) {
      return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/base/child/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    }
    if (options.method === "PROPFIND" && pathname.endsWith("/base/child/")) return new Response(null, { status: 404 });
    if (options.method === "PROPFIND" && pathname.endsWith("/base/")) {
      return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/base/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    }
    return new Response(null, { status: 404 });
  },
});
await propagatedParentClient.ensureCollections("base/child");
assert.equal(propagatedChildMkcolCalls, 2, "a 409 caused by parent propagation must reissue MKCOL after the parent becomes visible");

const nonCollectionClient = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => {
    if (options.method === "MKCOL") return new Response(null, { status: 409 });
    if (options.method === "PROPFIND") return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/file/</d:href><d:propstat><d:prop><d:getcontenttype>text/plain</d:getcontenttype></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    return new Response(null, { status: 204 });
  },
});
await assert.rejects(nonCollectionClient.ensureCollections("file"), (error) => error?.code === "WEBDAV_REMOTE_PATH_NOT_COLLECTION", "a conflicting file path must not be treated as an existing collection");

const unauthorized = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "wrong",
  fetchImpl: async () => new Response(null, { status: 401 }),
});
await assert.rejects(unauthorized.options(), (error) => error?.code === "WAITING_CREDENTIALS");

const forbidden = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async () => new Response(null, { status: 403 }),
});
await assert.rejects(forbidden.options(), (error) => error?.code === "WEBDAV_FORBIDDEN");

const expired = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async () => new Response("<?xml version=\"1.0\"?><d:error xmlns:d=\"DAV:\" xmlns:s=\"http://ns.jianguoyun.com\"><s:exception>AccountExpired</s:exception><s:message>account expired</s:message></d:error>", { status: 403 }),
});
await assert.rejects(expired.options(), (error) => error?.code === "NUTSTORE_ACCOUNT_EXPIRED" && !/user@example\.com/u.test(error.message));

const headMetadataFallback = createWebDavClient({
  endpoint: NUTSTORE_DEFAULT_ENDPOINT,
  account: "user@example.com",
  password: "application-password",
  fetchImpl: async (_url, options) => {
    if (options.method === "HEAD") return new Response(null, { status: 200 });
    if (options.method === "PROPFIND") {
      return new Response("<?xml version=\"1.0\"?><d:multistatus xmlns:d=\"DAV:\"><d:response><d:href>/dav/file.bin</d:href><d:propstat><d:prop><d:getetag>\"head-fallback-etag\"</d:getetag><d:getcontentlength>77</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>", { status: 207 });
    }
    return new Response(null, { status: 500 });
  },
});
assert.deepEqual(await headMetadataFallback.head("file.bin"), {
  exists: true,
  size: 77,
  etag: "head-fallback-etag",
  acceptRanges: "",
}, "HEAD 缺少文件元数据时必须使用只读 PROPFIND 补齐，不能误判为零字节");

const conditionalError = (status = 412) => Object.assign(new Error(`HTTP ${status}`), { code: `WEBDAV_HTTP_${status}`, status });
const capabilityClient = ({ rejectIfNoneMatch = false, rejectIfMatch = false, rejectConditionalMove = false, rejectOverwriteMove = false } = {}) => {
  const files = new Map();
  let etag = 0;
  const store = (path, buffer) => {
    const value = Buffer.from(buffer);
    const record = { buffer: value, etag: `etag-${++etag}`, size: value.length };
    files.set(path, record);
    return { etag: record.etag };
  };
  return {
    options: async () => ({ dav: "1,2", allow: "OPTIONS, PROPFIND, GET, PUT, DELETE, MOVE" }),
    ensureCollections: async (path) => { calls.push({ method: "ENSURE_COLLECTIONS", path }); },
    putBuffer: async (path, buffer, options = {}) => {
      if (options.ifNoneMatch && rejectIfNoneMatch) throw conditionalError();
      if (options.ifMatch && rejectIfMatch) throw conditionalError();
      return store(path, buffer);
    },
    propfind: async () => [],
    getBuffer: async (path) => {
      const record = files.get(path);
      if (!record) throw Object.assign(new Error("missing"), { code: "WEBDAV_HTTP_404" });
      return { buffer: record.buffer, etag: record.etag };
    },
    move: async (source, destination, options = {}) => {
      if (options.destinationEtag && rejectConditionalMove) throw conditionalError();
      if (options.overwrite && files.has(destination) && rejectOverwriteMove) throw conditionalError(409);
      const record = files.get(source);
      if (!record) throw Object.assign(new Error("missing"), { code: "WEBDAV_HTTP_404" });
      files.set(destination, record); files.delete(source);
    },
    head: async (path) => {
      const record = files.get(path);
      return record ? { exists: true, size: record.size, etag: record.etag, acceptRanges: "bytes" } : { exists: false, size: 0, etag: "", acceptRanges: "bytes" };
    },
    remove: async (path) => {
      for (const key of [...files.keys()]) if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    },
  };
};

const safeAutoProbe = await probeWebDavCapabilities({ client: capabilityClient() });
assert.equal(safeAutoProbe.capabilityLevel, "safe_auto");
assert.equal(safeAutoProbe.cleanup, true);

const ifNoneFallbackProbe = await probeWebDavCapabilities({ client: capabilityClient({ rejectIfNoneMatch: true }) });
assert.equal(ifNoneFallbackProbe.capabilityLevel, "safe_manual", "HTTP 412 for If-None-Match must downgrade instead of failing authentication");
assert.equal(ifNoneFallbackProbe.put && ifNoneFallbackProbe.get && ifNoneFallbackProbe.delete, true);
assert.equal(ifNoneFallbackProbe.ifNoneMatch, false);
assert.match(ifNoneFallbackProbe.reasons.join("\n"), /If-None-Match/u);

const ifMatchFallbackProbe = await probeWebDavCapabilities({ client: capabilityClient({ rejectIfMatch: true }) });
assert.equal(ifMatchFallbackProbe.capabilityLevel, "safe_manual");
assert.equal(ifMatchFallbackProbe.ifMatch, false);

const moveFallbackProbe = await probeWebDavCapabilities({ client: capabilityClient({ rejectConditionalMove: true }) });
assert.equal(moveFallbackProbe.capabilityLevel, "safe_manual");
assert.equal(moveFallbackProbe.move, true);
assert.equal(moveFallbackProbe.conditionalMove, false);

const noOverwriteMoveProbe = await probeWebDavCapabilities({ client: capabilityClient({ rejectConditionalMove: true, rejectOverwriteMove: true }) });
assert.equal(noOverwriteMoveProbe.capabilityLevel, "safe_manual", "拒绝覆盖已有目标的 MOVE 仍应通过移动到空目标的安全手动能力检查");
assert.equal(noOverwriteMoveProbe.move, true);
assert.equal(noOverwriteMoveProbe.conditionalMove, false);

const repositoryClient = ({ initialTarget = null, rejectStagingCondition = false } = {}) => {
  const files = new Map();
  const calls = [];
  let etag = 0;
  const put = (path, buffer) => {
    const value = Buffer.from(buffer);
    const record = { buffer: value, size: value.length, etag: `repo-${++etag}` };
    files.set(path, record);
    return { etag: record.etag };
  };
  const clientValue = {
    calls, files,
    ensureCollections: async () => {},
    head: async (path) => {
      const record = files.get(path);
      return record ? { exists: true, size: record.size, etag: record.etag, acceptRanges: "bytes" } : { exists: false, size: 0, etag: "", acceptRanges: "bytes" };
    },
    putFile: async (path, sourcePath, options = {}) => {
      calls.push({ method: "PUT_FILE", path, options });
      if (options.ifNoneMatch && rejectStagingCondition) throw conditionalError();
      return put(path, Buffer.from("hello"));
    },
    putBuffer: async (path, buffer, options = {}) => { calls.push({ method: "PUT_BUFFER", path, options }); return put(path, buffer); },
    move: async (source, destination, options = {}) => {
      calls.push({ method: "MOVE", source, destination, options });
      if (!options.overwrite && files.has(destination)) throw conditionalError();
      const record = files.get(source); files.set(destination, record); files.delete(source);
    },
    remove: async (path) => { calls.push({ method: "DELETE", path }); files.delete(path); },
    propfind: async () => [],
    getBuffer: async (path) => ({ buffer: files.get(path)?.buffer || Buffer.alloc(0), etag: files.get(path)?.etag || "" }),
  };
  if (initialTarget) put(initialTarget.path, initialTarget.buffer);
  return clientValue;
};

const manualCapability = { capabilityLevel: "safe_manual", ifNoneMatch: true, ifMatch: true, conditionalMove: false };
const initializationClient = repositoryClient();
let initializationEnsureCalls = 0;
initializationClient.ensureCollections = async () => { initializationEnsureCalls += 1; };
const initializationRepository = createNutstoreRemoteRepository({ client: initializationClient, remoteRoot: "/神思同步/", deviceId: "device-init", capability: manualCapability });
await Promise.all([initializationRepository.initialize(), initializationRepository.initialize()]);
await initializationRepository.inventory();
assert.equal(initializationEnsureCalls, 8, "同一远端仓库实例只能初始化目录结构一次");

const stagingClient = repositoryClient({ rejectStagingCondition: true });
const stagingRepository = createNutstoreRemoteRepository({ client: stagingClient, remoteRoot: "/神思同步/", deviceId: "device-test", capability: manualCapability });
const uploaded = await stagingRepository.upload({ entry: { logicalPath: "作品/测试.md", sourcePath: "unused", hash: "hash", size: 5, contentType: "text/markdown" }, expectedRemoteExists: false });
assert.equal(uploaded.size, 5);
assert.equal(stagingClient.calls.filter((item) => item.method === "PUT_FILE").length, 2, "safe_manual staging must retry without conditions only after absence was checked");
assert.equal(stagingClient.calls.find((item) => item.method === "MOVE")?.options.overwrite, false, "new remote files must never use overwrite mode");

const changedClient = repositoryClient();
const changedRepository = createNutstoreRemoteRepository({ client: changedClient, remoteRoot: "/神思同步/", deviceId: "device-test", capability: manualCapability });
changedClient.files.set(changedRepository.dataPath("作品/冲突.md"), { buffer: Buffer.from("remote"), size: 6, etag: "late-etag" });
await assert.rejects(changedRepository.upload({ entry: { logicalPath: "作品/冲突.md", sourcePath: "unused", hash: "local", size: 5, contentType: "text/markdown" }, expectedRemoteExists: false }), (error) => error?.code === "REMOTE_CHANGED_DURING_SYNC");
assert.equal(changedClient.files.get(changedRepository.dataPath("作品/冲突.md")).buffer.toString("utf8"), "remote", "late remote content must not be overwritten");

const existingClient = repositoryClient();
const existingRepository = createNutstoreRemoteRepository({ client: existingClient, remoteRoot: "/神思同步/", deviceId: "device-test", capability: manualCapability });
const existingPath = existingRepository.dataPath("作品/已有.md");
existingClient.files.set(existingPath, { buffer: Buffer.from("remote"), size: 6, etag: "stable-etag" });
await existingRepository.upload({ entry: { logicalPath: "作品/已有.md", sourcePath: "unused", hash: "local", size: 5, contentType: "text/markdown" }, expectedRemoteEtag: "stable-etag", expectedRemoteExists: true });
assert.equal(existingClient.files.get(existingPath).buffer.toString("utf8"), "hello", "缺少条件 MOVE 时必须使用 If-Match 条件 PUT 安全更新已有远程文件");
assert.equal(existingClient.calls.find((item) => item.method === "PUT_FILE" && item.path === existingPath)?.options.ifMatch, "stable-etag");

const noIfMatchClient = repositoryClient();
const originalNoIfMatchMove = noIfMatchClient.move;
noIfMatchClient.move = async (source, destination, options = {}) => {
  if (options.ifMatch) throw conditionalError();
  return originalNoIfMatchMove(source, destination, options);
};
const noIfMatchRepository = createNutstoreRemoteRepository({
  client: noIfMatchClient,
  remoteRoot: "/神思同步/",
  deviceId: "device-manual-confirmed",
  capability: { ...manualCapability, ifMatch: false },
});
const noIfMatchPath = noIfMatchRepository.dataPath("作品/手动确认覆盖.md");
noIfMatchClient.files.set(noIfMatchPath, { buffer: Buffer.from("remote"), size: 6, etag: "manual-etag" });
await noIfMatchRepository.upload({
  entry: { logicalPath: "作品/手动确认覆盖.md", sourcePath: "unused", hash: "local", size: 5, contentType: "text/markdown" },
  expectedRemoteEtag: "manual-etag",
  expectedRemoteExists: true,
  manualOverwriteConfirmed: true,
});
assert.equal(noIfMatchClient.files.get(noIfMatchPath).buffer.toString("utf8"), "hello", "明确选择使用本地后，safe_manual 服务必须能够通过备份替换完成覆盖");
assert.equal(noIfMatchClient.calls.find((item) => item.method === "MOVE" && item.source === noIfMatchPath)?.options.ifMatch, "", "服务端已拒绝 If-Match 时不得在手动备份移动中重复发送该条件头");

const temporaryRoot = await mkdtemp(join(tmpdir(), "shensi-nutstore-safe-manual-"));
try {
const engine = createNutstoreSyncEngine({
    dataRoot: join(temporaryRoot, "data"), machineRoot: join(temporaryRoot, "machine"), desktopRuntime: true,
    clientFactory: () => ({}), repositoryFactory: async () => ({}),
    capabilityProbe: async () => ({ capabilityLevel: "safe_manual", propfind: true, get: true, put: true, delete: true, move: true, conditionalMove: false, etag: true, ifMatch: true, ifNoneMatch: false, cleanup: true, reasons: ["manual only"] }),
  });
  await engine.configure({ account: "user@example.com", password: "application-password", autoSync: true });
  const manualStatus = await engine.status();
  assert.equal(manualStatus.capabilityLevel, "safe_manual");
  assert.equal(manualStatus.autoSync, false, "safe_manual must never enable background automatic synchronization");
} finally { await rm(temporaryRoot, { recursive: true, force: true }); }

const retryRoot = await mkdtemp(join(tmpdir(), "shensi-nutstore-transient-retry-"));
try {
  const retryDataRoot = join(retryRoot, "data");
  await mkdir(join(retryDataRoot, "作品"), { recursive: true });
  await writeFile(join(retryDataRoot, "作品", "瞬时繁忙续接.md"), "真实同步内容", "utf8");
  let initializationCalls = 0;
  let uploadCalls = 0;
  const transientEngine = createNutstoreSyncEngine({
    dataRoot: retryDataRoot,
    machineRoot: join(retryRoot, "machine"),
    desktopRuntime: true,
    clientFactory: () => ({}),
    capabilityProbe: async () => ({ capabilityLevel: "safe_manual", propfind: true, get: true, put: true, delete: true, move: true, conditionalMove: false, etag: true, ifMatch: true, ifNoneMatch: true, cleanup: true, reasons: [] }),
    repositoryFactory: async () => ({
      initialize: async () => {
        initializationCalls += 1;
        if (initializationCalls === 2) throw Object.assign(new Error("服务暂时繁忙"), { code: "RETRY_WAIT", status: 503, retryAfterMs: 1 });
      },
      inventory: async () => [],
      upload: async ({ entry }) => {
        uploadCalls += 1;
        return { ...entry, etag: "transient-retry-etag" };
      },
    }),
  });
  await transientEngine.configure({ account: "user@example.com", password: "application-password" });
  const transientPreview = await transientEngine.firstSyncPreview();
  const transientResult = await transientEngine.enable({ previewToken: transientPreview.previewToken });
  assert.equal(transientResult.ok, true, "服务端明确拒绝的瞬时 503 必须在重新扫描后自动续接");
  assert.equal(initializationCalls, 3, "续接必须建立新仓库并重新扫描，不能盲目重放失败写请求");
  assert.equal(uploadCalls, 1, "自动续接最终只能完成一次有效上传");
} finally { await rm(retryRoot, { recursive: true, force: true }); }

const connectionReuseRoot = await mkdtemp(join(tmpdir(), "shensi-nutstore-connection-reuse-"));
try {
  let clientInstances = 0;
  let repositoryInstances = 0;
  const reuseEngine = createNutstoreSyncEngine({
    dataRoot: join(connectionReuseRoot, "data"),
    machineRoot: join(connectionReuseRoot, "machine"),
    desktopRuntime: true,
    clientFactory: () => ({ instance: ++clientInstances }),
    repositoryFactory: async () => ({
      instance: ++repositoryInstances,
      initialize: async () => {},
      inventory: async () => [],
    }),
    capabilityProbe: async () => ({ capabilityLevel: "safe_manual", propfind: true, get: true, put: true, delete: true, move: true, conditionalMove: false, etag: true, ifMatch: true, ifNoneMatch: true, cleanup: true, reasons: [] }),
  });
  await reuseEngine.configure({ account: "user@example.com", password: "application-password" });
  await reuseEngine.firstSyncPreview();
  assert.equal(clientInstances, 2, "配置写入能力后只应重建一次会话，首次预览必须复用该会话");
  assert.equal(repositoryInstances, 2);
  await reuseEngine.firstSyncPreview();
  assert.equal(clientInstances, 2, "同一会话后续预览不得重复创建 WebDAV 客户端");
} finally { await rm(connectionReuseRoot, { recursive: true, force: true }); }

const lateRemoteChangeRoot = await mkdtemp(join(tmpdir(), "shensi-nutstore-late-remote-change-"));
try {
  const lateDataRoot = join(lateRemoteChangeRoot, "data");
  const latePath = join(lateDataRoot, "作品", "扫描后变化.md");
  await mkdir(join(lateDataRoot, "作品"), { recursive: true });
  await writeFile(latePath, "共同基线", "utf8");
  let remoteEntry = null;
  let uploadCalls = 0;
  const lateChangeEngine = createNutstoreSyncEngine({
    dataRoot: lateDataRoot,
    machineRoot: join(lateRemoteChangeRoot, "machine"),
    desktopRuntime: true,
    clientFactory: () => ({}),
    capabilityProbe: async () => ({ capabilityLevel: "safe_manual", propfind: true, get: true, put: true, delete: true, move: true, conditionalMove: false, etag: true, ifMatch: true, ifNoneMatch: true, cleanup: true, reasons: [] }),
    repositoryFactory: async () => ({
      initialize: async () => {},
      inventory: async () => remoteEntry ? [{ ...remoteEntry }] : [],
      upload: async ({ entry }) => {
        uploadCalls += 1;
        if (uploadCalls > 1) throw Object.assign(new Error("远端在扫描后变化"), { code: "REMOTE_CHANGED_DURING_SYNC" });
        remoteEntry = { ...entry, sourcePath: undefined, etag: "baseline-etag" };
        return remoteEntry;
      },
    }),
  });
  await lateChangeEngine.configure({ account: "user@example.com", password: "application-password" });
  const preview = await lateChangeEngine.firstSyncPreview();
  await lateChangeEngine.enable({ previewToken: preview.previewToken });
  await writeFile(latePath, "本地已修改，需要在提交时识别远端变化", "utf8");
  await lateChangeEngine.noteLocalChange("作品/扫描后变化.md");
  const result = await lateChangeEngine.run({ reason: "late_remote_change" });
  assert.equal(result.summary.upload, 0, "提交时转成冲突后不得继续汇报为上传成功");
  assert.equal(result.summary.conflict, 1, "扫描后远端变化必须按实际执行结果汇报冲突");
  assert.equal((await lateChangeEngine.conflicts()).length, 1, "扫描后远端变化必须进入冲突中心");
} finally { await rm(lateRemoteChangeRoot, { recursive: true, force: true }); }

const xml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/神思同步/</d:href><d:propstat><d:prop><d:getetag>"abc"</d:getetag><d:getcontentlength>12</d:getcontentlength><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>`;
assert.equal(parseWebDavMultiStatus(xml)[0].collection, true);
assert.throws(() => parseWebDavMultiStatus("<!DOCTYPE x [<!ENTITY y SYSTEM 'file:///x'>]><x>&y;</x>"), /实体声明/u);

const outboxState = { localCursor: 1, outbox: [] };
const firstScan = enqueueOutboxOperation(outboxState, { logicalPath: "*", action: "scan" });
outboxState.localCursor += 1;
const coalescedScan = enqueueOutboxOperation(outboxState, { logicalPath: "*", action: "scan" });
assert.equal(coalescedScan.id, firstScan.id, "repeated full scans must be coalesced");
assert.equal(outboxState.outbox.length, 1, "a save storm must not grow the full-scan queue");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /enableButton\.disabled = status\.desktopRuntime === false \|\| ui\.nutstoreSync\.loading/u);
assert.match(appSource, /await previewNutstoreFirstSync\(\);\s*if \(!ui\.nutstoreSync\.preview\?\.previewToken\) return;/u);
assert.doesNotMatch(appSource, /nutstoreOfficialLogin/u, "unavailable official SSO placeholder must not remain in the UI");
assert.doesNotMatch(appSource, /nutstore-official-auth/u, "unavailable official SSO placeholder panel must not remain in the UI");
assert.match(appSource, /<details class="nutstore-manual-webdav" id="nutstoreManualWebdav">[\s\S]{0,2000}id="nutstoreAccount"/u, "manual WebDAV credentials must be inside a collapsed fallback section");
assert.doesNotMatch(appSource, /<details class="nutstore-manual-webdav"[^>]*\sopen(?:\s|>)/u, "manual WebDAV credential fields must not be visible by default");
assert.match(appSource, /第三方应用密码/u);
assert.match(appSource, /class="nutstore-app-password-guide"/u, "app password help must be expandable beside the credential field");
assert.match(appSource, /如何获取第三方应用密码？/u);
assert.match(appSource, /账户信息[\s\S]{0,200}安全选项[\s\S]{0,200}第三方应用管理[\s\S]{0,200}添加应用密码/u);
assert.match(appSource, /不是坚果云登录密码/u);
assert.match(appSource, /账号认证及基础读写已通过/u, "HTTP 412 compatibility mode must be presented as a successful basic connection");
assert.match(appSource, /已限制为仅手动同步，自动同步不会启用/u);
assert.match(appSource, /autoSyncInput\.disabled = manualOnly/u, "safe_manual must disable automatic synchronization in the UI");
assert.match(appSource, /NUTSTORE_ACCOUNT_EXPIRED[\s\S]{0,160}账号服务已到期/u, "expired accounts must not be mislabeled as bad credentials");
assert.doesNotMatch(appSource, /WEBDAV_HTTP_409"\s*\|\|\s*\/409\//u, "HTTP 409 must not be mapped from arbitrary error text");
assert.match(appSource, /const payload = await nutstoreRequest\("\/api\/sync\/nutstore\/first-sync-preview"[\s\S]{0,500}await bridge\.storeNutstore/u, "secure credential replacement must happen only after a successful preview");
assert.doesNotMatch(appSource, /storeNutstore[\s\S]{0,300}\/api\/sync\/nutstore\/configure/u, "invalid credentials must not overwrite the saved secure credential before validation");

console.log("Nutstore v1.2.4 login, WebDAV, credential-error and UI contracts passed");
