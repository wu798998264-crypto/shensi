import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { getProviderModelOptions, getProviderPreset } from "../src/model-presets.js";
import { normalizeGenerationProfiles, removeGenerationProfile } from "../src/generation-profiles.js";
import { freeModelDisplayName, freePublicModels, isFreePublicModel, modelDisplayName, modelPickerDisplayName } from "../src/public-model-catalog.js";
import { runModelAdapter, testModelAdapter } from "../src/server/adapters.mjs";

const provider = getProviderPreset("免费模型");
assert.equal(provider.public, true);
assert.equal(provider.api.protocol, "chat_completions");
assert.equal(provider.api.baseUrl, "https://api.kilo.ai/api/openrouter");
assert.ok(getProviderModelOptions("免费模型").some((item) => item.slug === "stepfun/step-3.7-flash:free"));
assert.equal(getProviderPreset("公益模型"), provider, "旧服务商名称必须继续解析到同一预设");
assert.equal(freeModelDisplayName({ id: "stepfun/step-3.7-flash:free", name: "StepFun: Step 3.7 Flash (free)" }), "Step 3.7 Flash");
assert.equal(freeModelDisplayName({ id: "tencent/hy3:free", name: "Tencent: Hy3 (free)" }), "Hy3");
assert.equal(freeModelDisplayName({ id: "kilo-auto/free", name: "Auto Free" }), "Auto");
assert.equal(modelDisplayName({ id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5" }), "GPT-5.5");
assert.equal(modelDisplayName("openai/gpt-5.5"), "gpt-5.5");
assert.equal(modelDisplayName("openrouter/free"), "OpenRouter");
assert.equal(modelPickerDisplayName("poolside/laguna-s-2.1:free"), "laguna-s-2.1");
assert.equal(modelPickerDisplayName("tencent/hy3:free"), "hy3");
assert.equal(modelPickerDisplayName({ slug: "tencent/hy3:free", label: "Tencent: Hy3 (free)", availabilityNote: "待连接验证" }), "Hy3");
assert.equal(modelPickerDisplayName({ slug: "deepseek-v4-flash", label: "DeepSeek V4 Flash 0731（最新·速度优先）" }), "DeepSeek V4 Flash 0731");
assert.equal(modelPickerDisplayName({ slug: "gemini-3.1-flash-image", label: "Nano Banana 2（Gemini 3.1 Flash Image）" }), "Nano Banana 2（Gemini 3.1 Flash Image）");
assert.equal(isFreePublicModel({ id: "kilo-auto/free", pricing: { prompt: "0", completion: "0" } }), true);
assert.equal(isFreePublicModel({ id: "provider/zero-price", pricing: { prompt: "0", completion: "0" } }), true);
assert.equal(isFreePublicModel({ id: "provider/paid", pricing: { prompt: "0.001", completion: "0.002" } }), false);
assert.equal(isFreePublicModel({ id: "provider/audio-preview", isFree: false, pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } }), false);
assert.equal(isFreePublicModel({ id: "provider/free-audio", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text", "audio"] } }), false, "文字免费目录不得混入音频生成模型");
assert.equal(isFreePublicModel({ id: "nvidia/content-safety:free", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] } }), false, "安全分类模型不得混入免费写作模型目录");
assert.deepEqual(freePublicModels([
  { id: "provider/paid", pricing: { prompt: "0.001", completion: "0.002" } },
  { id: "provider/free:free", pricing: { prompt: "0", completion: "0" } },
]).map((item) => item.id), ["provider/free:free"]);

const freshInstall = normalizeGenerationProfiles({});
assert.equal(freshInstall.activeTextConnectionId, "text-public-agent", "全新安装默认免费模型 Agent 配置");
assert.equal(freshInstall.activeTextChatConnectionId, "text-public-agent", "旧 Chat 指针必须跟随统一 Agent 配置");
assert.deepEqual(freshInstall.textConnections.filter((item) => item.provider === "免费模型").map((item) => item.id), ["text-public-agent"]);

const legacyCustom = normalizeGenerationProfiles({
  adapter: "api",
  provider: "自定义兼容接口",
  protocol: "chat_completions",
  baseUrl: "https://legacy-user.invalid/v1",
  model: "legacy-user-model",
  apiKey: "legacy-user-key",
});
assert.notEqual(legacyCustom.activeTextConnectionId, "text-public-kilo", "旧用户自定义文字连接不得被系统免费配置抢占");
assert.notEqual(legacyCustom.activeTextConnectionId, "text-public-agent", "旧单连接配置不得被新默认值抢占");

const autoConfigured = normalizeGenerationProfiles({
  textConnections: [{
    id: "existing-text",
    adapter: "api",
    provider: "OpenAI",
    protocol: "responses",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-sol",
  }],
  activeTextConnectionId: "existing-text",
});
const publicProfiles = autoConfigured.textConnections.filter((item) => item.provider === "免费模型");
assert.deepEqual(publicProfiles.map((item) => item.id), ["text-public-agent"], "限免组合存在，旧独立免费文字配置不恢复");
assert.equal(autoConfigured.activeTextConnectionId, "existing-text", "清理旧配置不得切换可用的当前连接");

const migratedLegacyPublic = normalizeGenerationProfiles({
  textConnections: [{
    id: "text-public-kilo",
    name: "公益模型",
    remarkName: "公益模型",
    adapter: "api",
    provider: "公益模型",
    protocol: "chat_completions",
    baseUrl: provider.api.baseUrl,
    model: "tencent/hy3:free",
  }],
});
const migratedLegacyProfile = migratedLegacyPublic.textConnections.find((item) => item.id === "text-public-kilo");
assert.equal(migratedLegacyProfile, undefined, "旧免费配置不得继续迁移回设置");

const removedPublic = removeGenerationProfile(autoConfigured, "text", "text-public-kilo");
const normalizedAfterRemoval = normalizeGenerationProfiles(removedPublic);
assert.equal(normalizedAfterRemoval.textConnections.some((item) => item.id === "text-public-kilo"), false, "免费配置删除后不得自动恢复");

const restoredAfterLegacyDisable = normalizeGenerationProfiles({
  textConnections: autoConfigured.textConnections.filter((item) => item.id !== "text-public-kilo"),
  disabledBuiltInTextProfileIds: ["text-public-kilo"],
  activeTextConnectionId: "existing-text",
});
const restoredSystemProfile = restoredAfterLegacyDisable.textConnections.find((item) => item.id === "text-public-kilo");
assert.equal(restoredSystemProfile, undefined, "旧版本删除标记也不得恢复免费配置");
assert.equal(restoredAfterLegacyDisable.activeTextConnectionId, "existing-text", "清理旧标记不得抢占用户当前连接");

const repairedTamperedSystemProfile = normalizeGenerationProfiles({
  textConnections: [{
    id: "text-public-kilo",
    name: "伪装配置",
    adapter: "api",
    provider: "自定义兼容接口",
    protocol: "responses",
    baseUrl: "https://must-not-route.invalid/v1",
    model: "poolside/laguna-s-2.1:free",
    apiKey: "must-not-be-embedded",
  }],
}).textConnections.find((item) => item.id === "text-public-kilo");
assert.equal(repairedTamperedSystemProfile, undefined, "伪装成旧系统免费配置的条目也必须删除");

const dynamicModel = "provider/new-free-model";
const normalized = normalizeGenerationProfiles({
  textConnections: [{
    id: "text-public",
    adapter: "api",
    provider: "免费模型",
    protocol: "chat_completions",
    baseUrl: provider.api.baseUrl,
    model: dynamicModel,
    apiKey: "",
  }],
});
const profile = normalized.textConnections.find((item) => item.id === "text-public");
assert.equal(profile.model, dynamicModel, "用户独立配置不能因名称清理被删除或改模型");

const adapterSource = await readFile(new URL("../src/server/adapters.mjs", import.meta.url), "utf8");
assert.match(adapterSource, /getProviderPreset\(settings\.provider\)\.public !== true/u);
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /publicProvider.*请先填写 Base URL/u);
assert.match(serverSource, /publicProvider \? freePublicModels\(catalog\) : catalog/u, "免费模型目录必须剔除付费模型");

let requestHeaders;
let requestBody;
const mockServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    requestHeaders = request.headers;
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      id: "public-mock-response",
      choices: [{ message: { content: "SHENSI_PUBLIC_ADAPTER_OK" } }],
    }));
  });
});
await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = mockServer.address();
  const result = await runModelAdapter({
    settings: {
      adapter: "api",
      provider: "免费模型",
      protocol: "chat_completions",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: dynamicModel,
      apiKey: "",
      maxOutputTokens: "32",
      timeoutMs: "15000",
    },
    messages: [{ role: "user", content: "public adapter test" }],
    system: "public adapter system",
    cwd: process.cwd(),
  });
  assert.equal(result.text, "SHENSI_PUBLIC_ADAPTER_OK");
  assert.equal(requestBody.model, dynamicModel);
  assert.equal(requestBody.messages.at(-1).content, "public adapter test");
  assert.equal(requestHeaders.authorization, undefined, "免费模型无 Key 时不得发送空 Authorization");
} finally {
  await new Promise((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()));
}

const probeBudgets = [];
const reasoningMockServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    probeBudgets.push(body.max_tokens);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body.max_tokens < 2048
      ? {
          id: "reasoning-only-probe",
          choices: [{ finish_reason: "length", message: { content: null, reasoning: "先完成连接测试推理" } }],
        }
      : {
          id: "reasoning-probe-success",
          choices: [{ finish_reason: "stop", message: { content: "SHENSI_CONNECTION_OK", reasoning: "已完成推理" } }],
        }));
  });
});
await new Promise((resolve) => reasoningMockServer.listen(0, "127.0.0.1", resolve));
try {
  const { port } = reasoningMockServer.address();
  const result = await testModelAdapter({
    settings: {
      adapter: "api",
      provider: "免费模型",
      protocol: "chat_completions",
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "tencent/hy3:free",
      apiKey: "",
      maxOutputTokens: "10000",
      timeoutMs: "120000",
    },
    cwd: process.cwd(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.testLevel, "real_inference");
  assert.deepEqual(probeBudgets, [256, 2048], "免费推理模型应在正文为空时自适应扩大连接测试 Token，而不是固定 32");
} finally {
  await new Promise((resolve, reject) => reasoningMockServer.close((error) => error ? reject(error) : resolve()));
}

const limitedMockServer = createServer((request, response) => {
  response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "7" });
  response.end(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Provider returned error" } }));
});
await new Promise((resolve) => limitedMockServer.listen(0, "127.0.0.1", resolve));
try {
  const address = limitedMockServer.address();
  await assert.rejects(() => runModelAdapter({
    settings: {
      provider: "免费模型",
      adapter: "api",
      protocol: "chat_completions",
      baseUrl: `http://127.0.0.1:${address.port}`,
      model: "provider/limited:free",
      maxOutputTokens: 32,
      timeoutMs: 5_000,
    },
    messages: [{ role: "user", content: "test" }],
    system: "test",
    cwd: process.cwd(),
  }), (error) => {
    assert.equal(error.code, "HTTP_429");
    assert.equal(error.statusCode, 429);
    assert.equal(error.providerErrorCode, "rate_limit_exceeded");
    assert.equal(error.retryAfterMs, 7_000);
    return true;
  });
} finally {
  await new Promise((resolve, reject) => limitedMockServer.close((error) => error ? reject(error) : resolve()));
}

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /profile\.apiKey \|\| publicTextProvider/u, "免 Key 免费模型必须被识别为已配置连接");
assert.match(appSource, /checkQuickTextModelConnection/u, "对话模型选择区必须允许用户主动检查当前模型");
assert.match(appSource, /id="checkQuickTextModel"/u, "对话模型选择区必须显示检查当前模型按钮");
assert.match(appSource, /id="checkWhiteboardTextModel"/u, "卡片文字生成区必须显示检查当前模型按钮");
assert.match(appSource, /id="quickTextModelVerification"[^>]*hidden/u, "非免费 Chat 配置不得默认显示检查栏");
assert.match(appSource, /id="quickAgentVerification"[^>]*hidden/u, "非免费 Agent 配置不得默认显示检查栏");
assert.match(appSource, /applyTextModelVerificationView[\s\S]{0,900}container\.hidden = !publicConnection/u, "只有免费模型才显示 Chat 手动检查入口");
assert.match(appSource, /renderAgentVerification[\s\S]{0,900}container\.hidden = !publicConnection/u, "只有免费 Agent 才显示 Agent 手动检查入口");
assert.match(appSource, /data-model-state/u, "文字模型选项必须携带可视状态标识");
assert.match(appSource, /textModelCapabilityProbeKey/u, "不同模型的核验结果必须分别保存，不能由同一配置互相覆盖");
assert.match(appSource, /if \(publicTextModelProbeIsolated\(profile\)\) return null/u, "免费模型与免费 Agent 禁止回退到配置级成功状态");
assert.match(appSource, /PUBLIC_TEXT_PROBE_SUCCESS_MAX_AGE_MS/u, "免费模型绿色状态必须具有较短有效期，不能永久冒充可用");
assert.match(appSource, /最近实测可用/u, "免费线路必须明确显示为最近实测结果，而非永久可用承诺");
assert.match(appSource, /classifyPublicTextCapabilityFailure/u, "免费线路必须使用独立证据分类，不能把通用上游错误武断判为不可用");
assert.match(appSource, /indeterminate_failure/u, "缺少状态码的通用上游错误必须清除绿色并标记为原因未知");
assert.match(appSource, /probe\?\.verificationLevel === "indeterminate_failure"\) return "unknown"/u, "原因未知不得被模型目录可见状态覆盖成蓝色或绿色");
assert.match(appSource, /agentTextModelOptionMarkup/u, "免费 Agent 的模型选项必须显示逐模型独立状态");
assert.match(appSource, /id="quickAgentModel" class="text-model-state-select"/u, "对话区免费 Agent 模型选择必须支持逐模型状态颜色");
assert.match(appSource, /id="whiteboardTextAgentModel" class="text-model-state-select"/u, "卡片区免费 Agent 模型选择必须支持逐模型状态颜色");
assert.match(appSource, /recordCustomTextGenerationCapability\(requestTextProfile, error/u, "真实生成失败必须回写发起请求的具体免费模型状态");
assert.match(appSource, /persistCapabilityProbes\(\);\s*renderCustomApiCapabilityStatus\(\);\s*renderQuickModelSelector\(\);\s*return true;/u, "真实生成失败写入状态后必须立即重绘对话区和卡片区模型状态");
assert.match(appSource, /modelReplyRequestError\(event\.payload\)/u, "流式生成错误必须通过保留状态码的统一错误解析器");
assert.match(serverSource, /providerErrorCode: String\(error\?\.providerErrorCode/u, "服务端流式错误必须返回上游错误代码用于限流与额度分类");
assert.match(appSource, /schedulePublicTextConnectionVerification/u, "切换免费模型后必须自动安排当前模型核验");
assert.match(appSource, /await autoPreparePublicTextConnection\(requestTextProfile/u, "免费模型首次正式生成前必须自动核验当前选择");
assert.match(appSource, /Automatic verification is advisory, never a generation gate/u, "自动核验失败不得吞掉用户的真实生成任务");
assert.match(appSource, /PUBLIC_TEXT_CAPABILITY_PROBE_KEY/u, "免费模型核验状态必须跨重启保留");
assert.match(appSource, /TEXT_CAPABILITY_PROBE_KEY/u, "所有文字配置的非敏感核验状态必须跨重启保留");
assert.match(appSource, /profile\.systemManaged === true/u, "系统内置免费配置必须在设置页锁定连接身份字段");
console.log("Shensi public model provider contract passed");
