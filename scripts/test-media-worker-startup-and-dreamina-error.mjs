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
assert.match(workerSource, /startupRecoveryScan = !targetJobId && \["startup", "watchdog", "credential-rebind"\]/u, "启动及凭据恢复扫描必须隔离即梦历史任务");
assert.match(workerSource, /listMediaGenerationJobsForWorker\(\{ skipDreamina: startupRecoveryScan \}\)/u, "启动扫描不得读取或迁移即梦历史任务");
assert.match(workerSource, /--scan-mode", "dreamina-deferred/u, "即梦历史任务只能在用户任务完成后进入后台恢复扫描");
assert.match(workerSource, /scanMode !== "dreamina-deferred"[\s\S]{0,300}Boolean\(job\.providerTaskId\)/u, "延后恢复不得自动提交没有厂商任务 ID 的旧即梦任务");

console.log("Media worker startup and Dreamina auth propagation tests passed");
