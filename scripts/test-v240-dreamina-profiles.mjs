import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DREAMINA_CLI_PROFILES, normalizeDreaminaCliProfileId, validDreaminaCliProfileId } from "../src/media-cli-presets.js";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { dreaminaCliEnvironment, dreaminaCliRuntime } from "../src/server/dreamina-cli-profile.mjs";
import { credentialFileFingerprint } from "../src/server/dreamina-profile-identity-store.mjs";

assert.equal(normalizeDreaminaCliProfileId("tashuo-juyougeng"), "tashuo-juyougeng");
assert.equal(normalizeDreaminaCliProfileId("default"), "default", "历史 ID default 必须继续绑定 Edge 账号");
assert.equal(normalizeDreaminaCliProfileId(""), "", "未选择账号不得回退到默认账号");
assert.equal(validDreaminaCliProfileId(""), false, "空账号 ID 必须被阻断");
assert.equal(validDreaminaCliProfileId("bad/profile"), false, "显式非法 profileId 必须被阻断，不能静默回退默认账号");
assert.equal(DREAMINA_CLI_PROFILES.find((item) => item.id === "tashuo-juyougeng")?.remarkName, "她说剧有梗");
assert.equal(DREAMINA_CLI_PROFILES.find((item) => item.id === "default")?.remarkName, "短剧最前线");
assert.equal(DREAMINA_CLI_PROFILES.find((item) => item.id === "duanju-zuiqianxian")?.remarkName, "冰封初恋");
assert.equal(DREAMINA_CLI_PROFILES.find((item) => item.id === "yinou-shijie")?.remarkName, "银鸥师姐");

const migratedSettings = normalizeGenerationProfiles({
  cliRemarkMigrationVersion: 0,
  videoCliDefaultVersion: 2,
  textConnections: [{ id: "text-default", provider: "OpenAI", adapter: "cli" }],
  imageConnections: [{ id: "image-default", provider: "OpenAI", adapter: "cli", cliPath: "shensi-openai-image" }],
  videoConnections: [{
    id: "video-dreamina-cli",
    provider: "即梦",
    adapter: "cli",
    cliPath: "shensi-dreamina-video",
    dreaminaCliProfile: "default",
    model: "seedance2.0",
    remarkName: "默认即梦",
  }],
});
assert.equal(migratedSettings.textConnections.find(({ id }) => id === "text-default")?.remarkName, "麻雀");
assert.equal(migratedSettings.imageConnections.some(({ id }) => id === "image-default"), false, "旧内置 GPT 图片配置必须移除");
assert.ok(migratedSettings.imageConnections.some(({ id }) => id === "image-cockpit-aggregate-api"), "聚合 API 必须接替内置 GPT 图片入口");
assert.equal(migratedSettings.videoConnections.find(({ id }) => id === "video-dreamina-cli")?.remarkName, "短剧最前线");
assert.ok(migratedSettings.videoConnections
  .filter(({ provider, adapter }) => provider === "即梦" && adapter === "cli")
  .every(({ model }) => model === "seedance2.5"));

const cleanedUnsupportedVideoProfiles = normalizeGenerationProfiles({
  videoCliDefaultVersion: 2,
  activeVideoConnectionId: "video-openai-seedance",
  videoConnections: [
    {
      id: "video-openai-seedance",
      name: "OpenAI",
      provider: "OpenAI",
      adapter: "api",
      protocol: "videos",
      model: "seedance2.5",
    },
    {
      id: "video-dreamina-preserved",
      name: "银鸥师姐",
      provider: "即梦",
      adapter: "cli",
      cliPath: "shensi-dreamina-video",
      dreaminaCliProfile: "yinou-shijie",
      model: "seedance2.5",
    },
    {
      id: "video-libtv-preserved",
      name: "LibTV",
      provider: "LibTV",
      adapter: "cli",
      model: "seedance2.5",
    },
  ],
});
assert.equal(
  cleanedUnsupportedVideoProfiles.videoConnections.some(({ id }) => id === "video-openai-seedance"),
  false,
  "不存在的 OpenAI Seedance 视频配置必须清除",
);
assert.equal(
  cleanedUnsupportedVideoProfiles.videoConnections.some(({ id }) => id === "video-dreamina-preserved"),
  true,
  "真实即梦 Seedance 配置必须保留",
);
assert.equal(
  cleanedUnsupportedVideoProfiles.videoConnections.some(({ id }) => id === "video-libtv-preserved"),
  true,
  "其他合法视频运行器不得被清理规则误删",
);
assert.notEqual(
  cleanedUnsupportedVideoProfiles.activeVideoConnectionId,
  "video-openai-seedance",
  "活动指针不得继续指向已清理的伪视频配置",
);

const portableImageRemarkMigration = normalizeGenerationProfiles({
  cliRemarkMigrationVersion: 1,
  imageConnections: [{ id: "image-default", provider: "OpenAI", adapter: "cli", model: "gpt-image-2" }],
});
assert.equal(portableImageRemarkMigration.imageConnections.some(({ id }) => id === "image-default"), false);

const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /providerId === "即梦"[\s\S]*?option\.value === "seedance2\.5"[\s\S]*?form\.videoModel\.value = "seedance2\.5"/);
assert.match(appSource, /whiteboardVideoForm\.elements\.generationMode\.value = "smart_params"/);
const runnerSource = readFileSync(new URL("./windows/dreamina-profile-runner.ps1", import.meta.url), "utf8");
assert.match(runnerSource, /AbandonedMutexException/);
const driverSource = readFileSync(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8");
assert.match(driverSource, /taskkill\.exe[\s\S]*?\/T[\s\S]*?\/F/);
assert.equal((driverSource.match(/timeoutMs: 150_000/g) || []).length, 2);
const runtime = dreaminaCliRuntime({ dreaminaCliProfile: "tashuo-juyougeng" });
assert.equal(runtime.profileId, "tashuo-juyougeng");
assert.equal(existsSync(runtime.executable), true);
assert.equal(credentialFileFingerprint(new URL("./missing-read-only-credential.reg", import.meta.url)), "");
const environment = dreaminaCliEnvironment({ dreaminaCliProfile: "tashuo-juyougeng" }, {});
assert.equal(environment.SHENSI_DREAMINA_PROFILE_HOME, runtime.profileHome);
assert.throws(
  () => dreaminaCliRuntime({}),
  (error) => error?.code === "DREAMINA_PROFILE_REQUIRED",
  "即梦运行时缺少账号时必须明确阻断",
);
assert.equal(dreaminaCliRuntime({ dreaminaCliProfile: "default" }).profileId, "default", "显式柏物语配置必须继续兼容旧凭据路径");

const unknownProfile = normalizeGenerationProfiles({
  cliRemarkMigrationVersion: 2,
  imageConnections: [{
    id: "image-custom-account",
    provider: "即梦",
    adapter: "cli",
    cliPath: "shensi-dreamina-image",
    dreaminaCliProfile: "custom-account",
    remarkName: "自定义账号",
  }],
  activeImageConnectionId: "image-custom-account",
});
assert.equal(
  unknownProfile.imageConnections.find(({ id }) => id === "image-custom-account")?.dreaminaCliProfile,
  "custom-account",
  "合法的动态账号 ID 必须原样保留，不能改成柏物语",
);
const unboundProfile = normalizeGenerationProfiles({
  cliRemarkMigrationVersion: 2,
  imageConnections: [{ id: "image-unbound", provider: "即梦", adapter: "cli", cliPath: "shensi-dreamina-image", remarkName: "未绑定" }],
  activeImageConnectionId: "image-unbound",
});
assert.equal(
  String(unboundProfile.imageConnections.find(({ id }) => id === "image-unbound")?.dreaminaCliProfile || ""),
  "",
  "未知连接不得仅因使用即梦 CLI 就被迁移成柏物语",
);
if (process.platform === "win32") {
  assert.match(environment.SHENSI_DREAMINA_EXECUTABLE, /powershell\.exe$/iu);
  const prefix = JSON.parse(environment.SHENSI_DREAMINA_PREFIX_ARGS);
  assert.ok(prefix.includes("-ProfileId"));
  assert.ok(prefix.includes("tashuo-juyougeng"));
  assert.ok(prefix.some((item) => /dreamina-profile-runner\.ps1$/iu.test(item)));
}
console.log("v2.4.0 Dreamina named profile isolation tests passed");
