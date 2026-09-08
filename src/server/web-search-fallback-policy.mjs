const text = (value = "") => String(value || "").trim();

const terminalModelFailure = (value = "") => /(?:invalid|incorrect)\s+api\s+key|unauthorized|authentication required|not logged in|\b401\b|insufficient[_\s-]?quota|usage limit|credits?\s+(?:exhausted|depleted)|model.*not found|模型.*(?:不可用|不存在)|用户取消|aborted|cancelled/iu.test(value);

// A public-web fallback only replaces a failed native search tool. It must not
// hide authentication, quota, model, or cancellation failures by issuing a
// second request through the same selected provider.
export const nativeWebSearchFallbackEligible = (error = {}) => {
  const code = text(error?.code || error?.providerErrorCode).toUpperCase();
  const detail = `${code} ${text(error?.message)}`;
  if (!detail || terminalModelFailure(detail)) return false;
  return /web[\s_-]?search|search tool|reconnecting|connection failed|stream disconnected|request timed out|timed out|etimedout|econnreset|socket hang up|fetch failed|network|HTTP_(?:408|429|5\d\d)/iu.test(detail);
};
