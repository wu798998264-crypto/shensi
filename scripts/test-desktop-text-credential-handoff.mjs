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

  const mainSource = await readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8");
  const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(mainSource, /credentialVault\.readChannel\("text"\)[\s\S]{0,800}\/api\/generation\/runtime\/text-credentials/u);
  assert.match(mainSource, /backendReadyProcess = child;[\s\S]{0,300}restoreTextGenerationCredentialSession\(\)/u);
  assert.match(serverSource, /\/api\/generation\/runtime\/text-credentials[\s\S]{0,600}credentials: \{ text: body\.credentials \}/u);
  assert.doesNotMatch(serverSource.match(/\/api\/generation\/runtime\/text-credentials[\s\S]{0,800}/u)?.[0] || "", /launchMediaGenerationWorker/u);
  assert.match(serverSource, /selectedAgentEngine === "codex_api"[\s\S]{0,280}resolveTrustedGenerationSettings\(\{[\s\S]{0,180}route: "agent"/u);
  console.log("Desktop text credential handoff restores Agent runtime without touching media workers");
} finally {
  if (previousRoot === undefined) delete process.env.SHENSI_MACHINE_DATA_ROOT;
  else process.env.SHENSI_MACHINE_DATA_ROOT = previousRoot;
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
