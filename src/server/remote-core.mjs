import { MAX_MODEL_MEDIA_REFERENCES } from "../model-presets.js";

const normalizedCoreUrl = () => String(process.env.SHENSI_REMOTE_CORE_URL || "").trim().replace(/\/+$/, "");
const coreToken = () => String(process.env.SHENSI_REMOTE_CORE_TOKEN || "").trim();

const assertCoreUrl = (value) => {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("云端核心只允许 HTTPS 地址");
  }
  return url.toString().replace(/\/$/, "");
};

export const remoteCoreConfigured = () => Boolean(normalizedCoreUrl() && coreToken());
export const remoteCoreRequired = () => /^(?:1|true|yes)$/i.test(String(process.env.SHENSI_REQUIRE_REMOTE_CORE || "").trim());

const coreHeaders = () => ({
  Authorization: `Bearer ${coreToken()}`,
  "Content-Type": "application/json",
});

const responseError = async (response) => {
  const payload = await response.json().catch(() => ({}));
  return new Error(String(payload?.message || `云端核心请求失败（HTTP ${response.status}）`).slice(0, 260));
};

export const remoteCoreStatus = async () => {
  if (!remoteCoreConfigured()) return { configured: false, connected: false, ready: false };
  const baseUrl = assertCoreUrl(normalizedCoreUrl());
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(8_000) });
    const payload = await response.json().catch(() => ({}));
    return {
      configured: true,
      connected: response.ok,
      ready: response.ok && payload.ready === true,
      service: payload.service || "",
      version: payload.version || "",
    };
  } catch (error) {
    return { configured: true, connected: false, ready: false, message: String(error?.message || "连接失败").slice(0, 200) };
  }
};

const cancelRemoteTask = async (baseUrl, requestId) => {
  try {
    await fetch(`${baseUrl}/v1/tasks/cancel`, {
      method: "POST",
      headers: coreHeaders(),
      body: JSON.stringify({ requestId }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The local abort still closes the upstream request even if the explicit cancel call fails.
  }
};

const normalizedAttachments = (attachments = []) => {
  if (attachments.length > MAX_MODEL_MEDIA_REFERENCES) {
    throw new Error(`本轮附件共 ${attachments.length} 项，云端生成链路最多承载 ${MAX_MODEL_MEDIA_REFERENCES} 项；请减少参考后重试`);
  }
  return attachments.map((attachment) => ({
    name: String(attachment?.name || "附件").slice(0, 240),
    mimeType: String(attachment?.mimeType || "application/octet-stream").slice(0, 120),
    text: String(attachment?.text || ""),
    dataUrl: String(attachment?.dataUrl || "").length <= 8 * 1024 * 1024 ? String(attachment?.dataUrl || "") : "",
  }));
};

export const runRemoteCoreTask = async ({ body, attachments = [], signal, onEvent = null, resolveContextRequest = null }) => {
  if (!remoteCoreConfigured()) throw new Error("云端核心尚未配置");
  const baseUrl = assertCoreUrl(normalizedCoreUrl());
  const requestId = String(body.requestId || "");
  const payload = {
    requestId,
    stream: true,
    webSearch: body.webSearch === true,
    mode: body.mode,
    messages: body.messages,
    projectContext: body.projectContext,
    postwriteProjectContext: body.postwriteProjectContext,
    activeModule: body.activeModule,
    contextDomain: body.contextDomain,
    workspaceKind: body.workspaceKind,
    targetDocumentId: body.targetDocumentId,
    languagePolicy: body.languagePolicy,
    attachments: normalizedAttachments(attachments),
    ...(body.resumePhase === "context_resolved" ? {
      resumePhase: "context_resolved",
      planningCheckpoint: body.planningCheckpoint,
      contextSupplement: body.contextSupplement,
      contextManifest: body.contextManifest,
      contextRevision: 2,
    } : {}),
  };
  const abortHandler = () => void cancelRemoteTask(baseUrl, requestId);
  signal?.addEventListener("abort", abortHandler, { once: true });
  try {
    const response = await fetch(`${baseUrl}/v1/tasks/execute`, {
      method: "POST",
      headers: coreHeaders(),
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) throw await responseError(response);
    const contentType = String(response.headers.get("content-type") || "");
    if (!contentType.includes("application/x-ndjson")) {
      const result = await response.json();
      if (!result.ok) throw new Error(result.message || "云端核心执行失败");
      onEvent?.("result", result);
      return result;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result = null;
    let contextRequest = null;
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "error") throw new Error(event.payload?.message || "云端核心执行失败");
        onEvent?.(event.type, event.payload);
        if (event.type === "result") result = event.payload;
        if (event.type === "context_request") contextRequest = event.payload;
      }
      if (done) break;
    }
    if (!result && contextRequest) {
      if (typeof resolveContextRequest !== "function") {
        const error = new Error("云端核心请求补读资料，但当前客户端不支持可信补读续跑");
        error.code = "REMOTE_CONTEXT_LOOP_UNSUPPORTED";
        throw error;
      }
      const resolved = await resolveContextRequest({
        request: { sufficient: false, needs: contextRequest.needs },
        round: 1,
        budget: { profile: "remote", maxDocuments: null, maxCharacters: null, maxRounds: 1, round: 1 },
        signal,
      });
      if (resolved?.status === "rejected" || (resolved?.unresolvedNeeds ?? []).some((need) => need?.blocking === true)) {
        const error = new Error("本地可信补读未能解决远程规划所需的关键资料");
        error.code = "REMOTE_CONTEXT_UNRESOLVED";
        throw error;
      }
      onEvent?.("progress", { execution: {
        status: "running",
        currentStageId: "context-refreeze",
        currentStage: "重新冻结本轮创作依据",
        result: "本地可信补读完成，正在续接远程规划",
        contextRounds: 1,
        contextRevision: 2,
      } });
      return runRemoteCoreTask({
        body: {
          ...body,
          resumePhase: "context_resolved",
          planningCheckpoint: contextRequest.planningCheckpoint,
          contextSupplement: {
            prewriteContext: resolved.prewriteContext,
            postwriteContext: resolved.postwriteContext,
            manifest: resolved.manifest,
          },
          contextManifest: resolved.manifest,
          contextRevision: 2,
        },
        attachments,
        signal,
        onEvent,
        resolveContextRequest: null,
      });
    }
    if (!result) throw new Error("云端核心没有返回完整结果");
    return result;
  } finally {
    signal?.removeEventListener("abort", abortHandler);
  }
};
