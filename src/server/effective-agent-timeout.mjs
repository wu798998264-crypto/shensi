const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || minimum));

/**
 * A runner timeout that measures active Agent time instead of wall-clock time.
 * Waiting for a user decision pauses the execution budget, while a bounded
 * pause and wall-clock ceiling still prevent an abandoned process from living
 * forever.
 */
export const createEffectiveAgentTimeout = ({
  timeoutMs = 1_800_000,
  isWaitingForUser = () => false,
  onTimeout = () => {},
  maxPauseMs,
  maxWallClockMs,
  tickMs = 250,
  minimumMs = 5_000,
} = {}) => {
  const minimum = clamp(minimumMs, 50, 30_000);
  const budget = clamp(timeoutMs, minimum, 3_600_000);
  const pauseBudget = clamp(maxPauseMs ?? Math.max(900_000, budget * 3), 30_000, 3_600_000);
  const wallBudget = clamp(maxWallClockMs ?? budget + pauseBudget, budget, 7_200_000);
  const startedAt = Date.now();
  let lastAt = startedAt;
  let activeMs = 0;
  let pausedMs = 0;
  let timer = null;
  let settled = false;

  const clear = () => {
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const snapshot = () => ({
    activeMs,
    pausedMs,
    wallClockMs: Math.max(0, Date.now() - startedAt),
    timeoutMs: budget,
    maxPauseMs: pauseBudget,
    maxWallClockMs: wallBudget,
  });

  const tick = () => {
    if (settled) return;
    const now = Date.now();
    const delta = Math.max(0, now - lastAt);
    lastAt = now;
    const waiting = Boolean(isWaitingForUser());
    if (waiting) pausedMs += delta;
    else activeMs += delta;
    const wallClockMs = now - startedAt;
    const timedOut = activeMs >= budget || pausedMs >= pauseBudget || wallClockMs >= wallBudget;
    if (timedOut) {
      settled = true;
      timer = null;
      onTimeout({
        ...snapshot(),
        reason: activeMs >= budget ? "active_timeout" : pausedMs >= pauseBudget ? "waiting_timeout" : "wall_clock_timeout",
      });
      return;
    }
    timer = setTimeout(tick, Math.min(Math.max(50, Number(tickMs) || 250), 1_000));
    timer.unref?.();
  };

  timer = setTimeout(tick, Math.min(Math.max(50, Number(tickMs) || 250), 1_000));
  timer.unref?.();
  return { clear, snapshot };
};
