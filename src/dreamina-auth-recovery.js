const AUTH_REFRESH_TRANSPORT_PATTERN = /authsdk\s*:\s*refresh failed[\s\S]{0,240}(?:protocol transport|do request|network|connection|timeout|timed out|temporar|econnreset|eai_again)/i;
const AUTH_REFRESH_SESSION_REJECTED_PATTERN = /authsdk\s*:\s*refresh failed[\s\S]{0,240}protocol server[\s\S]{0,80}code\s*=\s*10044/i;
const AUTH_REQUIRED_PATTERN = /(?:authsdk\s*:\s*not logged in|未检测到(?:有效)?登录态|请先执行\s*dreamina\s+login|dreamina profile[^\r\n]*is not signed in)/iu;

export const isDreaminaAuthRefreshTransportFailure = (value) => AUTH_REFRESH_TRANSPORT_PATTERN.test(String(value || ""));
export const isDreaminaAuthRefreshSessionRejected = (value) => AUTH_REFRESH_SESSION_REJECTED_PATTERN.test(String(value || ""));
export const isDreaminaAuthRequiredResponse = (value) => AUTH_REQUIRED_PATTERN.test(String(value || ""))
  || isDreaminaAuthRefreshSessionRejected(value);
export const isDreaminaAuthRefreshRetryableFailure = (value) => (
  isDreaminaAuthRefreshTransportFailure(value) || isDreaminaAuthRefreshSessionRejected(value)
);

export const dreaminaAuthRefreshSessionRejectedMessage = () => (
  "当前即梦配置保存的登录会话已被即梦服务器拒绝，神思有界重试原命令后仍未通过。请核验当前配置后重试；本次未创建厂商任务。"
);

export const dreaminaAuthRefreshFailureMessage = (_value, retryCount = 0) => {
  const retries = Math.max(0, Number(retryCount) || 0);
  return `即梦登录会话刷新暂时失败${retries ? `，已自动重试原命令 ${retries} 次` : ""}。请检查网络或代理是否可访问即梦服务，稍后重新检查。神思没有启动隐式登录，现有 CLI/API 配置也没有被修改。`;
};
