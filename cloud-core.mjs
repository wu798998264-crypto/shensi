import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { runModelAdapter } from "./src/server/adapters.mjs";
import { validateShensiBundlePaths } from "./src/server/bundled-shensi.mjs";
import { CONFIDENTIAL_REFUSAL, isConfidentialityProbe } from "./src/server/shensi-context.mjs";
import { runShensiOrchestration } from "./src/server/shensi-orchestrator.mjs";
import { textRevealChunks } from "./src/text-stream.js";
import { normalizeConversationMessages } from "./src/conversation-context.js";
import {
  ContextRequestRequiredError,
  createPlanningCheckpoint,
  normalizeContextSupplement,
  verifyPlanningCheckpoint,
} from "./src/server/context-request-protocol.mjs";

const host = process.env.SHENSI_CORE_HOST || "127.0.0.1";
const port = Number(process.env.SHENSI_CORE_PORT || 4180);
const shensiRoot = resolve(process.env.SHENSI_CORE_SKILLS_ROOT || "/opt/shensi-core/skills");
const shensiManifestPath = resolve(process.env.SHENSI_CORE_SKILLS_MANIFEST || join(dirname(shensiRoot), "SKILLS-MANIFEST.json"));
const capabilityBundle = await validateShensiBundlePaths({
  bundleRoot: shensiRoot,
  manifestPath: shensiManifestPath,
  source: "cloud-application-bundle",
}).catch(() => null);
const accessToken = String(process.env.SHENSI_CORE_TOKEN || "").trim();
const allowedOrigins = new Set(String(process.env.SHENSI_CORE_ALLOWED_ORIGINS || "https://skill.hexing.studio")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const activeRuns = new Map();
const consumedContextCheckpoints = new Map();
const rateBuckets = new Map();
const MAX_BODY_BYTES = 16 * 1024 * 1024;

const modelSettings = Object.freeze({
  adapter: "api",
  provider: process.env.SHENSI_MODEL_PROVIDER || "DeepSeek",
  model: process.env.SHENSI_MODEL_ID || "deepseek-chat",
  baseUrl: process.env.SHENSI_MODEL_BASE_URL || "https://api.deepseek.com",
  apiKey: process.env.SHENSI_MODEL_API_KEY || "",
  protocol: process.env.SHENSI_MODEL_PROTOCOL || "chat-completions",
  reasoningEffort: process.env.SHENSI_MODEL_REASONING || "",
  speedMode: process.env.SHENSI_MODEL_SPEED || "default",
  temperature: process.env.SHENSI_MODEL_TEMPERATURE || "0.7",
  maxOutputTokens: process.env.SHENSI_MODEL_MAX_OUTPUT || "8192",
  timeoutMs: process.env.SHENSI_MODEL_TIMEOUT_MS || "240000",
});

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

const sendJson = (response, status, payload) => {
  if (response.writableEnded) return;
  response.writeHead(status, { ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
};

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
};

const assertAuthorized = (request) => {
  if (!accessToken) throw Object.assign(new Error("云端核心尚未配置访问令牌"), { statusCode: 503 });
  const authorization = String(request.headers.authorization || "");
  if (!authorization.startsWith("Bearer ") || !safeEqual(authorization.slice(7).trim(), accessToken)) {
    throw Object.assign(new Error("访问令牌无效"), { statusCode: 401 });
  }
};

const assertOrigin = (request) => {
  const origin = String(request.headers.origin || "").trim();
  if (origin && !allowedOrigins.has(origin)) {
    throw Object.assign(new Error("拒绝未授权来源"), { statusCode: 403 });
  }
};

const clientIdentity = (request) => String(request.headers["x-real-ip"] || request.socket.remoteAddress || "unknown")
  .split(",")[0]
  .trim();

const assertRateLimit = (request) => {
  const key = clientIdentity(request);
  const now = Date.now();
  const bucket = rateBuckets.get(key) || { startedAt: now, count: 0 };
  if (now - bucket.startedAt >= 60_000) {
    bucket.startedAt = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  rateBuckets.set(key, bucket);
  if (bucket.count > 30) throw Object.assign(new Error("请求过于频繁"), { statusCode: 429 });
};

const readJsonBody = (request) => new Promise((resolveBody, rejectBody) => {
  let body = "";
  let size = 0;
  let rejected = false;
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    if (rejected) return;
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY_BYTES) {
      rejected = true;
      body = "";
      rejectBody(Object.assign(new Error("请求内容超过大小限制"), { statusCode: 413 }));
      return;
    }
    body += chunk;
  });
  request.on("end", () => {
    if (rejected) return;
    try {
      resolveBody(body ? JSON.parse(body) : {});
    } catch {
      rejectBody(Object.assign(new Error("请求 JSON 格式无效"), { statusCode: 400 }));
    }
  });
  request.on("error", rejectBody);
});

const cleanMessages = (messages) => normalizeConversationMessages(messages)
  .map(({ role, content }) => ({ role, content }));

const cleanAttachments = (attachments) => (Array.isArray(attachments) ? attachments : [])
  .slice(0, 12)
  .map((attachment) => ({
    name: String(attachment?.name || "附件").slice(0, 240),
    mimeType: String(attachment?.mimeType || "application/octet-stream").slice(0, 120),
    text: String(attachment?.text || "").slice(0, 120_000),
    dataUrl: /^data:[^;]+;base64,/i.test(String(attachment?.dataUrl || ""))
      ? String(attachment.dataUrl).slice(0, 8 * 1024 * 1024)
      : "",
  }));

const publicError = (error) => String(error?.message || "云端核心执行失败")
  .replace(/[A-Za-z]:\\[^\r\n]+/g, "<内部路径>")
  .replace(/\/(?:Users|home|var|opt)\/[^\r\n]+/g, "<内部路径>")
  .slice(0, 260);

const remoteTaskEnvelope = ({ body, requestId }) => ({
  taskId: requestId,
  documentId: String(body.targetDocumentId || "").slice(0, 160),
  taskType: String(body.mode || "creative").slice(0, 40),
  contextDomain: String(body.contextDomain || "novel").slice(0, 40),
  templateHash: String(capabilityBundle?.sha256 || ""),
});

const handleTask = async (request, response) => {
  const body = await readJsonBody(request);
  const messages = cleanMessages(body.messages);
  if (!messages.length) throw Object.assign(new Error("缺少有效对话消息"), { statusCode: 400 });
  if (!modelSettings.apiKey) throw Object.assign(new Error("云端核心尚未配置模型密钥"), { statusCode: 503 });
  const prompt = messages.at(-1).content;
  if (isConfidentialityProbe(prompt)) return sendJson(response, 200, { ok: true, text: CONFIDENTIAL_REFUSAL });

  const suppliedRequestId = String(body.requestId || "");
  const requestId = /^[A-Za-z0-9_-]{8,100}$/.test(suppliedRequestId) ? suppliedRequestId : `core_${randomUUID()}`;
  if (activeRuns.has(requestId)) throw Object.assign(new Error("任务标识重复"), { statusCode: 409 });
  const controller = new AbortController();
  activeRuns.set(requestId, controller);
  const streaming = body.stream === true;
  const taskEnvelope = remoteTaskEnvelope({ body, requestId });
  const resumeRequested = body.resumePhase === "context_resolved";
  let resumeSupplement = null;
  if (resumeRequested) {
    const verification = verifyPlanningCheckpoint({
      secret: accessToken,
      checkpoint: body.planningCheckpoint,
      requestId,
      taskEnvelope,
      templateHash: capabilityBundle?.sha256 || "",
      initialContext: String(body.projectContext || ""),
    });
    if (!verification.valid) throw Object.assign(new Error(`上下文续跑检查点无效：${verification.reason}`), { statusCode: 409 });
    const checkpointKey = String(body.planningCheckpoint?.signature || "");
    if (consumedContextCheckpoints.has(checkpointKey)) throw Object.assign(new Error("上下文续跑检查点已使用，请从原任务状态恢复或重新开始"), { statusCode: 409 });
    resumeSupplement = normalizeContextSupplement(body.contextSupplement);
    if (!resumeSupplement.prewriteContext.trim()) throw Object.assign(new Error("上下文续跑缺少可信补读内容"), { statusCode: 400 });
    consumedContextCheckpoints.set(checkpointKey, Date.now());
    for (const [key, consumedAt] of consumedContextCheckpoints) {
      if (Date.now() - consumedAt > 30 * 60_000) consumedContextCheckpoints.delete(key);
    }
  }
  const writeEvent = (type, payload) => {
    if (!streaming || response.writableEnded) return;
    response.write(`${JSON.stringify({ type, payload })}\n`);
  };
  if (streaming) {
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
  }

  try {
    let result;
    try {
      result = await runShensiOrchestration({
      shensiRoot,
      settings: { ...modelSettings, webSearchEnabled: body.webSearch === true },
      messages,
      projectContext: resumeSupplement?.prewriteContext || String(body.projectContext || ""),
      postwriteProjectContext: resumeSupplement?.postwriteContext || String(body.postwriteProjectContext || body.projectContext || ""),
      activeModule: String(body.activeModule || "manuscript").slice(0, 40),
      contextDomain: String(body.contextDomain || "novel").slice(0, 40),
      workspaceKind: body.workspaceKind === "notebook" ? "notebook" : "project",
      targetDocumentId: String(body.targetDocumentId || "").slice(0, 160),
      sourceMode: ["original", "adaptation"].includes(body.sourceMode) ? body.sourceMode : "",
      cwd: resolve(process.env.SHENSI_CORE_TEMP_ROOT || "/tmp"),
      attachments: cleanAttachments(body.attachments),
      runModel: runModelAdapter,
      signal: controller.signal,
      onProgress: (execution) => writeEvent("progress", { execution }),
      requestMode: String(body.mode || "creative").slice(0, 40),
      languagePolicy: body.languagePolicy && typeof body.languagePolicy === "object" ? body.languagePolicy : {},
      userSkillRuntime: null,
      taskEnvelope,
      adaptiveContextPolicy: resumeRequested
        ? { enabled: false, initialRevision: 2 }
        : body.adaptiveContextPolicy?.enabled === false ? { enabled: false } : { enabled: true },
      resolveContextRequest: resumeRequested || body.adaptiveContextPolicy?.enabled === false ? null : async ({ request: contextRequest, planning, initialContext }) => {
        const planningCheckpoint = createPlanningCheckpoint({
          secret: accessToken,
          requestId,
          taskEnvelope,
          templateHash: capabilityBundle?.sha256 || "",
          initialContext,
          plan: planning,
        });
        throw new ContextRequestRequiredError({ requestId, needs: contextRequest.needs, planningCheckpoint });
      },
      });
    } catch (error) {
      if (!(error instanceof ContextRequestRequiredError)) throw error;
      if (!streaming) return sendJson(response, 200, { ok: true, contextRequest: error.publicPayload, requestId });
      writeEvent("context_request", error.publicPayload);
      response.end();
      return;
    }
    const payload = { ok: true, ...result, requestId };
    if (!streaming) return sendJson(response, 200, payload);
    for (const delta of textRevealChunks(result.text, { targetFrames: 80, maxChunkSize: 48 })) {
      if (controller.signal.aborted || response.writableEnded) break;
      writeEvent("text_delta", { delta });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 8));
    }
    writeEvent("result", payload);
    response.end();
  } finally {
    activeRuns.delete(requestId);
  }
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    assertOrigin(request);
    assertRateLimit(request);
    if (url.pathname === "/health" && request.method === "GET") {
      return sendJson(response, 200, {
        ok: true,
        service: "shensi-cloud-core",
        ready: Boolean(accessToken && modelSettings.apiKey && capabilityBundle?.verified),
        capabilityBundle: capabilityBundle ? {
          id: capabilityBundle.id,
          version: capabilityBundle.version,
          sha256: capabilityBundle.sha256,
          fileCount: capabilityBundle.fileCount,
          verified: true,
          source: capabilityBundle.source,
        } : { verified: false, errorCode: "SHENSI_BUNDLE_UNAVAILABLE" },
        version: "0.1.0",
      });
    }
    assertAuthorized(request);
    if (!capabilityBundle) throw Object.assign(new Error("内置神思能力包不可用"), { statusCode: 503 });
    if (url.pathname === "/v1/tasks/execute" && request.method === "POST") return await handleTask(request, response);
    if (url.pathname === "/v1/tasks/cancel" && request.method === "POST") {
      const body = await readJsonBody(request);
      const controller = activeRuns.get(String(body.requestId || ""));
      if (controller && !controller.signal.aborted) controller.abort(Object.assign(new Error("任务已由用户终止"), { name: "AbortError" }));
      return sendJson(response, 200, { ok: true, cancelled: Boolean(controller) });
    }
    return sendJson(response, 404, { ok: false, message: "Not Found" });
  } catch (error) {
    if (!response.headersSent) return sendJson(response, Number(error?.statusCode) || 400, { ok: false, message: publicError(error) });
    if (!response.writableEnded) {
      response.write(`${JSON.stringify({ type: "error", payload: { message: publicError(error) } })}\n`);
      response.end();
    }
  }
});

server.listen(port, host, () => {
  console.log(`神思云端核心运行于 http://${host}:${port}`);
});
