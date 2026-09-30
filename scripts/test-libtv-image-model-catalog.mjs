import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIBTV_IMAGE_MODEL_OPTIONS, getProviderImageModelOptions } from "../src/model-presets.js";
import { normalizeGenerationProfiles, visibleGenerationPickerProfiles } from "../src/generation-profiles.js";
import { classifyMediaSubmissionFailure } from "../src/server/media-submission-recovery.mjs";
import { LibTvMediaDriver } from "../src/server/media-provider-drivers.mjs";

const ids = LIBTV_IMAGE_MODEL_OPTIONS.map((item) => item.slug);
assert.deepEqual(ids.slice(0, 2), ["lib-image-2.5-s", "lib-image-2.5-f"]);
assert.deepEqual(
  getProviderImageModelOptions("LibTV").slice(0, 2).map((item) => item.slug),
  ["lib-image-2.5-s", "lib-image-2.5-f"],
  "LibTV 图片配置必须显示官方 CLI 当前可见模型",
);

const normalizeWithModel = (model) => normalizeGenerationProfiles({
  imageConnections: [{
    id: "image-libtv",
    name: "LibTV",
    adapter: "cli",
    provider: "LibTV",
    model,
  }],
  activeImageConnectionId: "image-libtv",
}).imageConnections.find((item) => item.id === "image-libtv");

assert.equal(normalizeWithModel("lib-image-2").model, "lib-image-2.5-s", "内置 LibTV 图片旧默认必须迁移到 2.5 默认模型");
assert.equal(normalizeWithModel("nebula-ultra").model, "lib-image-2.5-s", "内置 LibTV 图片旧兼容默认必须迁移到 2.5 默认模型");
assert.equal(normalizeWithModel("lib-image-2.5-s").model, "lib-image-2.5-s");
assert.equal(normalizeWithModel("lib-image-2.5-f").model, "lib-image-2.5-f");

const normalizedVideo = normalizeGenerationProfiles({}).videoConnections;
const localH3 = normalizedVideo.find((profile) => profile.id === "video-local-h3");
assert.ok(localH3, "安装前也必须保留本地 H3 视频配置入口");
assert.equal(localH3.provider, "本地 H3");
assert.equal(localH3.protocol, "comfyui");
assert.equal(localH3.model, "minimax-h3-reference-video");
assert.ok(visibleGenerationPickerProfiles(normalizeGenerationProfiles({}), "video").some((profile) => profile.id === "video-local-h3"), "本地 H3 必须在视频配置选择器中可见");

const libTvColdStartRetry = classifyMediaSubmissionFailure({
  job: {
    channel: "image",
    status: "submitting",
    submissionState: "submitting",
    providerTaskId: null,
    transientFailures: 0,
    request: { settings: { provider: "LibTV", adapter: "cli" } },
  },
  error: Object.assign(new Error("媒体驱动命令超过 90 秒未响应"), {
    providerErrorCode: "DRIVER_TIMEOUT",
    submissionOutcomeKnown: true,
  }),
});
assert.equal(libTvColdStartRetry.submissionUnknown, false, "LibTV 冷启动未取得任务号不得进入人工找回态");
assert.equal(libTvColdStartRetry.safeAutomaticRetry, true, "LibTV 冷启动超时必须走有限自动重试");

const dreaminaExitStillUnknown = classifyMediaSubmissionFailure({
  job: {
    channel: "image",
    status: "submitting",
    submissionState: "submitting",
    providerTaskId: null,
    transientFailures: 0,
    request: { settings: { provider: "即梦", adapter: "cli" } },
  },
  error: Object.assign(new Error("媒体驱动命令退出"), {
    providerErrorCode: "DRIVER_EXIT_FAILED",
    submissionOutcomeKnown: true,
  }),
});
assert.equal(dreaminaExitStillUnknown.submissionUnknown, false, "即梦旧语义仍不能被 LibTV 规则覆盖");
assert.equal(dreaminaExitStillUnknown.safeAutomaticRetry, false, "即梦 DRIVER_EXIT_FAILED 不能被意外放宽为自动重提");

const libTvAlreadySubmitted = classifyMediaSubmissionFailure({
  job: {
    channel: "image",
    status: "submitting",
    submissionState: "submitting",
    providerTaskId: "libtv-task-123",
    transientFailures: 0,
    request: { settings: { provider: "LibTV", adapter: "cli" } },
  },
  error: Object.assign(new Error("CLI 进程退出"), {
    providerErrorCode: "DRIVER_EXIT_FAILED",
    submissionOutcomeKnown: true,
  }),
});
assert.equal(libTvAlreadySubmitted.safeAutomaticRetry, false, "LibTV 已取得厂商任务号后不得重新提交");

const projectRoot = await mkdtemp(join(tmpdir(), "shensi-libtv-project-"));
try {
  const driver = new LibTvMediaDriver();
  const calls = [];
  let useAttempts = 0;
  driver.invoke = async (args) => {
    calls.push(args);
    if (args[0] === "project" && args[1] === "create") return { uuid: "project-cold-start" };
    if (args[0] === "project" && args[1] === "use") {
      useAttempts += 1;
      if (useAttempts === 1) throw Object.assign(new Error("媒体驱动命令退出"), { providerErrorCode: "DRIVER_EXIT_FAILED" });
      return {};
    }
    throw new Error(`unexpected LibTV test call: ${args.join(" ")}`);
  };
  const first = await driver.project(projectRoot, {});
  assert.equal(first.projectUuid, "project-cold-start");
  assert.equal(calls.filter((args) => args[0] === "project" && args[1] === "create").length, 1, "同一任务只能创建一个远程画布");
  assert.equal(JSON.parse(await readFile(join(projectRoot, "libtv-project.json"), "utf8")).projectUuid, "project-cold-start", "create 成功后必须立即持久化 UUID");

  const reuseCalls = [];
  driver.invoke = async (args) => { reuseCalls.push(args); if (args[0] === "project" && args[1] === "use") return {}; throw new Error("不得为已有 UUID 再次 create"); };
  const resumed = await driver.project(projectRoot, {});
  assert.equal(resumed.projectUuid, "project-cold-start");
  assert.equal(reuseCalls.some((args) => args[0] === "project" && args[1] === "create"), false, "已有画布 UUID 时恢复只能 use，不能创建孤儿画布");
} finally {
  await rm(projectRoot, { recursive: true, force: true });
}

console.log("LibTV image model catalog passed");
