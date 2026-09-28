import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  dreaminaFailureDiagnosis,
  dreaminaFailureRequiresAccountVerification,
} from "../src/dreamina-failure.js";
import { dreaminaProfileSwitchMessage } from "../src/dreamina-manual-profile-policy.js";
import { markDreaminaPreSubmitNoTask } from "../src/cli/dreamina-account-preflight.mjs";
import { classifyMediaSubmissionFailure } from "../src/server/media-submission-recovery.mjs";

const runChild = (executable, args, env) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(executable, args, { cwd: fileURLToPath(new URL("..", import.meta.url)), env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", rejectRun);
  child.on("close", (code) => resolveRun({ code, stdout, stderr }));
});

const generationRejected = dreaminaFailureDiagnosis({
  code: "DREAMINA_GENERATION_SESSION_REJECTED",
  message: "authsdk: not logged in",
  submissionState: "submitting",
});
assert.equal(generationRejected.requiresAccountVerification, false, "生成阶段会话异常不得再次要求 OAuth 核验");
assert.equal(generationRejected.category, "submission_outcome_unknown");
assert.match(generationRejected.resolution, /幂等记录|不会重复提交|手动终止/u);
const generationAuthRequired = dreaminaFailureDiagnosis({
  code: "DREAMINA_GENERATION_AUTH_REQUIRED",
  message: "即梦生成端点明确返回当前配置未登录，且本次没有返回厂商任务编号",
  submissionState: "submitting",
});
assert.equal(generationAuthRequired.requiresAccountVerification, true,
  "无任务号且明确未登录的生成结果必须进入当前配置核验");
assert.match(generationAuthRequired.resolution, /核验.*重新提交/u);
assert.equal(dreaminaFailureRequiresAccountVerification({
  code: "DREAMINA_PROVIDER_TASK_AUTH_FAILURE",
  message: "authsdk: not logged in",
  providerTaskId: "provider-task-kept",
}), false, "已有任务的厂商内部 auth 错误不得伪装成账号失效");
assert.match(dreaminaProfileSwitchMessage({
  reason: "submission_outcome_unknown",
  activeProfileId: "default",
}), /凭证锁已经释放/u);
assert.match(dreaminaProfileSwitchMessage({
  reason: "submission_outcome_unknown",
  activeProfileId: "default",
  channel: "image",
}), /一次图片提交/u);
const markedPreSubmitFailure = markDreaminaPreSubmitNoTask(Object.assign(new Error("list_task timeout"), { code: "DREAMINA_QUERY_TRANSIENT" }));
assert.equal(markedPreSubmitFailure.submissionOutcomeKnown, true);
assert.equal(markedPreSubmitFailure.preSubmitNoTask, true);
const safePreSubmitRetry = classifyMediaSubmissionFailure({
  job: { status: "submitting", channel: "image", transientFailures: 0 },
  error: markedPreSubmitFailure,
});
assert.equal(safePreSubmitRetry.submissionUnknown, false, "付费命令前失败不得误判为厂商可能已受理");
assert.equal(safePreSubmitRetry.safeAutomaticRetry, true, "付费命令前的临时查询失败应保留同一幂等键自动重试");

const [runner, videoCli, driver, worker, app, oauth, identityStore] = await Promise.all([
  readFile(new URL("../scripts/windows/dreamina-profile-runner.ps1", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/dreamina-profile-oauth.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/dreamina-profile-identity-store.mjs", import.meta.url), "utf8"),
]);
assert.match(runner, /DREAMINA_GENERATION_SESSION_REJECTED/u);
assert.match(runner, /Test-DreaminaTaskIdentityOutput/u);
assert.match(videoCli, /DREAMINA_GENERATION_SESSION_REJECTED/u);
assert.match(videoCli, /DREAMINA_GENERATION_AUTH_REQUIRED/u);
assert.match(videoCli, /DREAMINA_PROVIDER_TASK_AUTH_FAILURE/u);
assert.match(videoCli, /dreaminaTaskIdInText/u);
assert.match(videoCli, /non-control commands containing `video`/u);
assert.match(driver, /providerTaskIdFromOutput/u);
assert.match(driver, /rawMarkedCode === "DREAMINA_GENERATION_SESSION_REJECTED"[\s\S]{0,180}DREAMINA_GENERATION_AUTH_REQUIRED/u,
  "旧版无任务号鉴权标记必须在驱动边界归一为明确核验，而不是未知提交");
assert.match(driver, /DREAMINA_PROVIDER_TASK_AUTH_FAILURE/u);
assert.match(driver, /DREAMINA_PRE_SUBMIT_NO_TASK/u);
assert.match(driver, /preSubmitNoTask\) error\.submissionOutcomeKnown = true/u);
assert.match(worker, /errorProviderTaskId/u);
assert.match(worker, /providerStatus: providerCode\.toUpperCase\(\) === "DREAMINA_PROVIDER_TASK_AUTH_FAILURE"[\s\S]{0,120}\? "failed"/u);
assert.match(worker, /dreaminaSubmissionRecoveryPending[\s\S]{0,600}DREAMINA_SUBMISSION_UNCERTAIN/u);
assert.match(worker, /dreaminaReconciliationDeferredByProfileLock[\s\S]{0,2200}另一即梦配置正在生成，本次只读找回已延后/u,
  "未知提交的只读找回遇到其他配置占锁时必须延后，不能被改写为失败");
assert.match(worker, /dreaminaReconciliationDeferredByProfileLock[\s\S]{0,1800}submissionState: "uncertain"[\s\S]{0,500}billingRisk: "submission_outcome_unknown"/u,
  "临时配置锁冲突必须保留原提交不确定性和计费保护");
assert.match(worker, /recordDreaminaProfileGenerationSuccess/u,
  "真实生成成功必须写入该即梦配置的最高可信可用证据");
assert.match(worker, /const dreaminaCapabilityProbeRequiresFresh[\s\S]{0,900}runtimeState[\s\S]{0,180}verified/u,
  "未知或明确失效配置必须由持久状态决定是否需要新探测");
assert.match(worker, /forceFresh: dreaminaCapabilityProbeRequiresFresh\(job, settings\)/u,
  "已真实生成成功的配置不得每次任务都强制重复探测");
assert.match(oauth, /runtimeAuthRequired = expected\.runtimeState === "auth_required"/u,
  "状态读取必须消费同一配置的明确 auth_required 证据");
assert.match(oauth, /runtimeState: "verified"[\s\S]{0,420}lastAuthFailureAt: ""/u,
  "OAuth 成功必须清除同一配置旧的 auth_required 标记");
assert.match(app, /String\(account\.runtimeState \|\| ""\) === "auth_required"/u,
  "生成前置检查必须阻止复用明确失效的即梦配置");
assert.match(app, /String\(account\?\.runtimeState \|\| ""\) !== "auth_required"[\s\S]{0,180}account\?\.state === "verified"/u,
  "生成前置检查不得让旧的 state=verified 快照绕过明确 auth_required 状态");
assert.match(app, /String\(account\.runtimeState \|\| ""\) !== "auth_required"/u,
  "持久身份判断不得把明确失效配置当作可用");
assert.match(identityStore, /runtimeState: "verified"[\s\S]{0,500}lastAuthFailureCode: ""/u,
  "真实生成成功必须清理持久化的旧鉴权失败标记");
assert.match(identityStore, /runtimeState: "auth_required"[\s\S]{0,300}stateReason: "explicit_auth_failure"/u,
  "只有明确鉴权失败才允许写入 auth_required");
assert.doesNotMatch(worker, /recordDreaminaProfileGenerationSuccess\(\{[\s\S]{0,260}browserSessionId: executionReceipt\.verificationSource/u,
  "生成证据来源不得覆盖 OAuth 绑定的浏览器会话隔离键");
assert.doesNotMatch(worker, /recordDreaminaProfileAuthFailure\(\{[\s\S]{0,280}providerExecutionReceipt\?\.verificationSource/u,
  "鉴权失败证据来源不得覆盖 OAuth 绑定的浏览器会话隔离键");
assert.match(app, /promptDreaminaSubmissionBlockForJob/u);
assert.match(app, /DREAMINA_PROFILE_SWITCH_BLOCKED/u);
assert.match(app, /!\["complete", "cancelled"\]\.includes\(jobStatus\)/u,
  "失败的锁冲突任务仍必须显示可操作的占用任务入口；成功或取消任务不得重复弹出");
assert.match(app, /showInterruptedConversationMediaJob\(job, \{ allowLockDialog: false \}\)/u,
  "启动恢复对话媒体任务时不得重放历史即梦锁弹窗");
assert.match(app, /showInterruptedDocumentArtifactJob\(job, \{ allowLockDialog: false \}\)/u,
  "启动恢复文档媒体任务时不得重放历史即梦锁弹窗");
assert.match(app, /showInterruptedWhiteboardGenerationJob\(job, \{ allowLockDialog: false \}\)/u,
  "启动恢复白板媒体任务时不得重放历史即梦锁弹窗");
assert.match(app, /promptDreaminaReverificationForJob = \(job, \{ allowPrompt = true \}/u,
  "历史任务恢复必须能够显式禁止自动弹出核验窗口");
assert.match(app, /promptDreaminaReverificationForJob\(job, \{ allowPrompt: allowLockDialog \}\)/u,
  "只有当前任务进入阻塞时才允许显示即梦核验入口");
assert.match(worker, /taskSessionExpired[\s\S]{0,700}return false/u,
  "任务号已存在时的 session 过期只能进入任务级续查，不得污染配置核验状态");
assert.match(app, /凭证锁已经释放，不影响新的生成/u);
assert.doesNotMatch(app, /已暂停新的提交；请查看占用任务/u);

const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-dreamina-generation-runtime-"));
const fakeCliPath = join(runtimeRoot, "fake-dreamina-generation.mjs");
const promptPath = join(runtimeRoot, "prompt.txt");
await writeFile(promptPath, "测试一段不会触发任务号解析误判的提示词", "utf8");
await writeFile(fakeCliPath, `
const args = process.argv.slice(2);
const operation = String(args[0] || "");
const mode = String(process.env.SHENSI_TEST_DREAMINA_GENERATION_MODE || "");
if (operation === "user_credit") {
  if (mode === "control-auth") {
    process.stderr.write("authsdk: not logged in\\n");
    process.exit(1);
  }
  if (mode === "membership-required") {
    process.stdout.write(JSON.stringify({ user_id: "2842687099901300", total_credit: 20, vip_level: "" }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ user_id: "2842687099901300", total_credit: 837, vip_level: "1" }));
  process.exit(0);
}
if (operation === "list_task") {
  if (mode === "preflight-list-failure") {
    process.stderr.write("[DREAMINA_QUERY_TRANSIENT] temporary list_task timeout\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ status: "submit", data: [] }));
  process.exit(0);
}
if (operation === "text2video") {
  if (mode === "task-auth") {
    process.stdout.write(JSON.stringify({ status: "failed", submit_id: "fixture-task-auth-123", fail_reason: "authsdk: not logged in" }));
    process.stderr.write("authsdk: not logged in\\n");
    process.exit(1);
  }
  if (mode === "task-auth-stderr") {
    process.stdout.write(JSON.stringify({ status: "failed", fail_reason: "authsdk: not logged in" }));
    process.stderr.write("submit_id=fixture-task-auth-stderr-123 authsdk: not logged in\\n");
    process.exit(1);
  }
  if (mode === "no-task-auth") {
    process.stderr.write("authsdk: not logged in\\n");
    process.exit(1);
  }
  if (mode === "placeholder-auth") {
    process.stdout.write(JSON.stringify({ status: "failed", submit_id: "none", fail_reason: "authsdk: not logged in" }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ status: "submit", submit_id: "fixture-task-success-123" }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ status: "ok" }));
`, "utf8");
const videoCliPath = fileURLToPath(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url));
const baseRuntimeEnv = {
  ...process.env,
  SHENSI_DREAMINA_PROFILE_ID: "default",
  SHENSI_DREAMINA_EXPECTED_USER_ID: "2842687099901300",
  SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT: "fixture-fingerprint",
  SHENSI_DREAMINA_EXECUTABLE: process.execPath,
  SHENSI_DREAMINA_PREFIX_ARGS: JSON.stringify([fakeCliPath]),
  SHENSI_MEDIA_PROVIDER_STATE_ROOT: runtimeRoot,
  SHENSI_DREAMINA_AUTH_RETRIES: "0",
  SHENSI_DREAMINA_UPLOAD_RETRIES: "0",
  SHENSI_DREAMINA_AUTH_RETRY_DELAY_MS: "1",
};
try {
  const taskAuth = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-task-auth-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "task-auth" });
  assert.equal(taskAuth.code, 0, `带真实任务号的生成阶段 auth 不应让提交进程失败：${taskAuth.stderr}`);
  const taskAuthPayload = JSON.parse(taskAuth.stdout.trim());
  assert.equal(taskAuthPayload.providerTaskId, "fixture-task-auth-123");
  assert.equal(taskAuthPayload.errorCode, "DREAMINA_PROVIDER_TASK_AUTH_FAILURE");

  const taskAuthStderr = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-task-auth-stderr-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "task-auth-stderr" });
  assert.equal(taskAuthStderr.code, 0, `stderr 中带真实任务号时也必须保留提交：${taskAuthStderr.stderr}`);
  const taskAuthStderrPayload = JSON.parse(taskAuthStderr.stdout.trim());
  assert.equal(taskAuthStderrPayload.providerTaskId, "fixture-task-auth-stderr-123");
  assert.equal(taskAuthStderrPayload.errorCode, "DREAMINA_PROVIDER_TASK_AUTH_FAILURE");

  const noTaskAuth = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-no-task-auth-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "no-task-auth" });
  assert.notEqual(noTaskAuth.code, 0, "无任务号的生成阶段 auth 必须显式失败");
  assert.match(noTaskAuth.stderr, /DREAMINA_GENERATION_AUTH_REQUIRED/u,
    "无任务号且明确未登录时必须进入当前配置核验语义");

  const placeholderAuth = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-placeholder-auth-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "placeholder-auth" });
  assert.notEqual(placeholderAuth.code, 0);
  assert.match(placeholderAuth.stderr, /DREAMINA_GENERATION_AUTH_REQUIRED/u, "none 等占位任务号不得绕过生成阶段鉴权保护");

  const controlAuth = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-control-auth-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "control-auth" });
  assert.equal(controlAuth.code, 0, `已有持久化身份时，控制面短暂未登录应交给真实生成端点最终判断：${controlAuth.stderr}`);
  const controlAuthPayload = JSON.parse(controlAuth.stdout.trim());
  assert.equal(controlAuthPayload.providerTaskId, "fixture-task-success-123");
  assert.equal(controlAuthPayload.accountControlPlaneDeferred, true,
    "控制面降级必须在回执中明确标记，不能伪装成实时核验成功");

  const preflightListFailure = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-preflight-list-failure-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "preflight-list-failure" });
  assert.notEqual(preflightListFailure.code, 0, "任务资源只读检查失败时不得进入付费提交");
  assert.match(preflightListFailure.stderr, /\[DREAMINA_PRE_SUBMIT_NO_TASK\]/u, "提交前失败必须跨子进程保留未创建厂商任务的事实");
  assert.match(preflightListFailure.stderr, /\[DREAMINA_QUERY_TRANSIENT\]/u);

  const membershipRequired = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-membership-required-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "membership-required" });
  assert.notEqual(membershipRequired.code, 0, "有积分但无 CLI 会员权限时必须在付费提交前停止");
  assert.match(membershipRequired.stderr, /\[DREAMINA_PRE_SUBMIT_NO_TASK\]/u);
  assert.match(membershipRequired.stderr, /\[DREAMINA_CLI_MEMBERSHIP_REQUIRED\]/u);
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
}

const root = await mkdtemp(join(tmpdir(), "shensi-dreamina-generation-auth-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;
try {
  const {
    createMediaGenerationJob,
    listDreaminaProfileBlockingJobs,
    listMediaGenerationJobsForWorker,
    readGenerationJobForWorker,
    updateMediaGenerationJob,
  } = await import("../src/server/generation-job-store.mjs");
  const job = await createMediaGenerationJob({
    channel: "video",
    target: {
      workspaceKind: "project",
      workspacePath: root,
      documentId: "legacy-auth-document",
      nodeId: "legacy-auth-node",
      targetType: "whiteboard-node",
    },
    request: {
      prompt: "legacy auth migration test",
      settings: {
        id: "video-default",
        connectionId: "video-default",
        provider: "即梦",
        adapter: "cli",
        protocol: "videos",
        model: "seedance2.5",
        dreaminaCliProfile: "default",
      },
    },
  });
  await updateMediaGenerationJob({
    jobId: job.id,
    patch: {
      status: "waiting_credentials",
      providerStatus: "failed",
      providerErrorCode: "DREAMINA_AUTH_REQUIRED",
      submissionState: "submitting",
      attempt: 1,
      error: "authsdk: not logged in during multimodal2video",
    },
  });
  await listMediaGenerationJobsForWorker();
  const migrated = await readGenerationJobForWorker({ jobId: job.id });
  assert.equal(migrated.status, "retry_required");
  assert.equal(migrated.providerStatus, "reconciling");
  assert.equal(migrated.providerErrorCode, "DREAMINA_SUBMISSION_UNCERTAIN");
  assert.equal(migrated.submissionState, "uncertain");
  assert.equal(migrated.billingRisk, "submission_outcome_unknown");
  assert.equal(migrated.safeNoTaskRetry, false);
  const occupants = await listDreaminaProfileBlockingJobs();
  assert.equal(occupants.some((item) => item.id === job.id), false, "不确定提交必须进入待处理但释放凭证锁，不能无限阻断其他配置");
  console.log("Dreamina generation-stage auth semantics and legacy migration checks passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()));
  await rm(resolved, { recursive: true, force: true });
}
