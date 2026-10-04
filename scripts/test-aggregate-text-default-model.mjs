import assert from "node:assert/strict";
import { getProviderModelOptions, getProviderPreset } from "../src/model-presets.js";

const customPreset = getProviderPreset("自定义兼容接口");
assert.equal(customPreset.api.model, "gpt-6.1-sol", "聚合 API 新建文字配置默认必须使用 GPT-6.1 Sol");

const customModels = getProviderModelOptions("自定义兼容接口");
assert.equal(customModels[0]?.slug, "gpt-6.1-sol", "聚合 API 模型目录首项必须是 GPT-6.1 Sol");
assert.ok(customModels.some((item) => item.slug === "gpt-6-astra"), "聚合 API 仍应保留 GPT-6 Astra 可选项");

console.log("Aggregate text default model contract passed");
