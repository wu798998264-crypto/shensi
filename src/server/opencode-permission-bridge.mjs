import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

const PERMISSION_POLL_INTERVAL_MS = 120;

const delay = (ms, signal = null) => new Promise((resolveDelay) => {
  if (signal?.aborted) return resolveDelay();
  const done = () => {
    signal?.removeEventListener?.("abort", onAbort);
    resolveDelay();
  };
  const timer = setTimeout(done, ms);
  timer.unref?.();
  const onAbort = () => { clearTimeout(timer); done(); };
  signal?.addEventListener?.("abort", onAbort, { once: true });
});

const safeError = (value = "") => String(value || "OpenCode 权限桥接失败")
  .replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]")
  .replace(/Authorization:\s*[^\s]+/giu, "Authorization: [REDACTED]")
  .replace(/[\r\n]+/gu, " ")
  .trim()
  .slice(0, 4_000);

const redactedJson = (value) => JSON.stringify(value, (key, entry) => (
  /api.?key|password|secret|token|authorization|credential/iu.test(key) ? "[REDACTED]" : entry
)).slice(0, 4_000);

const approvalAllowed = (response) => {
  const answer = String(response?.answer || response || "").trim().toLowerCase();
  return answer === "allow" || answer.includes("允许本次操作");
};

export const allocateOpenCodePermissionPort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.unref?.();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

export const openCodePermissionPrompt = (request = {}) => {
  const action = String(request.permission || request.action || request.type || "受保护操作").slice(0, 200);
  const resources = (Array.isArray(request.patterns) ? request.patterns : Array.isArray(request.resources) ? request.resources : [])
    .map((item) => String(item).slice(0, 1_000)).slice(0, 32);
  const metadata = request.metadata && typeof request.metadata === "object" ? redactedJson(request.metadata) : "";
  const target = resources.join("、") || metadata || "运行器未提供目标详情";
  return {
    question: `OpenCode 请求执行 ${action}：${target}。是否允许本次操作？`,
    options: [{ id: "allow", label: "允许本次操作" }, { id: "deny", label: "拒绝本次操作" }],
    detail: { runner: "opencode", requestId: String(request.id || ""), action, resources, metadata },
  };
};

export const replyToOpenCodePermission = async ({
  baseUrl,
  directory,
  request,
  requestApproval,
  fetchImpl = globalThis.fetch,
  headers = {},
} = {}) => {
  const requestId = String(request?.id || "").trim();
  if (!/^per[A-Za-z0-9_-]+$/u.test(requestId)) throw new Error("OpenCode 权限请求 ID 无效");
  let allowed = false;
  if (typeof requestApproval === "function") {
    try { allowed = approvalAllowed(await requestApproval(openCodePermissionPrompt(request))); } catch { allowed = false; }
  }
  const replyUrl = new URL(`/permission/${encodeURIComponent(requestId)}/reply`, baseUrl);
  if (directory) replyUrl.searchParams.set("directory", directory);
  const response = await fetchImpl(replyUrl, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ reply: allowed ? "once" : "reject" }),
  });
  if (!response?.ok) throw new Error(`OpenCode 权限答复失败（${Number(response?.status) || 0}）`);
  return { allowed, reply: allowed ? "once" : "reject", requestId };
};

export const monitorOpenCodePermissions = async ({ baseUrl, directory, requestApproval, fetchImpl = globalThis.fetch, headers = {}, signal, onEvent }) => {
  const handled = new Set();
  while (!signal?.aborted) {
    try {
      const listUrl = new URL("/permission", baseUrl);
      if (directory) listUrl.searchParams.set("directory", directory);
      const response = await fetchImpl(listUrl, { headers: { ...headers, accept: "application/json" } });
      if (response?.ok) {
        const requests = await response.json();
        for (const request of Array.isArray(requests) ? requests : []) {
          const requestId = String(request?.id || "");
          if (!requestId || handled.has(requestId) || signal?.aborted) continue;
          handled.add(requestId);
          onEvent?.({ type: "permission_requested", request });
          try {
            const decision = await replyToOpenCodePermission({ baseUrl, directory, request, requestApproval, fetchImpl, headers });
            onEvent?.({ type: "permission_resolved", requestID: requestId, reply: decision.reply });
          } catch (error) {
            handled.delete(requestId);
            onEvent?.({ type: "permission_reply_error", requestID: requestId, error: safeError(error?.message || error) });
          }
        }
      }
    } catch {
      // The per-run OpenCode server may not be listening yet. Retry until the
      // child exits or the task is cancelled; no permission is auto-approved.
    }
    await delay(PERMISSION_POLL_INTERVAL_MS, signal);
  }
};

export const openCodePermissionServerAuth = () => {
  const password = randomBytes(24).toString("hex");
  return {
    password,
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  };
};
