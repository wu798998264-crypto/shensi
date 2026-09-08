import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [worker, imageCli, videoCli, runner] = await Promise.all([
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-image-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("./windows/dreamina-profile-runner.ps1", import.meta.url), "utf8"),
]);

assert.doesNotMatch(worker, /acquireJobLock\("dreamina-cli-global"\)/u,
  "不得用一个工作任务锁住提交、查询、下载和结果回填的整个生命周期");
assert.match(imageCli, /dreaminaPrefixArgs\(\)/u, "图片每条 CLI 命令都必须使用配置运行前缀");
assert.match(videoCli, /dreaminaPrefixArgs\(\)/u, "视频每条 CLI 命令都必须使用配置运行前缀");
assert.match(runner, /Global\\ShensiDreaminaCredentialSwitchV1/u);
assert.match(runner, /WaitOne\(\[TimeSpan\]::FromSeconds\(2\)\)/u, "互斥仅等待当前命令的短时间窗口");
assert.match(runner, /AbandonedMutexException/u, "遗弃锁必须可由下一条命令安全接管");
assert.match(runner, /finally[\s\S]{0,900}ReleaseMutex/u, "当前命令退出时必须在 finally 释放凭据互斥");

console.log("v3.0 即梦单次 CLI 互斥测试通过");
