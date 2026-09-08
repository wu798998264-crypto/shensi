const failureFacts = (error = {}) => {
  const code = String(error?.code || "").trim();
  const providerErrorCode = String(error?.providerErrorCode || "").trim();
  const statusCode = Number(error?.statusCode)
    || Number(code.match(/^HTTP_(\d{3})$/iu)?.[1])
    || 0;
  const retryAfterMs = Math.max(0, Number(error?.retryAfterMs) || 0);
  const message = String(error?.message || "").trim();
  return {
    code,
    providerErrorCode,
    statusCode,
    retryAfterMs,
    message,
    searchable: `${code} ${providerErrorCode} ${message}`,
  };
};

export const publicTextFailureIsRequestSpecific = (error = {}) => {
  const facts = failureFacts(error);
  return /context[_ -]?(?:length|window)|maximum context|max(?:imum)? tokens?|prompt (?:is )?too long|input (?:is )?too long|内容过长|上下文.*(?:过长|超限)|输入.*(?:过长|超限)|content[_ -]?filter|safety|内容安全|安全策略/iu.test(facts.searchable);
};

export const classifyPublicTextCapabilityFailure = (error = {}, {
  responseWithoutText = false,
  fallbackState = "unavailable",
} = {}) => {
  if (responseWithoutText) return "response_without_text";
  const facts = failureFacts(error);
  if (/auth[_ -]?unavailable|no auth available|no available auth|上游.*(?:认证|凭据).*(?:不可用|缺失)/iu.test(facts.searchable)) {
    return "upstream_auth_unavailable";
  }
  if (facts.statusCode === 402
    || /insufficient[_ -]?quota|quota (?:exceeded|exhausted)|credit(?:s| balance)? (?:exhausted|depleted|insufficient)|额度不足|额度耗尽|余额不足|积分不足/iu.test(facts.searchable)) {
    return "quota_exhausted";
  }
  if (facts.statusCode === 429 || facts.statusCode >= 500
    || /rate[_ -]?limit|too many requests|high demand|capacity|请求过于频繁|限流|线路繁忙|timeout|timed out|failed to fetch|network|socket|connection (?:failed|refused|reset)|连接超时|网络异常|服务暂时不可用/iu.test(facts.searchable)) {
    return "temporarily_unavailable";
  }
  if (facts.statusCode === 401
    || /invalid (?:api )?key|invalid[_ -]?credential|authentication failed|unauthorized|凭据失效|密钥无效|认证失败/iu.test(facts.searchable)) {
    return "authentication_required";
  }
  if (facts.statusCode === 403) return "permission_denied";
  if ([404, 405, 501].includes(facts.statusCode)
    || /not supported|unsupported|model (?:not found|unavailable)|does not support|不支持|模型不存在|模型不可用/iu.test(facts.searchable)) {
    return "unsupported";
  }
  // A generic gateway message proves only that this attempt failed. Without
  // a status/error code it cannot prove quota, authentication or model state.
  if (!facts.statusCode || /Provider returned error/iu.test(facts.message)) return "unknown";
  return fallbackState;
};

export const describePublicTextCapabilityFailure = (error = {}, state = "unknown") => {
  const facts = failureFacts(error);
  const raw = facts.message || "限免模型请求失败";
  const evidence = [
    facts.statusCode ? `HTTP ${facts.statusCode}` : "",
    facts.providerErrorCode
      && facts.providerErrorCode !== facts.code
      && facts.providerErrorCode !== `HTTP_${facts.statusCode}`
      ? facts.providerErrorCode
      : "",
    facts.retryAfterMs ? `建议 ${Math.ceil(facts.retryAfterMs / 1000)} 秒后重试` : "",
  ].filter(Boolean).join(" · ");
  const withEvidence = evidence ? `${raw}（${evidence}）` : raw;
  if (state === "quota_exhausted") return `当前限免模型额度已耗尽：${withEvidence}`;
  if (state === "upstream_auth_unavailable") return `当前上游认证池没有可用凭据，用户配置未被清除：${withEvidence}`;
  if (facts.statusCode === 429) return `当前限免模型正在限流或线路繁忙：${withEvidence}`;
  if (facts.statusCode >= 500 || state === "temporarily_unavailable") return `当前限免模型上游暂时不可用：${withEvidence}`;
  if (state === "unsupported") return `当前限免模型已下线、变更或不受支持：${withEvidence}`;
  if (state === "authentication_required") return `当前限免模型认证失效：${withEvidence}`;
  if (state === "permission_denied") return `当前限免模型没有调用权限：${withEvidence}`;
  if (state === "response_without_text") return `当前限免模型有响应但没有产生可用正文：${withEvidence}`;
  if (state === "unknown") return `上游没有返回足以判断的错误证据，当前状态记为未知：${withEvidence}`;
  return `当前限免模型不可用：${withEvidence}`;
};
