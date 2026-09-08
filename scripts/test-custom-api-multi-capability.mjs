import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AGGREGATE_CUSTOM_MEDIA_PROFILE_VERSION,
  generationSecrets,
  normalizeGenerationProfiles,
} from "../src/generation-profiles.js";
import {
  aggregateCustomApiCapabilityStatus,
  classifyCustomApiCapabilityFailure,
  customApiCapabilitySyncChannels,
  CUSTOM_API_CAPABILITY_CHANNELS,
} from "../src/custom-api-capabilities.js";

const endpoint = "http://127.0.0.1:5317/v1";
assert.deepEqual(CUSTOM_API_CAPABILITY_CHANNELS, ["text", "image", "video", "audio"]);
const shared = normalizeGenerationProfiles({
  textConnections: [{ id: "text-aggregate", adapter: "api", provider: "自定义兼容接口", protocol: "responses", baseUrl: endpoint, model: "gpt-5.6-sol", apiKey: "shared-token" }],
  imageConnections: [{ id: "image-aggregate", adapter: "api", provider: "自定义兼容接口", protocol: "images", baseUrl: `${endpoint}/`, model: "gpt-image-2", apiKey: "" }],
  videoConnections: [{ id: "video-aggregate", adapter: "api", provider: "自定义兼容接口", protocol: "videos", baseUrl: endpoint, model: "sora-2", apiKey: "" }],
  audioConnections: [{ id: "audio-aggregate", adapter: "api", provider: "自定义兼容接口", protocol: "audio", baseUrl: endpoint, model: "gpt-4o-mini-tts", apiKey: "" }],
});
assert.equal(shared.imageConnections.find((item) => item.id === "image-aggregate")?.apiKey, "shared-token");
assert.equal(shared.videoConnections.find((item) => item.id === "video-aggregate")?.apiKey, "shared-token");
assert.equal(shared.audioConnections.find((item) => item.id === "audio-aggregate")?.apiKey, "shared-token");
assert.equal(shared.imageConnections.find((item) => item.id === "image-aggregate")?.credentialSharedFromChannel, "text");
assert.equal(generationSecrets(shared).text["text-aggregate"], "shared-token");
assert.equal(generationSecrets(shared).image["image-aggregate"], undefined, "共享凭据不得重复写入图片凭据槽");
assert.equal(generationSecrets(shared).video["video-aggregate"], undefined, "共享凭据不得重复写入视频凭据槽");
assert.equal(generationSecrets(shared).audio["audio-aggregate"], undefined, "共享凭据不得重复写入音频凭据槽");

const hydratedFromVault = normalizeGenerationProfiles({
  textConnections: [{ id: "text-vault", adapter: "api", provider: "自定义兼容接口", protocol: "responses", baseUrl: endpoint, model: "gpt-5.6-sol" }],
  imageConnections: [{ id: "image-vault", adapter: "api", provider: "自定义兼容接口", protocol: "images", baseUrl: endpoint, model: "gpt-image-2" }],
  videoConnections: [{ id: "video-vault", adapter: "api", provider: "自定义兼容接口", protocol: "videos", baseUrl: endpoint, model: "sora-2" }],
  audioConnections: [{ id: "audio-vault", adapter: "api", provider: "自定义兼容接口", protocol: "audio", baseUrl: endpoint, model: "gpt-4o-mini-tts" }],
}, { text: { "text-vault": "vault-token" } });
assert.equal(hydratedFromVault.imageConnections.find((item) => item.id === "image-vault")?.apiKey, "vault-token");
assert.equal(hydratedFromVault.videoConnections.find((item) => item.id === "video-vault")?.apiKey, "vault-token");
assert.equal(hydratedFromVault.audioConnections.find((item) => item.id === "audio-vault")?.apiKey, "vault-token");

const ambiguous = normalizeGenerationProfiles({
  textConnections: [
    { id: "text-a", adapter: "api", provider: "自定义兼容接口", protocol: "responses", baseUrl: endpoint, model: "a", apiKey: "token-a" },
    { id: "text-b", adapter: "api", provider: "自定义兼容接口", protocol: "responses", baseUrl: endpoint, model: "b", apiKey: "token-b" },
  ],
  imageConnections: [{ id: "image-empty", adapter: "api", provider: "自定义兼容接口", protocol: "images", baseUrl: endpoint, model: "gpt-image-2", apiKey: "" }],
});
assert.equal(ambiguous.imageConnections.find((item) => item.id === "image-empty")?.apiKey, "", "同端点存在多个不同凭据时不得自动猜测");

const isolated = normalizeGenerationProfiles({
  textConnections: [{ id: "text-only", adapter: "api", provider: "自定义兼容接口", protocol: "responses", baseUrl: endpoint, model: "a", apiKey: "token-a" }],
  imageConnections: [{ id: "image-isolated", adapter: "api", provider: "自定义兼容接口", protocol: "images", baseUrl: endpoint, model: "gpt-image-2", credentialSharing: "isolated", apiKey: "" }],
});
assert.equal(isolated.imageConnections.find((item) => item.id === "image-isolated")?.apiKey, "");

const migrated = normalizeGenerationProfiles({});
assert.equal(migrated.aggregateCustomMediaProfileVersion, AGGREGATE_CUSTOM_MEDIA_PROFILE_VERSION);
assert.ok(migrated.videoConnections.some((item) => item.id === "video-cockpit-aggregate-api"));

assert.deepEqual(
  classifyCustomApiCapabilityFailure({ code: "HTTP_403", message: "image quota exhausted" }),
  { state: "quota_exhausted", invalidatesCredential: false, retryable: false },
);
assert.deepEqual(
  classifyCustomApiCapabilityFailure({ code: "HTTP_403", message: "permission denied for this model" }),
  { state: "permission_denied", invalidatesCredential: false, retryable: false },
);
assert.equal(classifyCustomApiCapabilityFailure({ code: "HTTP_401" }).invalidatesCredential, true);
assert.deepEqual(
  classifyCustomApiCapabilityFailure({ code: "auth_unavailable", statusCode: 502, message: "no auth available" }),
  { state: "upstream_auth_unavailable", invalidatesCredential: false, retryable: false },
  "聚合网关认证池不可用不得清除用户 Key 或进入自动重连",
);
assert.deepEqual(
  classifyCustomApiCapabilityFailure({ code: "MODEL_NOT_AVAILABLE", message: "模型不在当前 API Key 的可用模型范围内" }),
  { state: "model_unconfirmed", invalidatesCredential: false, retryable: false },
  "动态模型资格变化只应失效所选模型，不应判定整条配置失效",
);
assert.deepEqual(
  classifyCustomApiCapabilityFailure({ code: "HTTP_503", message: "upstream temporarily unavailable" }),
  { state: "temporarily_unavailable", invalidatesCredential: false, retryable: true },
);
const partial = aggregateCustomApiCapabilityStatus({
  text: { state: "available", available: true },
  image: { state: "quota_exhausted" },
  video: { state: "available", available: true },
  audio: { state: "available", available: true },
});
assert.equal(partial.available, true);
assert.equal(partial.state, "partially_available");
assert.deepEqual(partial.availableChannels, ["text", "video", "audio"]);
assert.equal(partial.channels.image.state, "quota_exhausted", "图片额度不足不得连带禁用其他通道");

const provisional = aggregateCustomApiCapabilityStatus({
  text: { state: "catalog_only" },
  image: { state: "unconfigured" },
  video: { state: "unknown" },
  audio: { state: "software_not_integrated" },
});
assert.equal(provisional.state, "provisional");
assert.deepEqual(provisional.provisionalChannels, ["text", "audio"]);

const empty = aggregateCustomApiCapabilityStatus(Object.fromEntries(["text", "image", "video", "audio"].map((channel) => [channel, { state: "unconfigured" }])));
assert.equal(empty.state, "unconfigured");
const notDetected = aggregateCustomApiCapabilityStatus(Object.fromEntries(["text", "image", "video", "audio"].map((channel) => [channel, { state: "not_detected" }])));
assert.equal(notDetected.state, "unconfigured", "没有检测到模型的未配置通道不得误报为整体不可用");

const detectedImageOnly = {
  text: { state: "catalog_only", detectable: true, syncable: true },
  image: { state: "catalog_only", detectable: true, syncable: true, model: "gpt-image-2" },
  video: { state: "model_unconfirmed", detectable: false, syncable: false },
  audio: { state: "software_not_integrated", detectable: true, syncable: false },
};
assert.deepEqual(customApiCapabilitySyncChannels(detectedImageOnly, ["text"]), ["image"]);
assert.deepEqual(customApiCapabilitySyncChannels(detectedImageOnly, ["text", "image"]), []);
assert.deepEqual(customApiCapabilitySyncChannels({ image: { state: "available", detectable: true } }, []), ["image"]);

const driverSource = await readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8");
assert.match(driverSource, /isProvider\("openai", "自定义兼容接口"\)/u, "自定义兼容视频配置必须进入通用视频驱动");
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /id="customApiCapabilityPanel"/u, "设置页必须显示自定义连接四模态能力状态");
assert.match(appSource, /data-custom-api-capability="audio"/u, "通用能力面板必须包含音频状态");
assert.match(appSource, /id="refreshCustomApiCapabilities"/u, "通用能力面板必须提供手动刷新按钮");
assert.match(appSource, /id="syncCustomApiCapabilities"/u, "通用能力面板必须提供按检测能力同步按钮");
assert.match(appSource, /customApiCapabilitySyncChannels/u, "同步按钮必须只针对已检测且未配置的通道");
assert.match(appSource, /未检测到能力的通道未创建/u, "同步结果必须明确不创建未检测能力通道");
assert.match(appSource, /connectionProbeOnly: true/u, "普通刷新只能执行非计费连接探针");
assert.match(appSource, /软件尚未接入音频生成驱动|神思尚未接入音频生成驱动/u, "音频未接入时不得虚报可生成");
assert.match(appSource, /文字与视频能力不受影响/u, "图片能力失败不得连带禁用文字和视频");
assert.match(appSource, /文字与图片能力不受影响/u, "视频能力失败不得连带禁用文字和图片");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /settings\.audioChannel === true \|\| settings\.channel === "audio"/u, "适配器探针必须按音频通道读取正确配置");
assert.match(serverSource, /body\.audioChannel === true \|\| body\.channel === "audio"/u, "模型目录必须按音频通道读取正确配置");
const adaptersSource = await readFile(new URL("../src/server/adapters.mjs", import.meta.url), "utf8");
assert.match(adaptersSource, /settings\.connectionProbeOnly === true/u, "CLI 刷新必须支持仅检查可执行文件且不触发真实推理");

console.log("Shensi custom API multi-capability contract passed");
