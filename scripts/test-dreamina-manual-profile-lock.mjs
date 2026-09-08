import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  dreaminaCliProfileId,
  dreaminaCancellationReconciliationExpired,
  dreaminaProfileSwitchDecision,
  dreaminaProfileSwitchMessage,
} from "../src/dreamina-manual-profile-policy.js";

assert.equal(dreaminaCliProfileId({}), "", "空配置不得借用柏物语");
assert.equal(dreaminaCliProfileId({ connectionId: "default" }), "", "连接 ID 不得冒充即梦账号 ID");
assert.equal(dreaminaCliProfileId({ dreaminaCliProfile: "default" }), "default", "显式 default 仍表示柏物语");
assert.equal(dreaminaProfileSwitchDecision({ jobs: [], requestedProfileId: "" }).reason, "profile_required");

const job = ({ profileId = "account-a", status = "running", appliedAt = "", provider = "即梦", adapter = "cli", billingRisk = "", providerStatus = "", cancelRequestedAt = "", updatedAt = "", profileIdentityKey = "", desiredAction = "", userStoppedAt = "" } = {}) => ({
  id: `generation-${profileId}-${status}`,
  channel: "image",
  status,
  appliedAt,
  billingRisk,
  providerStatus,
  cancelRequestedAt,
  updatedAt,
  desiredAction,
  userStoppedAt,
  ...(profileIdentityKey ? { profileIdentityKey } : {}),
  request: { settings: { provider, adapter, dreaminaCliProfile: profileId, remarkName: profileId } },
});

assert.deepEqual(dreaminaProfileSwitchDecision({ jobs: [], requestedProfileId: "account-a" }), {
  allowed: true,
  queuedBehindCurrent: false,
  activeProfileId: "",
  blockingJobId: "",
});

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a" })],
  requestedProfileId: "account-a",
}).allowed, true, "同一即梦配置应允许在其他卡片继续提交并进入串行队列");

const blocked = dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a" })],
  requestedProfileId: "account-b",
});
assert.equal(blocked.allowed, false, "当前账号有任务时必须阻止切换另一即梦配置");
assert.equal(blocked.activeProfileId, "account-a");
assert.match(dreaminaProfileSwitchMessage(blocked), /只有一个共享凭证锁/u);
assert.match(dreaminaProfileSwitchMessage(blocked), /其他即梦配置暂时无法生成/u);
assert.match(dreaminaProfileSwitchMessage(blocked), /非即梦配置不受影响/u);

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "alias-a", profileIdentityKey: "user:account-1" })],
  requestedProfileId: "alias-b",
  requestedCredentialIdentity: "user:account-1",
}).allowed, true, "同一真实账号绑定不同配置名时不得互相阻塞");
assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "alias-a", profileIdentityKey: "user:account-1" })],
  requestedProfileId: "alias-a",
  requestedCredentialIdentity: "user:account-2",
}).allowed, false, "同一配置名实际绑定另一账号时必须阻塞切换");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a", status: "complete", appliedAt: "" })],
  requestedProfileId: "account-b",
}).allowed, true, "厂商任务成功后，本地卡片回写不得继续占用即梦凭据锁");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a", status: "complete", appliedAt: "2026-08-23T10:00:00.000Z" })],
  requestedProfileId: "account-b",
}).allowed, true, "结果已经回写卡片后可以切换账号");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a", status: "failed", providerStatus: "failed", billingRisk: "submission_outcome_unknown" })],
  requestedProfileId: "account-b",
}).allowed, true, "已经明确失败的任务不得因为旧风险标记继续占用凭据锁");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a", status: "cancel_requested", cancelRequestedAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z" })],
  requestedProfileId: "account-b",
  nowMs: Date.parse("2026-08-24T01:00:00.000Z"),
}).allowed, true, "长期无法核验的旧取消任务必须从配置切换门禁中过期释放");
assert.equal(dreaminaCancellationReconciliationExpired(
  job({ profileId: "account-a", status: "cancel_requested", cancelRequestedAt: "2026-07-28T00:00:00.000Z", updatedAt: "2026-08-24T00:59:59.000Z" }),
  { nowMs: Date.parse("2026-08-24T01:00:00.000Z") },
), true, "后台反复更新 updatedAt 不能无限延长取消核验窗口");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a", status: "cancel_requested", cancelRequestedAt: "2026-08-24T00:55:00.000Z" })],
  requestedProfileId: "account-b",
  nowMs: Date.parse("2026-08-24T01:00:00.000Z"),
}).allowed, true, "用户主动取消后必须立即释放配置切换权，后台核验不得继续占用门禁");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a", status: "waiting_credentials", desiredAction: "cancel", userStoppedAt: "2026-08-24T00:55:00.000Z" })],
  requestedProfileId: "account-b",
}).allowed, true, "取消核验转入凭据等待后也不得重新占用即梦切换门禁");

assert.equal(dreaminaProfileSwitchDecision({
  jobs: [job({ profileId: "account-a", provider: "OpenAI" })],
  requestedProfileId: "account-b",
}).allowed, true, "其他厂商任务不得占用即梦账号切换门禁");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const data = await readFile(new URL("../src/data.js", import.meta.url), "utf8");
const projectStatus = await readFile(new URL("../src/project-status.js", import.meta.url), "utf8");
const structureLanguage = await readFile(new URL("../src/structure-language.js", import.meta.url), "utf8");
const workspace = await readFile(new URL("../src/server/workspace.mjs", import.meta.url), "utf8");
const server = await readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8");
assert.doesNotMatch(app, /selectDreaminaAccountCandidate/u, "生成界面不得继续调用自动账号池选择器");
assert.doesNotMatch(app, /即梦 · 自动账号池/u, "生成界面不得继续显示自动账号池");
assert.match(server, /DREAMINA_PROFILE_SWITCH_BLOCKED/u, "服务端必须有跨账号并发的最终门禁");
assert.match(app, /当前即梦配置暂时无法生成/u, "跨即梦配置冲突必须使用可见弹窗提示");
assert.match(app, /openDreaminaProfileLockDialog\(error\.details \|\| \{\}\)/u, "图片和视频生成必须把服务端凭证锁冲突转换为弹窗");
assert.match(app, /setWhiteboardGenerationSubmitBusy\(elements\.whiteboardImageForm, whiteboardMediaSubmissionLocks\.has\(whiteboardMediaSubmissionKey\(\{ channel: "image", nodeId \}\)\)\)/u, "切换到另一图片卡片时必须按目标任务重置按钮，不能沿用上一张卡片的禁用态");
assert.match(app, /setWhiteboardGenerationSubmitBusy\(elements\.whiteboardVideoForm, whiteboardMediaSubmissionLocks\.has\(whiteboardMediaSubmissionKey\(\{ channel: "video", nodeId \}\)\)\)/u, "切换到另一视频卡片时必须按目标任务重置按钮");
const imageSubmitBlock = app.slice(
  app.indexOf('whiteboardImageForm.addEventListener("submit"'),
  app.indexOf('whiteboardVideoSettingsTrigger.addEventListener', app.indexOf('whiteboardImageForm.addEventListener("submit"')),
);
const imageEmptyPromptIndex = imageSubmitBlock.indexOf('showToast("请先输入画面描述")');
const imageLockIndex = imageSubmitBlock.indexOf("acquireWhiteboardMediaSubmissionLock");
assert.ok(imageEmptyPromptIndex >= 0 && imageLockIndex > imageEmptyPromptIndex, "图片空提示词必须先给出明确提示，不能先占用卡片锁");
const videoSubmitBlock = app.slice(
  app.indexOf('whiteboardVideoForm.addEventListener("submit"'),
  app.indexOf('whiteboardLandForm.addEventListener("submit"', app.indexOf('whiteboardVideoForm.addEventListener("submit"')),
);
const videoEmptyPromptIndex = videoSubmitBlock.indexOf('showToast("请先输入画面描述")');
const videoLockIndex = videoSubmitBlock.indexOf("acquireWhiteboardMediaSubmissionLock");
assert.ok(videoEmptyPromptIndex >= 0 && videoLockIndex > videoEmptyPromptIndex, "视频空提示词必须先给出明确提示，不能静默返回");
assert.match(app, /if \(action === "cancel"\) \{[\s\S]{0,800}window\.confirm[\s\S]{0,420}releaseWhiteboardMediaSubmissionLockForJob\(current\);[\s\S]{0,260}fetch\(`/u, "确认终止后必须先释放当前卡片按钮，再等待厂商取消回执");
assert.match(app, /job\.target\?\.nodeId && \(userStopped \|\| !whiteboardMediaJobHoldsCard\(job\)\)[\s\S]{0,120}releaseWhiteboardMediaSubmissionLockForJob\(job\)/u, "完成、失败、终止或放弃后必须统一释放当前卡片锁");
assert.doesNotMatch(data, /当前编译状态/u, "项目总览文档的固定标题必须与导航名称一致");
assert.match(data, /\["report-compile", "项目总览"\]/u);
assert.match(projectStatus, /<h1>项目总览<\/h1>/u);
assert.match(app, /state\.activeDocument = rememberedModuleDocument\(\{[\s\S]{0,260}\}\) \|\| documentIds\[0\] \|\| null/u,
  "任意板块都必须优先恢复上次位置；首次进入时统一打开目录最上方文档");
assert.match(app, /ui\.documentPreviewKey = substantiveManuscriptDocumentIds\(\)\.includes\(documentId\)[\s\S]{0,100}currentDocumentPreviewKey/u,
  "重启恢复到已有正文时必须继续进入正文预览");
assert.doesNotMatch(app, /const projectEntryDocumentId/u, "应用重启恢复工作区时不能覆盖上次最后打开的文档");
assert.match(app, /const documentId = pointer\?\.activeDocument && state\.documents\[pointer\.activeDocument\]/u, "重启恢复必须优先采用已保存的活动文档指针");
assert.match(app, /preserveActiveDocumentId:\s*preservedActiveDocument/u, "工作区外部刷新必须保留当前活动文档");
assert.match(structureLanguage, /"report-compile":\s*"Project Overview"/u, "英文结构标题必须与项目总览一致");
assert.match(workspace, /"report-compile":\s*join\("07_编译报告",\s*"项目总览\.md"\)/u, "项目总览必须使用统一的规范文件名");

console.log("即梦手动配置选择与凭据锁门禁测试通过");
