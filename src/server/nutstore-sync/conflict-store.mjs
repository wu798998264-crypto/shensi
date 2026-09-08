import { randomUUID } from "node:crypto";

export const addConflict = (state, conflict = {}) => {
  const existing = state.conflicts.find((item) => item.logicalPath === conflict.logicalPath && item.status === "unresolved");
  if (existing) { Object.assign(existing, conflict, { updatedAt: new Date().toISOString() }); return existing; }
  const value = { id: randomUUID(), status: "unresolved", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...conflict };
  state.conflicts.push(value);
  return value;
};

export const resolveConflictRecord = (state, id, resolution) => {
  const value = state.conflicts.find((item) => item.id === id);
  if (!value) throw Object.assign(new Error("同步冲突不存在"), { code: "SYNC_CONFLICT_NOT_FOUND" });
  value.status = "resolved";
  value.resolution = resolution;
  value.resolvedAt = new Date().toISOString();
  value.updatedAt = value.resolvedAt;
  return value;
};

