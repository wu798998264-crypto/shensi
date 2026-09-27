import assert from "node:assert/strict";
import {
  getProviderAudioModelOptions,
  getProviderVideoModelOptions,
} from "../src/model-presets.js";
import { readFile } from "node:fs/promises";

const dreaminaVideo = getProviderVideoModelOptions("即梦", "cli");
for (const id of ["MiniMax-Hailuo-H3-Max", "MiniMax-Hailuo-H3", "happy-horse-1.1", "wanx3.0"]) {
  assert.equal(dreaminaVideo.some((item) => item.slug === id), false, `即梦 CLI 不应展示未接通模型 ${id}`);
}

const dreaminaAudio = getProviderAudioModelOptions("即梦", "cli");
assert.equal(dreaminaAudio.some((item) => item.slug === "seed-audio-1.0"), false, "即梦 CLI 不应展示未接通音频项");

const libtvAudio = getProviderAudioModelOptions("LibTV", "cli");
assert.ok(libtvAudio.length >= 3, "LibTV 音频目录必须保留真实可用模型");
assert.ok(libtvAudio.some((item) => item.slug === "seed-audio-1.0"));

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /即梦音频（当前 CLI 未开放）/u, "即梦音频不可用时不得由设置界面补回目录项");

console.log("Media model catalogue boundaries passed");
