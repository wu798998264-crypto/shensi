import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-text-credential-handoff-"));
const previousRoot = process.env.SHENSI_MACHINE_DATA_ROOT;
process.env.SHENSI_MACHINE_DATA_ROOT = root;

try {
  const runtime = await import(`../src/server/generation-runtime-store.mjs?handoff=${Date.now()}`);
  const profileId = "text-runtime-handoff";
  const binding = {
    channel: "text",
    profileId,
    adapter: "api",
    provider: "自定义兼容接口",
    agentEngine: "codex_api",
    protocol: "responses",
    baseUrl: "http://127.0.0.1:5317/v1",
    cliPath: "",
    cliArgs: "",
  };
  await runtime.saveGenerationRuntimeBindings({ bindings: [binding] });
  assert.equal(runtime.rememberGenerationRuntimeCredentials({
    credentials: { text: { [profileId]: "test-only-secret" } },
    bindings: [binding],
  }), 1);
  const resolved = await runtime.resolveTrustedGenerationSettings({
    channel: "text",
    route: "agent",
    settings: {
      activeTextAgentConnectionId: profileId,
      textConnections: [{
        id: profileId,
        name: "聚合api",
        adapter: "api",
        provider: "自定义兼容接口",
        protocol: "responses",
        agentEngine: "codex_api",
        model: "gpt-6-astra",
        agentModelId: "gpt-6-astra",
        credentialSource: "shensi",
      }],
    },
  });
  assert.equal(resolved.apiKey, "test-only-secret");
  assert.equal(resolved.baseUrl, binding.baseUrl);
  assert.equal(resolved.model, "gpt-6-astra");
  const resolvedProfile = resolved.textConnections.find((profile) => profile.id === profileId);
  assert.equal(resolvedProfile.apiKey, "test-only-secret");
  assert.equal(resolvedProfile.baseUrl, binding.baseUrl);
  assert.equal(resolvedProfile.name, "聚合api");
  assert.equal(resolvedProfile.model, "gpt-6-astra");

  // The first request after startup can race the durable binding write. The
  // process-only credential handoff must still project the key onto the
  // selected profile so the Agent contract does not reject a valid session.
  const transientProfileId = "text-runtime-transient";
  assert.equal(runtime.rememberGenerationRuntimeCredentials({
    credentials: { text: { [transientProfileId]: "transient-only-secret" } },
  }), 1);
  const transientResolved = await runtime.resolveTrustedGenerationSettings({
    channel: "text",
    route: "agent",
    settings: {
      activeTextAgentConnectionId: transientProfileId,
      textConnections: [{
        id: transientProfileId,
        name: "聚合api（启动竞态）",
        adapter: "api",
        provider: "自定义兼容接口",
        protocol: "responses",
        agentEngine: "codex_api",
        model: "gpt-6.1-sol",
        agentModelId: "gpt-6.1-sol",
        baseUrl: "http://127.0.0.1:5317/v1",
        credentialSource: "shensi",
      }],
    },
  });
  assert.equal(transientResolved.apiKey, "transient-only-secret");
  assert.equal(transientResolved.textConnections.find((profile) => profile.id === transientProfileId)?.apiKey, "transient-only-secret");
  const { effectiveRuntimeContract } = await import(`../src/effective-runtime-contract.js?handoff=${Date.now()}`);
  assert.equal(effectiveRuntimeContract({ settings: transientResolved, surface: "agent" }).ok, true,
    "瞬时凭证注入后文字 Agent 合同必须可验证");

  const mainSource = await readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(mainSource, /credentialVault\.readChannel\("text"\)[\s\S]{0,800}\/api\/generation\/runtime\/text-credentials/u);
  assert.match(mainSource, /backendReadyProcess = child;[\s\S]{0,300}restoreTextGenerationCredentialSession\(\)/u);
  assert.match(appSource, /const rebindDesktopTextGenerationRuntime = async[\s\S]{0,1800}\/api\/generation\/runtime\/text-credentials/u,
    "全局文字配置加载后必须再次把 DPAPI 文字凭证绑定到当前核心");
  assert.match(serverSource, /\/api\/generation\/runtime\/text-credentials[\s\S]{0,600}credentials: \{ text: body\.credentials \}/u);
  assert.doesNotMatch(serverSource.match(/\/api\/generation\/runtime\/text-credentials[\s\S]{0,800}/u)?.[0] || "", /launchMediaGenerationWorker/u);
  assert.match(serverSource, /selectedAgentEngine === "codex_api"[\s\S]{0,280}resolveTrustedGenerationSettings\(\{[\s\S]{0,180}route: "agent"/u);
  console.log("Desktop text credential handoff restores Agent runtime without touching media workers");
} finally {
  if (previousRoot === undefined) delete process.env.SHENSI_MACHINE_DATA_ROOT;
  else process.env.SHENSI_MACHINE_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
