import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applyDreaminaConfigSync,
  dreaminaConfigSyncProposal,
} from "../src/dreamina-config-sync-policy.js";

const image = {
  id: "image-account-a",
  provider: "即梦",
  adapter: "cli",
  protocol: "images",
  model: "5.0",
  remarkName: "甲账号",
  dreaminaCliProfile: "account-a",
  cliPath: "shensi-dreamina-image",
  cliArgs: "--model {model}",
  timeoutMs: "1800000",
};

const video = {
  id: "video-account-a",
  provider: "即梦",
  adapter: "cli",
  protocol: "videos",
  model: "seedance2.5",
  remarkName: "旧备注",
  dreaminaCliProfile: "account-a",
  cliPath: "shensi-dreamina-video",
  cliArgs: "--model {model}",
  timeoutMs: "1200000",
  resolution: "1080p",
};

const base = {
  imageConnections: [image],
  activeImageConnectionId: image.id,
  videoConnections: [],
  activeVideoConnectionId: "",
};

const unbound = {
  ...base,
  imageConnections: [{ ...image, id: "image-unbound", dreaminaCliProfile: "" }],
  activeImageConnectionId: "image-unbound",
};
assert.equal(dreaminaConfigSyncProposal({ settings: unbound, sourceChannel: "image" }), null, "未绑定账号不得产生柏物语同步提案");
assert.equal(applyDreaminaConfigSync(base, { sourceChannel: "image", targetChannel: "video", dreaminaCliProfile: "" }), base, "缺失账号的同步操作不得改写配置");

const imageToVideo = dreaminaConfigSyncProposal({ settings: base, sourceChannel: "image" });
assert.equal(imageToVideo?.targetChannel, "video");
assert.equal(imageToVideo?.sourceProfileId, image.id);

const syncedVideo = applyDreaminaConfigSync(base, imageToVideo);
assert.equal(syncedVideo.videoConnections.length, 1);
assert.equal(syncedVideo.videoConnections[0].dreaminaCliProfile, "account-a");
assert.equal(syncedVideo.videoConnections[0].model, "seedance2.5", "同步图片账号时必须使用视频模型默认值");
assert.equal(syncedVideo.activeVideoConnectionId, "", "确认同步不得擅自切换活动视频配置");
assert.equal(base.videoConnections.length, 0, "生成同步方案不得提前修改原设置");

const videoSettings = {
  imageConnections: [],
  activeImageConnectionId: "",
  videoConnections: [video],
  activeVideoConnectionId: video.id,
};
const videoToImage = dreaminaConfigSyncProposal({ settings: videoSettings, sourceChannel: "video" });
assert.equal(videoToImage?.targetChannel, "image");
assert.equal(applyDreaminaConfigSync(videoSettings, videoToImage).imageConnections[0].model, "5.0");

const withExistingVideo = {
  ...base,
  videoConnections: [video],
  activeVideoConnectionId: video.id,
};
const updateProposal = dreaminaConfigSyncProposal({ settings: withExistingVideo, sourceChannel: "image" });
const updated = applyDreaminaConfigSync(withExistingVideo, updateProposal);
assert.equal(updated.videoConnections[0].model, "seedance2.5", "同步不得覆盖另一通道已选模型");
assert.equal(updated.videoConnections[0].resolution, "1080p", "同步不得覆盖另一通道专属参数");
assert.equal(updated.videoConnections[0].remarkName, "甲账号");

const settled = dreaminaConfigSyncProposal({ settings: updated, sourceChannel: "image" });
assert.equal(settled, null, "相同来源版本已确认同步后不得重复弹窗");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /id="dreaminaConfigSyncDialog"/u);
assert.match(app, /已保存即梦\$\{source\}配置/u);
assert.match(app, /当前活动配置未改变/u);
assert.match(app, /暂不同步/u);
assert.match(app, /确认同步/u);

console.log("即梦图片与视频配置双向确认同步测试通过");
