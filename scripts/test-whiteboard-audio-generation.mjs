import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeGenerationProfiles, portableGenerationSettings } from "../src/generation-profiles.js";
import {
  mediaGenerationConnectionAvailable,
} from "../src/media-capability-probe.js";
import {
  whiteboardGenerationMeasurementActive,
  whiteboardGenerationProgressActive,
} from "../src/whiteboard-progress.js";
import {
  deactivateWhiteboardGenerationDraft,
  preferredWhiteboardGenerationDraftForNode,
  updateWhiteboardGenerationDraftCache,
  whiteboardGenerationDraftKey,
} from "../src/whiteboard-generation-draft.js";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const driver = await readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(app, /id="whiteboardAudioDialog"/u, "白板必须提供音频生成操作栏");
assert.match(app, /availableGenerationConnections\("audio"\)\.length > 0/u, "音频入口必须由真实可用连接控制显隐");
assert.match(app, /whiteboardPickerProfile\([\s\S]{0,120}"audio"[\s\S]{0,220}syncWhiteboardAudioModelOptions\(profile\?\.model \|\| "", \{ applyModelDefaults: true \}\)/u, "切换音频连接必须采用该配置自己的默认模型，不能沿用上一个连接的模型");
assert.match(app, /const profiles = \[[\s\S]{0,500}audioConnections[\s\S]{0,500}imageConnections[\s\S]{0,500}videoConnections/u, "启动探针必须先确认音频，不能被慢速视频账号检查长期阻塞入口");
assert.match(app, /\{ channel: "audio", dialog: elements\.whiteboardAudioDialog, form: elements\.whiteboardAudioForm \}/u);
for (const field of ["audioType", "voiceId", "language", "speed", "format", "sampleRate"]) {
  assert.match(app, new RegExp(`name="${field}"`, "u"), `音频操作栏缺少 ${field} 参数`);
  assert.match(app, new RegExp(`${field}:`, "u"), `音频任务没有提交 ${field} 参数`);
}
assert.match(app, /createWhiteboardMediaGenerationJob\(\{[\s\S]*?channel: "audio"/u, "音频必须进入持久媒体任务链");
assert.match(driver, /voice_setting_voice_id=\$\{String\(job\.request\.voiceId/u, "语音模型必须接收操作栏音色");
assert.match(driver, /sample_rate=\$\{Math\.max\(8000, Number\(job\.request\.sampleRate\)/u, "通用音频模型必须接收采样率");
assert.match(styles, /:is\(#whiteboardImageDialog, #whiteboardVideoDialog, #whiteboardAudioDialog\) \.whiteboard-media-picker-trigger \{/u, "音频连接和模型必须复用图片、视频的选择器布局");
assert.match(styles, /:is\(#whiteboardImageDialog, #whiteboardVideoDialog, #whiteboardAudioDialog\)\.is-expanded :is\(\.whiteboard-image-primary-option, \.whiteboard-video-primary-option, \.whiteboard-audio-primary-option\)/u, "音频展开态必须复用图片、视频的主选项布局");

const audioDraftScope = { workspaceId: "workspace-audio", documentId: "board-audio", nodeId: "card-audio", channel: "audio" };
assert.ok(whiteboardGenerationDraftKey(audioDraftScope), "音频必须是合法的白板生成草稿通道");
let audioDraftCache = updateWhiteboardGenerationDraftCache({}, audioDraftScope, {
  connectionId: "audio-libtv-jimeng",
  model: "seed-audio-1.0",
  prompt: "生成一段雨夜旁白",
}, { updatedAt: 20 });
audioDraftCache = updateWhiteboardGenerationDraftCache(audioDraftCache, { ...audioDraftScope, channel: "image" }, {
  connectionId: "image-old",
  model: "image-old",
  prompt: "较早的图片提示词",
}, { active: false, open: false, updatedAt: 10 });
audioDraftCache = deactivateWhiteboardGenerationDraft(audioDraftCache, audioDraftScope);
const reopenedDraft = preferredWhiteboardGenerationDraftForNode(audioDraftCache, {
  workspaceId: audioDraftScope.workspaceId,
  documentId: audioDraftScope.documentId,
  nodeId: audioDraftScope.nodeId,
});
assert.equal(reopenedDraft?.channel, "audio", "点击卡片外关闭音频操作栏后，再次打开必须保持音频模式");
assert.equal(reopenedDraft?.values.connectionId, "audio-libtv-jimeng", "音频连接选择必须随草稿保留");
assert.equal(reopenedDraft?.values.model, "seed-audio-1.0", "音频模型选择必须随草稿保留");

const normalized = normalizeGenerationProfiles({
  audioConnections: [
    { id: "audio-sumo-reserved", name: "旧占位", provider: "Sumo", adapter: "api", model: "sumo", reserved: true },
    { id: "audio-a", name: "同一配置", remarkName: "同一备注", provider: "LibTV", adapter: "cli", protocol: "media", model: "seed-audio-1.0", cliPath: "libtv", cliArgs: "", reserved: false },
    { id: "audio-b", name: "同一配置", remarkName: "同一备注", provider: "LibTV", adapter: "cli", protocol: "media", model: "seed-audio-1.0", cliPath: "libtv", cliArgs: "", reserved: false },
  ],
  activeAudioConnectionId: "audio-b",
});
assert.equal(normalized.audioConnections.some((profile) => profile.reserved === true), false, "预留占位配置必须清理");
assert.equal(normalized.audioConnections.filter((profile) => profile.name === "同一配置").length, 1, "完全重复配置只保留一份");
assert.ok(normalized.audioConnections.some((profile) => profile.id === normalized.activeAudioConnectionId), "清理后活动配置必须指向保留项");
assert.ok(normalized.audioConnections.some((profile) => profile.id === "audio-libtv-jimeng"));
assert.ok(normalized.audioConnections.some((profile) => profile.id === "audio-libtv-hailuo"));
const portableRoundTrip = normalizeGenerationProfiles(portableGenerationSettings(normalized));
for (const profileId of ["audio-libtv-jimeng", "audio-libtv-hailuo"]) {
  const profile = portableRoundTrip.audioConnections.find((item) => item.id === profileId);
  assert.equal(profile?.cliPath, "libtv", `${profileId} 重载后必须恢复内置 LibTV CLI`);
  assert.equal(profile?.provider, "LibTV", `${profileId} 重载后必须保持内置服务商`);
  assert.equal(profile?.reserved, false, `${profileId} 重载后不能退回预留配置`);
}
const audioProfile = portableRoundTrip.audioConnections.find((item) => item.id === "audio-libtv-jimeng");
assert.equal(mediaGenerationConnectionAvailable("audio", audioProfile, null), false, "音频探针确认前不得显示生成入口");
assert.equal(mediaGenerationConnectionAvailable("audio", audioProfile, {
  connected: true,
  available: true,
  driverRegistered: true,
  visibilityChecked: true,
  models: [audioProfile.model],
}), true, "音频驱动和当前模型确认后必须自动显示生成入口");
assert.equal(mediaGenerationConnectionAvailable("audio", audioProfile, {
  connected: false,
  available: false,
  driverRegistered: true,
  visibilityChecked: true,
  models: [],
}), false, "音频能力失效时必须隐藏生成入口");

const activeAudio = { channel: "audio", status: "running", providerTaskId: "audio-task", submissionState: "submitted" };
assert.equal(whiteboardGenerationMeasurementActive(activeAudio), true);
assert.equal(whiteboardGenerationProgressActive(activeAudio), true);

console.log("whiteboard audio generation and invalid-profile cleanup contracts passed");
