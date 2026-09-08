import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dreaminaOAuthFinalizationDisposition } from "../src/server/dreamina-profile-oauth.mjs";

const approvedAt = Date.parse("2026-09-05T01:00:00.000Z");
const pending = { providerApprovedAt: new Date(approvedAt).toISOString() };

assert.deepEqual([
  dreaminaOAuthFinalizationDisposition({
    pending,
    live: { ok: false, transient: true, code: "DREAMINA_PROFILE_BROKER_BUSY" },
    nowMs: approvedAt + 1_000,
  }),
  dreaminaOAuthFinalizationDisposition({
    pending,
    live: { ok: true, userId: "guobazai-user" },
    nowMs: approvedAt + 2_000,
  }),
], ["defer", "complete"], "checklogin 成功后首次回读 busy，第二次成功时必须保留并完成同一事务");

assert.equal(dreaminaOAuthFinalizationDisposition({
  pending,
  live: { ok: false, transient: false, code: "DREAMINA_AUTH_REQUIRED" },
  nowMs: approvedAt + 5 * 60_000,
}), "defer", "供应商已接受授权后，宽限期内的暂时未登录不得恢复旧凭据");

assert.equal(dreaminaOAuthFinalizationDisposition({
  pending,
  live: { ok: false, transient: false, code: "DREAMINA_AUTH_REQUIRED" },
  nowMs: approvedAt + 10 * 60_000,
}), "rollback", "宽限期结束后仍明确未登录才允许恢复旧凭据");

assert.equal(dreaminaOAuthFinalizationDisposition({
  pending: {},
  live: { ok: false, transient: false, code: "DREAMINA_AUTH_REQUIRED" },
  nowMs: approvedAt + 1_000,
}), "rollback", "没有供应商授权成功证据时不得伪造宽限期");

const source = await readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8");
assert.match(source,
  /const finalizationDisposition = dreaminaOAuthFinalizationDisposition\(\{ pending, live \}\);[\s\S]{0,1500}restoreCredentialBackup\(id, pending\)/u,
  "OAuth 完成流程必须先经过有界宽限状态机，之后才允许回滚凭据");
assert.match(source,
  /providerApprovedAt: new Date\(\)\.toISOString\(\)[\s\S]{0,900}liveIdentity\(id\)/u,
  "checklogin 成功证据必须先持久化，再执行可能撞锁的身份回读");
assert.doesNotMatch(source, /invokeProfile\(profileId, \["login", "--headless"\]/u,
  "OAuth 成功后的身份回读不得启动新的 Device Flow 并覆盖刚写入的凭据");

console.log("Dreamina OAuth finalization grace regression checks passed");
