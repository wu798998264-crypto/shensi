import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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

console.log("Media worker startup and Dreamina auth propagation tests passed");
