import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForLibTvVideoRun } from "../src/server/libtv-video-run.mjs";
import { LibTvMediaDriver } from "../src/server/media-provider-drivers.mjs";

const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdout.setEncoding = child.stderr.setEncoding = () => {};
  child.killed = false; child.kill = () => { child.killed = true; };
  return child;
};
const child = fakeChild(), receipts = [];
let timers = 0, finished = false;
const originalSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (...args) => { timers += 1; return originalSetTimeout(...args); };
let waiting;
try {
  waiting = waitForLibTvVideoRun({ executable: "fake", args: ["node", "node-1", "--run"],
    spawnProcess: () => child, onProviderTask: async value => receipts.push(value) });
} finally { globalThis.setTimeout = originalSetTimeout; }
waiting.then(() => { finished = true; });
child.stderr.emit("data", "[run] ta"); child.stderr.emit("data", "sk=provider-123 progress=11\n");
await Promise.resolve(); await Promise.resolve();
assert.equal(timers, 0, "视频不得套用短请求计时器，必须由官方 CLI 等待生成终态");
assert.equal(child.killed, false);
assert.equal(finished, false, "取得 taskId 后不能将官方实时查询交给陈旧节点快照");
assert.equal(receipts[0].providerTaskId, "provider-123", "分片进度日志必须及时持久化真实厂商任务 ID");
child.stdout.emit("data", '{"taskId":"provider-123","data":{"taskInfo":{"status":2},"url":["https://example.invalid/result.mp4"]}}');
child.emit("close", 0);
const terminal = await waiting;
assert.equal(terminal.providerTaskId, "provider-123"); assert.ok(terminal.stdout.includes("result.mp4"));

const failedChild = fakeChild();
const failure = waitForLibTvVideoRun({ executable: "fake", args: [], spawnProcess: () => failedChild });
failedChild.stderr.emit("data", '[run] task=failed-task\n{"code":"CONTENT_REJECTED","message":"参考素材未通过审核"}\n');
failedChild.emit("close", 1);
await assert.rejects(failure, error => error.providerTaskId === "failed-task" && error.message.includes("参考素材未通过审核"));

const root = await mkdtemp(join(tmpdir(), "shensi-libtv-live-wait-"));
try {
  await writeFile(join(root, "libtv-node.json"), JSON.stringify({ nodeKey: "node", projectUuid: "project" }));
  for (const channel of ["image", "audio", "video"]) {
    const driver = new LibTvMediaDriver(); driver.project = async () => ({ projectUuid: "project" });
    let options;
    driver.invoke = async (args, value) => { options = value; return { status: "completed", taskId: "task" }; };
    // The existing video schema is read-only; no mock/real paid command runs.
    await driver.submit({ job: { id: "mock", channel, request: { prompt: "mock", settings: { model: "star-video2-mini" } } }, workRoot: root });
    assert.equal(options.waitForVideoResult === true, channel === "video", "只有 LibTV 视频启用完整官方等待");
    if (channel !== "video") assert.ok(options.timeoutMs <= 90_000, "图片/音频原调用参数不变");
    if (channel === "video") {
      driver.invoke = async () => ({ data: { taskInfo: { status: 1, taskId: "original-task" } } });
      await assert.rejects(driver.submit({ job: { id: "mock", channel, request: { prompt: "mock", settings: { model: "star-video2-mini" } } }, workRoot: root }),
        error => error.providerErrorCode === "LIBTV_VIDEO_TERMINAL_MISSING" && error.providerTaskId === "original-task",
        "CLI 退出但无终态时必须明确报错，不能回到陈旧画布快照无限等待");
      driver.invoke = async () => { throw Object.assign(new Error("fetch failed"), { providerErrorCode: "DRIVER_EXIT_FAILED" }); };
      await assert.rejects(driver.submit({ job: { id: "mock", channel, request: { prompt: "mock", settings: { model: "star-video2-mini" } } }, workRoot: root }), /fetch failed/u,
        "视频查询连接失败必须保留真实错误，不能静默转为旧快照无限轮询");
    }
  }
} finally { await rm(root, { recursive: true, force: true }); }
console.log("LibTV video live wait, durable task receipt and unchanged image/audio runner tests passed");
