import assert from "node:assert/strict";
import { verifiedDreaminaAccountForPaidSubmission } from "../src/cli/dreamina-account-preflight.mjs";
import { readFile } from "node:fs/promises";

const names = [
  "SHENSI_DREAMINA_PROFILE_ID",
  "SHENSI_DREAMINA_EXPECTED_USER_ID",
  "SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT",
  "SHENSI_DREAMINA_RUNTIME_STATE",
  "SHENSI_DREAMINA_SAVED_CREDIT",
  "SHENSI_DREAMINA_SAVED_CREDIT_AT",
];
const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
try {
  process.env.SHENSI_DREAMINA_PROFILE_ID = "fixture-profile";
  process.env.SHENSI_DREAMINA_EXPECTED_USER_ID = "fixture-user";
  process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT = "fixture-fingerprint";
  process.env.SHENSI_DREAMINA_RUNTIME_STATE = "verified";
  process.env.SHENSI_DREAMINA_SAVED_CREDIT = "100";
  process.env.SHENSI_DREAMINA_SAVED_CREDIT_AT = new Date().toISOString();
  let readCount = 0;
  const account = await verifiedDreaminaAccountForPaidSubmission(async () => {
    readCount += 1;
    throw new Error("user_credit must not be called for a durable verified profile");
  });
  assert.equal(readCount, 0, "已确认配置的提交前快速路径不得重复调用 user_credit");
  assert.equal(account.preSubmitControlPlaneSkipped, true);
  assert.equal(account.controlPlaneDeferred, true);
  assert.equal(account.identity.profileId, "fixture-profile");
} finally {
  for (const name of names) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
}

const workerSource = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
assert.match(workerSource, /preSubmitTiming:/u, "即梦任务必须持久化提交前分段计时");
assert.match(workerSource, /capabilityProbeStartedAt/u, "即梦任务必须记录能力探测开始时间");
assert.match(workerSource, /providerTaskAcceptedAt/u, "即梦任务必须记录厂商任务 ID 接收时间");
const queueSource = await readFile(new URL("../src/dreamina-task-queue.js", import.meta.url), "utf8");
assert.match(queueSource, /dreaminaPreSubmitTimingLabel/u, "队列必须暴露提交前耗时信息");
console.log("dreamina pre-submit fast path: ok");
