const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
const detail = (value) => typeof value === "string" ? value.trim()
  : value && typeof value === "object" ? String(value.message || value.reason || JSON.stringify(value)) : "";

export const parseLibTvCliOutput = (output = "") => {
  const source = String(output || "").trim();
  try { return JSON.parse(source); } catch {}
  // CLI progress belongs to stderr; tolerate line-delimited final JSON and
  // banners, but never turn an empty/malformed response into success ({}).
  for (const line of source.split(/\r?\n/).reverse()) {
    try { return JSON.parse(line); } catch {}
  }
  throw Object.assign(new Error(`LibTV CLI 未返回有效结果 JSON${source ? `：${source.slice(-4000)}` : "（空输出）"}`), { providerErrorCode: "LIBTV_INVALID_RESPONSE" });
};

export const libtvTaskFromPayload = (payload = {}) => {
  const root = object(Array.isArray(payload) ? payload.at(-1) : payload);
  const node = object(root.node || root);
  const data = object(node.data || node);
  const info = object(data.taskInfo || data.task_info || root.taskInfo);
  const taskId = String(root.taskId || root.task_id || data.taskId || data.task_id || info.taskId || info.task_id || "").trim();
  const reason = [info.failedReason, info.failReason, info.fail_reason, info.error, data.failedReason,
    data.failReason, data.fail_reason, data.error, root.error, root.message].map(detail).find(Boolean) || "";
  const rejected = root.ok === false || root.success === false || data.ok === false || data.success === false;
  const value = rejected ? "failed" : info.status ?? info.taskStatus ?? data.status ?? root.status;
  const normalized = String(value ?? "").toLowerCase();
  const status = ["2", "completed", "complete", "success", "succeeded", "done"].includes(normalized) ? "completed"
    : rejected || ["3", "failed", "fail", "error"].includes(normalized) ? "failed"
      : ["4", "5", "cancelled", "canceled"].includes(normalized) ? "cancelled"
        : ["0", "queued", "pending", "created", "waiting"].includes(normalized) ? "queued"
          : ["1", "running", "processing", "generating", "submitted"].includes(normalized) ? "running" : "unknown";
  const urls = Array.isArray(data.url) ? data.url : [data.url || data.resultUrl || data.result_url].filter(Boolean);
  const code = info.errorCode || info.error_code || data.errorCode || data.error_code || root.error?.code || root.code;
  const progress = Number(info.progressPercent ?? info.progress ?? data.progressPercent);
  return {
    providerTaskId: taskId, providerStatus: status, rawStatus: String(value ?? ""),
    providerTaskIdType: taskId ? "task" : "",
    ...(urls[0] ? { resultUrl: String(urls[0]) } : {}),
    ...(["failed", "unknown"].includes(status) ? {
      error: reason || (status === "failed" ? "LibTV 返回生成失败，但未提供具体原因" : `LibTV 返回无法识别的任务状态：${String(value ?? "空状态")}`),
      errorCode: code ? String(code) : status === "failed" ? "LIBTV_PROVIDER_FAILED" : "LIBTV_UNKNOWN_STATUS",
    } : {}),
    ...(Number.isFinite(progress) ? { progressPercent: progress } : {}),
    raw: payload,
  };
};
