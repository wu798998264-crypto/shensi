import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseOpenCodeModelCatalog, detectOpenCodeModelCatalog, resetOpenCodeModelCatalogCache } from "../src/cli/opencode-model-catalog.mjs";
import { validateGenericOpenCodeConnection, genericOpenCodeManualProfile } from "../src/generation-profiles.js";
import { usableOpenCodeCliOverride } from "../src/opencode-profile-ui-policy.js";
import { opencodeReportedProviderModel, testOpenCodeAgentConnection } from "../src/server/opencode-agent-runner.mjs";

const parsed = parseOpenCodeModelCatalog("openai/gpt-5\ndeepseek/deepseek-v4-pro\nanthropic/claude-sonnet");
assert.deepEqual(parsed.models.map((item) => item.slug), ["openai/gpt-5", "deepseek/deepseek-v4-pro", "anthropic/claude-sonnet"]);
assert.deepEqual(parsed.groups.map((item) => item.provider), ["openai", "deepseek", "anthropic"]);
assert.equal(parseOpenCodeModelCatalog(JSON.stringify({ models: [{ id: "openai/gpt-5" }], defaultModel: "openai/gpt-5" })).defaultModel, "openai/gpt-5");

let launches = 0;
const fixture = "const a=process.argv.slice(1); if(a.includes('--version')) console.log('1.0.0-test'); else console.log('openai/gpt-5\\ndeepseek/deepseek-chat');";
const fakeLaunchResolver = async () => {
  launches += 1;
  return { executable: process.execPath, prefixArgs: ["-e", fixture, "--"] };
};
resetOpenCodeModelCatalogCache();
const [first, second, third] = await Promise.all([
  detectOpenCodeModelCatalog({ force: true, launchResolver: fakeLaunchResolver }),
  detectOpenCodeModelCatalog({ force: true, launchResolver: fakeLaunchResolver }),
  detectOpenCodeModelCatalog({ force: true, launchResolver: fakeLaunchResolver }),
]);
assert.equal(launches, 1, "concurrent refreshes must share one OpenCode process chain");
assert.deepEqual(first.models.map((item) => item.slug), ["openai/gpt-5", "deepseek/deepseek-chat"]);
assert.deepEqual(second.models, first.models);
assert.deepEqual(third.models, first.models);
await detectOpenCodeModelCatalog({ launchResolver: fakeLaunchResolver });
assert.equal(launches, 1, "short-lived cache must avoid a second process");
const profile = genericOpenCodeManualProfile({ model: "deepseek/deepseek-v4-pro" });
assert.equal(profile.agentEngine, "opencode");
assert.equal(validateGenericOpenCodeConnection({ profile, capability: { available: true } }).ok, true);
assert.equal(validateGenericOpenCodeConnection({ profile: { ...profile, model: "deepseek-v4-pro", agentModelId: "" }, capability: { available: true } }).stage, "model");
assert.equal(usableOpenCodeCliOverride("codex"), "", "旧配置残留的 Codex 路径不得传给 OpenCode 探测");
assert.equal(usableOpenCodeCliOverride("opencode"), "", "默认 OpenCode 命令由服务端安全探测");
assert.match(usableOpenCodeCliOverride("C:\\Tools\\opencode.exe"), /opencode\.exe$/iu, "用户明确指定的 OpenCode 可执行文件应保留");
const runnerSource = await readFile(new URL("../src/server/opencode-agent-runner.mjs", import.meta.url), "utf8");
assert.match(runnerSource, /credentialSource/u, "统一运行器必须显式区分 OpenCode 凭据与神思安全凭据");
assert.match(runnerSource, /shell:\s*false/u, "通用运行器必须使用参数数组而不是 shell 命令");
assert.match(runnerSource, /"--model",\s*requestedModel/u, "完整 provider\/model 必须作为独立参数传入");
assert.deepEqual(opencodeReportedProviderModel({ part: { message: { info: { providerID: "deepseek", modelID: "deepseek-v4-pro" } } } }), {
  provider: "deepseek",
  model: "deepseek-v4-pro",
});

const managedFixture = [
  "const config=JSON.parse(process.env.OPENCODE_CONFIG_CONTENT||'{}');",
  "const ok=config.provider?.deepseek?.options?.apiKey==='{env:SHENSI_OPENCODE_API_KEY}' && process.env.SHENSI_OPENCODE_API_KEY==='managed-test-secret';",
  "if(!ok){console.error('managed provider missing');process.exit(7)}",
  "console.log(JSON.stringify({type:'text',text:'SHENSI_OPENCODE_OK',providerID:'deepseek',modelID:'deepseek-v4-pro'}));",
].join("");
const managedInference = await testOpenCodeAgentConnection({
  cwd: process.cwd(),
  model: "deepseek/deepseek-v4-pro",
  provider: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "managed-test-secret",
  credentialSource: "shensi",
  launchResolver: async () => ({ executable: process.execPath, prefixArgs: ["-e", managedFixture, "--"] }),
});
assert.equal(managedInference.provider, "deepseek");
assert.equal(managedInference.model, "deepseek/deepseek-v4-pro");
resetOpenCodeModelCatalogCache();
console.log("Generic OpenCode model catalog and profile validation tests passed");
