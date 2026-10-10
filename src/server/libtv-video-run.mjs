import { spawn } from "node:child_process";

// `libtv node --run` owns submission, live polling and canvas writeback.
// Killing it at the short request timeout leaves only a stale canvas snapshot.
// Used exclusively by LibTV video; image/audio keep their existing runner.
export const waitForLibTvVideoRun = ({ executable, args, cwd, env = process.env, onProviderTask, spawnProcess = spawn }) => new Promise((resolveRun, rejectRun) => {
  const child = spawnProcess(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", pendingLine = "", taskId = "", settled = false;
  let receipt = Promise.resolve();
  const fail = (error) => {
    if (settled) return;
    settled = true;
    if (taskId) error.providerTaskId = taskId;
    error.stdout = stdout.trim(); error.stderr = stderr.trim();
    rejectRun(error);
  };
  const readProgress = (line) => {
    const found = String(line).match(/\[run\]\s+task=([A-Za-z0-9_-]+)/u)?.[1];
    if (!found || found === taskId) return;
    taskId = found;
    // This is only an early durable receipt, never evidence of completion.
    receipt = receipt.then(() => onProviderTask?.({ providerTaskId: found, providerStatus: "running", rawStatus: "cli_live_wait" }));
    receipt.catch((error) => { child.kill(); fail(error); });
  };
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", (value) => {
    stdout += value;
    if (stdout.length > 8 * 1024 * 1024) {
      child.kill(); fail(Object.assign(new Error("LibTV 视频结果输出超过安全上限"), { providerErrorCode: "LIBTV_VIDEO_OUTPUT_TOO_LARGE" }));
    }
  });
  child.stderr.on("data", (value) => {
    stderr = (stderr + value).slice(-256 * 1024);
    pendingLine += value;
    const lines = pendingLine.split(/\r?\n/u);
    pendingLine = lines.pop().slice(-8192);
    for (const line of lines) readProgress(line);
  });
  child.once("error", (cause) => fail(Object.assign(new Error(`LibTV 视频命令无法启动：${cause.message}`), { providerErrorCode: cause.code || "DRIVER_START_FAILED" })));
  child.once("close", async (code) => {
    readProgress(pendingLine);
    try { await receipt; } catch (error) { fail(error); return; }
    if (settled) return;
    if (code !== 0) {
      fail(Object.assign(new Error(stderr.trim() || stdout.trim() || `LibTV 视频命令退出码 ${code}`), { providerErrorCode: "DRIVER_EXIT_FAILED" }));
      return;
    }
    settled = true;
    resolveRun({ stdout, stderr, providerTaskId: taskId });
  });
});
