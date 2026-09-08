import assert from "node:assert/strict";
import { parseDreaminaOAuthMaterial } from "../src/server/dreamina-profile-oauth.mjs";

const expected = {
  verificationUri: "https://example.invalid/device",
  userCode: "ABCD-EFGH",
  deviceCode: "device-secret-value",
  expiresAt: "2026-09-04T12:00:00.000Z",
};

assert.deepEqual(parseDreaminaOAuthMaterial([
  `verification_uri: ${expected.verificationUri}`,
  `user_code: ${expected.userCode}`,
  `device_code: ${expected.deviceCode}`,
  `expires_at: ${expected.expiresAt}`,
].join("\n")), expected, "line-oriented OAuth output must remain supported");

assert.deepEqual(parseDreaminaOAuthMaterial([
  `请在浏览器中打开 verification_uri: ${expected.verificationUri}`,
  `用户代码 user_code：${expected.userCode}`,
  `设备授权 device_code=${expected.deviceCode}`,
  `有效期 expires_at: ${expected.expiresAt}`,
].join("\n")), expected, "localized CLI prefixes must not hide OAuth fields");

assert.deepEqual(parseDreaminaOAuthMaterial(JSON.stringify({
  verificationUri: expected.verificationUri,
  userCode: expected.userCode,
  deviceCode: expected.deviceCode,
  expiresAt: expected.expiresAt,
})), expected, "JSON and camelCase OAuth output must be supported");

assert.deepEqual(parseDreaminaOAuthMaterial([
  `\u001b[36m授权链接 verification_uri: "${expected.verificationUri}"\u001b[0m`,
  `user_code='${expected.userCode}'`,
  `device_code: "${expected.deviceCode}"`,
  `expires_at: "${expected.expiresAt}"`,
].join("\n")), expected, "quoted and ANSI-colored OAuth output must be supported");

assert.deepEqual(parseDreaminaOAuthMaterial("核验启动失败，没有授权材料"), {
  verificationUri: "",
  userCode: "",
  deviceCode: "",
  expiresAt: "",
}, "unrelated output must not be misclassified as OAuth material");

console.log("Dreamina OAuth material parser regression checks passed");
