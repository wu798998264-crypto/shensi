import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeWhiteboardGenerationPreferences,
  rememberWhiteboardGenerationPreference,
} from "../src/whiteboard-generation-preference.js";

const initial = normalizeWhiteboardGenerationPreferences({
  text: {
    executionSurface: "agent",
    connectionId: "text-opencode-deepseek",
    model: "deepseek/deepseek-v4-pro",
    apiKey: "must-not-persist",
  },
  image: { connectionId: "image-dreamina-cli-chenan", model: "jimeng-4.1" },
  video: { connectionId: "video-dreamina-cli-guobazai", model: "seedance-2.5" },
});

assert.deepEqual(initial.text, {
  executionSurface: "agent",
  connectionId: "text-opencode-deepseek",
  model: "deepseek/deepseek-v4-pro",
}, "文字生成栏应记住运行模式、配置和模型，但绝不能保存凭据");
assert.equal(initial.image.connectionId, "image-dreamina-cli-chenan", "图片通道应独立记住最近配置");
assert.equal(initial.video.connectionId, "video-dreamina-cli-guobazai", "视频通道应独立记住最近配置");

const changedImage = rememberWhiteboardGenerationPreference(initial, "image", {
  connectionId: "image-cockpit-aggregate-api",
  model: "gpt-image-2",
});
assert.equal(changedImage.image.connectionId, "image-cockpit-aggregate-api", "图片配置切换必须更新最近选择");
assert.equal(changedImage.text.connectionId, initial.text.connectionId, "图片配置切换不得改动文字配置记忆");
assert.equal(changedImage.video.connectionId, initial.video.connectionId, "图片配置切换不得改动视频配置记忆");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /WHITEBOARD_GENERATION_PROFILE_PREFERENCES_KEY = "shensi-whiteboard-generation-profile-preferences-v1"/u);
assert.match(app, /state\.settings = \{ \.\.\.state\.settings, whiteboardGenerationProfilePreferences: next \};[\s\S]{0,40}persist\(\)/u, "最近配置必须随工作区持久化，不能因桌面后台端口变化或软件重启丢失");
assert.match(app, /state\?\.settings\?\.whiteboardGenerationProfilePreferences/u, "本地缓存不可用时必须从工作区恢复最近配置");
assert.match(app, /const rememberedValues = whiteboardRememberedGenerationProfile\("text"\);[\s\S]{0,420}connectionId: String\(draftValues\?\.connectionId \|\| rememberedValues\.connectionId \|\| firstTextProfileId\)/u, "文字栏应优先恢复卡片草稿，其次最近配置，首次打开才使用列表第一项");
assert.match(app, /whiteboardRememberedGenerationProfile\("image"\)[\s\S]{0,350}profiles\.some\(\(profile\) => profile\.id === rememberedValues\.connectionId\)/u, "图片栏不得每次固定跳回 GPT CLI");
assert.match(app, /whiteboardRememberedGenerationProfile\("video"\)[\s\S]{0,350}profiles\.some\(\(profile\) => profile\.id === rememberedValues\.connectionId\)/u, "视频栏应恢复最近配置");
assert.match(app, /persistWhiteboardGenerationProfile\("text", whiteboardGenerationFormValues\(elements\.whiteboardGenerateForm\)\)/u, "文字栏的用户选择必须持久化");
assert.match(app, /persistWhiteboardGenerationProfile\("image", whiteboardGenerationFormValues\(elements\.whiteboardImageForm\)\)/u, "图片栏的用户选择必须持久化");
assert.match(app, /persistWhiteboardGenerationProfile\("video", whiteboardGenerationFormValues\(elements\.whiteboardVideoForm\)\)/u, "视频栏的用户选择必须持久化");
assert.doesNotMatch(app, /persistWhiteboardGenerationProfile\([^\n]*state\.settings/u, "生成栏记忆不得重写模型设置或用户凭据配置");

console.log("whiteboard generation last-profile persistence tests passed");
