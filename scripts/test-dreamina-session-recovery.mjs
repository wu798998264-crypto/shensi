import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  dreaminaFailureDiagnosis,
  dreaminaFailureDisplayText,
  dreaminaFailureRequiresAccountVerification,
} from "../src/dreamina-failure.js";
import {
  isDreaminaAuthRequiredResponse,
  isDreaminaAuthRefreshRetryableFailure,
  isDreaminaAuthRefreshSessionRejected,
} from "../src/dreamina-auth-recovery.js";
import { dreaminaProfileCommandFailure } from "../src/server/dreamina-profile-oauth.mjs";

const [imageCli, videoCli, app, worker, adapters] = await Promise.all([
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/adapters.mjs", import.meta.url), "utf8"),
]);

const protocolServerRefreshFailure = "Dreamina CLI 退出码 1：authsdk: refresh failed: protocol server: code=10044";
assert.equal(isDreaminaAuthRefreshSessionRejected(protocolServerRefreshFailure), true,
  "服务端 10044 刷新失败必须识别为可恢复的当前配置会话故障");
assert.equal(isDreaminaAuthRefreshRetryableFailure(protocolServerRefreshFailure), true,
  "服务端 10044 刷新失败不得降级为未知提交结果");
assert.deepEqual(
  dreaminaProfileCommandFailure({ code: 1, stderr: protocolServerRefreshFailure }),
  {
    ok: false,
    transient: false,
    code: "DREAMINA_AUTH_REQUIRED",
    error: "当前即梦配置保存的登录会话已被即梦服务器拒绝，神思有界重试原命令后仍未通过。请核验当前配置后重试；本次未创建厂商任务。",
  },
  "保存会话自动恢复后仍返回 10044 时必须明确要求核验当前配置",
);
assert.equal(isDreaminaAuthRequiredResponse("未检测到有效登录态，请先执行 dreamina login"), true,
  "新版 CLI 的中文未登录提示必须与 authsdk 未登录使用同一认证终态");
assert.equal(dreaminaFailureDiagnosis({
  code: "DRIVER_EXIT_FAILED",
  message: "dreamina.exe : 未检测到有效登录态，请先执行 dreamina login",
}).code, "DREAMINA_AUTH_REQUIRED", "未提交任务的中文未登录错误必须直接要求核验当前配置");
assert.equal(dreaminaFailureDiagnosis({
  code: "DRIVER_EXIT_FAILED",
  message: "dreamina.exe : 未检测到有效登录态，请先执行 dreamina login",
  providerTaskId: "provider-task-kept",
}).code, "DREAMINA_PROVIDER_SESSION_EXPIRED", "已有厂商任务的中文未登录错误必须保留任务并只续接查询");

for (const [name, source, invoke] of [
  ["图片", imageCli, "runOnce"],
  ["视频", videoCli, "runCliOnce"],
]) {
  assert.match(source, /const dreaminaSessionMissing =/, `${name}桥接必须识别精确的 authsdk 未登录结果`);
  assert.match(source, /if \(!markedCode && isDreaminaAuthRequiredResponse\(detail\)\)/,
    `${name}桥接不得用错误文字覆盖厂商已经返回的结构化错误码`);
  assert.match(source, /\(dreaminaAuthRetryAllowed\(args\) \|\| error\.submissionOutcomeKnown === true\)[\s\S]{0,160}attempt < authRetries/,
    `${name}桥接只允许对只读或已确认未提交的原命令做有界重试`);
  assert.doesNotMatch(source, new RegExp(`${invoke}\\(\\["login", "--headless"\\]\\)`),
    `${name}桥接不得在状态检查或生成流程中隐式启动登录`);
  assert.match(source, new RegExp(`return verifiedSemanticResult\\(await ${invoke}\\(args\\)\\)`),
    `${name}桥接必须验证原命令，退出码 0 的未登录响应不得冒充成功`);
  assert.match(source, /isDreaminaAuthRefreshSessionRejected\(error\?\.message\)/,
    `${name}桥接必须识别 authsdk protocol server 10044 会话拒绝`);
  assert.match(source, /const semanticAuthFailure = \(command = ""\) => \{[\s\S]{0,700}error\.code = generationCommand \? "DREAMINA_GENERATION_SESSION_REJECTED" : "DREAMINA_AUTH_REQUIRED"/,
    `${name}桥接必须区分生成阶段会话波动和真实配置失效`);
  assert.match(source, /continue;[\s\S]{0,100}if \(authRejected\) throw semanticAuthFailure\(args\[0\]\)/,
    `${name}桥接有界重试后仍被拒绝必须要求核验当前配置`);
  assert.match(source, /"DREAMINA_AUTH_REQUIRED", "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED", "DREAMINA_PROFILE_BROKER_BUSY"/,
    `${name}桥接自动恢复失败后必须保留真实认证错误码`);
  assert.match(source, /error\.code = preserveDreaminaQueryErrorCode\(error\)/,
    `${name}桥接不得把真实认证失效覆盖为普通查询故障`);
  assert.match(source, /providerSessionExpired[\s\S]{0,300}"DREAMINA_PROVIDER_SESSION_EXPIRED"/,
    `${name}桥接必须区分厂商任务会话失效与账号凭据失效`);
}

for (const [name, source] of [["图片", imageCli], ["视频", videoCli]]) {
  assert.match(source, /assertDreaminaGenerationCredit\(account\);[\s\S]{0,240}await ensureDreaminaTaskStoreSession\(\);[\s\S]{0,160}const idempotencyKey/u,
    `${name}收费提交前必须先只读预检任务资源会话，且不得无条件重复登录`);
  assert.match(source, /const ensureDreaminaTaskStoreSession = async \(\) => \{[\s\S]{0,120}await listTasks\(\{ limit: 1 \}\);/u,
    `${name}任务资源会话预检必须使用当前 profile 的 list_task 只读接口`);
  assert.match(source, /const taskStoreSessionError = \(payload = \{\}\) => \{[\s\S]{0,300}isDreaminaAuthRequiredResponse/u,
    `${name}任务资源接口返回结构化 authsdk 未登录时必须保留真实会话错误`);
  assert.match(source, /if \(result\.errorCode === "DREAMINA_PROVIDER_SESSION_EXPIRED"\)[\s\S]{0,420}DREAMINA_PROVIDER_SESSION_RESTORE_PENDING/u,
    `${name}提交已取得厂商任务号但会话失效时必须转为原任务续查`);
  assert.match(source, /recoverableSessionFailure = \[[\s\S]{0,300}"DREAMINA_PROVIDER_SESSION_RESTORE_PENDING"[\s\S]{0,360}providerStatus: "running"/u,
    `${name}幂等记录里的会话失败必须继续查询，不能永久重放失败终态`);
  assert.match(source, /strictCandidate \|\| \(\(!prepared\?\.preparedAt && allowHistoricalMatch\)[\s\S]{0,120}findListedTask/u,
    `${name}已经预备的新任务不得按相同提示词认领历史厂商任务`);
  assert.doesNotMatch(source, /DREAMINA_PROVIDER_SESSION_EXPIRED[\s\S]{0,220}runGenerationSubmit/u,
    `${name}会话失效不得重新执行生成提交`);
  assert.doesNotMatch(source, /confirmGenerationAuthVerdict/u,
    `${name}生成链路不得通过额外探测次数掩盖认证判断`);
}
assert.doesNotMatch(imageCli, /const refreshGenerationAuth/u,
  "图片已核验账号不得在每次生成前额外执行易失败的 login --headless");
assert.doesNotMatch(videoCli, /const refreshGenerationAuth/u,
  "视频已核验账号不得在每次生成前额外执行易失败的 login --headless");
assert.match(imageCli, /SHENSI_DREAMINA_AUTH_RETRIES", 2/u,
  "图片桥接认证恢复必须有界，避免同一失效会话长时间空转");
assert.match(videoCli, /SHENSI_DREAMINA_AUTH_RETRIES", 2/u,
  "视频桥接认证恢复必须有界，避免同一失效会话长时间空转");
  assert.match(imageCli, /(?:await ensureDreaminaTaskStoreSession\(\);|const taskResource = await ensureDreaminaTaskStoreSession\(\);)[\s\S]{0,700}(?:taskResourceChecked: true|taskResource\.taskResourceChecked)[\s\S]{0,220}(?:generationReady: true|generationReady: taskResource\.taskResourceChecked)/u,
  "图片连接检查必须验证任务资源会话后才报告可生成");
assert.match(videoCli, /(?:await ensureDreaminaTaskStoreSession\(\);|const taskResource = await ensureDreaminaTaskStoreSession\(\);)[\s\S]{0,700}(?:taskResourceChecked: true|taskResource\.taskResourceChecked)[\s\S]{0,220}(?:generationReady: true|generationReady: taskResource\.taskResourceChecked)/u,
  "视频连接检查必须验证任务资源会话后才报告可生成");

const errorTextStart = app.indexOf("const mediaGenerationErrorText");
const errorTextEnd = app.indexOf("const mediaGenerationPhaseText", errorTextStart);
const errorText = app.slice(errorTextStart, errorTextEnd);
assert.match(errorText, /dreaminaFailureDisplayText/,
  "即梦失败必须统一显示错误代码、原因和处理方法");
assert.match(app, /dreaminaFailureNeedsVerification\(\{ error, job: durableJob \}\)/,
  "白板图片和视频任务必须结合真实任务状态决定是否核验");
assert.match(app, /requiresAccountVerification: dreaminaFailureNeedsVerification\(\{ error, job: durableJob \}\)/,
  "批量视频必须保留每个失败任务的核验判定");
assert.match(app, /status \|\| ""\) !== "waiting_credentials"[\s\S]{0,300}dreaminaFailureNeedsVerification\(\{ job \}\)/,
  "任务恢复时只有结构化核验错误可以自动打开账号核验");
assert.match(app, /waiting_credentials" && accountVerificationRequired/,
  "卡片核验按钮只能在结构化协议确认需要核验时显示");
assert.match(app, /mediaRecoveryJobNeedsAccountVerification\(job\)[\s\S]{0,120}!actions\.includes\('data-media-job-action="reverify"'\)/u,
  "待处理窗口必须复用通用核验动作，同一任务不得显示两个核验账号按钮");
assert.match(app, /const dreaminaReverifyPromptQueue = new Map\(\)/,
  "多个失效账号必须使用独立的核验弹窗队列");
assert.match(app, /addEventListener\("close", \(\) => \{[\s\S]{0,300}showNextQueuedDreaminaReverification/,
  "关闭当前核验弹窗后必须继续展示下一失效账号");
assert.match(app, /dreaminaReverifyPromptedJobs\.delete\(jobId\)/,
  "核验周期完成后必须释放已提示标记，允许将来再次提示同一任务");
assert.match(app, /if \(dialogAlreadyOpen && !sameVisibleAccount\) return false/,
  "后台失效账号不得覆盖用户正在阅读的核验弹窗");
assert.doesNotMatch(app, /String\(error\?\.code \|\| ""\)\.toUpperCase\(\) === "DREAMINA_AUTH_REQUIRED"\s*\|\| \/authsdk:/,
  "白板异常分支不得再仅凭裸错误文字打开核验弹窗");
assert.match(worker, /dreaminaFailureRequiresAccountVerification/,
  "后台任务必须使用同一结构化协议决定 waiting_credentials");
assert.match(worker, /const explicitDreaminaAccountVerificationFailure = \(job, error\) => dreaminaCliMediaJob\(job\)[\s\S]{0,320}dreaminaFailureRequiresAccountVerification/u,
  "明确未登录或原任务会话失效必须进入账号核验分支");
assert.match(worker, /if \(explicitDreaminaAccountVerificationFailure\(job, error\)\) throw error/u,
  "恢复原厂商任务时遇到明确掉线必须跳过普通传输重试");
assert.match(worker, /code: explicitDreaminaAccountVerification \? "" : providerCode/u,
  "明确认证失效必须绕过会话恢复空转，立即交给凭据等待状态");
assert.match(worker, /nextPollAt: missingCredentials \? ""[\s\S]{0,500}即梦明确返回当前配置未登录/u,
  "明确未登录后必须停止无意义轮询并保留原厂商任务等待核验");
assert.match(app, /正在恢复查询会话；只续接原任务，不会重新提交/u,
  "恢复原任务查询会话时必须显示准确状态，不能继续伪装成正常生成");
assert.match(app, /sessionRecoveryPending[\s\S]{0,500}Math\.max\(1, previousProgress\)/u,
  "对话区恢复查询会话时必须冻结百分比，不得继续推进虚假进度");
assert.match(worker, /dreaminaSubmissionRecoveryPending[\s\S]{0,1400}providerStatus: "reconciling"[\s\S]{0,800}不会重新提交或重复扣费/u,
  "即梦提交响应中断后必须立即进入自动核对状态，不能先显示 100% 失败");
assert.match(worker, /原厂商任务 \$\{current\.providerTaskId\}[\s\S]{0,180}只续查原任务，不会重新提交或重复扣费/u,
  "核验提示必须明确保留原任务且不重复提交");
assert.match(worker, /executionProfileSignature[\s\S]{0,5000}DREAMINA_ACCOUNT_MISMATCH/u,
  "后台恢复必须校验原任务绑定的即梦账号身份，禁止串号");
assert.match(worker, /failureCategory:[\s\S]{0,200}failureReason:[\s\S]{0,200}failureResolution:/,
  "后台失败记录必须保存错误类别、原因和解决方法");
assert.match(app, /refreshedAccount[\s\S]{0,500}dreaminaAccountRequiresVerification\(refreshedAccount\)[\s\S]{0,500}openDreaminaReverifyDialog/u,
  "切换到明确失效或未绑定的即梦账号后必须自动打开绑定该配置和频道的核验框");
assert.match(adapters, /retryAdvice: dreaminaFailure\.resolution/,
  "即梦结构化错误必须覆盖通用 CLI 的错误处理建议");

const authBeforeSubmit = dreaminaFailureDiagnosis({
  code: "DREAMINA_AUTH_REQUIRED",
  message: "authsdk: not logged in",
});
assert.equal(authBeforeSubmit.requiresAccountVerification, true);
assert.match(authBeforeSubmit.resolution, /核验.*重新提交/u);

const authAfterSubmit = dreaminaFailureDiagnosis({
  code: "DREAMINA_AUTH_REQUIRED",
  message: "authsdk: not logged in",
  providerTaskId: "provider-task-1",
  submissionState: "submitted",
});
assert.equal(authAfterSubmit.requiresAccountVerification, true,
  "已有厂商任务时，本机真实授权失效仍必须核验");
assert.match(authAfterSubmit.resolution, /续接原厂商任务.*不要重新提交/u);

const providerSessionExpired = dreaminaFailureDiagnosis({
  code: "DREAMINA_PROVIDER_SESSION_EXPIRED",
  message: "authsdk: not logged in",
  providerTaskId: "provider-task-2",
});
assert.equal(providerSessionExpired.requiresAccountVerification, true,
  "厂商任务自身的生成会话失效必须要求核验原配置");
assert.match(providerSessionExpired.resolution, /核验.*只续接原厂商任务.*不会重新提交/u);

assert.equal(dreaminaFailureRequiresAccountVerification({
  code: "DREAMINA_QUERY_TRANSIENT",
  message: "authsdk: not logged in",
}), false, "稳定的普通错误码必须优先于错误文字，不得误弹核验");
assert.equal(dreaminaFailureRequiresAccountVerification({
  message: "authsdk: not logged in",
}), true, "没有结构化错误码的旧任务仍须识别真实未登录");
assert.equal(dreaminaFailureRequiresAccountVerification({
  message: "authsdk: not logged in",
  providerTaskId: "legacy-provider-task",
}), true, "旧任务已有厂商任务 ID 时也必须核验原配置并续接原任务");

const unknown = dreaminaFailureDisplayText({ code: "DREAMINA_NEW_PROVIDER_ERROR", message: "new failure detail" });
assert.match(unknown, /错误代码：DREAMINA_NEW_PROVIDER_ERROR/u);
assert.match(unknown, /原因：/u);
assert.match(unknown, /处理方法：/u);
assert.match(unknown, /原始报错：new failure detail/u);

console.log("Dreamina saved-session recovery regression checks passed");
