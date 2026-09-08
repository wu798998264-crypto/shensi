import assert from "node:assert/strict";
import { getProviderImageModelOptions } from "../src/model-presets.js";

const customCompatibleModels = getProviderImageModelOptions("自定义兼容接口", "api");
assert.deepEqual(
  customCompatibleModels.map((item) => item.slug),
  ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"],
  "OpenAI Images 兼容的自定义图片 API 必须提供三个 GPT Image 模型选项",
);
assert.deepEqual(
  customCompatibleModels.map((item) => item.label),
  ["GPT Image 2.0", "GPT Image 1.5", "GPT Image 1"],
);
assert.deepEqual(
  getProviderImageModelOptions("OpenAI", "api").map((item) => item.slug),
  ["gpt-image-2", "gpt-image-1.5", "gpt-image-1"],
  "OpenAI 原有图片模型目录不得回归",
);

console.log("Custom compatible image model option tests passed");
