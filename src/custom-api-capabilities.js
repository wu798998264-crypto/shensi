export const CUSTOM_API_CAPABILITY_CHANNELS = Object.freeze(["text", "image", "video", "audio"]);

export const CUSTOM_API_PROVISIONAL_CAPABILITY_STATES = Object.freeze(new Set([
  "catalog_only",
  "connected_only",
  "software_not_integrated",
]));

// A capability can be copied into another channel only after the provider
// has exposed a matching model or a successful generation record. A mere
// connection check is not enough to create a potentially unusable profile.
export const CUSTOM_API_SYNCABLE_CAPABILITY_STATES = Object.freeze(new Set([
  "available",
  "catalog_only",
  "connected_only",
]));

export const customApiCapabilityIsSyncable = (capability = {}) => (
  capability?.syncable === true
  || (capability?.detectable === true && CUSTOM_API_SYNCABLE_CAPABILITY_STATES.has(String(capability?.state || "")))
);

export const customApiCapabilitySyncChannels = (capabilities = {}, configuredChannels = []) => {
  const configured = new Set((Array.isArray(configuredChannels) ? configuredChannels : []).map((channel) => String(channel || "")));
  return CUSTOM_API_CAPABILITY_CHANNELS.filter((channel) => (
    !configured.has(channel) && customApiCapabilityIsSyncable(capabilities?.[channel])
  ));
};

const normalizedFailureText = (value) => String(value || "").trim().toLocaleLowerCase();

export const classifyCustomApiCapabilityFailure = ({
  code = "",
  statusCode = 0,
  message = "",
} = {}) => {
  const normalizedCode = String(code || "").trim().toUpperCase();
  const normalizedStatus = Number(statusCode) || Number(normalizedCode.match(/^HTTP_(\d{3})$/u)?.[1]) || 0;
  const text = normalizedFailureText(`${normalizedCode} ${message}`);
  const upstreamAuthUnavailable = /auth[_ -]?unavailable|no auth available|no available auth|上游.*(?:认证|凭据).*(?:不可用|缺失)/u.test(text);
  const quotaExhausted = /insufficient[_ -]?quota|quota (?:exceeded|exhausted)|credit(?:s| balance)? (?:exhausted|depleted|insufficient)|额度不足|额度耗尽|余额不足|积分不足/u.test(text);
  const modelUnconfirmed = /model[_ -]?not[_ -]?available|model[_ -]?unconfirmed|不在当前.*可用模型范围|当前凭证不可见.*模型/u.test(text);
  const unsupported = /not supported|unsupported|model (?:not found|unavailable)|does not support|不支持|模型不存在|模型不可用/u.test(text);
  const invalidCredential = /invalid (?:api )?key|invalid[_ -]?credential|authentication failed|unauthorized|凭据失效|密钥无效|认证失败/u.test(text);
  if (upstreamAuthUnavailable) return { state: "upstream_auth_unavailable", invalidatesCredential: false, retryable: false };
  if (quotaExhausted) return { state: "quota_exhausted", invalidatesCredential: false, retryable: false };
  if (modelUnconfirmed) return { state: "model_unconfirmed", invalidatesCredential: false, retryable: false };
  if (unsupported || [404, 405, 501].includes(normalizedStatus)) return { state: "unsupported", invalidatesCredential: false, retryable: false };
  if (invalidCredential || normalizedStatus === 401 || normalizedCode === "MISSING_CREDENTIALS") {
    return { state: "authentication_required", invalidatesCredential: true, retryable: false };
  }
  if (normalizedStatus === 403) return { state: "permission_denied", invalidatesCredential: false, retryable: false };
  if (normalizedStatus === 429 || normalizedStatus >= 500
    || /timeout|timed out|network|socket|connection (?:failed|refused|reset)|连接超时|网络异常|服务暂时不可用/u.test(text)) {
    return { state: "temporarily_unavailable", invalidatesCredential: false, retryable: true };
  }
  return { state: "unavailable", invalidatesCredential: false, retryable: true };
};

export const aggregateCustomApiCapabilityStatus = (capabilities = {}) => {
  const channels = Object.fromEntries(CUSTOM_API_CAPABILITY_CHANNELS.map((channel) => [channel, {
    state: String(capabilities?.[channel]?.state || "unknown"),
    available: capabilities?.[channel]?.available === true || capabilities?.[channel]?.state === "available",
  }]));
  const availableChannels = CUSTOM_API_CAPABILITY_CHANNELS.filter((channel) => channels[channel].available);
  const configuredChannels = CUSTOM_API_CAPABILITY_CHANNELS.filter((channel) => !["unconfigured", "not_detected"].includes(channels[channel].state));
  const provisionalChannels = CUSTOM_API_CAPABILITY_CHANNELS.filter((channel) => CUSTOM_API_PROVISIONAL_CAPABILITY_STATES.has(channels[channel].state));
  const authenticationRequired = configuredChannels.length > 0
    && configuredChannels.every((channel) => channels[channel].state === "authentication_required");
  return {
    available: availableChannels.length > 0,
    availableChannels,
    configuredChannels,
    provisionalChannels,
    authenticationRequired,
    state: availableChannels.length
      ? availableChannels.length === configuredChannels.length && configuredChannels.length === CUSTOM_API_CAPABILITY_CHANNELS.length ? "available" : "partially_available"
      : provisionalChannels.length ? "provisional" : authenticationRequired ? "authentication_required" : configuredChannels.length ? "unavailable" : "unconfigured",
    channels,
  };
};
