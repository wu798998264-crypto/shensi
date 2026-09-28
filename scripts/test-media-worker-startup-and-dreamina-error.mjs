import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { launchMediaGenerationWorker, mediaWorkerCredentialSnapshot } from "../src/server/media-worker-manager.mjs";
import { parseStructuredCliError } from "../src/server/adapters.mjs";

assert.deepEqual(
  mediaWorkerCredentialSnapshot({ jobId: "generation-new-media-job", credentials: null }),
  {},
  "单任务启动在没有显式凭据快照时必须使用空对象，不得抛出 Object.keys(null)",
);

const child = new EventEmitter();
child.pid = 12345;
child.exitCode = null;
child.signalCode = null;
child.unref = () => {};
let launched = null;
const result = launchMediaGenerationWorker({
  appRoot: process.cwd(),
  jobId: "generation-worker-startup-test",
  credentials: null,
  spawnImpl: (executable, args, options) => {
    launched = { executable, args, options };
    return child;
  },
});
assert.equal(result.reused, false);
assert.equal(launched.args.includes("--job"), true);
assert.equal(launched.options.env.SHENSI_MEDIA_WORKER_CREDENTIALS, undefined, "无凭据任务不得写入空凭据环境变量");
child.exitCode = 0;
child.emit("exit", 0);

const auth = parseStructuredCliError("[DREAMINA_AUTH_REQUIRED] authsdk: not logged in\n");
assert.equal(auth?.code, "DREAMINA_AUTH_REQUIRED");
assert.equal(auth?.providerErrorCode, "DREAMINA_AUTH_REQUIRED");
assert.equal(auth?.submissionOutcomeKnown, true, "即梦登录失效发生在厂商提交前，必须允许进入核验流程");

const workerSource = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
const managerSource = await readFile(new URL("../src/server/media-worker-manager.mjs", import.meta.url), "utf8");
assert.match(managerSource, /const liveWorker = \(key\) => \{[\s\S]{0,900}processIsAlive\(worker\.pid\)/u, "watchdog 不能只相信内存中的 ChildProcess，必须验证分离 worker 的真实 PID 存活状态");
assert.match(workerSource, /startupRecoveryScan = !targetJobId && \["startup", "watchdog", "credential-rebind"\]/u, "启动及凭据恢复扫描必须隔离即梦历史任务");
assert.match(workerSource, /listMediaGenerationJobsForWorker\(\{ skipDreamina: startupRecoveryScan \}\)/u, "启动扫描不得读取或迁移即梦历史任务");
assert.match(workerSource, /--scan-mode", "dreamina-deferred/u, "即梦历史任务只能在用户任务完成后进入后台恢复扫描");
assert.match(workerSource, /scanMode !== "dreamina-deferred"[\s\S]{0,300}Boolean\(job\.providerTaskId\)/u, "延后恢复不得自动提交没有厂商任务 ID 的旧即梦任务");
assert.match(workerSource, /targetIsDreamina[\s\S]{0,900}!activeDreaminaLease && !anotherDreaminaTaskActive/u, "后台找回必须确认没有活动即梦任务或凭证租约后才能启动");
assert.match(workerSource, /physicalLeaseConflicts[\s\S]{0,1600}status: "polling"[\s\S]{0,500}DREAMINA_PROFILE_BROKER_BUSY/u, "已有厂商任务遇到正常占用时必须保留任务并只读续查");
assert.match(workerSource, /dreaminaProfileSwitchDeferred[\s\S]{0,900}status: "polling"[\s\S]{0,500}DREAMINA_PROFILE_BROKER_BUSY/u, "提交竞态在已有厂商任务时必须保留任务并只读续查");
assert.match(workerSource, /dreaminaProfileSwitchQueued[\s\S]{0,900}status: "queued"[\s\S]{0,500}safeNoTaskRetry: true/u, "提交竞态在尚无厂商任务时必须排队重试而不是失败或弹核验");
assert.match(workerSource, /dreaminaProfileSwitchQueued[\s\S]{0,260}!submissionUnknown/u, "未知提交结果不得被锁占用分支改写为普通排队");
assert.match(workerSource, /localH3Loopback[\s\S]{0,260}settings\.adapter === "api" && !settings\.apiKey && !localH3Loopback/u, "本地 H3 的 loopback ComfyUI 连接不得因没有 API Key 被错误拦截");

console.log("Media worker startup and Dreamina auth propagation tests passed");
