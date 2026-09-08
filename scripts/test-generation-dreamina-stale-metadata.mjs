import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeGenerationProfileDraftsById, normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { generateImageWithAdapter } from "../src/server/adapters.mjs";

const runtimeRoot = await mkdtemp(join(tmpdir(), "shensi-dreamina-stale-metadata-"));
process.env.SHENSI_MACHINE_DATA_ROOT = runtimeRoot;
const { listGenerationRuntimeBindings, resolveTrustedGenerationSettings, saveGenerationRuntimeBindings } = await import(
  `../src/server/generation-runtime-store.mjs?stale-metadata=${Date.now()}`,
);

const profileId = "image-cockpit-aggregate-api";
const endpoint = "http://127.0.0.1:5317/v1";
const staleDreaminaBinding = {
  channel: "image",
  profileId,
  adapter: "cli",
  provider: "即梦",
  protocol: "dreamina_cli",
  cliPath: "shensi-dreamina-image",
  cliArgs: "generate",
  dreaminaCliProfile: "guobazai",
};
await saveGenerationRuntimeBindings({ bindings: [staleDreaminaBinding] });

const resolved = await resolveTrustedGenerationSettings({
  channel: "image",
  settings: {
    id: profileId,
    connectionId: profileId,
    adapter: "api",
    provider: "自定义兼容接口",
    protocol: "images",
    baseUrl: endpoint,
    model: "gpt-image-2",
    apiKey: "aggregate-test-token",
    dreaminaCliProfile: "guobazai",
    dreaminaExpectedIdentity: "user:stale",
  },
});

assert.equal(resolved.adapter, "api");
assert.equal(resolved.provider, "自定义兼容接口");
assert.equal(resolved.baseUrl, endpoint);
assert.equal(resolved.model, "gpt-image-2");
assert.equal(resolved.dreaminaCliProfile, undefined, "自定义 API 不得携带即梦账号字段");
assert.equal(resolved.dreaminaExpectedIdentity, undefined, "自定义 API 不得携带即梦身份字段");
const migratedBinding = (await listGenerationRuntimeBindings()).bindings.find(
  (binding) => binding.channel === "image" && binding.profileId === profileId,
);
assert.deepEqual(
  migratedBinding,
  {
    channel: "image",
    profileId,
    adapter: "api",
    provider: "自定义兼容接口",
    protocol: "images",
    baseUrl: endpoint,
    cliPath: "",
    cliArgs: "",
    chatAdapter: "",
    chatProtocol: "",
    chatBaseUrl: "",
  },
  "迁移后的绑定必须是纯 API 绑定，不得保留即梦 CLI 身份",
);

const originalFetch = globalThis.fetch;
let submittedUrl = "";
globalThis.fetch = async (url) => {
  submittedUrl = String(url);
  return new Response(JSON.stringify({
    id: "aggregate-stale-metadata-regression",
    data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }],
  }), { status: 200, headers: { "content-type": "application/json" } });
};
try {
  const generated = await generateImageWithAdapter({
    settings: { ...resolved, imageChannel: true },
    prompt: "生成一张路由隔离测试图",
    aspectRatio: "1:1",
    quality: "standard",
  });
  assert.equal(submittedUrl, `${endpoint}/images/generations`, "带旧即梦元数据的聚合 API 必须提交到聚合图片端点");
  assert.equal(generated.returnedImageCount, 1, "聚合 API 返回结果必须能正常解析");
} finally {
  globalThis.fetch = originalFetch;
}

const normalized = normalizeGenerationProfiles({
  activeImageConnectionId: profileId,
  imageConnections: [{
    id: profileId,
    adapter: "api",
    provider: "自定义兼容接口",
    protocol: "images",
    baseUrl: endpoint,
    model: "gpt-image-2",
    dreaminaCliProfile: "guobazai",
    dreaminaExpectedIdentity: "user:stale",
  }],
});
const normalizedProfile = normalized.imageConnections.find((profile) => profile.id === profileId);
assert.ok(normalizedProfile);
assert.equal(Object.hasOwn(normalizedProfile, "dreaminaCliProfile"), false, "规范化必须清除旧即梦账号字段");
assert.equal(Object.hasOwn(normalizedProfile, "dreaminaExpectedIdentity"), false, "规范化必须清除旧即梦身份字段");

const storedWithExtension = {
  activeImageConnectionId: profileId,
  imageConnections: [{
    id: profileId,
    adapter: "api",
    provider: "自定义兼容接口",
    protocol: "images",
    baseUrl: endpoint,
    model: "gpt-image-2",
    dreaminaCliProfile: "",
    dreaminaExpectedIdentity: "",
    customExtension: { retained: true },
  }],
};
const persisted = mergeGenerationProfileDraftsById(
  storedWithExtension,
  normalizeGenerationProfiles(storedWithExtension),
);
const persistedProfile = persisted.imageConnections.find((profile) => profile.id === profileId);
assert.equal(Object.hasOwn(persistedProfile, "dreaminaCliProfile"), false, "设置保存不得恢复旧即梦账号字段");
assert.equal(Object.hasOwn(persistedProfile, "dreaminaExpectedIdentity"), false, "设置保存不得恢复旧即梦身份字段");
assert.deepEqual(persistedProfile.customExtension, { retained: true }, "清理身份字段不得删除未知扩展字段");

await rm(runtimeRoot, { recursive: true, force: true });
console.log("Dreamina stale metadata isolation tests passed");
