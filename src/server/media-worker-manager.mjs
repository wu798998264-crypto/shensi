import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { appDataRoot } from "./app-data.mjs";
import { generationRuntimeCredentialsSnapshot } from "./generation-runtime-store.mjs";
import { readGenerationJobForWorker, updateActiveMediaGenerationJob, updateMediaGenerationJob } from "./generation-job-store.mjs";

export const recordMediaWorkerFailure = async ({ jobId, detail = "", workerPid = 0, code = "MEDIA_WORKER_EXIT_FAILED" }) => {
  const job = await readGenerationJobForWorker({ jobId });
  if (workerPid && job.workerPid && Number(job.workerPid) !== Number(workerPid)) return;
  if (job.mode !== "server" || job.userStoppedAt || job.forceReleasePendingAt
    || !["queued", "submitting", "running", "polling", "downloading"].includes(job.status)) return;
  const uncertain = !job.providerTaskId && ["submitting", "uncertain", "unknown"].includes(job.submissionState);
  const now = new Date().toISOString();
  return updateActiveMediaGenerationJob({ jobId, expectedDesiredAction: "run", expectedStatuses: [job.status], patch: {
    status: job.providerTaskId || uncertain ? "retry_required" : "failed",
    providerErrorCode: code, nextPollAt: "", retryAllowed: true,
    connectionRetryExhausted: true,
    ...(uncertain ? { submissionState: "uncertain", billingRisk: "submission_outcome_unknown", resubmitConfirmationRequired: true } : {}),
    error: `媒体执行进程异常退出，自动执行已停止。${detail || "进程未返回具体原因"}`,
    lastProviderError: { code, message: detail || "进程未返回具体原因", phase: job.executionPhase || job.status, at: now },
  } });
};

const workerPath = resolve(dirname(fileURLToPath(import.meta.url)), "media-generation-worker.mjs");

// A watchdog tick can arrive while the previous recovery worker is still
// polling a long-running provider task. File locks protect correctness, but
// spawning another Node process still creates avoidable CPU, memory and disk
// pressure. Keep one live worker per target and let different jobs continue to
// run concurrently.
const activeWorkers = new Map();

const workerKey = ({ jobId = "", scanMode = "" } = {}) => jobId
  ? `job:${String(jobId)}`
  : scanMode === "credential-rebind" ? "recovery-scan:credential-rebind" : "recovery-scan";

const liveWorker = (key) => {
  const worker = activeWorkers.get(key);
  return worker && worker.exitCode === null && worker.signalCode === null ? worker : null;
};

const processIsAlive = (pid) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const readWindowsCommandLine = (pid) => new Promise((resolveCommandLine) => {
  if (process.platform !== "win32") return resolveCommandLine("");
  const powershell = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  execFile(powershell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
    `(Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}').CommandLine`,
  ], { windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024 }, (_error, stdout) => {
    resolveCommandLine(String(stdout || "").trim());
  });
});

const workerProcessMatchesJob = async (pid, jobId) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0 || !processIsAlive(value)) return false;
  const key = `job:${String(jobId || "")}`;
  const active = liveWorker(key);
  if (active && Number(active.pid) === value) return true;
  if (process.platform !== "win32") return false;
  const commandLine = await readWindowsCommandLine(value);
  return /media-generation-worker\.mjs/i.test(commandLine)
    && new RegExp(`(?:^|[\\s"'])--job(?:=|[\\s]+)${String(jobId || "").replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?:$|[\\s"'])`, "i").test(commandLine);
};

const findWindowsWorkerPid = (jobId) => new Promise((resolvePid) => {
  if (process.platform !== "win32" || !/^generation-[a-z0-9-]{20,}$/i.test(String(jobId || ""))) return resolvePid({ pid: 0 });
  const powershell = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const safeJobId = String(jobId);
  // Packaged Electron workers are launched with the app executable rather
  // than node.exe. Match the worker script and exact job argument across all
  // process names so a service restart can still find the detached worker.
  const command = `(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.Name -notmatch '^(powershell|pwsh)\\.exe$' -and $_.CommandLine -like '*media-generation-worker.mjs*' -and $_.CommandLine -like '*--job*' -and $_.CommandLine -like '*${safeJobId}*' } | Select-Object -First 1 -ExpandProperty ProcessId)`;
  execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 }, (error, stdout) => {
    const pid = Number(String(stdout || "").trim());
    resolvePid({ pid: Number.isInteger(pid) && pid > 0 ? pid : 0, scanError: error ? String(error.message) : "" });
  });
});

const terminateProcessTree = (pid) => new Promise((resolveTermination) => {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return resolveTermination(false);
  if (process.platform !== "win32") {
    try { process.kill(value, "SIGKILL"); } catch (error) { if (error?.code !== "ESRCH") return resolveTermination(false); }
    return resolveTermination(true);
  }
  execFile("taskkill.exe", ["/PID", String(value), "/T", "/F"], { windowsHide: true, timeout: 15_000 }, (error) => resolveTermination(!error));
});

const waitForProcessExit = async (pid, timeoutMs = 5_000) => {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (processIsAlive(pid) && Date.now() < deadline) await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  return !processIsAlive(pid);
};

export const mediaWorkerCredentialSnapshot = ({ jobId = "", credentials = null } = {}) => (
  credentials && typeof credentials === "object"
    ? credentials
    : !jobId
      ? generationRuntimeCredentialsSnapshot({ channels: ["image", "video", "audio"] })
      : {}
);

export const launchMediaGenerationWorker = ({ appRoot, jobId = "", settings = null, credentials = null, scanMode = "", spawnImpl = spawn } = {}) => {
  const key = workerKey({ jobId, scanMode });
  const existing = liveWorker(key);
  if (existing) return { pid: existing.pid, jobId: String(jobId || ""), reused: true };
  const args = [workerPath, "--app-root", resolve(appRoot || process.cwd())];
  if (jobId) args.push("--job", String(jobId));
  if (!jobId && scanMode) args.push("--scan-mode", String(scanMode));
  const env = {
    ...process.env,
    SHENSI_DATA_ROOT: appDataRoot(),
    ...(settings?.apiKey
      ? { SHENSI_MEDIA_WORKER_SETTINGS: Buffer.from(JSON.stringify({ apiKey: String(settings.apiKey) }), "utf8").toString("base64url") }
      : {}),
  };
  const credentialSnapshot = mediaWorkerCredentialSnapshot({ jobId, credentials });
  if (Object.keys(credentialSnapshot || {}).length) {
    env.SHENSI_MEDIA_WORKER_CREDENTIALS = Buffer.from(
      JSON.stringify(credentialSnapshot),
      "utf8",
    ).toString("base64url");
  }
  const child = spawnImpl(process.execPath, args, {
    cwd: resolve(appRoot || process.cwd()),
    env,
    shell: false,
    windowsHide: true,
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errorOutput = "";
  child.stderr?.on("data", (chunk) => { errorOutput = (errorOutput + String(chunk)).slice(-8192); });
  child.stderr?.unref?.();
  const reportExitFailure = (detail) => {
    if (!jobId) return;
    void recordMediaWorkerFailure({ jobId, detail, workerPid: child.pid }).catch((error) => {
      process.stderr.write(`媒体执行进程错误记录失败：${error.message}\n`);
    });
  };
  child.once("close", (code, signal) => {
    if (code !== 0 || signal) reportExitFailure(errorOutput || `退出码 ${code ?? "无"}${signal ? `，信号 ${signal}` : ""}`);
  });
  activeWorkers.set(key, child);
  if (jobId && child.pid && /^generation-[a-z0-9-]{20,}$/i.test(String(jobId))) {
    void updateMediaGenerationJob({
      jobId: String(jobId),
      patch: { workerPid: Number(child.pid), workerStartedAt: new Date().toISOString() },
    }).catch(() => {});
  }
  child.once("exit", () => {
    if (activeWorkers.get(key) === child) activeWorkers.delete(key);
  });
  child.once("error", (error) => {
    if (activeWorkers.get(key) === child) activeWorkers.delete(key);
    reportExitFailure(error.message);
  });
  child.unref();
  return { pid: child.pid, jobId: String(jobId || ""), reused: false };
};

export const terminateMediaGenerationWorker = async ({ jobId = "", pid = 0 } = {}) => {
  const normalizedJobId = String(jobId || "");
  const active = normalizedJobId ? liveWorker(`job:${normalizedJobId}`) : null;
  if (!normalizedJobId) return { terminated: false, verified: false, pid: 0 };

  // The server can restart while a detached worker continues running. In that
  // case the persisted PID may be stale or may belong to a different process;
  // always verify it and fall back to a fresh command-line scan before giving
  // up. This keeps force-release usable after restart without ever killing an
  // unrelated process that happens to reuse the old PID.
  const candidates = [];
  const addCandidate = (value) => {
    const candidate = Number(value);
    if (Number.isInteger(candidate) && candidate > 0 && !candidates.includes(candidate)) candidates.push(candidate);
  };
  addCandidate(active?.pid);
  addCandidate(pid);
  const scan = process.platform === "win32" ? await findWindowsWorkerPid(normalizedJobId) : { pid: 0 };
  addCandidate(scan.pid);
  for (const candidatePid of candidates) {
    if (!(await workerProcessMatchesJob(candidatePid, normalizedJobId))) continue;
    const terminated = await terminateProcessTree(candidatePid);
    const exited = terminated ? await waitForProcessExit(candidatePid) : false;
    if (terminated && active && activeWorkers.get(`job:${normalizedJobId}`) === active) activeWorkers.delete(`job:${normalizedJobId}`);
    return { terminated, verified: true, exited, pid: candidatePid };
  }
  return { terminated: false, verified: false, pid: candidates.at(-1) || 0, scanError: scan.scanError || "" };
};
