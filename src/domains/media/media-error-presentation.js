import { dreaminaFailureDisplayText } from "../../dreamina-failure.js?v=1.0.0-structured-failure";
import { mediaGenerationIssueNeedsCard } from "../../media-execution-policy.js";

export const mediaGenerationProfileLabel = (job = {}) => {
  const current = job && typeof job === "object" ? job : {};
  const settings = current.request?.settings ?? {};
  const explicit = String(settings.remarkName || "").trim();
  if (explicit) return explicit;
  const connectionId = String(settings.connectionId || settings.id || "");
  const known = {
    "video-dreamina-cli": "柏物语",
    "video-dreamina-cli-chenan": "陈安",
    "video-dreamina-cli-guobazai": "锅巴仔",
    "video-dreamina-cli-xiaoyujie": "小鱼姐",
    "video-dreamina-cli-tashuo-juyougeng": "她说剧有梗",
  };
  return known[connectionId] || String(settings.name || settings.provider || "当前连接").trim();
};

export const mediaGenerationErrorText = (job = {}) => {
  const current = job && typeof job === "object" ? job : {};
  const storedReason = String(current.failureReason || "").trim();
  const storedResolution = String(current.failureResolution || "").trim();
  const lastProviderError = current.lastProviderError && typeof current.lastProviderError === "object"
    ? current.lastProviderError
    : {};
  const currentError = String(current.error || "").trim();
  const preservedProviderError = String(lastProviderError.message || "").trim();
  const terminalFailure = mediaGenerationIssueNeedsCard(current);
  const userHandled = Boolean(current.userStoppedAt || current.resultSuppressed || current.userStopped);
  // Stopping a task is an action outcome, not the provider failure cause. Keep
  // the durable provider error first so a later local termination cannot turn
  // "insufficient credit" or "reference upload failed" into a silent generic
  // cancellation message.
  const raw = String(
    (terminalFailure || userHandled ? preservedProviderError : "")
    || currentError
    || preservedProviderError
    || storedReason
    || "",
  ).trim();
  const handlingOutcome = userHandled && currentError && currentError !== raw ? currentError : "";
  const code = String(current.providerErrorCode || current.errorCode || lastProviderError.code || "").trim().toUpperCase();
  const settings = current.request?.settings ?? {};
  const provider = String(settings.provider || "").trim().toLowerCase();
  const providerTask = String(current.providerTaskId || "").trim();
  const diagnosticParts = [
    code ? `错误代码：${code}` : "",
    storedReason ? `原因：${storedReason}` : "",
    storedResolution ? `处理方法：${storedResolution}` : "",
    raw && raw !== storedReason ? `原始报错：${raw}` : "",
    handlingOutcome ? `用户处理结果：${handlingOutcome}` : "",
    providerTask ? `厂商任务：${providerTask}` : "",
  ].filter(Boolean);
  if (/^(?:即梦|LibTV)\s*配置“/u.test(raw) && /错误代码：/u.test(raw)) return raw;
  const dreamina = ["即梦", "dreamina"].includes(provider)
    || code.startsWith("DREAMINA_") || /authsdk:\s*not logged in/i.test(raw);
  if (dreamina && (storedReason || storedResolution)) {
    return `即梦配置“${mediaGenerationProfileLabel(current)}”：${diagnosticParts.join("。")}。`;
  }
  if (dreamina && (code || raw || terminalFailure)) return `即梦配置“${mediaGenerationProfileLabel(current)}”：${dreaminaFailureDisplayText({
    code: code || "DREAMINA_UNCLASSIFIED_FAILURE",
    message: raw,
    providerTaskId: providerTask,
    submissionState: current.submissionState,
  })}${providerTask ? ` 厂商任务：${providerTask}。` : ""}${handlingOutcome ? ` 用户处理结果：${handlingOutcome}` : ""}`;
  if (provider === "libtv" && diagnosticParts.length) return `LibTV 配置“${mediaGenerationProfileLabel(current)}”：${diagnosticParts.join("。")}。`;
  if (raw && code && !raw.toUpperCase().includes(code)) return `错误代码：${code}。原始报错：${raw}`;
  if (raw) return raw;
  if (terminalFailure) return `错误代码：${code || "MEDIA_FAILURE_WITHOUT_DETAILS"}。运行器报告任务失败，但没有返回错误详情；神思已保留任务记录和原生成参数。`;
  return "";
};
