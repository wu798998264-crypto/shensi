import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

const ref = (mimeType) => ({ mimeType });
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
  }

  async project() { return { projectUuid: "test-project" }; }

  async invoke(args) {
    if (args[0] === "upload") return { nodeKey: `uploaded-${args[1]}` };
    if (args[0] === "node" && args[1] === "create") {
      this.createdArgs = args;
      return { nodeKey: "generated-node" };
    }
    return { status: "completed", taskId: "test-task" };
  }
}

const captureSubmission = async ({ model, request, references, channel = "video" }) => {
  const workRoot = await mkdtemp(join(tmpdir(), "shensi-libtv-test-"));
  try {
    const driver = new CapturingLibTvDriver();
    await driver.submit({
      job: {
        id: `job-${model}`,
        channel,
        request: { prompt: channel === "image" ? "测试图片" : "测试视频", settings: { cliPath: "libtv", model }, ...request },
      },
      references,
      workRoot,
    });
    return driver.createdArgs;
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

const imageProArgs = await captureSubmission({
  channel: "image",
  model: "lib-image-2.5-s",
  request: { imageCount: 1, aspectRatio: "1:1", quality: "xhigh", resolution: "2K", background: "transparent" },
  references: [],
});
assert.ok(imageProArgs.includes("model=Lib Image 2.5 Pro"), "Lib Image 2.5 Pro 必须向 CLI 传递官方模型名");
assert.equal(imageProArgs.includes("model=lib-image-2.5-s"), false, "不得把 2.5 Pro 的内部 key 当作模型名传给 CLI");
assert.ok(imageProArgs.includes("quality=xhigh"), "Lib Image 2.5 Pro 必须透传官方画质枚举");
assert.ok(imageProArgs.includes("resolution=2K"), "Lib Image 2.5 Pro 必须透传清晰度");
assert.ok(imageProArgs.includes("background=transparent"), "Lib Image 2.5 Pro 必须透传背景模式");

const imageFastArgs = await captureSubmission({
  channel: "image",
  model: "lib-image-2.5-f",
  request: { imageCount: 1, aspectRatio: "1:1", resolution: "2K" },
  references: [],
});
assert.ok(imageFastArgs.includes("model=Lib Image 2.5 Fast"), "Lib Image 2.5 Fast 必须向 CLI 传递官方模型名");
assert.equal(imageFastArgs.includes("model=lib-image-2.5-f"), false, "不得把 2.5 Fast 的内部 key 当作模型名传给 CLI");

const referenceRoot = await mkdtemp(join(tmpdir(), "shensi-libtv-image-reference-"));
try {
  const referencePath = join(referenceRoot, "reference.png");
  await writeFile(referencePath, Buffer.from("reference-image-fixture"));
  const imageReferenceArgs = await captureSubmission({
    channel: "image",
    model: "lib-image-2.5-s",
    request: { imageCount: 1, aspectRatio: "21:9", quality: "high", resolution: "2K" },
    references: [{ mimeType: "image/png", absolutePath: referencePath }],
  });
  const leftIndex = imageReferenceArgs.indexOf("--left");
  assert.ok(leftIndex >= 0 && /^uploaded-/u.test(imageReferenceArgs[leftIndex + 1]), "LibTV 图片参考必须上传并连接到生成节点");
  assert.ok(imageReferenceArgs.includes("ratio=21:9"), "LibTV 图片节点必须透传新增比例");
} finally {
  await rm(referenceRoot, { recursive: true, force: true });
}

console.log("LibTV 图片模型名、视频 Schema 时长与参考模式适配测试通过");
