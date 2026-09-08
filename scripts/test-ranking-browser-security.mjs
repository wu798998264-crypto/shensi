import assert from "node:assert/strict";
import { RankingBrowserService, assertSafeRankingUrl } from "../src/server/ranking-browser-service.mjs";
import { verifyRankingSourceContent, verifyRankingSourceSignature } from "../src/server/ranking-source-signature.mjs";
import { readFile } from "node:fs/promises";

assert.throws(() => assertSafeRankingUrl("http://localhost:4173/"), /本机|内网/u);
assert.throws(() => assertSafeRankingUrl("http://192.168.1.2/rank"), /本机|内网/u);
const calls = [];
const service = new RankingBrowserService({ sessionFactory: async (options) => ({
  async readDom(url) { calls.push({ type: "readDom", url, options }); return "<main>榜单</main>"; },
  async close() { calls.push({ type: "close" }); },
}) });
await assert.rejects(() => service.readPage({ url: "https://fanqienovel.com/rank", allowBrowserAccess: false }), /未授权/u);
const page = await service.readPage({ url: "https://fanqienovel.com/rank", allowBrowserAccess: true, allowAuthenticatedPageAccess: false });
assert.match(page.html, /榜单/u);
assert.equal(calls.some((item) => /cookie|token|localStorage/i.test(item.type)), false);
assert.equal(calls.at(-1).type, "close");
const loginService = new RankingBrowserService({ sessionFactory: async () => ({ readDom: async () => ({ status: "waiting_login", html: "" }), close: async () => {} }) });
await assert.rejects(() => loginService.readPage({ url: "https://fanqienovel.com/rank", allowBrowserAccess: true, allowAuthenticatedPageAccess: false }), /需要登录/u);
const authenticatedStub = await loginService.readPage({ url: "https://fanqienovel.com/rank", allowBrowserAccess: true, allowAuthenticatedPageAccess: true });
assert.equal(authenticatedStub.status, "waiting_login", "认证授权也只能进入等待态，不能由系统伪造登录成功");
const captchaService = new RankingBrowserService({ sessionFactory: async () => ({ readDom: async () => ({ status: "captcha", html: "" }), close: async () => {} }) });
await assert.rejects(() => captchaService.readPage({ url: "https://fanqienovel.com/rank", allowBrowserAccess: true }), /验证码/u);
assert.equal(await verifyRankingSourceSignature("qidian"), true);
const trustedQidian = await readFile(new URL("../src/server/ranking-sources/qidian.mjs", import.meta.url));
assert.equal(verifyRankingSourceContent("src/server/ranking-sources/qidian.mjs", Buffer.concat([trustedQidian, Buffer.from("\n// tampered")])), false);
console.log("Ranking browser security tests passed");
