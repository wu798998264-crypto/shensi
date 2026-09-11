import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibTvMediaDriver, listLibTvModelCapabilities, resolveLibTvVideoMode } from "../src/server/media-provider-drivers.mjs";

const settings = { cliPath: "libtv" };
const catalog = await listLibTvModelCapabilities({ channel: "video", settings });
assert.ok(catalog.models.length >= 1, "LibTV CLI 应返回视频模型目录");
assert.equal(Object.keys(catalog.schemaErrors).length, 0, "当前 LibTV 视频模型 Schema 不应读取失败");

const duration = (id) => catalog.modelCapabilities[id]?.durationSeconds || [];
assert.deepEqual(duration("star-video2"), [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
assert.deepEqual(duration("wanx3.0"), Array.from({ length: 29 }, (_, index) => index + 2));
assert.deepEqual(duration("happy-horse-1.1"), Array.from({ length: 13 }, (_, index) => index + 3));
assert.deepEqual(duration("viduq3-pro"), Array.from({ length: 16 }, (_, index) => index + 1));
assert.deepEqual(duration("pixverse-v5.5"), [5, 8, 10]);
assert.deepEqual(duration("kling-v3-motion-control"), []);
assert.equal(catalog.modelCapabilities["kling-v3-motion-control"].durationDerivedFromReference, true);

const ref = (mimeType) => ({ mimeType, absolutePath: "reference.fixture" });
const capability = (id) => catalog.modelCapabilities[id];
assert.equal(resolveLibTvVideoMode({ capability: capability("star-video2"), references: [] }), "text2video");
assert.equal(resolveLibTvVideoMode({ capability: capability("star-video2"), references: [ref("image/png")] }), "singleImage2video");
assert.equal(resolveLibTvVideoMode({ capability: capability("star-video2"), references: [ref("video/mp4"), ref("audio/mpeg")] }), "mixed2video");
assert.equal(resolveLibTvVideoMode({ capability: capability("wanx2.7-video"), references: [ref("video/mp4")] }), "video2video");
assert.equal(resolveLibTvVideoMode({ capability: capability("viduq3-pro"), references: [ref("image/png")] }), "singleImage2video");
assert.equal(resolveLibTvVideoMode({ capability: capability("happy-horse-1.1"), references: [ref("audio/mpeg")] }), "");
assert.equal(resolveLibTvVideoMode({ capability: capability("kling-v3-motion-control"), references: [ref("image/png"), ref("video/mp4")] }), "mixed2video");
assert.equal(resolveLibTvVideoMode({ capability: capability("omnihuman-1.5"), references: [ref("image/png"), ref("audio/mpeg")] }), "audio2video");
assert.equal(resolveLibTvVideoMode({ capability: capability("omnihuman-1.5"), references: [ref("image/png")] }), "");
assert.equal(resolveLibTvVideoMode({ capability: capability("omnihuman-1.5"), references: [] }), "");

class CapturingLibTvDriver extends LibTvMediaDriver {
  constructor() {
    super();
    this.createdArgs = null;
    this.projectCalls = 0;
  }

  async project() {
    this.projectCalls += 1;
    return { projectUuid: "test-project" };
  }

  async invoke(args) {
    if (args[0] === "upload") return { nodeKey: `uploaded-${args[1]}` };
    if (args[0] === "node" && args[1] === "create") {
      this.createdArgs = args;
      return { nodeKey: "generated-node" };
    }
    return { status: "completed", taskId: "test-task" };
  }
}

const captureSubmission = async ({ model, request, references }) => {
  const workRoot = await mkdtemp(join(tmpdir(), "shensi-libtv-test-"));
  try {
    const driver = new CapturingLibTvDriver();
    await driver.submit({
      job: {
        id: `job-${model}`,
        channel: "video",
        request: { prompt: "测试视频", settings: { cliPath: "libtv", model }, ...request },
      },
      references,
      workRoot,
    });
    return driver.createdArgs;
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

const captureSubmissionFailure = async ({ model, request, references, prompt = "测试视频" }) => {
  const workRoot = await mkdtemp(join(tmpdir(), "shensi-libtv-test-"));
  try {
    const driver = new CapturingLibTvDriver();
    let failure = null;
    try {
      await driver.submit({
        job: {
          id: `job-${model}`,
          channel: "video",
          request: { prompt, settings: { cliPath: "libtv", model }, ...request },
        },
        references,
        workRoot,
      });
    } catch (error) {
      failure = error;
    }
    return { driver, failure };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
};

const wanArgs = await captureSubmission({
  model: "wanx2.7-video",
  request: { duration: 2, resolution: "1080p", aspectRatio: "16:9" },
  references: [ref("video/mp4")],
});
assert.ok(wanArgs.includes("modeType=video2video"), "视频参考必须选择 video2video");
assert.ok(wanArgs.includes("duration=2"), "时长必须使用当前模型 Schema 支持的真实值");
assert.ok(wanArgs.includes("resolution=1080P"), "参数必须还原成 LibTV Schema 的真实大小写");

const motionArgs = await captureSubmission({
  model: "kling-v3-motion-control",
  request: { duration: 0, resolution: "high", aspectRatio: "auto" },
  references: [ref("image/png"), ref("video/mp4")],
});
assert.ok(motionArgs.includes("modeType=mixed2video"), "动作迁移必须使用图片+视频混合模式");
assert.equal(motionArgs.some((value) => /^duration=/u.test(value)), false, "跟随参考视频时长的模型不能伪造 duration 参数");

const hailuoArgs = await captureSubmission({
  model: "MiniMax-Hailuo-H3",
  request: { duration: 5, resolution: "768p", aspectRatio: "16:9" },
  references: [ref("image/png")],
});
assert.ok(hailuoArgs.includes("model=Minimax H3"), "动态 LibTV 型号必须使用 Schema 返回的 modelName，不能把 modelKey 当成展示名提交");

const overLimit = await captureSubmissionFailure({
  model: "MiniMax-Hailuo-H3",
  request: { duration: 5, resolution: "768p", aspectRatio: "16:9" },
  references: [{ mimeType: "image/png", absolutePath: "never-uploaded.png" }],
  prompt: "长".repeat(2001),
});
assert.equal(overLimit.failure?.providerErrorCode, "LIBTV_PROMPT_TOO_LONG");
assert.equal(overLimit.failure?.submissionOutcomeKnown, true, "提示词超限必须明确标记为未创建厂商生成任务");
assert.equal(overLimit.driver.projectCalls, 0, "提示词超限必须发生在创建画布和上传素材之前");
assert.equal(overLimit.driver.createdArgs, null);

console.log("LibTV 视频模型 Schema 时长与参考模式适配测试通过");
