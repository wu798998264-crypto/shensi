import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeLibTvAccountStatus, probeLibTvAccountStatus } from "../src/server/libtv-account-status.mjs";
import { createLibTvAccountPanel } from "../src/libtv-account-panel.js";

const listed = { accounts: [{ accountId: 7, accountName: "测试账号", isActive: true,
  token: "must-not-leak", memberAccount: { memberName: "VIP-66000积分", effective: true } }] };
const status = normalizeLibTvAccountStatus(listed);
assert.equal(status.accountId, "7");
assert.equal(status.loggedIn, true);
assert.equal(status.credit, null, "套餐积分不能被伪造为当前余额");
assert.equal(status.consumed, null);
assert.equal(status.membership, "VIP-66000积分");
assert.equal(status.generationPermissionChecked, false);
assert.ok(!JSON.stringify(status).includes("must-not-leak"));
for (const value of [null, undefined, "", " ", true, {}, -1]) {
  assert.equal(normalizeLibTvAccountStatus({ accounts: [{ isActive: true, credits: value }] }).credit, null);
}
assert.equal(normalizeLibTvAccountStatus({ accounts: [{ isActive: true, credits: 0 }] }).credit, 0);
assert.equal(normalizeLibTvAccountStatus({ accounts: [{ isActive: true, remainingCredits: "42" }] }).credit, 42);
assert.equal(normalizeLibTvAccountStatus({ accounts: [{ accountId: "old", isActive: false }, { accountId: "new", isActive: true }] }).accountId, "new");
assert.equal(normalizeLibTvAccountStatus({ accounts: [{ accountId: "unselected" }] }).activeAccountAvailable, false);
assert.throws(() => normalizeLibTvAccountStatus({}), /没有返回账户列表/u);

const calls = [];
await probeLibTvAccountStatus({ cwd: "test-only", settings: { provider: "LibTV", adapter: "cli" },
  driver: { id: "libtv-cli", invoke: async (args, options) => { calls.push({ args, options }); return listed; } } });
assert.deepEqual(calls[0].args, ["account", "list"], "只能只读查询，不得执行 info/use/login/生成/模型设置");
assert.equal(calls.length, 1);
await assert.rejects(probeLibTvAccountStatus({ driver: { id: "dreamina-video" }, settings: { provider: "即梦", adapter: "cli" } }));

const nodes = new Map();
const buttons = [{ disabled: false }, { disabled: false }];
const panel = { hidden: true, addEventListener() {}, querySelectorAll: () => buttons,
  querySelector: (selector) => { if (!nodes.has(selector)) nodes.set(selector, { textContent: "", title: "" }); return nodes.get(selector); } };
let selected = { visible: true, channel: "image", settings: { id: "a", provider: "LibTV", adapter: "cli" } };
const resolvers = new Map();
let requests = 0;
const controller = createLibTvAccountPanel({ panel, snapshot: () => selected,
  request: (current) => { requests += 1; return new Promise((resolve) => resolvers.set(current.settings.id, resolve)); } });
const a = controller.refresh();
void controller.refresh();
await Promise.resolve();
assert.equal(requests, 1, "重复渲染必须合并查询");
selected = { ...selected, settings: { ...selected.settings, id: "b" } };
const b = controller.refresh();
await Promise.resolve();
resolvers.get("a")({ ...status, accountName: "旧账号" });
await a;
assert.ok(!panel.querySelector("[data-libtv-account-title]").textContent.includes("旧账号"), "陈旧回读不能污染新配置");
resolvers.get("b")({ ...status, accountName: "新账号" });
await b;
assert.ok(panel.querySelector("[data-libtv-account-title]").textContent.includes("新账号"));
assert.equal(panel.querySelector('[data-libtv-metric="credit"]').textContent, "—");
assert.equal(buttons[0].disabled, false);
selected = { ...selected, settings: { ...selected.settings, provider: "即梦" } };
controller.render();
assert.equal(panel.hidden, true, "其他厂商不显示 LibTV 状态栏");
selected = { ...selected, settings: { ...selected.settings, provider: "LibTV" } };
let fail = false;
const failureController = createLibTvAccountPanel({ panel, snapshot: () => selected, request: async () => {
  if (fail) throw new Error("临时查询超时");
  return { ...status, accountName: "已读取账号" };
} });
await failureController.refresh();
fail = true;
await failureController.refresh({ force: true });
assert.ok(panel.querySelector("[data-libtv-account-title]").textContent.includes("已读取账号"), "临时查询失败不得抹掉上次成功读取的账号");
assert.ok(panel.querySelector("[data-libtv-account-status]").textContent.includes("不等同于退出登录"));

const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const route = server.slice(server.indexOf('if (pathname === "/api/libtv/account/status"'), server.indexOf('if (pathname === "/api/media/capabilities/probe"'));
assert.match(route, /resolveTrustedGenerationSettings/u, "必须先读取受信任配置，不能任意执行客户端路径");
assert.doesNotMatch(route, /submit|poll|download|save|write|oauth/u);
console.log("LibTV account listing, unknown credit, configuration isolation and stale-read UI tests passed");
