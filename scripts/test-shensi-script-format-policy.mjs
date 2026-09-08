import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { creativeDeliverableType } from "../src/request-routing.js";
import { validateShortDramaFormat } from "../src/short-drama-format.js";

for (const prompt of [
  "创作一部短剧剧本",
  "写一集漫剧脚本",
  "创作一份影视剧本",
  "写一个电影剧本",
  "生成电视剧剧本",
  "创作网络电影脚本",
]) {
  assert.equal(creativeDeliverableType({ text: prompt }), "short_drama_script", `${prompt} 必须进入神思剧本格式链`);
}

for (const prompt of ["写一份短视频剧本", "创作抖音剧情短视频", "生成剧情号脚本"]) {
  assert.equal(creativeDeliverableType({ text: prompt }), "short_video_script", `${prompt} 不得误入固定神思剧本格式`);
}

const screenplay = [
  "第1集",
  "1-1、日，内，办公室",
  "人物：林舟、周宁",
  "△林舟把文件推到周宁面前。",
  "林舟：这份名单不对。",
].join("\n");

assert.deepEqual(validateShortDramaFormat({
  text: screenplay,
  prompt: "创作电影剧本",
  deliverableType: "short_drama_script",
}), { applicable: true, pass: true, kind: "screenplay", issues: [] });

assert.equal(validateShortDramaFormat({
  text: "开头三秒直接抛出结果，随后用口播解释原因。",
  targetDocumentId: "script-episode-1",
  prompt: "写一份短视频剧本",
  deliverableType: "short_video_script",
}).applicable, false, "短视频剧本即使目标 ID 类似剧本，也不得套用固定神思剧本格式");

const orchestrator = await readFile(new URL("../src/server/shensi-orchestrator.mjs", import.meta.url), "utf8");
assert.match(orchestrator, /所有短剧、漫剧及影视类剧本必须统一使用已加载的神思剧本格式/u);
assert.match(orchestrator, /短视频剧本不适用此固定格式/u);

console.log("神思剧本统一格式与短视频格式豁免规则通过");
