import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertDreaminaAccountIdentity } from "../src/cli/dreamina-account-identity.mjs";

const originalProfile = process.env.SHENSI_DREAMINA_PROFILE_ID;
const originalExpected = process.env.SHENSI_DREAMINA_EXPECTED_USER_ID;

try {
  process.env.SHENSI_DREAMINA_PROFILE_ID = "chenan";
  delete process.env.SHENSI_DREAMINA_EXPECTED_USER_ID;
  assert.throws(
    () => assertDreaminaAccountIdentity({ user_id: "user-chen" }),
    (error) => error.code === "DREAMINA_PROFILE_UNVERIFIED",
    "named profiles must not submit before identity binding",
  );

  process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = "user-chen";
  assert.throws(
    () => assertDreaminaAccountIdentity({ user_id: "user-default" }),
    (error) => error.code === "DREAMINA_ACCOUNT_MISMATCH",
    "account mismatch must be a hard pre-submit failure",
  );
  assert.equal(assertDreaminaAccountIdentity({ user_id: "user-chen", total_credit: 88 }).credit, 88);
  process.env.SHENSI_DREAMINA_PROFILE_ID = "default";
  delete process.env.SHENSI_DREAMINA_EXPECTED_USER_ID;
  assert.throws(
    () => assertDreaminaAccountIdentity({ user_id: "user-default" }),
    (error) => error.code === "DREAMINA_PROFILE_UNVERIFIED",
    "default profile must also bind a stable user_id before paid submission",
  );
} finally {
  if (originalProfile === undefined) delete process.env.SHENSI_DREAMINA_PROFILE_ID;
  else process.env.SHENSI_DREAMINA_PROFILE_ID = originalProfile;
  if (originalExpected === undefined) delete process.env.SHENSI_DREAMINA_EXPECTED_USER_ID;
  else process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = originalExpected;
}

const [runner, oauth, profileRuntime, identityStore, videoBridge, imageBridge, drivers, mediaWorker, server, app, styles] = await Promise.all([
  readFile(new URL("../scripts/windows/dreamina-profile-runner.ps1", import.meta.url), "utf8"),
  readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/dreamina-cli-profile.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/dreamina-profile-identity-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
]);

assert.match(runner, /\[switch\]\$FreshLogin/);
assert.match(runner, /if \(-not \$FreshLogin -and \(Test-Path -LiteralPath \$profileAuth\)\)/);
assert.match(oauth, /"360":[\s\S]*360se\.exe/);
assert.match(oauth, /quark:[\s\S]*Quark/);
assert.match(oauth, /qq:[\s\S]*QQBrowser/);
assert.match(oauth, /uc:[\s\S]*UC浏览器[\s\S]*uc\.exe/);
assert.match(oauth, /sogou:[\s\S]*搜狗浏览器[\s\S]*SogouExplorer\.exe/);
assert.match(oauth, /"duanju-zuiqianxian": "chrome"/);
assert.match(oauth, /"yinou-shijie": "uc"/);
assert.match(oauth, /guobazai: "sogou"/);
assert.match(oauth, /PROFILE_DEFAULT_BROWSER_IDS[\s\S]*chenan: "360"[\s\S]*xiaoyujie: "quark"[\s\S]*"tashuo-juyougeng": "qq"/);
assert.match(oauth, /DREAMINA_ACCOUNT_DUPLICATE/);
assert.match(oauth, /checklogin[\s\S]*freshLogin: false/);
assert.match(oauth, /export const reopenDreaminaProfileOAuth/);
assert.match(oauth, /live && !live\.ok && !live\.transient/);
assert.match(oauth, /已保存的核验状态保持有效/);
assert.match(oauth, /creditSnapshot/);
assert.match(profileRuntime, /SHENSI_DREAMINA_EXPECTED_USER_ID/);
assert.match(profileRuntime, /SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT/);
assert.match(profileRuntime, /const useWindowsCredentialBroker = process\.platform === "win32"/);
assert.doesNotMatch(profileRuntime, /profileId === "default" \? userHome/);
assert.match(identityStore, /consumedCredit/);
assert.match(identityStore, /vipExpiresAt/);
assert.match(identityStore, /creditEstimates/);
assert.match(identityStore, /recordDreaminaProfileCreditEstimate/);
assert.match(identityStore, /referenceClassForRequest/);
assert.match(identityStore, /unitCredit/);
assert.match(identityStore, /calibrationRevision/);
assert.match(identityStore, /deviationRatio/);
assert.match(videoBridge, /verifiedDreaminaAccount/);
assert.match(imageBridge, /verifiedDreaminaAccount/);
assert.match(videoBridge, /verifiedDreaminaAccountWithControlPlaneFallback/);
assert.match(imageBridge, /verifiedDreaminaAccountWithControlPlaneFallback/);
assert.doesNotMatch(videoBridge, /const beforeTaskIds = \(await listTasks\(\)\)/);
assert.doesNotMatch(imageBridge, /const beforeTaskIds = \(await listTasks\(\)\)/);
assert.match(videoBridge, /creditCount: nestedNumber\(payload, \["credit_count", "creditCount"\]\)/);
assert.match(imageBridge, /creditCount: nestedNumber\(payload, \["credit_count", "creditCount"\]\)/);
assert.match(drivers, /credentialFingerprint: String\(result\.credentialFingerprint/);
assert.match(drivers, /cachedDreaminaCapability/);
assert.match(drivers, /\(pollCount \+ 1\) % 120 === 0/);
assert.match(mediaWorker, /providerCreditCount/);
assert.match(mediaWorker, /providerExecutionReceipt/);
assert.match(mediaWorker, /providerControlPlaneTransient/);
assert.match(mediaWorker, /recordDreaminaProfileCreditEstimate/);
assert.match(mediaWorker, /Calibrate only after the provider result has been downloaded and verified/);
assert.match(server, /\/api\/dreamina-profiles\/status/);
assert.match(server, /\/api\/dreamina-profiles\/oauth\/start/);
assert.match(server, /\/api\/dreamina-profiles\/oauth\/reopen/);
assert.match(server, /\/api\/dreamina-profiles\/oauth\/complete/);
assert.match(app, /dreaminaAccountPanel/);
assert.match(app, /dreaminaAccountMetrics/);
assert.match(app, /data-dreamina-metric="credit"/);
assert.doesNotMatch(app, /data-dreamina-metric="last-consumed"/);
assert.doesNotMatch(app, /data-dreamina-metric="total"/);
assert.doesNotMatch(app, /data-dreamina-metric="expires"/);
assert.match(app, /id="refreshDreaminaCredit"/);
assert.match(app, /refreshCurrentDreaminaCredit/);
assert.match(app, /ui\.dreaminaAccountStatuses/);
assert.match(app, /whiteboardImageCreditEstimate/);
assert.match(app, /whiteboardVideoCreditEstimate/);
assert.match(app, /usesDreaminaAccountCredits/);
assert.match(app, /本次消耗：待首次生成校准/);
assert.match(app, /dreaminaCreditEstimateForForm/);
assert.match(app, /whiteboardGenerationReferenceClassForForm/);
assert.match(app, /生成后以实际扣除为准/);
assert.match(app, /同参数最近一次实际消耗/);
assert.match(app, /whiteboardCreditBalanceTotal/);
assert.doesNotMatch(app, /id="verifyDreaminaAccount"/);
assert.doesNotMatch(app, /const creditSuffix = dreaminaProfileId/);
assert.match(app, /id="dreaminaReverifyDialog"/);
assert.match(app, /ensureDreaminaGenerationAccountAvailable/);
assert.match(app, /前往核验/);
assert.match(app, /\/api\/dreamina-profiles\/oauth\/reopen/);
assert.match(app, /refreshDreaminaAccountStatus\(\{ verifyLive: false, profileId, channel: verificationChannel \}\)/);
assert.match(app, /persistVerifiedGenerationChannel\(verificationChannel(?:,\s*\{\s*profileId\s*\})?\)/);
assert.match(app, /dataset\.channel = channel/);
assert.match(app, /startDreaminaProfileVerification\(profileId, \{ trigger: null, channel \}\)/,
  "核验弹窗按钮不得继续绑定到异步 OAuth 状态，避免后续账号弹窗串屏");
assert.match(app, /dreaminaReverifyQueuePaused = true[\s\S]{0,500}showNextQueuedDreaminaReverification/,
  "当前账号完成 OAuth 启动后必须恢复后续账号的核验弹窗队列");
assert.match(app, /trigger\.disabled = false;[\s\S]*trigger\.textContent = "核验账号"/);
assert.doesNotMatch(app, />重新核验账号</);
assert.match(styles, /\.dreamina-account-metrics/);
assert.match(styles, /\.dreamina-reverify-dialog/);
assert.match(styles, /\.whiteboard-generation-credit/);
assert.match(styles, /\.whiteboard-credit-balance/);
assert.match(app, /whiteboard-card-generation-type/);
assert.match(app, /pendingGenerationType/);
assert.match(app, /Opening a generation type is an explicit new intent/);
assert.match(app, /if \(!node\) \{[\s\S]{0,220}continue;/, "缺失上游引用必须保留原始标记后继续处理");
assert.match(app, /insertion \+= String\(segment\.token \?\? ""\)/, "缺失上游引用不得被静默删除");
assert.doesNotMatch(app, /fullscreenSavedSidebarState/);
assert.doesNotMatch(videoBridge, /if \(command\[0\] === "__shensi_segmented_long_video__"\)/);
assert.doesNotMatch(videoBridge, /id\.startsWith\(LONG_VIDEO_PROVIDER_PREFIX\)/);
assert.match(videoBridge, /不会用多任务拼接伪装成原生能力/);
assert.match(app, /当前凭据与此配置登记的账号不一致，已禁止提交/);
assert.match(app, /与另一配置绑定了同一账号，已禁止提交/);

console.log("v2.8.0 Dreamina account isolation regression checks passed");
