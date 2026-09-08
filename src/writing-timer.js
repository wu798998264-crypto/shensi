export const WRITING_TIMER_SCHEMA_VERSION = 5;
export const GLOBAL_WRITING_TIMER_ID = "global";
export const WRITING_METRICS_IDLE_THRESHOLD_MS = 60_000;
export const WRITING_METRICS_WINDOW_MS = 60_000;
const WRITING_METRICS_RETENTION_DAYS = 31;
const WRITING_METRICS_SAMPLE_LIMIT = 120;

export const WRITING_TIMER_STATUS = Object.freeze({
  idle: "idle",
  running: "running",
  paused: "paused",
  stopped: "stopped",
});

const validStatuses = new Set(Object.values(WRITING_TIMER_STATUS));
const LEGACY_AUTO_PAUSED_STATUS = "auto-paused";
const timestamp = (value, fallback = Date.now()) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
const duration = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const wholeNumber = (value) => Math.max(0, Math.round(Number(value) || 0));
const finiteEntries = (value = {}) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {})
  .map(([key, amount]) => [String(key || ""), wholeNumber(amount)])
  .filter(([key, amount]) => key && amount > 0));

export const writingMetricsDayKey = (now = Date.now()) => {
  const date = new Date(timestamp(now));
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeWritingMetricsDay = (value = {}) => {
  const documentNet = finiteEntries(value?.documentNet);
  return {
    addedChars: Object.values(documentNet).reduce((sum, amount) => sum + amount, 0),
    effectiveMs: duration(value?.effectiveMs),
    documentNet,
  };
};

const normalizeWritingMetricsSession = (value = {}) => ({
  id: String(value?.id || ""),
  startedAt: timestamp(value?.startedAt, 0),
  addedChars: wholeNumber(value?.addedChars),
  effectiveMs: duration(value?.effectiveMs),
  lastActivityAt: timestamp(value?.lastActivityAt, 0),
  documentNet: finiteEntries(value?.documentNet),
  samples: (Array.isArray(value?.samples) ? value.samples : [])
    .map((sample) => ({ at: timestamp(sample?.at, 0), chars: wholeNumber(sample?.chars) }))
    .filter((sample) => sample.at > 0 && sample.chars > 0)
    .sort((left, right) => left.at - right.at)
    .slice(-WRITING_METRICS_SAMPLE_LIMIT),
});

export const normalizeWritingMetrics = (value = {}, now = Date.now()) => {
  const today = writingMetricsDayKey(now);
  const retainedDayKeys = Object.keys(value?.days && typeof value.days === "object" ? value.days : {})
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key) && key <= today)
    .sort()
    .slice(-WRITING_METRICS_RETENTION_DAYS);
  const days = Object.fromEntries(retainedDayKeys.map((key) => [key, normalizeWritingMetricsDay(value.days[key])]));
  const session = normalizeWritingMetricsSession(value?.session);
  session.addedChars = Object.values(session.documentNet).reduce((sum, amount) => sum + amount, 0);
  return {
    firstTrackedDay: /^\d{4}-\d{2}-\d{2}$/.test(value?.firstTrackedDay || "")
      ? String(value.firstTrackedDay)
      : retainedDayKeys[0] || "",
    session,
    days,
  };
};

export const normalizeWritingTimerRecord = (value = {}, workspaceId = value?.workspaceId ?? "") => {
  const status = value?.status === LEGACY_AUTO_PAUSED_STATUS
    ? WRITING_TIMER_STATUS.paused
    : validStatuses.has(value?.status) ? value.status : WRITING_TIMER_STATUS.idle;
  return {
    workspaceId: String(workspaceId || value?.workspaceId || ""),
    elapsedMs: duration(value?.elapsedMs),
    startedAt: status === WRITING_TIMER_STATUS.running ? timestamp(value?.startedAt, 0) : 0,
    status,
    resumeWhenEligible: false,
    expanded: value?.expanded === true,
    updatedAt: timestamp(value?.updatedAt, 0),
  };
};

export const normalizeWritingTimerStore = (value = {}) => {
  const sourceSchemaVersion = wholeNumber(value?.schemaVersion);
  const source = value?.timers && typeof value.timers === "object" ? value.timers : {};
  const globalRecord = source[GLOBAL_WRITING_TIMER_ID];
  const legacyRecords = Object.entries(source)
    .filter(([timerId]) => timerId && timerId !== GLOBAL_WRITING_TIMER_ID)
    .map(([timerId, record]) => normalizeWritingTimerRecord(record, timerId));
  const statusPriority = {
    [WRITING_TIMER_STATUS.running]: 4,
    [WRITING_TIMER_STATUS.paused]: 3,
    [WRITING_TIMER_STATUS.stopped]: 2,
    [WRITING_TIMER_STATUS.idle]: 1,
  };
  const migratedRecord = legacyRecords.sort((left, right) => (
    (statusPriority[right.status] || 0) - (statusPriority[left.status] || 0)
    || right.updatedAt - left.updatedAt
  ))[0];
  const record = normalizeWritingTimerRecord(globalRecord ?? migratedRecord ?? {}, GLOBAL_WRITING_TIMER_ID);
  if (sourceSchemaVersion < WRITING_TIMER_SCHEMA_VERSION) record.expanded = false;
  return {
    schemaVersion: WRITING_TIMER_SCHEMA_VERSION,
    timers: { [GLOBAL_WRITING_TIMER_ID]: record },
    metrics: sourceSchemaVersion >= WRITING_TIMER_SCHEMA_VERSION
      ? normalizeWritingMetrics(value?.metrics)
      : normalizeWritingMetrics(),
  };
};

export const beginWritingMetricsSession = (value = {}, { now = Date.now(), restart = false } = {}) => {
  const normalized = normalizeWritingMetrics(value, now);
  if (restart || !normalized.session.id) {
    normalized.session = normalizeWritingMetricsSession({
      id: `writing-${timestamp(now)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: timestamp(now),
      lastActivityAt: 0,
    });
  } else {
    normalized.session.lastActivityAt = 0;
  }
  return normalized;
};

export const pauseWritingMetricsSession = (value = {}, now = Date.now()) => {
  const normalized = normalizeWritingMetrics(value, now);
  const pausedAt = timestamp(now);
  const session = normalized.session;
  const trailingActiveMs = session.lastActivityAt
    ? Math.min(WRITING_METRICS_IDLE_THRESHOLD_MS, Math.max(0, pausedAt - session.lastActivityAt))
    : 0;
  if (trailingActiveMs > 0) {
    session.effectiveMs += trailingActiveMs;
    const dayKey = writingMetricsDayKey(pausedAt);
    const day = normalizeWritingMetricsDay(normalized.days[dayKey]);
    day.effectiveMs += trailingActiveMs;
    normalized.days[dayKey] = day;
    normalized.firstTrackedDay ||= dayKey;
  }
  normalized.session.lastActivityAt = 0;
  return normalized;
};

export const recordWritingMetricsActivity = (value = {}, {
  now = Date.now(),
  documentId = "",
  deltaChars = 0,
  insertedChars = null,
} = {}) => {
  const activityAt = timestamp(now);
  const normalized = normalizeWritingMetrics(value, activityAt);
  if (!normalized.session.id) return normalized;
  const session = normalized.session;
  const elapsedSinceActivity = session.lastActivityAt ? activityAt - session.lastActivityAt : 0;
  const effectiveDeltaMs = session.lastActivityAt && elapsedSinceActivity >= 0
    ? Math.min(elapsedSinceActivity, WRITING_METRICS_IDLE_THRESHOLD_MS)
    : 0;
  session.lastActivityAt = activityAt;
  session.effectiveMs += effectiveDeltaMs;

  const safeDocumentId = String(documentId || "document");
  // "录入字数" counts characters inserted into the document. Deletions do
  // not erase work already performed and replacements count their new text.
  const rawDelta = wholeNumber(insertedChars === null ? Math.max(0, Number(deltaChars) || 0) : insertedChars);
  const previousSessionNet = wholeNumber(session.documentNet[safeDocumentId]);
  const nextSessionNet = previousSessionNet + rawDelta;
  if (nextSessionNet > 0) session.documentNet[safeDocumentId] = nextSessionNet;
  else delete session.documentNet[safeDocumentId];
  session.addedChars = Object.values(session.documentNet).reduce((sum, amount) => sum + amount, 0);

  const dayKey = writingMetricsDayKey(activityAt);
  const day = normalizeWritingMetricsDay(normalized.days[dayKey]);
  const previousDayNet = wholeNumber(day.documentNet[safeDocumentId]);
  const nextDayNet = previousDayNet + rawDelta;
  if (nextDayNet > 0) day.documentNet[safeDocumentId] = nextDayNet;
  else delete day.documentNet[safeDocumentId];
  day.addedChars = Object.values(day.documentNet).reduce((sum, amount) => sum + amount, 0);
  day.effectiveMs += effectiveDeltaMs;
  normalized.days[dayKey] = day;
  normalized.firstTrackedDay ||= dayKey;

  if (rawDelta > 0) {
    const bucketAt = Math.floor(activityAt / 1000) * 1000;
    const latest = session.samples.at(-1);
    if (latest?.at === bucketAt) latest.chars += rawDelta;
    else session.samples.push({ at: bucketAt, chars: rawDelta });
    session.samples = session.samples
      .filter((sample) => sample.at >= activityAt - WRITING_METRICS_WINDOW_MS * 2)
      .slice(-WRITING_METRICS_SAMPLE_LIMIT);
  }
  return normalizeWritingMetrics(normalized, activityAt);
};

export const countInsertedCharacters = (before = "", after = "") => {
  const previousText = String(before ?? "");
  const nextText = String(after ?? "");
  if (previousText === nextText) return 0;
  // Count Unicode code points, not UTF-16 storage units. This keeps emoji and
  // supplementary CJK characters from being reported as two input characters.
  const previous = Array.from(previousText);
  const next = Array.from(nextText);
  let prefix = 0;
  const sharedLength = Math.min(previous.length, next.length);
  while (prefix < sharedLength && previous[prefix] === next[prefix]) prefix += 1;
  let previousSuffix = previous.length - 1;
  let nextSuffix = next.length - 1;
  while (previousSuffix >= prefix && nextSuffix >= prefix && previous[previousSuffix] === next[nextSuffix]) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }
  return Math.max(0, nextSuffix - prefix + 1);
};

const calendarDayDistance = (fromDay, toDay) => {
  const from = Date.parse(`${fromDay}T00:00:00Z`);
  const to = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 1;
  return Math.floor((to - from) / 86_400_000) + 1;
};

const ratePerMinute = (characters, milliseconds) => milliseconds > 0
  ? Math.round((wholeNumber(characters) * 60_000) / milliseconds)
  : 0;

export const writingMetricsSnapshot = (value = {}, now = Date.now(), {
  timerElapsedMs = null,
  timerRunning = true,
} = {}) => {
  const snapshotAt = timestamp(now);
  const normalized = normalizeWritingMetrics(value, snapshotAt);
  const { session } = normalized;
  const todayKey = writingMetricsDayKey(snapshotAt);
  const today = normalizeWritingMetricsDay(normalized.days[todayKey]);
  const liveActiveTailMs = timerRunning && session.lastActivityAt
    ? Math.min(WRITING_METRICS_IDLE_THRESHOLD_MS, Math.max(0, snapshotAt - session.lastActivityAt))
    : 0;
  const uncappedWritingMs = session.effectiveMs + liveActiveTailMs;
  const elapsedMs = timerElapsedMs === null || timerElapsedMs === undefined
    ? uncappedWritingMs
    : duration(timerElapsedMs);
  const writingMs = Math.min(uncappedWritingMs, elapsedMs);
  const idleMs = Math.max(0, elapsedMs - writingMs);
  const inputCharsPerSecond = writingMs > 0
    ? Math.round((session.addedChars * 10_000) / writingMs) / 10
    : 0;
  const sessionAverageCharsPerMinute = ratePerMinute(session.addedChars, elapsedMs);
  const retainedDays = Object.entries(normalized.days)
    .filter(([key]) => key <= todayKey)
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-WRITING_METRICS_RETENTION_DAYS);
  const trackedCalendarDays = Math.min(30, calendarDayDistance(normalized.firstTrackedDay || todayKey, todayKey));
  const retainedCharacters = retainedDays.reduce((sum, [, day]) => sum + day.addedChars, 0);
  return {
    inputCharsPerSecond,
    writingMs,
    idleMs,
    elapsedMs,
    instantCharsPerMinute: sessionAverageCharsPerMinute,
    sessionAverageCharsPerMinute,
    hourlyCharacters: sessionAverageCharsPerMinute * 60,
    dailyAverageCharacters: Math.round(retainedCharacters / Math.max(1, trackedCalendarDays)),
    trackedCalendarDays,
    sessionAddedChars: session.addedChars,
    sessionEffectiveMs: writingMs,
    todayAddedChars: today.addedChars,
    todayEffectiveMs: today.effectiveMs,
    sessionPerCharacterMs: session.addedChars > 0 ? session.effectiveMs / session.addedChars : 0,
    sessionPerThousandMs: session.addedChars > 0 ? (session.effectiveMs * 1000) / session.addedChars : 0,
    todayPerCharacterMs: today.addedChars > 0 ? today.effectiveMs / today.addedChars : 0,
    todayPerThousandMs: today.addedChars > 0 ? (today.effectiveMs * 1000) / today.addedChars : 0,
  };
};

export const writingTimerElapsedMs = (record, now = Date.now()) => {
  const normalized = normalizeWritingTimerRecord(record);
  if (normalized.status !== WRITING_TIMER_STATUS.running || !normalized.startedAt) return normalized.elapsedMs;
  return normalized.elapsedMs + Math.max(0, timestamp(now) - normalized.startedAt);
};

export const startWritingTimer = (record = {}, now = Date.now()) => {
  const normalized = normalizeWritingTimerRecord(record);
  if (normalized.status === WRITING_TIMER_STATUS.running) return normalized;
  const startedAt = timestamp(now);
  return {
    ...normalized,
    elapsedMs: normalized.status === WRITING_TIMER_STATUS.stopped ? 0 : normalized.elapsedMs,
    startedAt,
    status: WRITING_TIMER_STATUS.running,
    resumeWhenEligible: false,
    updatedAt: startedAt,
  };
};

export const pauseWritingTimer = (record = {}, now = Date.now()) => {
  const normalized = normalizeWritingTimerRecord(record);
  if (normalized.status !== WRITING_TIMER_STATUS.running) return normalized;
  const pausedAt = timestamp(now);
  return {
    ...normalized,
    elapsedMs: writingTimerElapsedMs(normalized, pausedAt),
    startedAt: 0,
    status: WRITING_TIMER_STATUS.paused,
    resumeWhenEligible: false,
    updatedAt: pausedAt,
  };
};

export const stopWritingTimer = (record = {}, now = Date.now()) => {
  const normalized = normalizeWritingTimerRecord(record);
  const stoppedAt = timestamp(now);
  return {
    ...normalized,
    elapsedMs: writingTimerElapsedMs(normalized, stoppedAt),
    startedAt: 0,
    status: WRITING_TIMER_STATUS.stopped,
    resumeWhenEligible: false,
    updatedAt: stoppedAt,
  };
};

export const setWritingTimerExpanded = (record = {}, expanded = false, now = Date.now()) => ({
  ...normalizeWritingTimerRecord(record),
  expanded: expanded === true,
  updatedAt: timestamp(now),
});

export const formatWritingTimerDuration = (milliseconds = 0) => {
  const totalSeconds = Math.floor(duration(milliseconds) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
};
