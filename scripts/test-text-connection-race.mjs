import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createTextConnectionTestGuard } from "../src/text-connection-test-guard.js";

const guard = createTextConnectionTestGuard();
const deepSeek = guard.begin({ profileId: "deepseek", profileSignature: "deepseek-signature" });
assert.equal(guard.matches(deepSeek, { profileId: "deepseek", profileSignature: "deepseek-signature" }), true);
guard.cancel();
assert.equal(deepSeek.controller.signal.aborted, true);
assert.equal(guard.matches(deepSeek, { profileId: "deepseek", profileSignature: "deepseek-signature" }), false);

const openAi = guard.begin({ profileId: "openai-relay", profileSignature: "openai-relay-signature" });
assert.equal(guard.matches(openAi, { profileId: "openai-relay", profileSignature: "changed-address" }), false);
assert.equal(guard.finish(openAi), true);
assert.equal(guard.finish(openAi), false);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const adapters = await readFile(new URL("../src/server/adapters.mjs", import.meta.url), "utf8");
assert.match(app, /renderTextConnectionTestStatus/u, "配置切换后必须按当前文字配置重新渲染状态");
assert.match(app, /signal: run\.controller\.signal/u, "异步文字连接测试必须支持取消旧请求");
assert.match(app, /if \(error\?\.name === "AbortError" \|\| !runStillCurrent\(\)\) return/u, "旧请求不得回写当前配置状态");
assert.match(app, /textModelCatalogRequestSequence/u, "异步模型目录读取也必须绑定当前配置");
assert.match(app, /cacheTextModelsForProfile\(settings/u, "模型目录必须按完整连接配置隔离缓存");
assert.match(app, /const current = String\(preferredModel/u, "切换配置时必须优先恢复该配置自己的模型");
const branchStart = adapters.indexOf('if (settings.imageChannel !== true && settings.videoChannel !== true)');
const branchEnd = adapters.indexOf('\n  const preset = getProviderPreset(settings.provider);', branchStart + 20);
const textApiBranch = adapters.slice(branchStart, branchEnd);
assert.ok(branchStart >= 0 && branchEnd > branchStart, "必须定位文字 API 真实推理分支");
assert.doesNotMatch(textApiBranch, /\/models/u, "文字真实推理测试不得被可选模型目录接口提前阻断");

console.log("文字 API 配置切换、异步回写与中转站真实推理测试契约通过");
