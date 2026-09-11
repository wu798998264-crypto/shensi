export const MIN_AGENT_INACTIVITY_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_AGENT_INACTIVITY_TIMEOUT_MS = 30 * 60_000;
export const MAX_AGENT_INACTIVITY_TIMEOUT_MS = 60 * 60_000;

export const effectiveAgentInactivityTimeoutMs = (value) => Math.min(
  MAX_AGENT_INACTIVITY_TIMEOUT_MS,
  Math.max(MIN_AGENT_INACTIVITY_TIMEOUT_MS, Number(value) || DEFAULT_AGENT_INACTIVITY_TIMEOUT_MS),
);

export const createAgentInactivityTimeout = ({
  timeoutMs,
  onTimeout,
  schedule = setTimeout,
  cancel = clearTimeout,
} = {}) => {
  const delayMs = Math.max(1, Number(timeoutMs) || 1);
  let timer = null;
  let stopped = false;
  let generation = 0;

  const arm = () => {
    if (stopped) return;
    if (timer) cancel(timer);
    const activeGeneration = ++generation;
    timer = schedule(() => {
      if (activeGeneration !== generation) return;
      timer = null;
      if (!stopped) onTimeout?.();
    }, delayMs);
    timer?.unref?.();
  };

  const refresh = () => arm();
  const stop = () => {
    stopped = true;
    generation += 1;
    if (timer) cancel(timer);
    timer = null;
  };

  arm();
  return { refresh, stop, timeoutMs: delayMs };
};
