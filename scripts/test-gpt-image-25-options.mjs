import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { imageModelCapabilities } from "../src/model-presets.js";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

for (const provider of ["OpenAI", "自定义兼容接口"]) {
  const capabilities = imageModelCapabilities(provider, "gpt-image-2.5");
  assert.ok(capabilities.qualityOptions.includes("standard"), `${provider} GPT Image 2.5 必须提供标准画质`);
  assert.ok(capabilities.outputResolutions.includes("2k"), `${provider} GPT Image 2.5 必须提供 2K 清晰度`);
}

assert.match(app, /id="whiteboardImageQualityField"><legend>清晰度<\/legend>/u, "图片参数必须保留清晰度字段容器");
assert.match(app, /id="whiteboardImageResolutionField" hidden><legend>画质<\/legend>/u, "图片参数必须保留画质字段容器");
assert.match(app, /elements\.whiteboardImageQualityField[\s\S]{0,180}legend\.textContent = "清晰度"/u, "GPT Image 2.5 第一组必须显示清晰度");
assert.match(app, /elements\.whiteboardImageResolutionField[\s\S]{0,180}legend\.textContent = gptImage25 \? "画质"/u, "GPT Image 2.5 第二组必须显示画质");
assert.match(app, /const defaultGptImage25Quality = gptImage25 && qualityOptions\.includes\("standard"\) \? "standard"/u, "GPT Image 2.5 默认画质必须为标准");
assert.match(app, /const defaultGptImage25Resolution = gptImage25 && resolutionOptions\.includes\("2k"\) \? "2k"/u, "GPT Image 2.5 默认清晰度必须为 2K");
assert.match(app, /preferGptImage25Defaults && defaultGptImage25Quality/u, "GPT Image 2.5 默认值必须只在专属初始化路径应用");
assert.match(app, /preferGptImage25Defaults && defaultGptImage25Resolution/u, "GPT Image 2.5 默认清晰度必须只在专属初始化路径应用");
assert.match(app, /gptImage25\s*\?\s*\[ratio, resolution, quality, background/u, "GPT Image 2.5 摘要必须按清晰度、画质顺序显示");

console.log("GPT Image 2.5 画质/清晰度名称与默认值测试通过");
