import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_WORKER_PATH = fileURLToPath(new URL("./startup-data-version-guard-worker.mjs", import.meta.url));

const appendBounded = (chunks, chunk, state) => {
  state.bytes += chunk.length;
  if (state.bytes > MAX_CAPTURE_BYTES) {
    const error = new Error("启动数据保护子进程输出超过安全上限");
    error.code = "STARTUP_DATA_GUARD_OUTPUT_LIMIT";
    throw error;
  }
  chunks.push(chunk);
};

export const runIsolatedDesktopStartupDataVersionGuard = ({
  appRoot,
  dataRoot,
  machineRoot,
  currentVersion,
  buildId,
  dataSchemaVersion,
  nodeExecutable = process.execPath,
  workerPath = DEFAULT_WORKER_PATH,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) => new Promise((resolveRun, rejectRun) => {
  const encodedInput = Buffer.from(JSON.stringify({
    protocolVersion: 1,
    appRoot,
    dataRoot,
    machineRoot,
    currentVersion,
    buildId,
    dataSchemaVersion,
  }), "utf8").toString("base64url");
  const child = spawn(nodeExecutable, [workerPath], {
    env: {
      ...env,
      SHENSI_STARTUP_GUARD_INPUT: encodedInput,
      SHENSI_DATA_ROOT: String(dataRoot || ""),
      SHENSI_MACHINE_DATA_ROOT: String(machineRoot || ""),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let settled = false;
  const finish = (callback) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback();
  };
  const failOutputLimit = (error) => {
    child.kill();
    finish(() => rejectRun(error));
  };
  child.stdout.on("data", (chunk) => {
    try { appendBounded(stdout, chunk, stdoutState); } catch (error) { failOutputLimit(error); }
  });
  child.stderr.on("data", (chunk) => {
    try { appendBounded(stderr, chunk, stderrState); } catch (error) { failOutputLimit(error); }
  });
  child.once("error", (error) => finish(() => rejectRun(error)));
  child.once("exit", (code, signal) => finish(() => {
    const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
    const stderrText = Buffer.concat(stderr).toString("utf8").trim();
    if (code !== 0) {
      let details = {};
      try { details = JSON.parse(stderrText); } catch {}
      const error = new Error(details.message || stderrText || `启动数据保护子进程退出码为 ${code}${signal ? `（${signal}）` : ""}`);
      error.code = details.code || "STARTUP_DATA_GUARD_FAILED";
      rejectRun(error);
      return;
    }
    try {
      const payload = JSON.parse(stdoutText);
      if (!payload?.ok || !payload.result) throw new Error("启动数据保护子进程返回了无效结果");
      resolveRun(payload.result);
    } catch (error) {
      error.code ||= "STARTUP_DATA_GUARD_INVALID_RESULT";
      rejectRun(error);
    }
  }));
  const timer = setTimeout(() => {
    child.kill();
    const error = new Error("启动数据保护超时；已停止启动，未跳过用户数据快照");
    error.code = "STARTUP_DATA_GUARD_TIMEOUT";
    finish(() => rejectRun(error));
  }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
});

