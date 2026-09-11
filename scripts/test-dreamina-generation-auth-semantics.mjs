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
const uploadTimeout = dreaminaFailureDiagnosis({
  code: "DREAMINA_REFERENCE_UPLOAD_NO_TASK",
  message: "upload resource: ApplyImageUpload http://imagex.bytedanceapi.com/?Action=ApplyImageUpload: context deadline exceeded",
  submissionState: "not_submitted",
});
assert.equal(uploadTimeout.category, "reference_upload_failed");
assert.match(uploadTimeout.title, /上传链路超时/u);
assert.match(uploadTimeout.cause, /创建视频任务前超时|没有创建收费任务/u);
assert.match(uploadTimeout.resolution, /网络或代理|无需重新核验账号/u);
assert.equal(dreaminaFailureRequiresAccountVerification({
  code: "DREAMINA_PROVIDER_TASK_AUTH_FAILURE",
  message: "authsdk: not logged in",
  providerTaskId: "provider-task-kept",
}), false, "已有任务的厂商内部 auth 错误不得伪装成账号失效");
assert.match(dreaminaProfileSwitchMessage({
  reason: "submission_outcome_unknown",
  activeProfileId: "default",
}), /手动终止本机任务/u);

const [runner, videoCli, driver, worker, app] = await Promise.all([
  readFile(new URL("../scripts/windows/dreamina-profile-runner.ps1", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
]);
assert.match(runner, /DREAMINA_GENERATION_SESSION_REJECTED/u);
assert.match(runner, /Test-DreaminaTaskIdentityOutput/u);
assert.match(videoCli, /DREAMINA_GENERATION_SESSION_REJECTED/u);
assert.match(videoCli, /DREAMINA_PROVIDER_TASK_AUTH_FAILURE/u);
assert.match(videoCli, /dreaminaTaskIdInText/u);
assert.match(videoCli, /non-control commands containing `video`/u);
assert.match(driver, /providerTaskIdFromOutput/u);
assert.match(driver, /DREAMINA_PROVIDER_TASK_AUTH_FAILURE/u);
assert.match(worker, /errorProviderTaskId/u);
assert.match(worker, /providerStatus: providerCode\.toUpperCase\(\) === "DREAMINA_PROVIDER_TASK_AUTH_FAILURE"[\s\S]{0,120}\? "failed"/u);
assert.match(worker, /dreaminaSubmissionRecoveryPending[\s\S]{0,600}DREAMINA_SUBMISSION_UNCERTAIN/u);
assert.match(app, /promptDreaminaSubmissionBlockForJob/u);
assert.match(app, /手动终止本机任务/u);

const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-dreamina-generation-runtime-"));
const fakeCliPath = join(runtimeRoot, "fake-dreamina-generation.mjs");
const promptPath = join(runtimeRoot, "prompt.txt");
await writeFile(promptPath, "测试一段不会触发任务号解析误判的提示词", "utf8");
await writeFile(fakeCliPath, `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const operation = String(args[0] || "");
const mode = String(process.env.SHENSI_TEST_DREAMINA_GENERATION_MODE || "");
if (operation === "user_credit") {
  if (mode === "control-auth") {
    process.stderr.write("authsdk: not logged in\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ user_id: "2842687099901300", total_credit: 837, vip_level: "1" }));
  process.exit(0);
}
if (operation === "list_task") {
  process.stdout.write(JSON.stringify({ status: "submit", data: [] }));
  process.exit(0);
}
if (operation === "text2video") {
  if (mode === "upload-timeout-once" || mode === "upload-timeout-always") {
    const attemptFile = String(process.env.SHENSI_TEST_DREAMINA_ATTEMPT_FILE || "");
    const attempt = attemptFile && existsSync(attemptFile) ? Number(readFileSync(attemptFile, "utf8")) + 1 : 1;
    if (attemptFile) writeFileSync(attemptFile, String(attempt));
    if (mode === "upload-timeout-always" || attempt === 1) {
      process.stderr.write("upload resource: ApplyImageUpload http://imagex.bytedanceapi.com/?Action=ApplyImageUpload: context deadline exceeded\\n");
      process.exit(1);
    }
  }
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
  assert.match(noTaskAuth.stderr, /DREAMINA_GENERATION_SESSION_REJECTED/u);
  assert.doesNotMatch(noTaskAuth.stderr, /\[DREAMINA_AUTH_REQUIRED\]/u, "已核验账号的生成阶段会话异常不得弹账号核验语义");

  const placeholderAuth = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-placeholder-auth-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "placeholder-auth" });
  assert.notEqual(placeholderAuth.code, 0);
  assert.match(placeholderAuth.stderr, /DREAMINA_GENERATION_SESSION_REJECTED/u, "none 等占位任务号不得绕过生成阶段未知提交保护");

  const controlAuth = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-control-auth-key",
  ], { ...baseRuntimeEnv, SHENSI_TEST_DREAMINA_GENERATION_MODE: "control-auth" });
  assert.notEqual(controlAuth.code, 0, "控制面未登录必须失败");
  assert.match(controlAuth.stderr, /\[DREAMINA_AUTH_REQUIRED\]/u, "控制面未登录仍必须要求账号核验");

  const recoveredAttemptFile = join(runtimeRoot, "upload-timeout-recovered-attempts.txt");
  const uploadTimeoutRecovered = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-upload-timeout-recovered-key",
  ], {
    ...baseRuntimeEnv,
    SHENSI_DREAMINA_UPLOAD_RETRIES: "1",
    SHENSI_DREAMINA_UPLOAD_RETRY_DELAY_MS: "1",
    SHENSI_TEST_DREAMINA_GENERATION_MODE: "upload-timeout-once",
    SHENSI_TEST_DREAMINA_ATTEMPT_FILE: recoveredAttemptFile,
  });
  assert.equal(uploadTimeoutRecovered.code, 0, `ApplyImageUpload 首次超时应在创建任务前有限重试：${uploadTimeoutRecovered.stderr}`);
  assert.equal(Number(await readFile(recoveredAttemptFile, "utf8")), 2, "上传授权超时恢复必须只重试到成功为止");
  assert.equal(JSON.parse(uploadTimeoutRecovered.stdout.trim()).providerTaskId, "fixture-task-success-123");

  const failedAttemptFile = join(runtimeRoot, "upload-timeout-failed-attempts.txt");
  const uploadTimeoutFailed = await runChild(process.execPath, [
    videoCliPath, "submit", "--prompt-file", promptPath, "--model", "seedance2.0", "--duration", "4", "--resolution", "720p", "--mode", "smart_params", "--idempotency-key", "fixture-upload-timeout-failed-key",
  ], {
    ...baseRuntimeEnv,
    SHENSI_DREAMINA_UPLOAD_RETRIES: "1",
    SHENSI_DREAMINA_UPLOAD_RETRY_DELAY_MS: "1",
    SHENSI_TEST_DREAMINA_GENERATION_MODE: "upload-timeout-always",
    SHENSI_TEST_DREAMINA_ATTEMPT_FILE: failedAttemptFile,
  });
  assert.notEqual(uploadTimeoutFailed.code, 0, "上传授权持续超时必须明确失败，不能静默结束");
  assert.equal(Number(await readFile(failedAttemptFile, "utf8")), 2, "上传授权持续超时不得无限重试");
  assert.match(uploadTimeoutFailed.stderr, /\[DREAMINA_REFERENCE_UPLOAD_NO_TASK\]/u);
  assert.match(uploadTimeoutFailed.stderr, /ApplyImageUpload[\s\S]*context deadline exceeded/u);
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
  assert.equal(occupants.some((item) => item.id === job.id), true, "不确定提交必须继续显示为凭证锁占用任务");
  console.log("Dreamina generation-stage auth semantics and legacy migration checks passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()));
  await rm(resolved, { recursive: true, force: true });
}
