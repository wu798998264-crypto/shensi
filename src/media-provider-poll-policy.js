export const durableProviderPollDelayMs = (job = {}, providerStatus = "", now = Date.now()) => {
  const status = String(providerStatus || job.providerStatus || "running").toLowerCase();
  const submittedAt = Date.parse(String(job.submittedAt || job.createdAt || ""));
  const elapsedMs = Number.isFinite(submittedAt) ? Math.max(0, Number(now) - submittedAt) : 0;
  if (status === "running") return elapsedMs >= 60 * 60_000 ? 60_000 : elapsedMs >= 15 * 60_000 ? 30_000 : 8_000;
  if (elapsedMs >= 6 * 60 * 60_000) return 10 * 60_000;
  if (elapsedMs >= 60 * 60_000) return 5 * 60_000;
  if (elapsedMs >= 15 * 60_000) return 60_000;
  if (elapsedMs >= 2 * 60_000) return 20_000;
  return 8_000;
};

export const providerTerminalStatus = (status) => ["completed", "failed", "cancelled"].includes(String(status || "").toLowerCase());
