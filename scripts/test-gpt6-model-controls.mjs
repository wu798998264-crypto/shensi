import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { getProviderModelOptions, getModelOption, getProviderImageModelOptions,
  getProviderVideoModelOptions, getProviderPreset, sanitizeModelControls, supportedSpeedModes } from "../src/model-presets.js";
import { addCodexCliOverrides, normalizeCodexModelCatalog, runModelAdapter } from "../src/server/adapters.mjs";
import { createCodexApiAgentRuntime } from "../src/server/codex-api-agent-runtime.mjs";

const levels = ["low", "medium", "high", "xhigh", "max"];
const model = "gpt-6-astra";
for (const provider of ["OpenAI", "自定义兼容接口"]) {
  assert.ok(getProviderModelOptions(provider).some((item) => item.slug === model));
  assert.deepEqual(getModelOption(provider, model).reasoningLevels, levels);
  assert.deepEqual(supportedSpeedModes(getModelOption(provider, model)), ["fast"]);
  assert.deepEqual(getModelOption(provider, `openai/${model}`).reasoningLevels, levels);
  assert.ok(!getProviderImageModelOptions(provider).some((item) => item.slug === model));
  assert.ok(!getProviderVideoModelOptions(provider).some((item) => item.slug === model));
}
assert.equal(getProviderPreset("OpenAI").api.model, "gpt-5.6-sol", "新增可选模型不切换默认配置");
assert.equal(getModelOption("DeepSeek", model), null, "不得污染其他供应商目录");
assert.equal(sanitizeModelControls({ provider: "OpenAI", model, reasoningEffort: "none", speedMode: "fast" }).reasoningEffort, "");
assert.equal(sanitizeModelControls({ provider: "自定义兼容接口", model, reasoningEffort: "ultra", speedMode: "flex" }).speedMode, "default");
assert.equal(sanitizeModelControls({ provider: "自定义兼容接口", model, reasoningEffort: "ultra" }).reasoningEffort, "");
const live = normalizeCodexModelCatalog({ models: [{ slug: model, supported_reasoning_levels: levels.map((effort) => ({ effort })), service_tiers: [{ id: "priority", name: "Fast" }] }] });
assert.deepEqual(getModelOption("OpenAI", model, live).reasoningLevels, levels);
assert.deepEqual(supportedSpeedModes(getModelOption("OpenAI", model, live)), ["fast"]);

for (const reasoningEffort of levels) {
  const settings = sanitizeModelControls({ adapter: "cli", provider: "OpenAI", cliPath: "codex", model, reasoningEffort, speedMode: "fast" });
  const args = addCodexCliOverrides({ settings, args: ["exec", "--sandbox", "read-only", "-"] });
  assert.ok(args.includes(model));
  assert.ok(args.includes(`model_reasoning_effort="${reasoningEffort}"`));
  assert.ok(args.includes('service_tier="fast"'));
  assert.equal(args.at(-1), "-");
}

const requests = [];
const server = createServer(async (request, response) => {
  let text = "";
  for await (const chunk of request) text += chunk;
  requests.push({ url: request.url, body: JSON.parse(text) });
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(request.url.endsWith("/responses")
    ? { id: "test-response", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }
    : { id: "test-chat", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
try {
  for (const provider of ["OpenAI", "自定义兼容接口"]) {
    for (const protocol of ["responses", "chat_completions"]) {
      for (const reasoningEffort of levels) {
        const settings = { adapter: "api", provider, protocol, model, apiKey: "mock-key-no-real-account",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoningEffort, speedMode: "fast", temperature: "0.7", maxOutputTokens: "2048" };
        const original = structuredClone(settings);
        const result = await runModelAdapter({ settings, system: "test", messages: [{ role: "user", content: "test" }], cwd: process.cwd() });
        assert.equal(result.text, "ok");
        assert.deepEqual(settings, original, "请求不能写回现有配置");
        const { body } = requests.at(-1);
        assert.equal(body.model, model);
        assert.equal(body.service_tier, "priority");
        assert.equal(body.temperature, undefined);
        if (protocol === "responses") {
          assert.equal(body.reasoning.effort, reasoningEffort);
          assert.equal(body.max_output_tokens, 2048);
        } else {
          assert.equal(body.reasoning_effort, reasoningEffort);
          assert.equal(body.max_completion_tokens, 2048);
          assert.equal(body.max_tokens, undefined);
        }
      }
    }
  }
  await runModelAdapter({ settings: { adapter: "api", provider: "OpenAI", protocol: "chat_completions",
    model: "gpt-4.1", apiKey: "mock-key", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, temperature: "0.6", maxOutputTokens: "256" },
    system: "test", messages: [{ role: "user", content: "test" }], cwd: process.cwd() });
  assert.equal(requests.at(-1).body.temperature, 0.6, "旧模型请求保持原行为");
  assert.equal(requests.at(-1).body.max_tokens, 256);
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const agentRequests = [];
const agent = createCodexApiAgentRuntime({ fetchImpl: async (url, options) => {
  agentRequests.push(JSON.parse(options.body));
  return new Response(JSON.stringify(String(url).endsWith("/responses")
    ? { id: "agent-test", output_text: "ok" }
    : { id: "agent-test", choices: [{ message: { content: "ok" } }] }), { status: 200 });
} });
try {
  for (const protocol of ["responses", "chat_completions"]) {
    for (const agentReasoningEffort of levels) {
      const settings = { adapter: "api", provider: "自定义兼容接口", protocol, model, agentEngine: "codex_api", apiKey: "mock-key",
        baseUrl: "https://mock.invalid/v1", agentReasoningEffort, agentSpeedMode: "fast" };
      const original = structuredClone(settings);
      assert.equal((await agent.runStage({ settings, prompt: "test", sessionId: `${protocol}-${agentReasoningEffort}` })).text, "ok");
      assert.deepEqual(settings, original);
      const body = agentRequests.at(-1);
      assert.equal(body.service_tier, "priority");
      assert.equal(protocol === "responses" ? body.reasoning.effort : body.reasoning_effort, agentReasoningEffort);
      assert.equal(body.temperature, undefined);
    }
  }
  const before = agentRequests.length;
  await assert.rejects(agent.runStage({
    settings: { adapter: "api", provider: "自定义兼容接口", protocol: "chat_completions", model, agentEngine: "codex_api", apiKey: "mock-key", baseUrl: "https://mock.invalid/v1" },
    prompt: "read", sessionId: "gpt6-tool-protocol", workspaceToolRuntime: {
      dynamicTools: [{ name: "workspace", tools: [{ type: "function", name: "read", description: "read", inputSchema: { type: "object", properties: {} } }] }],
    },
  }), (error) => error.code === "GPT6_RESPONSES_REQUIRED");
  assert.equal(agentRequests.length, before, "不支持的工具协议必须在提交前拒绝");
} finally { agent.close(); }
console.log("GPT-6 catalog, Codex CLI controls, and aggregate/API request regression passed (mock requests only)");
