import { beginLocalMediaStop, finishLocalMediaStop, updateMediaGenerationJob } from "./generation-job-store.mjs";
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
  try {
    const worker = await terminate({ jobId, pid: job.workerPid });
    if (worker.scanError) throw new Error(`无法确认媒体进程是否已经退出：${worker.scanError}`);
    if (worker.verified && (!worker.terminated || !worker.exited)) {
      throw new Error("对应媒体进程尚未确认退出，终止意图已保存；请重试终止");
    }
    if (isDreaminaCliSettings(job.request?.settings)) {
      let result;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        result = await probe(job.request.settings.dreaminaCliProfile);
        if (result.released) break;
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (!result?.released) throw new Error(result?.error || "本地执行已停止，但即梦物理凭证槽尚未确认释放；任务继续显示，可重试终止");
    }
    return await finishLocalMediaStop({ jobId });
  } catch (error) {
    await updateMediaGenerationJob({ jobId, patch: {
      error: String(error.message || error), providerErrorCode: "MEDIA_LOCAL_STOP_INCOMPLETE",
    } });
    throw error;
  }
};
