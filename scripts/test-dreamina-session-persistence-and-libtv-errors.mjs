import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyLibTvCliError, parseLibTvTaskPayload } from "../src/server/media-provider-drivers.mjs";
import { verifiedDreaminaAccountWithControlPlaneFallback } from "../src/cli/dreamina-account-preflight.mjs";

const previous = Object.fromEntries([
  "SHENSI_DREAMINA_PROFILE_ID",
  "SHENSI_DREAMINA_EXPECTED_USER_ID",
  "SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT",
].map((key) => [key, process.env[key]]));

try {
  process.env.SHENSI_DREAMINA_PROFILE_ID = "persistent-test";
  process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = "persistent-user";
  process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT = "persistent-fingerprint";
  const deferred = await verifiedDreaminaAccountWithControlPlaneFallback(async () => {
    throw Object.assign(new Error("authsdk: not logged in"), { code: "DREAMINA_AUTH_REQUIRED" });
  });
  assert.equal(deferred.controlPlaneDeferred, true, "已核验账号的只读 auth 抖动必须延后而不是清空身份");
  assert.equal(deferred.identity.profileId, "persistent-test");

  const capacity = classifyLibTvCliError(Object.assign(new Error('{"code":1200000136,"msg":"算力不足"}'), {
    stdout: '{"code":1200000136,"msg":"算力不足"}',
    stderr: "",
  }));
  assert.equal(capacity.providerErrorCode, "LIBTV_CAPACITY_INSUFFICIENT");
  assert.equal(capacity.submissionOutcomeKnown, true);
  assert.equal(capacity.capacityLimited, true);
  assert.match(capacity.message, /算力不足/u);
  const payloadFailure = parseLibTvTaskPayload({ code: 1200000136, msg: "算力不足" });
  assert.equal(payloadFailure.providerStatus, "failed", "LibTV JSON 错误响应不得被默认当成排队");
  assert.equal(payloadFailure.errorCode, "LIBTV_CAPACITY_INSUFFICIENT");

  const [image, video, driver, worker, oauth] = await Promise.all([
    readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(image, /taskResourceDeferred/u);
  assert.match(video, /taskResourceDeferred/u);
  assert.match(driver, /LIBTV_CAPACITY_INSUFFICIENT/u);
  assert.match(worker, /capability\.taskResourceChecked !== true && capability\.taskResourceDeferred !== true/u);
  assert.match(oauth, /durableIdentityEvidence/u);
  console.log("Dreamina durable read-session fallback and LibTV error classification tests passed");
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
