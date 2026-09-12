import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { LibTvMediaDriver } from "../src/server/media-provider-drivers.mjs";
import { libtvTaskFromPayload, parseLibTvCliOutput } from "../src/libtv-result.js";
import { mediaConnectionRetry, mediaGenerationIssueNeedsCard } from "../src/media-execution-policy.js";
import { dreaminaJobRequiresCredentialProfile } from "../src/dreamina-manual-profile-policy.js";
import { dreaminaFailureDiagnosis } from "../src/dreamina-failure.js";
import { classifyMediaSubmissionFailure } from "../src/server/media-submission-recovery.mjs";
import { mediaRecoveryJobBlocksOperation } from "../src/media-generation-coordination.js";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-media-lifecycle-"));
process.env.SHENSI_DATA_ROOT = dataRoot;
process.env.SHENSI_MACHINE_DATA_ROOT = dataRoot;
const nowMs = Date.now();
const dreamina = { mode: "server", channel: "video", status: "running", request: { settings: { adapter: "cli", provider: "即梦", dreaminaCliProfile: "test-profile" } } };
for (const status of ["waiting_credentials", "waiting_storage", "retry_required", "reconciliation_required", "failed", "cancelled"]) {
  assert.equal(dreaminaJobRequiresCredentialProfile({ ...dreamina, status }), false, `${status} 必须释放配置占用`);
}
assert.equal(dreaminaJobRequiresCredentialProfile({ ...dreamina, status: "downloading", providerStatus: "completed" }), true, "下载验收仍在完整执行链中");
const applying = { ...dreamina, status: "complete", providerStatus: "completed", completedAt: new Date(nowMs).toISOString(), result: { attachment: { relativePath: "result.png" } } };
assert.equal(dreaminaJobRequiresCredentialProfile(applying, { nowMs }), true);
assert.equal(dreaminaJobRequiresCredentialProfile({ ...applying, appliedAt: new Date(nowMs).toISOString() }), false);
assert.equal(dreaminaJobRequiresCredentialProfile(applying, { nowMs: nowMs + 121_000 }), true, "结果未成功回写卡片前不能按时间静默释放锁");
assert.equal(dreaminaJobRequiresCredentialProfile({ ...applying, cardApplyFailed: true }, { nowMs: nowMs + 121_000 }), false, "回写明确失败后必须释放锁并保留错误");
let retryJob = { ...dreamina };
for (let i = 1; i <= 4; i++) {
  Object.assign(retryJob, mediaConnectionRetry(retryJob, { nowMs: nowMs + i * 1000 }));
  assert.equal(retryJob.connectionRetryExhausted, i === 4);
}
assert.equal(dreaminaJobRequiresCredentialProfile(retryJob), false);
assert.equal(mediaConnectionRetry({ connectionRetryStartedAt: new Date(nowMs - 121_000).toISOString() }, { nowMs }).connectionRetryExhausted, true);
assert.equal(classifyMediaSubmissionFailure({ job: { ...dreamina, status: "queued", transientFailures: 10 }, error: { providerErrorCode: "DREAMINA_PROFILE_BROKER_BUSY", submissionOutcomeKnown: true } }).safeAutomaticRetry, false, "凭证忙不能绕过重试上限");
assert.equal(classifyMediaSubmissionFailure({ job: { ...dreamina, providerTaskId: "keep-task" }, error: { providerErrorCode: "DRIVER_TIMEOUT", submissionOutcomeKnown: true } }).safeAutomaticRetry, false, "有任务号不能自动重提");
for (const targetType of ["whiteboard-node", "conversation-message"]) {
  const pending = { ...dreamina, target: { targetType }, status: "waiting_credentials", error: "原错误" };
  assert.equal(mediaRecoveryJobBlocksOperation(pending), true, "媒体任务不因来自对话而漏掉");
  assert.equal(mediaGenerationIssueNeedsCard(pending), true);
}
assert.equal(mediaGenerationIssueNeedsCard({ ...dreamina, status: "retry_required", billingRisk: "submission_outcome_unknown", error: "CLI 原因" }), true);
for (const code of ["", "DREAMINA_REFERENCE_UPLOAD_NO_TASK", "DREAMINA_UNCLASSIFIED_FAILURE"]) {
  const failure = dreaminaFailureDiagnosis({ code, providerTaskId: "keep-task", message: "ApplyImageUpload: context deadline exceeded" });
  assert.equal(failure.category, "reference_upload_failed");
  assert.equal(failure.requiresAccountVerification, false);
  assert.doesNotMatch(failure.cause, /没有创建|未创建收费/);
}
assert.equal(dreaminaFailureDiagnosis({ code: "", providerTaskId: "keep-task", message: "resource store: authsdk: not logged in" }).requiresAccountVerification, false);
assert.equal(dreaminaFailureDiagnosis({ code: "DREAMINA_AUTH_REQUIRED", message: "authsdk: not logged in" }).requiresAccountVerification, true);

class FixtureDriver extends LibTvMediaDriver {
  calls = [];
  failAt = "";
  async modelSchema() { return { modelName: "internal-key", schema: { modelName: "Real Model Name", properties: { prompt: { maxLength: 2000 } }, config: { settings: { text2video: [] } } } }; }
  async project() { this.calls.push("project"); return { projectUuid: "test-project" }; }
  async invoke(args, options) {
    this.calls.push(args);
    if (args[0] === this.failAt || args.includes("--run") && this.failAt === "run") throw Object.assign(new Error(`fixture ${this.failAt} 原始报错`), { providerErrorCode: "DRIVER_EXIT_FAILED" });
    if (args[0] === "upload") return { nodeKey: "fixture-ref" };
    if (args[1] === "create") return { nodeKey: "fixture-node" };
    if (args.includes("--run")) assert.equal(options.timeoutMs, 0);
    return { data: { taskInfo: { status: 3, taskId: "fixture-task", failedReason: "明确的厂商失败原因" } } };
  }
}
let next = 0;
const context = () => ({ job: { id: "fixture", channel: "video", request: { prompt: "测试", settings: { model: "internal-key" } } }, references: [], workRoot: join(dataRoot, `case-${next++}`) });
try {
  const tooLong = new FixtureDriver(), longContext = context();
  longContext.job.request.prompt = "文".repeat(2001);
  await assert.rejects(tooLong.submit(longContext), (e) => e.providerErrorCode === "LIBTV_PROMPT_TOO_LONG" && e.submissionOutcomeKnown);
  assert.equal(tooLong.calls.length, 0);
  const failedCreate = new FixtureDriver(); failedCreate.failAt = "node";
  await assert.rejects(failedCreate.submit(context()), (e) => e.submissionOutcomeKnown && /原始报错/.test(e.message) && e.executionPhase === "creating_node");
  const failedRun = new FixtureDriver(); failedRun.failAt = "run";
  const replay = context();
  await assert.rejects(failedRun.submit(replay), (e) => e.providerTaskId === "fixture-node" && !e.submissionOutcomeKnown);
  failedRun.failAt = "";
  await failedRun.submit(replay);
  assert.equal(failedRun.calls.filter((args) => Array.isArray(args) && args.includes("--run")).length, 1, "重启重入只能查询节点，不得再次运行");
  const valid = new FixtureDriver();
  const terminal = await valid.submit(context());
  assert.equal(terminal.error, "明确的厂商失败原因");
  assert.equal(terminal.providerStatus, "failed");
  assert.ok(valid.calls.some((args) => Array.isArray(args) && args.includes("model=Real Model Name")));
  assert.throws(() => parseLibTvCliOutput(""), /空输出/);
  assert.throws(() => parseLibTvCliOutput("malformed"), /malformed/);
  assert.equal(libtvTaskFromPayload({ success: false, error: { code: "CLI_VALIDATION", message: "参数不合法" } }).error, "参数不合法");
  assert.equal(libtvTaskFromPayload({ data: { taskInfo: { status: 3 } } }).errorCode, "LIBTV_PROVIDER_FAILED");
  assert.equal(libtvTaskFromPayload({ status: "unexpected" }).providerStatus, "unknown");
  class ProcessDriver extends LibTvMediaDriver { executable() { return process.execPath; } }
  const child = new ProcessDriver();
  await assert.rejects(child.invoke(["-e", 'process.stdout.write("output reason");process.stderr.write("stderr reason");process.exit(1)'], { cwd: dataRoot }), (e) => /output reason/.test(e.message) && /stderr reason/.test(e.message));
  await assert.rejects(child.invoke(["-e", 'process.stdout.write(JSON.stringify({ok:false,error:{message:"JSON failure",code:"BAD_INPUT"}}))'], { cwd: dataRoot }), /JSON failure/);
  const failedPayload = await child.invoke(["-e", 'process.stdout.write(JSON.stringify({taskId:"real-task",status:3,message:"terminal reason"}));process.stderr.write("progress only");process.exit(1)', "--", "--run"], { cwd: dataRoot });
  assert.equal(libtvTaskFromPayload(failedPayload).error, "terminal reason");
  console.log("Media lifecycle, bounded retry, CLI stdout/stderr and LibTV submission regressions passed (no provider calls)");
} finally {
  assert.ok(resolve(dataRoot).startsWith(resolve(tmpdir())));
  await rm(dataRoot, { recursive: true, force: true });
}
