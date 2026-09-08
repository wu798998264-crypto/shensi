import { randomUUID } from "node:crypto";
import { normalizeLogicalPath, stableIdempotencyKey } from "./contracts.mjs";

export const enqueueOutboxOperation = (state, input = {}) => {
  const logicalPath = input.logicalPath === "*" ? "*" : normalizeLogicalPath(input.logicalPath);
  const action = String(input.action || "scan");
  // A full inventory scan supersedes every older pending full scan. Local
  // saves can arrive much faster than a WebDAV run; keeping one row per save
  // made an offline/disabled account grow an unbounded multi-megabyte queue.
  if (logicalPath === "*" && action === "scan") {
    const pendingScan = state.outbox.find((item) => item.logicalPath === "*" && item.action === "scan" && !["completed", "cancelled"].includes(item.status));
    if (pendingScan) {
      pendingScan.updatedAt = new Date().toISOString();
      return pendingScan;
    }
  }
  const idempotencyKey = input.idempotencyKey || (logicalPath === "*" ? `scan:${state.localCursor || 0}` : stableIdempotencyKey({ action, logicalPath, hash: input.hash || "", deleted: input.deleted === true }));
  const existing = state.outbox.find((item) => item.idempotencyKey === idempotencyKey && !["completed", "cancelled"].includes(item.status));
  if (existing) return existing;
  if (logicalPath !== "*" && !["delete"].includes(action)) {
    state.outbox = state.outbox.filter((item) => item.logicalPath !== logicalPath || ["completed", "cancelled"].includes(item.status) || item.action === "delete");
  }
  const operation = { id: input.id || randomUUID(), idempotencyKey, logicalPath, action, hash: String(input.hash || ""), deleted: input.deleted === true, status: "pending", attempt: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), retryAt: "", errorCode: "" };
  state.outbox.push(operation);
  return operation;
};

export const updateOutboxOperation = (state, id, patch = {}) => {
  const operation = state.outbox.find((item) => item.id === id);
  if (!operation) return null;
  Object.assign(operation, patch, { updatedAt: new Date().toISOString() });
  return operation;
};
