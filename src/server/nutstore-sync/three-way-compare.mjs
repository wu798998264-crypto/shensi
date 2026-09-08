const version = (value) => ({ hash: String(value?.hash || value?.baseHash || ""), deleted: value == null || value?.deleted === true, exists: Boolean(value) && value?.deleted !== true });
const same = (left, right) => left.deleted === right.deleted && left.hash === right.hash && left.exists === right.exists;

export const compareThreeWay = ({ base: baseValue = null, local: localValue = null, remote: remoteValue = null } = {}) => {
  const base = version(baseValue);
  const local = version(localValue);
  const remote = version(remoteValue);
  if (same(local, remote)) return { action: "baseline", reason: "local_remote_equal" };
  const localChanged = !same(local, base);
  const remoteChanged = !same(remote, base);
  if (!localChanged && !remoteChanged) return { action: "skip", reason: "unchanged" };
  if (localChanged && !remoteChanged) return { action: local.deleted ? "delete_remote" : "upload", reason: "local_only" };
  if (!localChanged && remoteChanged) return { action: remote.deleted ? "delete_local" : "download", reason: "remote_only" };
  if (local.deleted && remote.deleted) return { action: "baseline", reason: "both_deleted" };
  return { action: "conflict", reason: local.deleted || remote.deleted ? "delete_modify" : "both_modified" };
};

export const planThreeWaySync = ({ baseline = {}, local = [], remote = [] } = {}) => {
  const localMap = new Map(local.map((item) => [item.logicalPath, item]));
  const remoteMap = new Map(remote.map((item) => [item.logicalPath, item]));
  const paths = [...new Set([...Object.keys(baseline), ...localMap.keys(), ...remoteMap.keys()])].sort();
  return paths.map((logicalPath) => ({
    logicalPath,
    ...compareThreeWay({ base: baseline[logicalPath] || null, local: localMap.get(logicalPath) || null, remote: remoteMap.get(logicalPath) || null }),
    base: baseline[logicalPath] || null,
    local: localMap.get(logicalPath) || null,
    remote: remoteMap.get(logicalPath) || null,
  }));
};
