import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { LibTvMediaDriver } from "../src/server/media-provider-drivers.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-libtv-task-persistence-"));

try {
  const driver = new LibTvMediaDriver();
  driver.project = async () => ({ projectUuid: "project-1" });
  const calls = [];
  driver.invoke = async (args, options = {}) => {
    calls.push({ args, options });
    if (args[0] === "node" && args[1] === "create") return { nodeKey: "node-1" };
    if (args.at(-1) === "--run") {
      throw Object.assign(new Error("媒体驱动命令超过 1800 秒未响应"), { providerErrorCode: "DRIVER_TIMEOUT" });
    }
    throw new Error(`unexpected LibTV command: ${args.join(" ")}`);
  };

  const created = [];
  await assert.rejects(
    driver.submit({
      job: {
        id: "generation-libtv-1",
        channel: "image",
        request: {
          prompt: "生成测试图片",
          aspectRatio: "1:1",
          quality: "standard",
          imageCount: 1,
          settings: { model: "gpt-image-1" },
        },
      },
      references: [],
      workRoot: root,
      onProviderTaskCreated: async (task) => { created.push(task); },
    }),
    (error) => error?.providerErrorCode === "DRIVER_TIMEOUT",
    "LibTV 长命令超时必须保留真实错误码",
  );
  assert.deepEqual(created, [{ providerTaskId: "node-1", providerStatus: "running", rawStatus: "node_created" }], "运行命令前必须先持久化节点 ID");
  assert.equal(JSON.parse(await readFile(join(root, "libtv-node.json"), "utf8")).nodeKey, "node-1");
  const runCalls = calls.filter(({ args }) => args.at(-1) === "--run");
  assert.equal(runCalls.length, 1, "不得为超时命令盲目重复提交节点");
  assert.ok(runCalls[0].options.timeoutMs <= 90_000, "LibTV 初始 --run 阻塞必须在 90 秒内交给持久任务轮询");

  const statusDriver = new LibTvMediaDriver();
  statusDriver.invoke = async () => ({ data: { taskInfo: { status: 3, failedReason: "厂商额度不足" } } });
  const failed = await statusDriver.getStatus({
    job: { providerTaskId: "node-1" },
    workRoot: root,
  });
  assert.equal(failed.providerStatus, "failed");
  assert.equal(failed.errorCode, "LIBTV_PROVIDER_FAILED");
  assert.equal(failed.error, "厂商额度不足", "LibTV 明确失败必须保留厂商真实原因");

  const runningDriver = new LibTvMediaDriver();
  runningDriver.invoke = async () => ({ data: { taskInfo: { status: 1, progress: 24 } } });
  const running = await runningDriver.getStatus({
    job: { providerTaskId: "node-1" },
    workRoot: root,
  });
  assert.equal(running.providerStatus, "running", "LibTV 数字运行状态必须识别为运行中");

  const workerSource = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
  assert.match(workerSource, /LIBTV_STALL_TIMEOUT_MS/u, "LibTV 必须有有界的状态停滞超时");
  assert.match(workerSource, /LIBTV_TASK_STALLED/u, "LibTV 状态长期不变化必须留下可处理的明确错误");
  const driverSource = await readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8");
  assert.match(driverSource, /LIBTV_RUN_TIMEOUT_MS/u, "LibTV 初始运行命令必须有独立的短超时");
  console.log("LibTV provider task persistence tests passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()), "只允许清理本测试创建的临时目录");
  await rm(resolved, { recursive: true, force: true });
}
