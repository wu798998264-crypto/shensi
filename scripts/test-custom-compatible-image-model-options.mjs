import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { explicitConversationImageAspectRatio } from "../src/conversation-image-settings.js";
import { getProviderImageModelOptions, imageModelCapabilities } from "../src/model-presets.js";

const customCompatibleModels = getProviderImageModelOptions("自定义兼容接口", "api");
assert.deepEqual(
  customCompatibleModels.map((item) => item.slug),
  ["gpt-image-2.5", "gpt-image-2", "gpt-image-1.5", "gpt-image-1"],
  "OpenAI Images 兼容的自定义图片 API 必须提供完整的 GPT Image 模型选项",
);
assert.deepEqual(
  customCompatibleModels.map((item) => item.label),
  ["GPT Image 2.5", "GPT Image 2.0", "GPT Image 1.5", "GPT Image 1"],
);
assert.deepEqual(
  getProviderImageModelOptions("OpenAI", "api").map((item) => item.slug),
  ["gpt-image-2.5", "gpt-image-2", "gpt-image-1.5", "gpt-image-1"],
  "OpenAI 原有图片模型目录不得回归",
);

for (const provider of ["OpenAI", "自定义兼容接口"]) {
  const capabilities = imageModelCapabilities(provider, "gpt-image-2.5");
  assert.deepEqual(capabilities.qualityOptions, ["low", "standard", "high", "ultra", "max"]);
  assert.deepEqual(capabilities.outputResolutions, ["1k", "2k", "4k"]);
  assert.deepEqual(capabilities.backgrounds, ["auto", "opaque", "transparent"]);
}

for (const model of ["lib-image-2.5-s", "lib-image-2.5-f"]) {
  const capabilities = imageModelCapabilities("LibTV", model);
  assert.deepEqual(capabilities.qualityOptions, ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(capabilities.outputResolutions, ["1k", "2k", "4k"]);
  assert.deepEqual(capabilities.backgrounds, ["auto", "opaque", "transparent"]);
}

for (const [provider, model] of [
  ["OpenAI", "gpt-image-2.5"],
  ["OpenAI", "gpt-image-2"],
  ["自定义兼容接口", "gpt-image-2.5"],
  ["自定义兼容接口", "gpt-image-2"],
  ["LibTV", "lib-image-2.5-s"],
  ["LibTV", "lib-image-2.5-f"],
  ["LibTV", "lib-image-2"],
]) {
  const capabilities = imageModelCapabilities(provider, model);
  assert.ok(capabilities.aspectRatios.includes("21:9"), `${provider} ${model} 必须提供 21:9`);
  assert.ok(capabilities.aspectRatios.includes("9:21"), `${provider} ${model} 必须提供 9:21`);
}

assert.equal(explicitConversationImageAspectRatio("生成一张 9:21 的竖向图片"), "9:21");
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(
  appSource,
  /const libTvImageCli = settings\.adapter === "cli"[\s\S]{0,260}settings\.cliPath === LIBTV_CLI_ALIAS[\s\S]{0,260}toLowerCase\(\) === "libtv"/u,
  "LibTV 图片 CLI 必须以专用画布连线能力通过图片参考预检，不能依赖通用 CLI 参数模板",
);
assert.match(appSource, /"9:21": "9:21 超长竖屏"/u, "图片生成界面必须显示 9:21 标签");

console.log("Custom compatible image model option tests passed");
