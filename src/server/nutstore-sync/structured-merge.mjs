const clone = (value) => JSON.parse(JSON.stringify(value));
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const stable = (value) => JSON.stringify(canonical(value));

const mergeRecordArray = ({ base = [], local = [], remote = [], idKey = "id" }) => {
  const maps = [base, local, remote].map((items) => new Map((Array.isArray(items) ? items : []).map((item) => [String(item?.[idKey] || ""), item]).filter(([id]) => id)));
  const ids = [...new Set([...maps[0].keys(), ...maps[1].keys(), ...maps[2].keys()])];
  const output = [];
  const conflicts = [];
  for (const id of ids) {
    const [b, l, r] = maps.map((map) => map.get(id));
    if (stable(l) === stable(r)) { if (l) output.push(clone(l)); continue; }
    if (stable(l) === stable(b)) { if (r) output.push(clone(r)); continue; }
    if (stable(r) === stable(b)) { if (l) output.push(clone(l)); continue; }
    conflicts.push({ id, base: b || null, local: l || null, remote: r || null });
  }
  return { value: output, conflicts };
};

export const mergeStructuredData = ({ kind = "json", base, local, remote } = {}) => {
  if (kind === "experience-store" && [base, local, remote].some((value) => !value || typeof value !== "object" || Array.isArray(value) || Number(value.schemaVersion) !== 3)) return { conflict: true, value: clone(local), conflicts: [{ field: "schemaVersion", base: base?.schemaVersion, local: local?.schemaVersion, remote: remote?.schemaVersion }] };
  if (stable(local) === stable(remote)) return { conflict: false, value: clone(local), conflicts: [] };
  if (stable(local) === stable(base)) return { conflict: false, value: clone(remote), conflicts: [] };
  if (stable(remote) === stable(base)) return { conflict: false, value: clone(local), conflicts: [] };
  if ([base, local, remote].some((value) => !value || typeof value !== "object" || Array.isArray(value))) return { conflict: true, value: clone(local), conflicts: [{ field: "$", base, local, remote }] };
  if (new Set([base.schemaVersion, local.schemaVersion, remote.schemaVersion].filter((value) => value != null)).size > 1) return { conflict: true, value: clone(local), conflicts: [{ field: "schemaVersion", base: base.schemaVersion, local: local.schemaVersion, remote: remote.schemaVersion }] };
  const result = clone(base);
  const conflicts = [];
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])];
  for (const key of keys) {
    if ((kind === "whiteboard" && ["nodes", "edges"].includes(key)) || (kind === "experience-store" && Array.isArray(base[key]) && Array.isArray(local[key]) && Array.isArray(remote[key]))) {
      const merged = mergeRecordArray({ base: base[key], local: local[key], remote: remote[key] });
      result[key] = merged.value;
      conflicts.push(...merged.conflicts.map((item) => ({ field: key, ...item })));
      continue;
    }
    if (kind === "experience-store" && key === "revision") {
      result[key] = Math.max(Number(base[key]) || 0, Number(local[key]) || 0, Number(remote[key]) || 0) + 1;
      continue;
    }
    const b = stable(base[key]); const l = stable(local[key]); const r = stable(remote[key]);
    if (l === r) result[key] = clone(local[key]);
    else if (l === b) result[key] = clone(remote[key]);
    else if (r === b) result[key] = clone(local[key]);
    else conflicts.push({ field: key, base: base[key], local: local[key], remote: remote[key] });
  }
  return { conflict: conflicts.length > 0, value: result, conflicts };
};

export const assertImmutableVersion = ({ kind, id, version, localHash, remoteHash }) => {
  if (localHash && remoteHash && localHash !== remoteHash) {
    const error = new Error(`${kind} ${id}@${version} 同版本内容不同，禁止自动覆盖`);
    error.code = "IMMUTABLE_VERSION_CONFLICT";
    throw error;
  }
  return true;
};
