export const MANUAL_MEMORY_SYNC_IDLE_MS = 15_000;
export const MANUAL_MEMORY_SYNC_MIN_INTERVAL_MS = 60_000;

export const manualMemorySyncDelay = ({
  now = Date.now(),
  lastRunAt = 0,
  immediate = false,
  idleMs = MANUAL_MEMORY_SYNC_IDLE_MS,
  minimumIntervalMs = MANUAL_MEMORY_SYNC_MIN_INTERVAL_MS,
} = {}) => Math.max(
  immediate ? 0 : Math.max(0, Number(idleMs) || 0),
  Math.max(0, Number(minimumIntervalMs) || 0) - Math.max(0, Number(now) - Number(lastRunAt || 0)),
  0,
);

export const memorySyncRevisionIsCurrent = ({ expectedRevision = "", currentRevision = "" } = {}) => (
  Boolean(expectedRevision) && expectedRevision === currentRevision
);
