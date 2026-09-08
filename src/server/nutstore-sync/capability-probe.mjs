import { randomUUID } from "node:crypto";
import { NUTSTORE_PROTOCOL_VERSION } from "./contracts.mjs";

const isConditionalRejection = (error) => ["WEBDAV_HTTP_409", "WEBDAV_HTTP_412"].includes(error?.code);

const addReason = (result, reason) => {
  if (reason && !result.reasons.includes(reason)) result.reasons.push(reason);
};

export const probeWebDavCapabilities = async ({ client, remoteRoot = "/神思同步/" } = {}) => {
  if (!client) throw new Error("WebDAV client is required");
  const id = randomUUID();
  const root = `${String(remoteRoot).replace(/^\/+|\/+$/g, "")}/.shensi-sync/probe-${id}`;
  const source = `${root}/source.txt`;
  const moved = `${root}/moved.txt`;
  const payload = Buffer.from(`shensi-probe:${NUTSTORE_PROTOCOL_VERSION}:${id}`, "utf8");
  const result = { https: true, options: false, propfind: false, mkcol: false, get: false, put: false, delete: false, move: false, conditionalMove: false, etag: false, ifMatch: false, ifNoneMatch: false, range: false, retryAfter: true, cleanup: false, capabilityLevel: "unsupported", reasons: [] };
  let ifNoneMatchRejected = false;
  try {
    await client.options(); result.options = true;
    await client.ensureCollections(root); result.mkcol = true;
    let put;
    try {
      put = await client.putBuffer(source, payload, { contentType: "text/plain", ifNoneMatch: true });
      result.ifNoneMatch = true;
    } catch (error) {
      if (!isConditionalRejection(error)) throw error;
      ifNoneMatchRejected = true;
      addReason(result, "服务端拒绝 If-None-Match 条件写；随机探测文件已在确认不存在后改用普通写入");
      const existing = await client.head(source);
      if (existing.exists) throw Object.assign(new Error("随机能力探测文件意外存在，已停止兼容写入"), { code: "WEBDAV_PROBE_COLLISION" });
      put = await client.putBuffer(source, payload, { contentType: "text/plain" });
    }
    result.put = true; result.etag = Boolean(put.etag);
    const listing = await client.propfind(root, 1); result.propfind = Array.isArray(listing);
    const read = await client.getBuffer(source); result.get = read.buffer.equals(payload); result.etag ||= Boolean(read.etag);
    if (read.etag) {
      try {
        await client.putBuffer(source, payload, { contentType: "text/plain", ifMatch: read.etag });
        result.ifMatch = true;
      } catch (error) {
        if (!isConditionalRejection(error)) throw error;
        addReason(result, "服务端拒绝 If-Match 条件更新");
      }
    } else addReason(result, "服务端未返回可用于冲突保护的稳定 ETag");
    let destination;
    try {
      destination = await client.putBuffer(moved, Buffer.from("destination", "utf8"), { contentType: "text/plain", ifNoneMatch: true });
      result.ifNoneMatch = true;
    } catch (error) {
      if (!isConditionalRejection(error)) throw error;
      ifNoneMatchRejected = true;
      addReason(result, "服务端拒绝 If-None-Match 条件写；随机探测文件已在确认不存在后改用普通写入");
      const existing = await client.head(moved);
      if (existing.exists) throw Object.assign(new Error("随机移动目标意外存在，已停止兼容写入"), { code: "WEBDAV_PROBE_COLLISION" });
      destination = await client.putBuffer(moved, Buffer.from("destination", "utf8"), { contentType: "text/plain" });
    }
    result.ifNoneMatch = result.ifNoneMatch && !ifNoneMatchRejected;
    if (destination.etag) {
      try {
        await client.move(source, moved, { overwrite: true, destinationEtag: destination.etag });
        result.move = true; result.conditionalMove = true;
      } catch (error) {
        if (!isConditionalRejection(error)) throw error;
        addReason(result, "服务端拒绝带目标 ETag 的安全移动");
        // Nutstore may reject every MOVE whose destination already exists,
        // even with Overwrite: T. The random probe destination belongs only to
        // this probe, so remove it and verify MOVE-to-absent instead. This is a
        // supported manual-sync capability, not a failed connection.
        await client.remove(moved, { allowMissing: false });
        await client.move(source, moved, { overwrite: false }); result.move = true;
      }
    } else {
      addReason(result, "移动目标未返回可用于安全替换的 ETag");
      await client.remove(moved, { allowMissing: false });
      await client.move(source, moved, { overwrite: false }); result.move = true;
    }
    const head = await client.head(moved); result.range = /bytes/i.test(head.acceptRanges);
    await client.remove(moved, { allowMissing: false }); result.delete = true;
    result.capabilityLevel = result.propfind && result.get && result.put && result.delete && result.move && result.conditionalMove && result.etag && result.ifMatch && result.ifNoneMatch ? "safe_auto"
      : result.propfind && result.get && result.put && result.delete ? "safe_manual" : "unsupported";
    if (result.capabilityLevel === "safe_manual") addReason(result, "服务端条件写、稳定 ETag 或安全 MOVE 能力不足，只允许手动同步");
    if (result.capabilityLevel === "unsupported") addReason(result, "服务端目录读取、读写或删除能力不足");
  } finally {
    await client.remove(root, { allowMissing: true }).then(() => { result.cleanup = true; }).catch(() => { addReason(result, "临时能力探测目录未能自动清理"); });
  }
  return result;
};
