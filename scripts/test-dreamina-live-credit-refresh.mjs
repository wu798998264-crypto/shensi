import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(app, /refreshDreaminaLiveStatus|dreaminaLiveRefreshAt|dreaminaLiveRefreshes/u, "配置切换和面板渲染不得保留隐式在线积分探测");
assert.match(app, /const accountRefresh = dreaminaChannel\s*\? refreshDreaminaAccountStatus\(\{ channel: dreaminaChannel \}\)/u, "配置面板只能读取已保存状态，不得隐式核验账号");
assert.match(app, /const refreshCurrentDreaminaCredit = async[\s\S]{0,900}new URLSearchParams\(\{ verify: "true", profileId \}\)/u, "只有显式积分刷新入口才允许在线查询");
assert.match(app, /#refreshDreaminaCredit[\s\S]{0,240}refreshCurrentDreaminaCredit/u, "用户主动点击刷新时才查询实时积分");
assert.match(app, /creditSource === "live"/u, "白板余额提示必须区分实时与已保存状态");
assert.match(app, /if \(profile\?\.creditRefreshDeferred !== true\) return profile/u, "明确的账号失效结果不得重复探测十二次");
console.log("Dreamina explicit live credit refresh contract passed");
