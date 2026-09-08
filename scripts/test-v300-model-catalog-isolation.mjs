import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  detectOpenCodeModelCatalog,
  resetOpenCodeModelCatalogCache,
} from "../src/cli/opencode-model-catalog.mjs";
import {
  openCodeCatalogCacheKey,
  openCodeModelMatchesProvider,
  openCodeRunnerDefaults,
} from "../src/opencode-profile-ui-policy.js";

let launches = 0;
const launchResolver = async ({ environment = {} } = {}) => {
  launches += 1;
  return {
    executable: process.execPath,
    prefixArgs: [resolve("scripts/fixtures/v300/fake-opencode-catalog.mjs")],
  };
};

resetOpenCodeModelCatalogCache();
const deepSeekKey = openCodeCatalogCacheKey({
  runner: "opencode",
  credentialSource: "shensi",
  provider: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
});
const openAiKey = openCodeCatalogCacheKey({
  runner: "opencode",
  credentialSource: "shensi",
  provider: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
});
assert.notEqual(deepSeekKey, openAiKey);

const deepSeek = await detectOpenCodeModelCatalog({
  cacheKey: deepSeekKey,
  environment: { ...process.env, SHENSI_TEST_CATALOG: "deepseek" },
  launchResolver,
});
const openAi = await detectOpenCodeModelCatalog({
  cacheKey: openAiKey,
  environment: { ...process.env, SHENSI_TEST_CATALOG: "openai" },
  launchResolver,
});
assert.deepEqual(deepSeek.models.map((item) => item.slug), ["deepseek/deepseek-chat", "deepseek/deepseek-v4-pro"]);
assert.deepEqual(openAi.models.map((item) => item.slug), ["openai/gpt-5.6-sol"]);
assert.equal(launches, 2, "不同凭据来源/服务商/Base URL 必须使用隔离的探测任务和缓存");

await Promise.all([
  detectOpenCodeModelCatalog({ cacheKey: deepSeekKey, force: true, environment: { ...process.env, SHENSI_TEST_CATALOG: "deepseek" }, launchResolver }),
  detectOpenCodeModelCatalog({ cacheKey: deepSeekKey, force: true, environment: { ...process.env, SHENSI_TEST_CATALOG: "deepseek" }, launchResolver }),
]);
assert.equal(launches, 3, "同一缓存键的并发刷新必须 single-flight");
assert.equal(openCodeModelMatchesProvider("deepseek/deepseek-v4-pro", "DeepSeek"), true);
assert.equal(openCodeModelMatchesProvider("openai/gpt-5.6-sol", "DeepSeek"), false);
assert.deepEqual(openCodeRunnerDefaults("opencode"), {
  adapter: "cli",
  cliPath: "opencode",
  cliArgs: "",
  requiresQualifiedModel: true,
});

const appSource = await readFile(resolve("src/app.js"), "utf8");
const serverSource = await readFile(resolve("server.mjs"), "utf8");
assert.match(appSource, /query\.set\("credentialSource"/u, "OpenCode 探测必须把凭据来源传给服务端缓存键");
assert.match(appSource, /query\.set\("provider"/u, "OpenCode 探测必须把服务商传给服务端缓存键");
assert.match(appSource, /query\.set\("baseUrl"/u, "OpenCode 探测必须把 Base URL 传给服务端缓存键");
assert.match(serverSource, /cacheKey:\s*openCodeCatalogCacheKey/u, "服务端必须按完整模型目录身份隔离缓存");

resetOpenCodeModelCatalogCache();
console.log("v3.0 OpenCode model catalog isolation tests passed");
