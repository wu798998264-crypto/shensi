// Only explicitly launched jobs belong to this HTTP session. Historical jobs
// are intentionally never admitted by a startup scan.
export const dreaminaWorkerNeedsContinuation = (job = {}) => {
  const settings = job.request?.settings || {};
  if (String(settings.adapter || '').toLowerCase() !== 'cli'
    || !['即梦', 'dreamina'].includes(String(settings.provider || '').toLowerCase())) return false;
  if (job.forceReleasePendingAt || job.forceReleaseCompletedAt) return false;
  if (['queued', 'submitting', 'running', 'polling', 'downloading', 'cancel_requested'].includes(job.status)) return true;
  return job.status === 'retry_required' && job.providerStatus === 'reconciling'
    && Boolean(job.nextPollAt) && !job.automaticRecoveryStoppedAt;
};

// Report a stopped local observer, never infer provider failure from age.
// Resuming its known task is safe; submitting a replacement is not.
export const dreaminaWorkerObservationStalled = (job = {}, { nowMs = Date.now(), isProcessAlive = () => true } = {}) => {
  const due = Date.parse(job.nextPollAt || "");
  return dreaminaWorkerNeedsContinuation(job)
    && ["polling", "running", "downloading"].includes(job.status)
    && Boolean(job.providerTaskId) && Number(job.workerPid) > 0
    && Number.isFinite(due) && nowMs - due > 45_000
    && !isProcessAlive(Number(job.workerPid));
};

export const createMediaWorkerContinuation = ({ readJob, isRunning, launch, canLaunch = async () => true, now = Date.now,
  schedule = setTimeout, unschedule = clearTimeout, fallbackDelayMs = 20_000 } = {}) => {
  const jobs = new Map();
  const forget = (id) => {
    const entry = jobs.get(id);
    if (entry?.timer) unschedule(entry.timer);
    jobs.delete(id);
  };
  const track = (id, options) => {
    if (!id) return;
    forget(id);
    jobs.set(id, { options, timer: null, checking: false });
  };
  const continueJob = async (id) => {
    const entry = jobs.get(id);
    if (!entry || entry.checking || entry.timer || isRunning(id)) return;
    entry.checking = true;
    try {
      const job = await readJob(id);
      if (jobs.get(id) !== entry) return;
      if (!dreaminaWorkerNeedsContinuation(job)) return forget(id);
      if (!(await canLaunch(job))) {
        // Wait in this existing server, not a new Node/CLI process per queue item.
        if (jobs.get(id) !== entry) return;
        entry.timer = schedule(() => { entry.timer = null; void continueJob(id); }, 1_500);
        entry.timer?.unref?.();
        return;
      }
      const next = Date.parse(job.nextPollAt || '');
      const delay = Number.isFinite(next) ? Math.max(100, next - now())
        : job.dreaminaQueuePolicy === 'command-lease-v1' && job.status === 'queued' ? 100 : fallbackDelayMs;
      entry.timer = schedule(() => {
        entry.timer = null;
        if (jobs.get(id) !== entry || isRunning(id)) return;
        try { launch(entry.options); }
        catch { /* A failed process launch is retried by the existing watchdog. */ }
      }, delay);
      entry.timer?.unref?.();
    } catch {
      // The existing watchdog can re-read a temporarily unavailable local
      // record; never resubmit or invent a terminal state from a read error.
    } finally {
      entry.checking = false;
    }
  };
  return { track, forget, continueJob, has: (id) => jobs.has(id), sweep: () => Promise.all([...jobs.keys()].map(continueJob)) };
};
