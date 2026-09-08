import { createHash, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { NUTSTORE_PROTOCOL_VERSION, createTransactionId, normalizeLogicalPath, normalizeRemoteRoot } from "./contracts.mjs";
import { acknowledgeTombstone, createTombstone } from "./tombstones.mjs";
import { isAuthorLevelLogicalPath } from "./path-policy.mjs";

const trim = (value) => String(value || "").replace(/^\/+|\/+$/g, "");
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
const entryName = (logicalPath) => `${createHash("sha256").update(normalizeLogicalPath(logicalPath), "utf8").digest("hex")}.json`;
const isConditionalRejection = (error) => ["WEBDAV_HTTP_409", "WEBDAV_HTTP_412"].includes(error?.code);
const remoteChanged = (message) => Object.assign(new Error(message), { code: "REMOTE_CHANGED_DURING_SYNC" });

export const createNutstoreRemoteRepository = ({ client, remoteRoot, deviceId, capability = null }) => {
  const root = trim(normalizeRemoteRoot(remoteRoot));
  const hasCapabilityProbe = capability && typeof capability === "object";
  const manualMode = capability?.capabilityLevel === "safe_manual";
  const supportsIfNoneMatch = !hasCapabilityProbe || capability.ifNoneMatch === true;
  const supportsIfMatch = !hasCapabilityProbe || capability.ifMatch === true;
  const supportsConditionalMove = !hasCapabilityProbe || capability.conditionalMove === true;
  const at = (suffix = "") => `${root}${suffix ? `/${trim(suffix)}` : ""}`;
  const metaRoot = at(".shensi-sync");
  const entryRoot = `${metaRoot}/entries`;
  const tombstoneRoot = `${metaRoot}/tombstones`;
  const stagingRoot = `${metaRoot}/staging`;
  const deviceRoot = `${metaRoot}/devices`;
  const dataPath = (logicalPath) => {
    const normalized = normalizeLogicalPath(logicalPath);
    return at(`${isAuthorLevelLogicalPath(normalized) ? "author" : "workspaces"}/${normalized}`);
  };
  const metadataPath = (logicalPath) => `${entryRoot}/${entryName(logicalPath)}`;
  const tombstonePath = (logicalPath) => `${tombstoneRoot}/${entryName(logicalPath)}`;
  let initializationPromise = null;

  const putBufferIfAbsent = async (remotePath, buffer, options = {}) => {
    const existing = await client.head(remotePath);
    if (existing.exists) return { created: false, etag: existing.etag || "" };
    if (supportsIfNoneMatch) {
      try {
        return { created: true, ...(await client.putBuffer(remotePath, buffer, { ...options, ifNoneMatch: true })) };
      } catch (error) {
        if (!manualMode || !isConditionalRejection(error)) throw error;
      }
      const rechecked = await client.head(remotePath);
      if (rechecked.exists) throw remoteChanged("远程文件在兼容写入前已出现，已停止覆盖");
    }
    return { created: true, ...(await client.putBuffer(remotePath, buffer, options)) };
  };

  const putUniqueStagingFile = async (remotePath, sourcePath, options = {}) => {
    const existing = await client.head(remotePath);
    if (existing.exists) throw remoteChanged("随机上传暂存文件意外存在，已停止写入");
    if (supportsIfNoneMatch) {
      try { return await client.putFile(remotePath, sourcePath, { ...options, ifNoneMatch: true }); }
      catch (error) {
        if (!manualMode || !isConditionalRejection(error)) throw error;
      }
      const rechecked = await client.head(remotePath);
      if (rechecked.exists) throw remoteChanged("远程暂存文件在兼容写入前已出现，已停止覆盖");
    }
    return client.putFile(remotePath, sourcePath, options);
  };

  const assertRemoteSnapshot = ({ current, expectedRemoteEtag = "", expectedRemoteExists = null, manualOverwriteConfirmed = false }) => {
    if (expectedRemoteExists === false && current.exists) throw remoteChanged("远程目标在扫描后已被创建，需要重新比较");
    if (expectedRemoteExists === true && !current.exists) throw remoteChanged("远程目标在扫描后已被删除，需要重新比较");
    if (expectedRemoteEtag && current.exists && current.etag !== expectedRemoteEtag) throw remoteChanged("远程 ETag 在提交前已变化，需要重新比较");
    if (manualMode && expectedRemoteExists === true && !expectedRemoteEtag && !manualOverwriteConfirmed) throw remoteChanged("远程目标缺少稳定 ETag，不能安全覆盖，请在冲突中心确认");
  };

  const initialize = ({ deviceName = "Windows 电脑", platform = "windows" } = {}) => {
    if (!initializationPromise) {
      initializationPromise = (async () => {
        await client.ensureCollections(root);
        for (const directory of [metaRoot, entryRoot, tombstoneRoot, stagingRoot, deviceRoot, at("workspaces"), at("author")]) await client.ensureCollections(directory);
        const protocol = { schemaVersion: 1, protocolVersion: NUTSTORE_PROTOCOL_VERSION, kind: "shensi-nutstore-webdav", collaboration: "eventual-consistency", pathEncoding: "utf-8-nfc", createdAt: new Date().toISOString() };
        await putBufferIfAbsent(at("protocol.json"), json(protocol), { contentType: "application/json" });
        await client.putBuffer(`${deviceRoot}/${deviceId}.json`, json({ schemaVersion: 1, protocolVersion: NUTSTORE_PROTOCOL_VERSION, deviceId, deviceName, platform, lastSeenAt: new Date().toISOString() }), { contentType: "application/json" });
      })().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }
    return initializationPromise;
  };

  const listMetadataDirectory = async (directory) => {
    const listing = await client.propfind(directory, 1);
    const values = [];
    for (const item of listing) {
      if (item.collection || !/\.json(?:$|[?#])/i.test(item.href)) continue;
      const name = decodeURIComponent(String(item.href).split("/").filter(Boolean).pop() || "");
      if (!/^[a-f0-9]{64}\.json$/i.test(name)) continue;
      try {
        const read = await client.getBuffer(`${directory}/${name}`);
        values.push(JSON.parse(read.buffer.toString("utf8")));
      } catch (error) {
        if (error instanceof SyntaxError) {
          error.code = "REMOTE_METADATA_CORRUPT";
          throw error;
        }
        throw error;
      }
    }
    return values;
  };

  const inventory = async () => {
    await initialize();
    const [entries, tombstones] = await Promise.all([listMetadataDirectory(entryRoot), listMetadataDirectory(tombstoneRoot)]);
    const byPath = new Map();
    for (const entry of entries) {
      const logicalPath = normalizeLogicalPath(entry.logicalPath);
      byPath.set(logicalPath, { logicalPath, hash: String(entry.hash || ""), size: Number(entry.size || 0), contentType: String(entry.contentType || "application/octet-stream"), etag: String(entry.etag || ""), deleted: false, updatedAt: entry.updatedAt || "" });
    }
    for (const tombstone of tombstones) {
      const logicalPath = normalizeLogicalPath(tombstone.logicalPath);
      const existing = byPath.get(logicalPath);
      if (!existing || Date.parse(tombstone.deletedAt || 0) >= Date.parse(existing.updatedAt || 0)) byPath.set(logicalPath, { logicalPath, hash: String(tombstone.lastKnownRemoteHash || tombstone.baseHash || ""), size: 0, contentType: "application/x-shensi-tombstone", etag: "", deleted: true, tombstone });
    }
    return [...byPath.values()].sort((a, b) => a.logicalPath.localeCompare(b.logicalPath, "zh-CN"));
  };

  const upload = async ({ entry, expectedRemoteEtag = "", expectedRemoteExists = null, manualOverwriteConfirmed = false }) => {
    const logicalPath = normalizeLogicalPath(entry.logicalPath);
    const transactionId = createTransactionId(deviceId);
    const staging = `${stagingRoot}/${transactionId}.upload`;
    const target = dataPath(logicalPath);
    await client.ensureCollections(dirname(target).replace(/\\/g, "/"));
    const current = await client.head(target);
    assertRemoteSnapshot({ current, expectedRemoteEtag, expectedRemoteExists, manualOverwriteConfirmed });
    await putUniqueStagingFile(staging, entry.sourcePath, { contentType: entry.contentType });
    const rechecked = await client.head(target);
    assertRemoteSnapshot({ current: rechecked, expectedRemoteEtag, expectedRemoteExists, manualOverwriteConfirmed });
    try {
      if (!rechecked.exists) await client.move(staging, target, { overwrite: false });
      else {
        if (supportsConditionalMove && rechecked.etag) {
          await client.move(staging, target, { overwrite: true, destinationEtag: rechecked.etag });
        } else if (supportsIfMatch && rechecked.etag) {
          // Nutstore rejects MOVE overwrite on some accounts, but supports a
          // conditional PUT. Re-upload the already verified local source with
          // If-Match so ordinary manual sync remains race-safe.
          await client.putFile(target, entry.sourcePath, {
            contentType: entry.contentType,
            ifMatch: rechecked.etag,
          });
          await client.remove(staging, { allowMissing: true }).catch(() => {});
        } else {
          if (!manualMode || !manualOverwriteConfirmed) throw remoteChanged("服务端不支持安全条件替换，不能覆盖已有远程文件，请在冲突中心确认");
          // An explicitly confirmed replacement still avoids MOVE overwrite:
          // rotate the old target to a unique backup, move the completed
          // staging upload into the now-empty path, and restore on failure.
          const backup = `${stagingRoot}/${transactionId}.previous`;
          await client.move(target, backup, {
            overwrite: false,
            // This explicit conflict choice authorizes the backup-and-swap.
            // Do not resend If-Match when the server already rejected it.
            ifMatch: supportsIfMatch ? rechecked.etag || "" : "",
          });
          try {
            await client.move(staging, target, { overwrite: false });
          } catch (error) {
            await client.move(backup, target, { overwrite: false }).catch(() => {});
            throw error;
          }
          await client.remove(backup, { allowMissing: true }).catch(() => {});
        }
      }
    } catch (error) {
      await client.remove(staging, { allowMissing: true }).catch(() => {});
      if (isConditionalRejection(error)) throw remoteChanged("远程目标在移动提交前已变化，需要重新比较");
      throw error;
    }
    const verified = await client.head(target);
    if (!verified.exists || verified.size !== entry.size) throw Object.assign(new Error("远程上传校验失败"), { code: "REMOTE_VERIFY_FAILED" });
    const metadata = { schemaVersion: 1, protocolVersion: NUTSTORE_PROTOCOL_VERSION, logicalPath, hash: entry.hash, size: entry.size, contentType: entry.contentType, etag: verified.etag, transactionId, updatedByDeviceId: deviceId, updatedAt: new Date().toISOString() };
    await client.putBuffer(metadataPath(logicalPath), json(metadata), { contentType: "application/json" });
    await client.remove(tombstonePath(logicalPath), { allowMissing: true });
    return metadata;
  };

  const download = async ({ entry, temporaryPath }) => client.downloadToFile(dataPath(entry.logicalPath), temporaryPath, { expectedSize: entry.size });

  const remove = async ({ entry, baseHash = "", expectedRemoteEtag = "", expectedRemoteExists = null, manualOverwriteConfirmed = false }) => {
    const logicalPath = normalizeLogicalPath(entry.logicalPath);
    const transactionId = createTransactionId(deviceId);
    const current = await client.head(dataPath(logicalPath));
    assertRemoteSnapshot({ current, expectedRemoteEtag, expectedRemoteExists, manualOverwriteConfirmed });
    if (current.exists && (!supportsIfMatch || !current.etag) && (!manualMode || !manualOverwriteConfirmed)) throw remoteChanged("服务端不支持安全条件删除，不能直接删除远程文件，请在冲突中心确认");
    const tombstone = createTombstone({ logicalPath, deviceId, baseHash, lastKnownRemoteHash: entry.hash || baseHash, transactionId });
    await client.putBuffer(tombstonePath(logicalPath), json(tombstone), { contentType: "application/json" });
    try { await client.remove(dataPath(logicalPath), { ifMatch: supportsIfMatch ? current.etag : "", allowMissing: true }); }
    catch (error) {
      if (isConditionalRejection(error)) {
        await client.remove(tombstonePath(logicalPath), { allowMissing: true }).catch(() => {});
        throw remoteChanged("远程目标在删除提交前已变化，需要重新比较");
      }
      throw error;
    }
    await client.remove(metadataPath(logicalPath), { allowMissing: true });
    return tombstone;
  };

  const acknowledgeDeletion = async ({ entry } = {}) => {
    const logicalPath = normalizeLogicalPath(entry?.logicalPath);
    const path = tombstonePath(logicalPath);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await client.getBuffer(path);
      const tombstone = JSON.parse(current.buffer.toString("utf8"));
      const acknowledged = acknowledgeTombstone(tombstone, deviceId);
      if ((tombstone.acknowledgedDevices || []).includes(deviceId)) return acknowledged;
      if (manualMode && !supportsIfMatch) return tombstone;
      try {
        await client.putBuffer(path, json(acknowledged), { contentType: "application/json", ifMatch: current.etag });
        return acknowledged;
      } catch (error) {
        if (error?.code !== "WEBDAV_HTTP_412" || attempt === 2) throw error;
      }
    }
    throw Object.assign(new Error("删除墓碑确认写入失败"), { code: "TOMBSTONE_ACK_FAILED" });
  };

  return { initialize, inventory, upload, download, remove, acknowledgeDeletion, paths: { root, metaRoot, entryRoot, tombstoneRoot, stagingRoot, deviceRoot }, dataPath };
};
