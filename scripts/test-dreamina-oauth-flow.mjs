import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [oauth, app, networkProxy] = await Promise.all([
  readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/network-proxy.mjs", import.meta.url), "utf8"),
]);

assert.match(oauth, /const launchProfileBrowser = async/,
  "浏览器启动必须能够等待真实进程事件");
assert.match(oauth, /child\.once\("spawn"/,
  "浏览器启动成功必须由 spawn 事件确认");
assert.match(oauth, /openError:/,
  "找不到浏览器或启动失败必须返回明确原因");
assert.match(oauth, /await launchProfileBrowser\(id, material\.verificationUri, browser\.id\)/,
  "首次 OAuth 必须等待浏览器启动结果");
assert.match(oauth, /await launchProfileBrowser\(id, pending\.verificationUri, pending\.browser\)/,
  "重新打开 OAuth 必须等待浏览器启动结果");

const completionStart = app.indexOf("const applyDreaminaOAuthCompletionStatus");
const completionEnd = app.indexOf("const refreshCurrentDreaminaCredit", completionStart);
assert.ok(completionStart >= 0 && completionEnd > completionStart,
  "前端必须存在 OAuth 完成状态回写函数");
const completionSource = app.slice(completionStart, completionEnd);
assert.match(completionSource, /state: "verified"/,
  "OAuth 完成必须立即标记为已核验");
assert.match(completionSource, /expectedUserId: userId/,
  "OAuth 完成必须回写账号 ID");
assert.match(completionSource, /ui\.dreaminaAccountStatuses = statuses/,
  "OAuth 完成必须更新当前会话状态表");

const finishStart = app.indexOf("const finishDreaminaOAuth");
const finishEnd = app.indexOf("const dreaminaVerificationTasks", finishStart);
const finishSource = app.slice(finishStart, finishEnd);
assert.match(finishSource, /applyDreaminaOAuthCompletionStatus\(payload, verificationChannel\)/,
  "OAuth 完成必须先回写当前状态再刷新面板");
assert.match(finishSource, /refreshDreaminaAccountStatus\(\{ verifyLive: false, profileId, channel: verificationChannel \}\)/,
  "状态面板刷新必须沿用正确的图片/视频频道");
assert.match(finishSource, /if \(refreshed\?\.state !== "verified"\) applyDreaminaOAuthCompletionStatus/,
  "旧状态刷新不得覆盖刚完成的已核验结果");

const startStart = app.indexOf("const startDreaminaProfileVerification");
const startEnd = app.indexOf("const openDreaminaReverifyDialog", startStart);
const startSource = app.slice(startStart, startEnd);
assert.match(startSource, /payload\.opened !== true/,
  "前端不得把浏览器未打开当成 OAuth 启动成功");
assert.match(startSource, /let reopened = false/,
  "重新打开授权页必须有明确成功状态");
assert.match(startSource, /return reopened/,
  "重新打开失败必须向调用方返回失败");
assert.match(startSource, /payload\.replacedExpiredTransaction[\s\S]{0,300}dreaminaVerificationDeadlineOverrides\.set/u,
  "重新打开时若厂商 device code 已过期，前端必须接管新事务的截止时间");
assert.match(app, /const effectiveDeadline = \(\) => Math\.max\(deadline, Number\(dreaminaVerificationDeadlineOverrides\.get\(profileId\)\) \|\| 0\)/u,
  "新授权事务必须延长当前 profile 的自动完成轮询，不能继续使用旧截止时间");

const ensureStart = app.indexOf("const ensureDreaminaGenerationAccountAvailable");
const ensureEnd = app.indexOf('document.querySelector("#bindDreaminaAccount")', ensureStart);
const ensureSource = app.slice(ensureStart, ensureEnd);
assert.match(ensureSource, /const visiblyUnverified = dreaminaAccountRequiresVerification\(account\)/,
  "生成前遇到旧的未核验状态必须显示当前 profile 的核验提示");
assert.match(ensureSource, /const refreshed = await refreshDreaminaAccountStatus\(\{ verifyLive: true, profileId, channel \}\)/,
  "每次收费生成前必须绑定当前 profile 和频道执行在线状态核验");

assert.match(networkProxy, /ECONNREFUSED/,
  "网络连接失败分类必须保留，不得与即梦授权失败混淆");

console.log("Dreamina OAuth launch and immediate verification regression checks passed");
