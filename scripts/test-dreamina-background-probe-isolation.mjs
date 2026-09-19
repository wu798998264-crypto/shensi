import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(
  source,
  /if \(\["image", "video"\]\.includes\(entry\.channel\) && isDreaminaCliProfile\(settings\)\) \{[\s\S]{0,900}reason: "dreamina_requires_explicit_live_check",[\s\S]{0,120}continue;/u,
  "启动后的每日能力检查必须跳过即梦 CLI，避免后台配置探测占用唯一凭证槽",
);
assert.match(
  source,
  /refreshDreaminaCredit[\s\S]{0,22000}verify: "true", profileId/u,
  "设置页的手动积分刷新仍必须请求当前配置的实时数据",
);
assert.match(
  source,
  /refreshDreaminaAccountStatus\(\{ verifyLive: true, profileId/u,
  "显式即梦核验必须保留实时 CLI 查询",
);

console.log("Dreamina 后台探测隔离与显式实时刷新回归通过");
