import { beginLocalMediaStop, finishLocalMediaStop } from "./generation-job-store.mjs";
import { terminateMediaGenerationWorker } from "./media-worker-manager.mjs";
import { probeDreaminaCredentialLock } from "./dreamina-profile-oauth.mjs";
import { isDreaminaCliSettings } from "../dreamina-manual-profile-policy.js";

export const stopLocalMediaJob = async ({ jobId }, {
  terminate = terminateMediaGenerationWorker, probe = probeDreaminaCredentialLock,
} = {}) => {
  // Persist the stop fence before touching the process. Watchdog and late
  // worker writes can never resurrect a user-stopped job after restart.
  const job = await beginLocalMediaStop({ jobId });
  if (job.forceReleaseCompletedAt || job.supersededBy) return job;
  const warnings = [];
  let physicalCredentialSlotReleased;
  try {
    const worker = await terminate({ jobId, pid: job.workerPid });
    if (worker.scanError) warnings.push(`无法确认媒体进程状态：${worker.scanError}`);
    else if (worker.verified && (!worker.terminated || !worker.exited)) warnings.push("对应媒体进程尚未确认退出");
  } catch (error) {
    warnings.push(`终止媒体进程失败：${String(error.message || error)}`);
  }
  if (isDreaminaCliSettings(job.request?.settings)) {
    let result;
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await probe(job.request.settings.dreaminaCliProfile);
        if (result.released) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      physicalCredentialSlotReleased = result?.released === true;
      if (!physicalCredentialSlotReleased) warnings.push(result?.error || "即梦物理凭证槽尚未确认释放；下一条即梦命令若仍繁忙会进入有限重试");
    } catch (error) {
      physicalCredentialSlotReleased = false;
      warnings.push(`即梦物理凭证槽探测失败：${String(error.message || error)}`);
    }
  }
  // “彻底终止”以用户决定为本地终态边界。进程或厂商取消无法
  // 确认时保留诊断，但不得重新占用待处理队列或恢复迟到结果。
  return finishLocalMediaStop({
    jobId,
    diagnostics: {
      warning: warnings.join("；"),
      physicalCredentialSlotReleased,
    },
  });
};
