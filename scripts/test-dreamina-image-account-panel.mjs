import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

const panelMarker = '<section class="wide dreamina-account-panel" id="dreaminaAccountPanel"';
const panelIndex = app.indexOf(panelMarker);
const videoIndex = app.indexOf('data-model-channel-panel="video"');
const audioIndex = app.indexOf('data-model-channel-panel="audio"');
assert.ok(panelIndex >= 0, "模型设置必须保留唯一的即梦账号面板");
assert.ok(videoIndex >= 0 && audioIndex > videoIndex, "图片、视频和音频模型面板结构必须存在");
assert.ok(panelIndex > audioIndex, "即梦账号面板必须位于频道面板共享区域，而不是视频面板内部");
const videoPanelSource = app.slice(videoIndex, audioIndex);
assert.doesNotMatch(videoPanelSource, /id="dreaminaAccountPanel"/u, "视频面板不得独占即梦账号状态面板");
assert.match(app.slice(panelIndex, panelIndex + 280), /data-dreamina-status-channel=""/u, "共享面板必须记录当前状态频道");

const renderStart = app.indexOf("const renderDreaminaAccountStatus");
const refreshStart = app.indexOf("const refreshDreaminaAccountStatus");
assert.ok(renderStart >= 0 && refreshStart > renderStart, "即梦账号渲染和状态读取函数必须存在");
const renderSource = app.slice(renderStart, refreshStart);
assert.match(renderSource, /dreaminaStatusChannel\(preferredChannel\)/u, "状态面板必须按图片/视频频道解析活动配置");
assert.match(renderSource, /generationSettingsForChannel\(generationWorkingSettings\(\), channel\)/u, "状态面板必须从当前频道活动配置读取 profile");
assert.match(renderSource, /settings\?\.adapter === "cli"/u, "非 CLI 配置必须隐藏即梦状态面板");
assert.match(renderSource, /settings\?\.provider === "即梦"/u, "非即梦配置必须隐藏即梦状态面板");
assert.match(renderSource, /账号状态读取失败：\$\{errorMessage\}/u, "状态接口失败必须显示明确错误");
const panelSource = app.slice(panelIndex, panelIndex + 2200);
assert.match(panelSource, /data-dreamina-metric="credit"/u, "状态面板必须显示当前积分");
assert.match(panelSource, /data-dreamina-metric="consumed"/u, "状态面板必须显示累计消耗");
assert.match(panelSource, /data-dreamina-metric="membership"/u, "状态面板必须显示会员等级");
assert.doesNotMatch(renderSource, /form\.videoAdapter|form\.videoProvider/u, "共享渲染函数不得固定读取视频表单");

const profileSource = app.slice(app.indexOf("const dreaminaStatusChannel"), renderStart);
assert.match(profileSource, /currentDreaminaProfileId = \(channel = ""\)/u, "profile 读取函数必须接受频道参数");
assert.match(profileSource, /generationSettingsForChannel\(generationWorkingSettings\(\), activeChannel\)/u, "profile 读取函数必须按频道读取活动配置");

const syncStart = app.indexOf("const syncProviderSpecificCliButtons");
const syncEnd = app.indexOf("const chooseDreaminaAuthorizationBrowser", syncStart);
const syncSource = app.slice(syncStart, syncEnd);
assert.match(syncSource, /isImageDreaminaCli/u, "图片即梦 CLI 必须参与账号状态刷新");
assert.match(syncSource, /isVideoDreaminaCli/u, "视频即梦 CLI 必须继续参与账号状态刷新");
assert.match(syncSource, /refreshDreaminaAccountStatus\(\{ channel: dreaminaChannel \}\)/u, "状态读取必须按当前即梦频道执行");
assert.match(syncSource, /renderDreaminaAccountStatus\(existingAccount, panelChannel\)/u, "切换配置时必须立即刷新面板可见性并保留已核验状态");

const channelRender = app.slice(app.indexOf("const renderModelSettingsChannel"), app.indexOf("const syncTypographyOutputs"));
assert.match(channelRender, /renderDreaminaAccountStatus\(account, ui\.modelSettingsChannel\)/u, "打开或切换模型设置频道时必须立即刷新状态面板且不清空稳定状态");

console.log("Dreamina image/video account status panel contract passed");
