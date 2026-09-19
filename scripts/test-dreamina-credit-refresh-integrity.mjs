import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assertDreaminaAccountIdentity } from "../src/cli/dreamina-account-identity.mjs";
import { confirmDreaminaLiveCredit, creditSnapshot } from "../src/server/dreamina-profile-oauth.mjs";
import { normalizedRecord } from "../src/server/dreamina-profile-identity-store.mjs";

let reads = 0;
const recovered = await confirmDreaminaLiveCredit(async () => {
  reads += 1;
  return reads === 1
    ? { ok: true, userId: "account-1", credit: 0 }
    : { ok: true, userId: "account-1", credit: 20 };
}, { retryDelayMs: 0, wait: async () => {} });
assert.equal(reads, 2, "a transient zero must be re-read before it is accepted");
assert.equal(recovered.credit, 20, "a later authoritative balance must replace the transient zero");

reads = 0;
const confirmedZero = await confirmDreaminaLiveCredit(async () => {
  reads += 1;
  return { ok: true, userId: "account-1", credit: 0 };
}, { retryDelayMs: 0, wait: async () => {} });
assert.equal(reads, 3, "a real zero balance must require three consistent live reads");
assert.equal(confirmedZero.credit, 0);
assert.equal(confirmedZero.creditZeroConfirmed, true);

reads = 0;
const deferred = await confirmDreaminaLiveCredit(async () => {
  reads += 1;
  return reads === 1
    ? { ok: true, userId: "account-1", credit: 0 }
    : { ok: false, transient: true, code: "DREAMINA_PROFILE_BROKER_BUSY" };
}, { retryDelayMs: 0, wait: async () => {} });
assert.equal(reads, 2);
assert.equal(deferred.transient, true, "a failed zero recheck must preserve the saved balance instead of persisting zero");

const ordinaryMembership = creditSnapshot({
  lastCredit: 20,
  vipLevel: "ultra",
  vipExpiresAt: "2099-01-01T00:00:00.000Z",
  membershipTier: "advanced",
  membershipLabel: "高级会员",
}, {
  credit: 20,
  vipLevel: "",
  vipExpiresAt: "",
  membershipTier: "standard",
  membershipLabel: "普通账号",
});
assert.equal(ordinaryMembership.vipLevel, "", "an authoritative ordinary account must clear a stale raw premium level");
assert.equal(ordinaryMembership.vipExpiresAt, "", "an authoritative ordinary account must clear a stale premium expiry");
assert.equal(ordinaryMembership.membershipTier, "standard");
assert.equal(ordinaryMembership.membershipLabel, "普通账号");
const normalizedOrdinaryRecord = normalizedRecord({
  profileId: "default",
  vipLevel: "",
  membershipTier: "standard",
  membershipLabel: "普通账号",
  creditEstimates: [{ model: "5.0", membership: "ultra", creditCount: 8 }],
});
assert.equal(normalizedOrdinaryRecord.membershipTier, "standard",
  "historical billing membership must not overwrite the current live membership");
assert.equal(normalizedOrdinaryRecord.membershipLabel, "普通账号");

const previousEnvironment = {
  profileId: process.env.SHENSI_DREAMINA_PROFILE_ID,
  expectedUserId: process.env.SHENSI_DREAMINA_EXPECTED_USER_ID,
};
try {
  process.env.SHENSI_DREAMINA_PROFILE_ID = "default";
  process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = "account-1";
  assert.equal(
    assertDreaminaAccountIdentity({ user_id: "account-1" }).credit,
    null,
    "a missing credit field must never be coerced to zero",
  );
} finally {
  if (previousEnvironment.profileId === undefined) delete process.env.SHENSI_DREAMINA_PROFILE_ID;
  else process.env.SHENSI_DREAMINA_PROFILE_ID = previousEnvironment.profileId;
  if (previousEnvironment.expectedUserId === undefined) delete process.env.SHENSI_DREAMINA_EXPECTED_USER_ID;
  else process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = previousEnvironment.expectedUserId;
}

const [oauthSource, appSource] = await Promise.all([
  readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);
assert.match(oauthSource, /rawCredit === ""[\s\S]{0,260}DREAMINA_CREDIT_RESPONSE_INCOMPLETE/u,
  "missing live credit must remain a retryable incomplete response");
assert.match(oauthSource, /verifyLive && credentialExists && !oauthPending[\s\S]{0,120}confirmedLiveIdentity/u,
  "manual refresh must use confirmed live credit reads");
assert.match(oauthSource, /live = await confirmedLiveIdentity\(id\)/u,
  "OAuth completion must not persist a single transient zero");
assert.match(oauthSource, /membershipTier: membershipEntry\.found[\s\S]{0,120}\? "standard"/u,
  "an explicit empty live membership field must clear a stale advanced membership label");
assert.match(oauthSource, /cliGenerationEligible:[\s\S]{0,320}DREAMINA_CLI_MEMBERSHIP_REQUIRED/u,
  "live refresh must expose the provider CLI eligibility verdict separately from the real credit balance");
assert.match(appSource, /account\.cliGenerationEligible === false[\s\S]{0,420}本次未创建任务、未扣积分/u,
  "the desktop must stop an ineligible account before creating a local or provider task");
assert.match(appSource, /ui\.dreaminaStatusReadAt\.set\(`\$\{channel\}:\$\{profileId\}`,[\s\S]{0,80}Date\.now\(\)\)/u,
  "a manual live refresh must make its authoritative eligibility verdict immediately reusable by generation preflight");

const phaseStart = appSource.indexOf("const mediaGenerationPhaseText");
const phaseEnd = appSource.indexOf("const mediaGenerationSettingsForJob", phaseStart);
const phaseSource = appSource.slice(phaseStart, phaseEnd);
assert.match(phaseSource, /safeNoTaskRetry === true[\s\S]{0,420}本次未创建收费任务，正在自动重试/u,
  "safe pre-submit retries must be presented as active retries, not failures");
assert.doesNotMatch(phaseSource, /return `\$\{uiText\("提交失败"\)\}/u,
  "a queued retry must never be labelled as a terminal submission failure");

console.log("Dreamina credit refresh integrity checks passed");
