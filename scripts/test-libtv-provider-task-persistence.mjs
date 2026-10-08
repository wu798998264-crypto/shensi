import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { classifyLibTvCliError, LibTvMediaDriver, parseLibTvTaskPayload } from "../src/server/media-provider-drivers.mjs";

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

  const transportCalls = [];
  driver.invoke = async (args, options = {}) => {
    transportCalls.push({ args, options });
    if (args.at(-1) === "--run") {
      throw Object.assign(new Error("fetch failed"), { providerErrorCode: "DRIVER_EXIT_FAILED" });
    }
    throw new Error(`unexpected LibTV recovery command: ${args.join(" ")}`);
  };
  const recovered = await driver.submit({
    job: {
      id: "generation-libtv-1-recovery",
      channel: "image",
      request: {
        prompt: "恢复测试图片",
        aspectRatio: "1:1",
        quality: "standard",
        imageCount: 1,
        settings: { model: "gpt-image-1" },
      },
    },
    references: [],
    workRoot: root,
  });
  assert.deepEqual(recovered, {
    providerTaskId: "node-1",
    providerStatus: "running",
    rawStatus: "run_transport_recovery",
    error: "LibTV 已创建任务，正在读取厂商状态",
    errorCode: "",
  }, "节点已创建后仅网络失败必须切换到只读状态恢复");
  assert.equal(transportCalls.filter(({ args }) => args.at(-1) === "--run").length, 1, "网络失败恢复不得重复提交节点");

  const capacityDriver = new LibTvMediaDriver();
  capacityDriver.project = async () => ({ projectUuid: "project-1" });
  capacityDriver.invoke = async (args) => {
    if (args.at(-1) === "--run") {
      throw Object.assign(new Error("LibTV 厂商当前算力不足"), {
        providerErrorCode: "LIBTV_CAPACITY_INSUFFICIENT",
        capacityLimited: true,
        retryAfterMs: 60_000,
      });
    }
    if (args[0] === "node" && args[1] === "create") return { nodeKey: "node-1" };
    throw new Error(`unexpected LibTV capacity command: ${args.join(" ")}`);
  };
  const capacityResult = await capacityDriver.submit({
    job: {
      id: "generation-libtv-capacity",
      channel: "image",
      request: { prompt: "算力不足测试", aspectRatio: "1:1", quality: "standard", imageCount: 1, settings: { model: "gpt-image-1" } },
    },
    references: [],
    workRoot: root,
  });
  assert.equal(capacityResult.providerStatus, "failed", "LibTV 算力不足必须返回明确失败观察");
  assert.equal(capacityResult.errorCode, "LIBTV_CAPACITY_INSUFFICIENT");
  assert.equal(capacityResult.providerTaskId, "node-1", "算力不足前的画布节点 ID 仅用于安全复用，不能伪装成远端任务");
  assert.match(capacityResult.rawStatus, /capacity_before_provider_task/u);

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

  const completedDriver = new LibTvMediaDriver();
  completedDriver.invoke = async () => ({ data: {
    taskInfo: { loading: false, status: 1, progressPercent: 100 },
    url: ["https://example.invalid/generated.png"],
  } });
  const completed = await completedDriver.getStatus({
    job: { providerTaskId: "node-1" },
    workRoot: root,
  });
  assert.equal(completed.providerStatus, "completed", "LibTV 返回 loading=false 且带结果 URL 时必须识别为完成");

  const delayedResourceDriver = new LibTvMediaDriver();
  delayedResourceDriver.invoke = async () => ({ data: {
    taskInfo: { loading: false, status: 2, progressPercent: 100 },
    url: [],
  } });
  const delayedResource = await delayedResourceDriver.getStatus({
    job: { providerTaskId: "node-delayed" },
    workRoot: root,
  });
  assert.equal(delayedResource.providerStatus, "completed", "LibTV 终态即使 URL 尚未出现也必须进入有界结果下载恢复");
  assert.equal(delayedResource.resultResourcePending, true, "LibTV 资源未就绪必须留下明确标记");

  const downloadPendingDriver = new LibTvMediaDriver();
  downloadPendingDriver.invoke = async () => {};
  await assert.rejects(
    downloadPendingDriver.download({
      job: { id: "generation-libtv-download-pending", channel: "image", providerTaskId: "node-delayed", request: { settings: {} } },
      workRoot: root,
      outputPath: join(root, "provider-result.image"),
    }),
    (error) => error?.providerErrorCode === "LIBTV_RESULT_PENDING",
    "LibTV 官方 CLI 无结果资源必须进入有界结果找回，不得伪装成普通缺文件",
  );

  const missingMetadataRoot = await mkdtemp(join(tmpdir(), "shensi-libtv-missing-node-"));
  try {
    const missingMetadataDriver = new LibTvMediaDriver();
    missingMetadataDriver.invoke = async () => { throw new Error("缺少节点时不应调用 CLI"); };
    const missingMetadata = await missingMetadataDriver.getStatus({
      job: { providerTaskId: "" },
      workRoot: missingMetadataRoot,
    });
    assert.equal(missingMetadata.providerStatus, "unknown", "LibTV 缺少本地节点记录不能伪装成排队");
    assert.equal(missingMetadata.errorCode, "LIBTV_NODE_METADATA_MISSING");
  } finally {
    await rm(missingMetadataRoot, { recursive: true, force: true });
  }

  const workerSource = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
  assert.match(workerSource, /LIBTV_STALL_TIMEOUT_MS/u, "LibTV 必须有有界的状态停滞超时");
  assert.match(workerSource, /LIBTV_TASK_STALLED/u, "LibTV 状态长期不变化必须留下可处理的明确错误");
  assert.match(workerSource, /LIBTV_DOWNLOAD_TIMEOUT/u, "LibTV 下载超时必须进入有界的手动重试状态");
  assert.match(workerSource, /LIBTV_RESULT_PENDING/u, "LibTV 结果资源未就绪必须进入有界只读重试");
  const driverSource = await readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8");
  assert.match(driverSource, /LIBTV_RUN_TIMEOUT_MS/u, "LibTV 初始运行命令必须有独立的短超时");
  assert.match(driverSource, /LIBTV_DOWNLOAD_TIMEOUT_MS/u, "LibTV 下载命令必须有独立的有界超时");
  const nestedProviderError = classifyLibTvCliError(Object.assign(new Error("LibTV CLI 退出"), {
    stderr: "warning: retrying\\n{\"data\":{\"code\":\"MODEL_NOT_AVAILABLE\",\"message\":\"当前账号不可用\"}}",
  }), { args: ["node", "create"] });
  assert.equal(nestedProviderError.providerErrorCode, "LIBTV_PROVIDER_MODEL_NOT_AVAILABLE", "带前缀日志的嵌套 LibTV JSON 必须保留厂商错误码");
  assert.equal(nestedProviderError.message, "当前账号不可用", "带前缀日志的嵌套 LibTV JSON 必须保留厂商错误原因");
  const nestedTaskFailure = parseLibTvTaskPayload({ data: { taskInfo: { status: 3, errorCode: "MODEL_NOT_AVAILABLE", errorMessage: "当前模型暂不可用" } } });
  assert.equal(nestedTaskFailure.errorCode, "LIBTV_PROVIDER_MODEL_NOT_AVAILABLE", "taskInfo 内嵌错误码必须保留厂商分类");
  assert.equal(nestedTaskFailure.error, "当前模型暂不可用", "taskInfo 内嵌错误原因必须显示给用户");
  assert.match(driverSource, /resolveLibTvModelName/u, "LibTV 节点创建必须按当前账号模型目录解析展示名");
  assert.match(driverSource, /capacity_before_provider_task/u, "LibTV 算力不足必须区分画布节点与厂商任务");
  assert.match(workerSource, /const libTvCapacity = driver\.id === "libtv-cli"/u, "LibTV 算力不足必须清理伪任务 ID 后再安全重试");
  const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(appSource, /current\.resultResourcePending === true[\s\S]{0,240}LibTV 已生成完成/u, "LibTV 资源未就绪必须在界面显示明确状态");
  console.log("LibTV provider task persistence tests passed");
} finally {
  const resolved = resolve(root);
  assert.ok(resolved.toLowerCase().startsWith(resolve(tmpdir()).toLowerCase()), "只允许清理本测试创建的临时目录");
  await rm(resolved, { recursive: true, force: true });
}
