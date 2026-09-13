import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { agentTaskLifecycle } from "../../agent-task-lifecycle.js";
import {
  assertMediaGenerationProfileIdentity,
  completeClientGenerationJob,
  createClientGenerationJob,
  createMediaGenerationJob,
  dismissMediaGenerationJob,
  failClientGenerationJob,
  finalizeLegacyMediaGenerationReplacement,
  getGenerationJob,
  heartbeatGenerationJob,
  listGenerationJobs,
  markGenerationJobApplied,
  publicGenerationJob,
  recoverLegacyMediaGenerationReplacement,
  reconcileMediaGenerationProviderTask,
  releaseLegacyMediaGenerationReplacement,
  reserveLegacyMediaGenerationReplacement,
  requestMediaGenerationCancel,
  requestMediaGenerationResume,
  updateActiveMediaGenerationJob,
} from "../../server/generation-job-store.mjs";
import { launchMediaGenerationWorker, terminateMediaGenerationWorker } from "../../server/media-worker-manager.mjs";
import { stopLocalMediaJob } from "../../server/media-local-stop.mjs";
import { resolveMediaProviderDriver } from "../../server/media-provider-drivers.mjs";
import {
  canonicalMediaProfileSignature,
  CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX,
} from "../../server/media-profile-signature.mjs";
import { resolveTrustedGenerationSettings } from "../../server/generation-runtime-store.mjs";
import { probeVideoValidationRuntime } from "../../server/workspace.mjs";

const generationJobWithLifecycle = (job = {}) => {
  const safe = publicGenerationJob(job);
  if (!safe || typeof safe !== "object" || !String(safe.id || "").trim() || !String(safe.status || "").trim()) {
    const error = new Error("生成任务记录为空或不完整，暂时无法返回状态");
    error.code = "GENERATION_JOB_RESPONSE_INVALID";
    error.statusCode = 500;
    throw error;
  }
  const targetType = String(safe?.target?.targetType || "");
  return {
    ...safe,
    lifecycle: agentTaskLifecycle({
      kind: targetType === "whiteboard-node" ? "whiteboard" : "media",
      status: safe.status,
      phase: safe.phase || safe.providerStatus,
      currentStage: safe.currentStage,
      provider: safe.provider || safe.request?.provider,
      model: safe.model || safe.request?.model,
      specialist: {
        providerTaskId: safe.providerTaskId || "",
        idempotencyKey: safe.idempotencyKey || "",
        desiredAction: safe.desiredAction || "",
        recovery: safe.recovery || null,
      },
    }),
  };
};

const trustedMediaRecoverySettings = async ({ job, suppliedSettings = {} } = {}) => {
  assertMediaGenerationProfileIdentity({ job, settings: suppliedSettings });
  const persisted = job.request?.settings || {};
  const connectionId = String(persisted.connectionId || suppliedSettings.connectionId || suppliedSettings.id || "").trim();
  const trusted = await resolveTrustedGenerationSettings({
    channel: job.channel,
    settings: {
      ...persisted,
      id: connectionId,
      connectionId,
      apiKey: String(suppliedSettings.apiKey || ""),
    },
  });
  if (String(job.profileSignature || "").startsWith(CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX)
    && (trusted.adapter !== "api" || trusted.apiKey)
    && canonicalMediaProfileSignature(job.channel, trusted) !== job.profileSignature) {
    const error = new Error("当前 endpoint、CLI 参数或凭证身份与原媒体任务不一致，旧任务不能认证或操作新配置");
    error.code = "MEDIA_JOB_CANONICAL_PROFILE_MISMATCH";
    error.statusCode = 409;
    throw error;
  }
  return trusted;
};

const deferMediaJobIfUnchanged = ({ job, desiredAction, patch }) => updateActiveMediaGenerationJob({
  jobId: job.id,
  expectedDesiredAction: desiredAction,
  expectedStatuses: [job.status],
  expectedUpdatedAt: job.updatedAt,
  patch,
});

export const createMediaGenerationApi = ({
  appRoot,
  mediaReplacementOwnerToken,
  readJsonBody,
  sendJson,
} = {}) => async ({ pathname, request, requestUrl, response } = {}) => {
  const respond = (status, payload) => {
    sendJson(response, status, payload);
    return true;
  };

  if (pathname === "/api/generation/jobs/media" && request.method === "POST") {
    const body = await readJsonBody(request, 2 * 1024 * 1024);
    const channel = String(body.channel || "");
    const forceNewGeneration = body.forceNewGeneration === true || body.request?.forceNewGeneration === true;
    let regenerationOfJobId = String(body.regenerationOfJobId || body.request?.regenerationOfJobId || "").trim();
    const trustedSettings = await resolveTrustedGenerationSettings({ channel, settings: body.request?.settings ?? {} });
    const canonicalProfileSignature = canonicalMediaProfileSignature(channel, trustedSettings);
    if (["video", "audio"].includes(channel) && !resolveMediaProviderDriver({ channel, settings: trustedSettings })) {
      const label = channel === "audio" ? "音频" : "视频";
      const error = new Error(`当前${label}连接暂不支持这种生成方式，已在产生费用前停止提交`);
      error.code = "DRIVER_NOT_REGISTERED";
      error.statusCode = 422;
      throw error;
    }
    if (channel === "video") {
      const validationRuntime = await probeVideoValidationRuntime({ appRoot });
      if (!validationRuntime.available) {
        return respond(503, {
          ok: false,
          code: "VIDEO_VALIDATOR_UNAVAILABLE",
          validatorCode: validationRuntime.code,
          message: `本机 FFprobe 完整文件校验器不可用；已在产生费用前阻止视频提交。${validationRuntime.message ? ` ${validationRuntime.message}` : ""}`,
        });
      }
    }
    let previousJob = null;
    if (forceNewGeneration && regenerationOfJobId) {
      previousJob = await getGenerationJob({ jobId: regenerationOfJobId });
      const previousTarget = previousJob?.target ?? {};
      const requestedTarget = body.target ?? {};
      const normalizedPreviousWorkspacePath = previousTarget.workspacePath
        ? resolve(String(previousTarget.workspacePath)).toLowerCase()
        : "";
      const normalizedRequestedWorkspacePath = requestedTarget.workspacePath
        ? resolve(String(requestedTarget.workspacePath)).toLowerCase()
        : "";
      const sameTarget = normalizedPreviousWorkspacePath === normalizedRequestedWorkspacePath
        && String(previousTarget.documentId || "") === String(requestedTarget.documentId || "")
        && String(previousTarget.nodeId || "") === String(requestedTarget.nodeId || "");
      if (!sameTarget) {
        previousJob = null;
        regenerationOfJobId = "";
      }
    }
    const job = await createMediaGenerationJob({
      channel,
      target: body.target,
      submissionId: body.submissionId || body.request?.submissionId,
      forceNewGeneration,
      regenerationOfJobId,
      allowDuplicateCapabilitySmoke: body.allowDuplicateCapabilitySmoke === true || body.request?.allowDuplicateCapabilitySmoke === true,
      canonicalProfileSignature,
      request: {
        ...(body.request ?? {}),
        settings: {
          ...(body.request?.settings ?? {}),
          id: trustedSettings.id,
          connectionId: trustedSettings.connectionId,
          adapter: trustedSettings.adapter,
          provider: trustedSettings.provider,
          protocol: trustedSettings.protocol,
          ...(trustedSettings.dreaminaCliProfile ? { dreaminaCliProfile: trustedSettings.dreaminaCliProfile } : {}),
          ...(trustedSettings.dreaminaExpectedIdentity ? { dreaminaExpectedIdentity: trustedSettings.dreaminaExpectedIdentity } : {}),
        },
      },
    });
    const abandonedJobIds = Array.isArray(job.abandonedJobIds) ? job.abandonedJobIds : [];
    for (const abandonedJobId of abandonedJobIds) {
      const abandoned = await getGenerationJob({ jobId: abandonedJobId }).catch(() => null);
      if (!abandoned) continue;
      const termination = terminateMediaGenerationWorker({
        jobId: abandonedJobId,
        pid: abandoned.workerPid,
      }).catch(() => ({ terminated: false }));
      const settings = abandoned.request?.settings || {};
      const dreaminaCli = settings.adapter === "cli" && settings.provider === "即梦";
      if (dreaminaCli) await termination;
      else void termination;
    }
    if (!job.reused) launchMediaGenerationWorker({ appRoot, jobId: job.id, settings: { apiKey: trustedSettings.apiKey || "" } });
    const { abandonedJobIds: _abandonedJobIds, ...responseJob } = job;
    return respond(job.reused && job.status === "complete" ? 200 : 202, {
      ok: true,
      duplicate: job.duplicate === true,
      reused: job.reused === true,
      abandonedPreviousTask: abandonedJobIds.length > 0,
      job: generationJobWithLifecycle(responseJob),
    });
  }

  if (pathname === "/api/generation/jobs/client" && request.method === "POST") {
    const body = await readJsonBody(request, 2 * 1024 * 1024);
    const job = await createClientGenerationJob({ channel: body.channel, target: body.target, request: body.request ?? {} });
    return respond(201, { ok: true, job: generationJobWithLifecycle(job) });
  }

  if (pathname === "/api/generation/jobs" && request.method === "GET") {
    const jobs = await listGenerationJobs({
      workspacePath: requestUrl.searchParams.get("workspacePath"),
      includeApplied: requestUrl.searchParams.get("includeApplied") === "true",
      targetType: requestUrl.searchParams.get("targetType"),
      profileSignature: requestUrl.searchParams.get("profileSignature"),
    });
    return respond(200, { ok: true, jobs: jobs.map(generationJobWithLifecycle) });
  }

  if (pathname === "/api/generation/jobs/pending-media" && request.method === "GET") {
    const jobs = await listGenerationJobs({ attentionMediaOnly: true });
    return respond(200, { ok: true, jobs: jobs.map(generationJobWithLifecycle) });
  }

  if (pathname === "/api/generation/jobs/stop-local" && request.method === "POST") {
    const body = await readJsonBody(request);
    const ids = [...new Set(Array.isArray(body.jobIds) ? body.jobIds : [])];
    if (!ids.length || ids.length > 500 || ids.some((id) => !/^generation-[a-z0-9-]+$/i.test(String(id)))) {
      return respond(400, { ok: false, message: "请选择有效的媒体任务（每批最多 500 项）" });
    }
    const jobs = [];
    let errors = [], remaining = ids;
    for (let pass = 0; pass < 2 && remaining.length; pass += 1) {
      errors = [];
      for (const jobId of remaining) {
        try { jobs.push(generationJobWithLifecycle(await stopLocalMediaJob({ jobId }))); }
        catch (error) { errors.push({ jobId, message: String(error.message || error) }); }
      }
      remaining = errors.map((item) => item.jobId);
    }
    return respond(200, { ok: errors.length === 0, jobs, errors });
  }

  const generationJobMatch = pathname.match(/^\/api\/generation\/jobs\/(generation-[a-z0-9-]+)(?:\/(heartbeat|complete|fail|applied|resume|cancel|reconcile|dismiss))?$/i);
  if (!generationJobMatch) {
    if (pathname === "/api/images/generate" && request.method === "POST") {
      return respond(410, { ok: false, code: "PERSISTENT_MEDIA_QUEUE_REQUIRED", message: "图片生成已迁移到后台生成接口，请使用 /api/generation/jobs/media" });
    }
    if (pathname === "/api/videos/generate" && request.method === "POST") {
      return respond(410, { ok: false, code: "PERSISTENT_MEDIA_QUEUE_REQUIRED", message: "视频生成已迁移到后台生成接口，请使用 /api/generation/jobs/media" });
    }
    return false;
  }

  const [, jobId, action = ""] = generationJobMatch;
  if (!action && request.method === "GET") {
    return respond(200, { ok: true, job: generationJobWithLifecycle(await getGenerationJob({ jobId })) });
  }
  if (request.method !== "POST") return false;
  const body = await readJsonBody(request);
  if (action === "heartbeat") return respond(200, { ok: true, job: generationJobWithLifecycle(await heartbeatGenerationJob({ jobId, progressPercent: body.progressPercent })) });
  if (action === "complete") return respond(200, { ok: true, job: generationJobWithLifecycle(await completeClientGenerationJob({ jobId, result: body.result })) });
  if (action === "fail") return respond(200, { ok: true, job: generationJobWithLifecycle(await failClientGenerationJob({ jobId, message: body.message, retryRequired: body.retryRequired !== false })) });
  if (action === "applied") return respond(200, { ok: true, job: generationJobWithLifecycle(await markGenerationJobApplied({ jobId, resultAssetId: body.resultAssetId, cardReadback: body.cardReadback })) });

  if (action === "reconcile") {
    const previous = await getGenerationJob({ jobId });
    const trustedSettings = await trustedMediaRecoverySettings({ job: previous, suppliedSettings: body.settings ?? {} });
    const driver = resolveMediaProviderDriver({ channel: previous.channel, settings: trustedSettings });
    if (!["dreamina-image-cli", "dreamina-video-cli"].includes(driver?.id)) {
      const error = new Error("当前仅支持通过原即梦 CLI 连接找回已有厂商媒体任务");
      error.code = "MEDIA_JOB_RECONCILE_PROVIDER_NOT_SUPPORTED";
      error.statusCode = 422;
      throw error;
    }
    const reconciled = await reconcileMediaGenerationProviderTask({ jobId, providerTaskId: body.providerTaskId });
    launchMediaGenerationWorker({ appRoot, jobId: reconciled.id, settings: { apiKey: trustedSettings.apiKey || "" } });
    return respond(202, { ok: true, reconciled: true, job: generationJobWithLifecycle(reconciled) });
  }

  if (action === "dismiss") {
    const job = await dismissMediaGenerationJob({ jobId });
    return respond(200, { ok: true, dismissed: true, job: generationJobWithLifecycle(job) });
  }

  if (action === "resume") {
    const previous = await getGenerationJob({ jobId });
    if (["queued", "submitting", "running", "polling", "downloading"].includes(previous.status)) {
      return respond(200, { ok: true, job: generationJobWithLifecycle(previous), alreadyRunning: true });
    }
    if (body.allowNewSubmission === true && !previous.providerTaskId && !previous.idempotencyKey) {
      const trustedSettings = await trustedMediaRecoverySettings({ job: previous, suppliedSettings: body.settings ?? {} });
      if (["video", "audio"].includes(previous.channel) && !resolveMediaProviderDriver({ channel: previous.channel, settings: trustedSettings })) {
        const label = previous.channel === "audio" ? "音频" : "视频";
        const error = new Error(`当前${label}连接暂不支持这种生成方式，已在创建替代任务前停止提交`);
        error.code = "DRIVER_NOT_REGISTERED";
        error.statusCode = 422;
        throw error;
      }
      const recoveredReplacement = await recoverLegacyMediaGenerationReplacement({
        jobId,
        ownerToken: mediaReplacementOwnerToken,
      });
      if (recoveredReplacement.action === "pending") {
        const error = new Error("旧任务的替代任务正在安全创建中，请稍后刷新；系统不会重复提交计费任务");
        error.code = "MEDIA_JOB_REPLACEMENT_PENDING";
        error.statusCode = 409;
        throw error;
      }
      if (recoveredReplacement.action === "finalized") {
        if (!recoveredReplacement.replacement) {
          const error = new Error("旧任务已标记为被替代，但替代任务记录缺失，请检查任务存储完整性");
          error.code = "MEDIA_JOB_REPLACEMENT_MISSING";
          error.statusCode = 409;
          throw error;
        }
        launchMediaGenerationWorker({ appRoot, jobId: recoveredReplacement.replacement.id, settings: { apiKey: trustedSettings.apiKey || "" } });
        return respond(202, { ok: true, recovered: true, job: generationJobWithLifecycle(recoveredReplacement.replacement), replacedJobId: jobId });
      }
      const { reservationId } = await reserveLegacyMediaGenerationReplacement({ jobId, ownerToken: mediaReplacementOwnerToken });
      let replacement = null;
      try {
        replacement = await createMediaGenerationJob({
          channel: previous.channel,
          target: previous.target,
          canonicalProfileSignature: canonicalMediaProfileSignature(previous.channel, trustedSettings),
          replacement: { sourceJobId: jobId, reservationId },
          request: {
            ...(previous.request ?? {}),
            prompt: previous.request?.executionPrompt || previous.request?.prompt || "",
            displayPrompt: previous.request?.prompt || "",
            settings: {
              ...(previous.request?.settings ?? {}),
              id: trustedSettings.id,
              connectionId: trustedSettings.connectionId,
              adapter: trustedSettings.adapter,
              provider: trustedSettings.provider,
              protocol: trustedSettings.protocol,
            },
          },
        });
        await finalizeLegacyMediaGenerationReplacement({ jobId, reservationId, replacementJobId: replacement.id });
      } catch (error) {
        if (replacement) await requestMediaGenerationCancel({ jobId: replacement.id }).catch(() => {});
        await releaseLegacyMediaGenerationReplacement({ jobId, reservationId }).catch(() => {});
        throw error;
      }
      launchMediaGenerationWorker({ appRoot, jobId: replacement.id, settings: { apiKey: trustedSettings.apiKey || "" } });
      return respond(202, { ok: true, job: generationJobWithLifecycle(replacement), replacedJobId: jobId });
    }
    assertMediaGenerationProfileIdentity({ job: previous, settings: body.settings ?? {} });
    const resumeRequestId = `resume-${randomUUID()}`;
    const job = await requestMediaGenerationResume({ jobId, allowNewSubmission: body.allowNewSubmission === true, requestId: resumeRequestId });
    if (job.resumeRequestId !== resumeRequestId) {
      return respond(200, { ok: true, job: generationJobWithLifecycle(job), alreadyRunning: true });
    }
    let trustedSettings;
    try {
      trustedSettings = await trustedMediaRecoverySettings({ job: previous, suppliedSettings: body.settings ?? {} });
    } catch (error) {
      if (error.code !== "LOCAL_RUNTIME_BINDING_REQUIRED") throw error;
      const waiting = await deferMediaJobIfUnchanged({
        job,
        desiredAction: "run",
        patch: {
          status: "waiting_credentials",
          desiredAction: "run",
          providerErrorCode: error.code,
          error: "原厂商任务和任务 ID 已保留；请在本机恢复同一连接凭证后点击续接原任务。",
          heartbeatAt: new Date().toISOString(),
        },
      });
      return respond(202, { ok: true, requiresCredentials: waiting.status === "waiting_credentials", job: generationJobWithLifecycle(waiting) });
    }
    if (trustedSettings.adapter === "api" && !trustedSettings.apiKey) {
      const waiting = await deferMediaJobIfUnchanged({
        job,
        desiredAction: "run",
        patch: {
          status: "waiting_credentials",
          desiredAction: "run",
          providerErrorCode: "MISSING_CREDENTIALS",
          error: "原厂商任务和任务 ID 已保留；请重新填写当前连接凭证后点击续接原任务。",
          heartbeatAt: new Date().toISOString(),
        },
      });
      return respond(202, { ok: true, requiresCredentials: waiting.status === "waiting_credentials", job: generationJobWithLifecycle(waiting) });
    }
    if (["video", "audio"].includes(previous.channel) && !resolveMediaProviderDriver({ channel: previous.channel, settings: trustedSettings })) {
      const label = previous.channel === "audio" ? "音频" : "视频";
      const blocked = await deferMediaJobIfUnchanged({
        job,
        desiredAction: "run",
        patch: { status: "failed", providerErrorCode: "DRIVER_NOT_REGISTERED", error: `当前版本没有与原任务匹配的${label}驱动，已阻止重新提交。` },
      });
      if (blocked.status !== "failed" || blocked.providerErrorCode !== "DRIVER_NOT_REGISTERED") {
        return respond(202, { ok: true, job: generationJobWithLifecycle(blocked) });
      }
      return respond(422, { ok: false, code: "DRIVER_NOT_REGISTERED", message: blocked.error, job: generationJobWithLifecycle(blocked) });
    }
    launchMediaGenerationWorker({ appRoot, jobId, settings: { apiKey: trustedSettings.apiKey || "" } });
    return respond(202, { ok: true, job: generationJobWithLifecycle(job) });
  }

  if (action === "cancel") {
    const previous = await getGenerationJob({ jobId });
    if (previous.desiredAction === "cancel") {
      return respond(200, { ok: true, alreadyCancelling: true, job: generationJobWithLifecycle(previous) });
    }
    assertMediaGenerationProfileIdentity({ job: previous, settings: body.settings ?? {} });
    const job = await requestMediaGenerationCancel({ jobId });
    if (job.status !== "cancelled") {
      let trustedSettings;
      try {
        trustedSettings = await trustedMediaRecoverySettings({ job: previous, suppliedSettings: body.settings ?? {} });
      } catch (error) {
        if (error.code !== "LOCAL_RUNTIME_BINDING_REQUIRED") throw error;
        const waiting = await deferMediaJobIfUnchanged({
          job,
          desiredAction: "cancel",
          patch: {
            status: "waiting_credentials",
            desiredAction: "cancel",
            providerErrorCode: error.code,
            error: "取消意图和原厂商任务 ID 已保存；恢复同一连接凭证后将自动继续核对取消结果。",
            heartbeatAt: new Date().toISOString(),
          },
        });
        return respond(202, { ok: true, requiresCredentials: waiting.status === "waiting_credentials", job: generationJobWithLifecycle(waiting) });
      }
      if (trustedSettings.adapter === "api" && !trustedSettings.apiKey) {
        const waiting = await deferMediaJobIfUnchanged({
          job,
          desiredAction: "cancel",
          patch: {
            status: "waiting_credentials",
            desiredAction: "cancel",
            providerErrorCode: "MISSING_CREDENTIALS",
            error: "取消意图和原厂商任务 ID 已保存；重新填写当前连接凭证后将自动继续核对取消结果。",
            heartbeatAt: new Date().toISOString(),
          },
        });
        return respond(202, { ok: true, requiresCredentials: waiting.status === "waiting_credentials", job: generationJobWithLifecycle(waiting) });
      }
      launchMediaGenerationWorker({ appRoot, jobId, settings: { apiKey: trustedSettings.apiKey || "" } });
    }
    return respond(202, { ok: true, job: generationJobWithLifecycle(job) });
  }

  return false;
};
