import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  cachedDreaminaAccountIdentity,
  dreaminaControlPlaneFailureIsTransient,
  verifiedDreaminaAccountWithControlPlaneFallback,
} from "../src/cli/dreamina-account-preflight.mjs";
import { durableProviderPollDelayMs, providerTerminalStatus } from "../src/media-provider-poll-policy.js";

const previous = Object.fromEntries([
  "SHENSI_DREAMINA_PROFILE_ID",
  "SHENSI_DREAMINA_EXPECTED_USER_ID",
  "SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT",
].map((key) => [key, process.env[key]]));

try {
  process.env.SHENSI_DREAMINA_PROFILE_ID = "chenan";
  process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = "user-chen";
  process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT = "fingerprint-chen";
  assert.equal(cachedDreaminaAccountIdentity()?.userId, "user-chen");
  assert.equal(dreaminaControlPlaneFailureIsTransient(Object.assign(new Error("Dreamina CLI 命令 user_credit 超过 45 秒未响应"), { code: "DREAMINA_CREDIT_QUERY_TIMEOUT" })), true);
  const fallback = await verifiedDreaminaAccountWithControlPlaneFallback(async () => {
    throw Object.assign(new Error("user_credit timeout"), { code: "DREAMINA_CREDIT_QUERY_TIMEOUT" });
  });
  assert.equal(fallback.controlPlaneDeferred, true);
  assert.equal(fallback.identity.profileId, "chenan");
  await assert.rejects(
    verifiedDreaminaAccountWithControlPlaneFallback(async () => { throw Object.assign(new Error("账号不匹配"), { code: "DREAMINA_ACCOUNT_MISMATCH" }); }),
    (error) => error.code === "DREAMINA_ACCOUNT_MISMATCH",
  );
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}

const now = Date.parse("2026-08-15T12:00:00.000Z");
assert.equal(durableProviderPollDelayMs({ submittedAt: new Date(now - 30_000).toISOString() }, "queued", now), 8_000);
assert.equal(durableProviderPollDelayMs({ submittedAt: new Date(now - 20 * 60_000).toISOString() }, "queued", now), 60_000);
assert.equal(durableProviderPollDelayMs({ submittedAt: new Date(now - 2 * 60 * 60_000).toISOString() }, "queued", now), 5 * 60_000);
assert.equal(durableProviderPollDelayMs({ submittedAt: new Date(now - 8 * 60 * 60_000).toISOString() }, "queued", now), 10 * 60_000);
assert.equal(providerTerminalStatus("queued"), false);
assert.equal(providerTerminalStatus("completed"), true);

const [worker, drivers, imageBridge, videoBridge, app] = await Promise.all([
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);

assert.match(worker, /One durable provider observation per worker invocation/);
assert.match(worker, /providerControlPlaneTransient/);
assert.match(worker, /current\.providerTaskId \|\| dreaminaSubmissionRecoveryPending \? "retry_required" : "failed"/, "查询失败达到上限时保留原任务、等待用户处理，不能无限轮询");
assert.match(worker, /providerExecutionReceipt/);
assert.match(drivers, /cachedDreaminaCapability/);
assert.match(drivers, /\(pollCount \+ 1\) % 120 === 0/);
assert.match(imageBridge, /verifiedDreaminaAccountWithControlPlaneFallback/);
assert.match(videoBridge, /verifiedDreaminaAccountWithControlPlaneFallback/);
assert.doesNotMatch(imageBridge, /const beforeTaskIds = \(await listTasks\(\)\)/);
assert.doesNotMatch(videoBridge, /const beforeTaskIds = \(await listTasks\(\)\)/);
assert.match(app, /Opening a generation type is an explicit new intent/);
assert.match(app, /if \(card && event\.detail === 1\) scheduleWhiteboardCardOpen/);

console.log("v2.16.7 Dreamina durable queue and toolbar regression checks passed");
