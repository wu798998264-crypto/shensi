import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyLibTvCliError, libTvDownloadArgs } from "../src/server/media-provider-drivers.mjs";
import { LibTvMediaDriver } from "../src/server/media-provider-drivers.mjs";

const node = { nodeKey: "node-1", projectUuid: "project-1" };
assert.deepEqual(
  libTvDownloadArgs({ job: { channel: "image" }, node, outputDir: "out" }),
  ["download", "-n", "node-1", "-p", "project-1", "-o", "out", "--without-ai-watermark", "--vip"],
);
assert.deepEqual(
  libTvDownloadArgs({ job: { channel: "video" }, node, outputDir: "out" }).slice(-2),
  ["--without-ai-watermark", "--vip"],
);
for (const channel of ["audio", "dreamina", "h3"]) {
  assert.equal(libTvDownloadArgs({ job: { channel }, node, outputDir: "out" }).includes("--without-ai-watermark"), false);
  assert.equal(libTvDownloadArgs({ job: { channel }, node, outputDir: "out" }).includes("--vip"), false);
}
const unsupported = classifyLibTvCliError(Object.assign(new Error("unknown option --without-ai-watermark"), {
  stderr: "unknown option --without-ai-watermark",
}), { args: ["download", "-n", "node-1", "--without-ai-watermark", "--vip"] });
assert.equal(unsupported.providerErrorCode, "LIBTV_DOWNLOAD_OPTION_UNSUPPORTED");
assert.equal(unsupported.downloadOptionUnsupported, true);
assert.match(unsupported.message, /未回退/);
const submitOptionText = classifyLibTvCliError(Object.assign(new Error("unknown option --without-ai-watermark"), {
  stderr: "unknown option --without-ai-watermark",
}), { args: ["node", "create"] });
assert.notEqual(submitOptionText.providerErrorCode, "LIBTV_DOWNLOAD_OPTION_UNSUPPORTED", "提交阶段不能误报下载参数不支持");

const root = await mkdtemp(join(tmpdir(), "shensi-libtv-image-reference-"));
try {
  const referencePath = join(root, "reference.png");
  await writeFile(referencePath, Buffer.from("not-a-real-image"));
  const driver = new LibTvMediaDriver();
  const calls = [];
  driver.project = async () => ({ projectUuid: "project-image-reference" });
  driver.invoke = async (args) => {
    calls.push(args);
    if (args[0] === "upload") return { nodeKey: "reference-node" };
    if (args[0] === "node" && args[1] === "create") return { nodeKey: "image-node" };
    if (args.at(-1) === "--run") return { status: "running", taskId: "image-node" };
    throw new Error(`unexpected LibTV command: ${args.join(" ")}`);
  };
  await driver.submit({
    job: {
      id: "image-reference-job",
      channel: "image",
      request: { prompt: "参考图测试", settings: { model: "lib-image-2.5-s" }, imageCount: 1 },
    },
    references: [{ absolutePath: referencePath, mimeType: "image/png" }],
    workRoot: root,
  });
  const createArgs = calls.find((args) => args[0] === "node" && args[1] === "create");
  assert.ok(createArgs, "带图片参考必须创建 LibTV 图片节点");
  assert.ok(createArgs.includes("modeType=image2image"), "带图片参考必须切换为 image2image");
  const textOnlyRoot = await mkdtemp(join(tmpdir(), "shensi-libtv-text-image-"));
  try {
    const textDriver = new LibTvMediaDriver();
    const textCalls = [];
    textDriver.project = async () => ({ projectUuid: "project-text-image" });
    textDriver.invoke = async (args) => {
      textCalls.push(args);
      if (args[0] === "node" && args[1] === "create") return { nodeKey: "text-image-node" };
      if (args.at(-1) === "--run") return { status: "running", taskId: "text-image-node" };
      throw new Error(`unexpected LibTV command: ${args.join(" ")}`);
    };
    await textDriver.submit({
      job: {
        id: "text-image-job",
        channel: "image",
        request: { prompt: "纯文字测试", settings: { model: "lib-image-2.5-s" }, imageCount: 1 },
      },
      references: [],
      workRoot: textOnlyRoot,
    });
    const textCreateArgs = textCalls.find((args) => args[0] === "node" && args[1] === "create");
    assert.ok(textCreateArgs);
    assert.equal(textCreateArgs.includes("modeType=image2image"), false, "无图片参考必须保留 text2image 默认行为");
  } finally {
    await rm(textOnlyRoot, { recursive: true, force: true });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("libtv download watermark args: ok");
