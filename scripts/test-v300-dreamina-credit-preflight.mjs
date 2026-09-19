import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertDreaminaCliGenerationAccess,
  assertDreaminaGenerationCredit,
  dreaminaAvailableCredit,
  dreaminaSavedPositiveCreditEvidence,
  verifiedDreaminaAccountForPaidSubmission,
} from "../src/cli/dreamina-account-preflight.mjs";
import { dreaminaFailureDisplayText } from "../src/dreamina-failure.js";

assert.equal(dreaminaAvailableCredit({ total_credit: 0 }), 0);
assert.equal(dreaminaAvailableCredit({ data: { credits: 37 } }), 37);
assert.equal(dreaminaAvailableCredit({}), null);
assert.doesNotThrow(() => assertDreaminaGenerationCredit({ credit: { total_credit: 1 } }));
assert.doesNotThrow(() => assertDreaminaGenerationCredit({ controlPlaneDeferred: true, credit: {} }));
assert.doesNotThrow(() => assertDreaminaCliGenerationAccess({ credit: { total_credit: 20, vip_level: "maestro" } }));
assert.doesNotThrow(() => assertDreaminaCliGenerationAccess({ controlPlaneDeferred: true, credit: {} }));
assert.throws(
  () => assertDreaminaCliGenerationAccess({ credit: { total_credit: 20, vip_level: "" } }),
  (error) => error.code === "DREAMINA_CLI_MEMBERSHIP_REQUIRED" && error.submissionOutcomeKnown === true,
);
assert.throws(
  () => assertDreaminaGenerationCredit({ credit: { total_credit: 0 } }),
  (error) => error.code === "DREAMINA_INSUFFICIENT_CREDIT" && error.submissionOutcomeKnown === true,
  "zero-credit profiles must fail before a paid submission",
);

const environmentKeys = [
  "SHENSI_DREAMINA_PROFILE_ID",
  "SHENSI_DREAMINA_EXPECTED_USER_ID",
  "SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT",
  "SHENSI_DREAMINA_SAVED_CREDIT",
  "SHENSI_DREAMINA_SAVED_CREDIT_AT",
];
const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
try {
  process.env.SHENSI_DREAMINA_PROFILE_ID = "guobazai";
  process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = "user-guobazai";
  process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT = "verified-fingerprint";
  process.env.SHENSI_DREAMINA_SAVED_CREDIT = "80";
  process.env.SHENSI_DREAMINA_SAVED_CREDIT_AT = new Date().toISOString();
  assert.equal(dreaminaSavedPositiveCreditEvidence()?.credit, 80);
  let reads = 0;
  const conflict = await verifiedDreaminaAccountForPaidSubmission(async () => {
    reads += 1;
    return { total_credit: 0, user_id: "user-guobazai", vip_level: "maestro" };
  }, { retries: 2, retryDelayMs: 0, wait: async () => {} });
  assert.equal(reads, 3, "zero/positive conflict must perform exactly two bounded rechecks");
  assert.equal(conflict.creditSourceConflict, true);
  assert.equal(conflict.creditConflictCode, "DREAMINA_CREDIT_SOURCE_CONFLICT");
  assert.equal(conflict.savedCreditEvidence.credit, 80);
  assert.doesNotThrow(() => assertDreaminaGenerationCredit(conflict),
    "conflicting zero must reach the provider generator for authoritative billing");

  process.env.SHENSI_DREAMINA_SAVED_CREDIT_AT = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString();
  assert.equal(dreaminaSavedPositiveCreditEvidence(), null, "stale saved balance must not bypass a confirmed live zero");
  const stale = await verifiedDreaminaAccountForPaidSubmission(async () => (
    { total_credit: 0, user_id: "user-guobazai", vip_level: "maestro" }
  ), { retries: 2, retryDelayMs: 0, wait: async () => {} });
  assert.equal(stale.creditSourceConflict, undefined);
  assert.throws(() => assertDreaminaGenerationCredit(stale), (error) => error.code === "DREAMINA_INSUFFICIENT_CREDIT");
} finally {
  for (const key of environmentKeys) {
    if (previousEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnvironment[key];
  }
}

const [imageCli, videoCli] = await Promise.all([
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
]);
assert.match(imageCli, /verifiedDreaminaAccountForPaidSubmission/u);
assert.match(videoCli, /verifiedDreaminaAccountForPaidSubmission/u);
assert.match(imageCli, /accountCreditSourceConflict: account\.creditSourceConflict === true/u);
assert.match(videoCli, /accountCreditSourceConflict: account\.creditSourceConflict === true/u);
assert.match(dreaminaFailureDisplayText({ code: "DREAMINA_INSUFFICIENT_CREDIT" }), /积分不足/u);
assert.match(dreaminaFailureDisplayText({ code: "DREAMINA_INSUFFICIENT_CREDIT" }), /处理方法：.*刷新积分/u);
assert.match(dreaminaFailureDisplayText({ code: "DREAMINA_CLI_MEMBERSHIP_REQUIRED" }), /CLI 生成.*会员/u);
assert.match(dreaminaFailureDisplayText({ code: "DREAMINA_CLI_MEMBERSHIP_REQUIRED" }), /不需要重复核验账号/u);

console.log("v3.0 Dreamina zero-credit preflight checks passed");
