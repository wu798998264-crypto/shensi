import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dreaminaOAuthBrowserTransactionIsReusable } from "../src/server/dreamina-profile-oauth.mjs";

const now = Date.parse("2026-09-04T06:00:00.000Z");
const base = {
  verificationUri: "https://example.invalid/verify",
  deviceCode: "test-device-code",
  startedAt: "2026-09-04T05:55:00.000Z",
};

assert.equal(dreaminaOAuthBrowserTransactionIsReusable({
  ...base,
  expiresAt: "2026-09-04T06:05:00.000Z",
}, now), true, "未过期的同一 device code 应继续复用，避免覆盖进行中的浏览器确认");

assert.equal(dreaminaOAuthBrowserTransactionIsReusable({
  ...base,
  expiresAt: "2026-09-04T05:59:59.000Z",
  providerApprovedAt: "2026-09-04T05:58:00.000Z",
}, now), false, "即使曾观察到浏览器确认，也不能重新打开已经过期的 device code");

assert.equal(dreaminaOAuthBrowserTransactionIsReusable({
  ...base,
  expiresAt: "2026-09-04T05:59:59.000Z",
  verifiedUserId: "test-user",
}, now), false, "本地身份证据不能让过期的厂商授权链接复活");

assert.equal(dreaminaOAuthBrowserTransactionIsReusable({
  verificationUri: base.verificationUri,
  deviceCode: base.deviceCode,
  startedAt: "2026-09-04T05:40:00.000Z",
}, now), false, "厂商未给过期时间时只能在短安全窗口内复用");

assert.equal(dreaminaOAuthBrowserTransactionIsReusable({
  verificationUri: base.verificationUri,
  startedAt: base.startedAt,
}, now), false, "缺少 device code 的残缺事务不可复用");

const source = await readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8");
assert.match(source, /if \(!dreaminaOAuthBrowserTransactionIsReusable\(pending\)\)[\s\S]{0,500}startDreaminaProfileOAuth/u,
  "重新打开过期授权时必须改为发起当前 profile 的新事务，不能再次打开旧链接");
assert.match(source, /oauthApprovalFinalizationIsWithinGrace[\s\S]{0,350}OAUTH_APPROVAL_FINALIZATION_GRACE_MS/u,
  "仅有 providerApprovedAt 的中间状态必须有收尾期限，不能永久掩盖真实掉线");

console.log("Dreamina expired OAuth device-code regression checks passed");
