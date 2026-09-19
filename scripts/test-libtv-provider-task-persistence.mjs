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
  driver.invoke = async (args) => {
    calls.push(args);
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
  assert.equal(calls.filter((args) => args.at(-1) === "--run").length, 1, "不得为超时命令盲目重复提交节点");

  const statusDriver = new LibTvMediaDriver();
  statusDriver.invoke = async () => ({ data: { taskInfo: { status: 3, failedReason: "厂商额度不足" } } });
  const failed = await statusDriver.getStatus({
    job: { providerTaskId: "node-1" },
    workRoot: root,
  });
  assert.equal(failed.providerStatus, "failed");
  assert.equal(failed.errorCode, "LIBTV_PROVIDER_FAILED");
  assert.equal(failed.error, "厂商额度不足", "LibTV 明确失败必须保留厂商真实原因");
  console.log("LibTV provider task persistence tests passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()), "只允许清理本测试创建的临时目录");
  await rm(resolved, { recursive: true, force: true });
}
