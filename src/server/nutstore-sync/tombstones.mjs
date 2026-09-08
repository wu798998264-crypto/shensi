import { randomUUID } from "node:crypto";
import { normalizeLogicalPath } from "./contracts.mjs";

export const createTombstone = ({ logicalPath, contentId = "", deviceId, baseHash = "", lastKnownRemoteHash = "", transactionId, retentionDays = 30 } = {}) => ({
  schemaVersion: 1,
  id: randomUUID(),
  logicalPath: normalizeLogicalPath(logicalPath),
  contentId: String(contentId || ""),
  deletedByDeviceId: String(deviceId || ""),
  deletedAt: new Date().toISOString(),
  baseHash: String(baseHash || ""),
  lastKnownRemoteHash: String(lastKnownRemoteHash || ""),
  transactionId: String(transactionId || randomUUID()),
  retentionUntil: new Date(Date.now() + Math.max(7, retentionDays) * 86400000).toISOString(),
  acknowledgedDevices: [String(deviceId || "")].filter(Boolean),
});

export const acknowledgeTombstone = (tombstone, deviceId) => ({ ...tombstone, acknowledgedDevices: [...new Set([...(tombstone.acknowledgedDevices || []), String(deviceId || "")].filter(Boolean))] });
export const tombstoneCanExpire = (tombstone, activeDeviceIds = [], now = Date.now()) => Date.parse(tombstone.retentionUntil || 0) <= now && activeDeviceIds.every((id) => tombstone.acknowledgedDevices?.includes(id));

