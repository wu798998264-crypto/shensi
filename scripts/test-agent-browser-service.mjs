import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { createAgentBrowserService, needsInteractivePage } from "../src/server/agent-browser-service.mjs";
import { conversationAgentProcessEnvironment } from "../src/server/conversation-agent-gateway.mjs";
import { createConversationAgentService } from "../src/server/conversation-agent-service.mjs";

const publicUrl = async (value) => {
  const url = new URL(String(value));
  if (url.hostname.endsWith(".internal")) throw new Error("网页解析到了不允许访问的网络地址");
  return url;
};

const publicReads = [];
const publicEvents = [];
const hiddenBrowser = createAgentBrowserService({
  validate: publicUrl,
  read: async (options) => {
    publicReads.push(options);
    return { sourceUrl: options.url, title: "公开榜单", text: "第一名：测试作品", contentCharacters: 8 };
  },
  fetchImpl: async () => { throw new Error("普通公开页面不应启动桌面浏览器"); },
});
const hiddenResult = await hiddenBrowser("open", { url: "https://example.com/rank", maxPages: 2 }, {
  emit: async (type, payload) => publicEvents.push({ type, payload }),
});
assert.equal(hiddenResult.sourceMode, "public_read_fallback");
assert.equal(hiddenResult.readOnly, true);
assert.equal(publicReads.length, 1);
assert.equal(publicEvents[0]?.type, "browser_read");
assert.equal(needsInteractivePage({ text: `${"公开榜单正文。".repeat(900)}登录后可评论` }), false, "可读正文中的普通登录提示不能误触发悬浮窗口");
assert.equal(needsInteractivePage({ text: "请先登录后查看榜单" }), true);
assert.equal(needsInteractivePage({ text: "公开内容", hasPasswordField: true }), true);
const isolatedAgentEnvironment = conversationAgentProcessEnvironment({ PATH: "test-path", SHENSI_BROWSER_BRIDGE_URL: "http://127.0.0.1:1", SHENSI_BROWSER_BRIDGE_TOKEN: "secret", SHENSI_OTHER: "keep" });
assert.deepEqual(isolatedAgentEnvironment, { PATH: "test-path", SHENSI_OTHER: "keep" }, "浏览器桥接地址和令牌不得进入模型子进程环境");

const bridgeCalls = [];
const questions = [];
const renderedBrowser = createAgentBrowserService({
  bridgeUrl: "http://127.0.0.1:41234",
  bridgeToken: "test-bridge-token",
  validate: publicUrl,
  read: async () => ({ title: "登录页", text: "请先登录后继续" }),
  fetchImpl: async (url, options) => {
    bridgeCalls.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith("/open")) return Response.json({ ok: true, status: "waiting_user", sessionId: "browser-session-a", url: "https://example.com/rank", title: "榜单登录" });
    if (url.endsWith("/continue")) return Response.json({ ok: true, status: "ready", sessionId: "browser-session-a", url: "https://example.com/rank", title: "公开榜单", text: "登录后可见榜单" });
    throw new Error(`unexpected bridge path: ${url}`);
  },
});
const renderedResult = await renderedBrowser("open", { url: "https://example.com/rank" }, {
  ask: async (question) => { questions.push(question); return { answer: "已完成登录，继续读取" }; },
});
assert.equal(renderedResult.sourceMode, "embedded_browser");
assert.equal(renderedResult.text, "登录后可见榜单");
assert.deepEqual(bridgeCalls.map((entry) => new URL(entry.url).pathname), ["/open", "/continue"]);
assert.ok(bridgeCalls.every((entry) => entry.options.redirect === "error"));
assert.ok(bridgeCalls.every((entry) => entry.options.headers.authorization === "Bearer test-bridge-token"));
assert.equal(questions[0]?.presentation, "browser_login");
assert.equal(questions[0]?.metadata?.sessionId, "browser-session-a");
assert.deepEqual(questions[0]?.options, ["已完成登录或验证，继续读取", "取消本次网页读取"]);

const searchBridgeCalls = [];
let fallbackSearchCalls = 0;
const embeddedSearch = createAgentBrowserService({
  bridgeUrl: "http://127.0.0.1:41236",
  bridgeToken: "test-bridge-token",
  validate: publicUrl,
  search: async () => { fallbackSearchCalls += 1; return { sources: [] }; },
  fetchImpl: async (url, options) => {
    searchBridgeCalls.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return Response.json({ ok: true, status: "ready", sessionId: "browser-search-a", query: "测试榜单", title: "搜索", text: "搜索结果", readOnly: false, sourceMode: "untrusted_override", results: [{ title: "公开榜单", url: "https://example.com/rank" }] });
  },
});
const searchResult = await embeddedSearch("search", { query: "测试榜单", maxResults: 3 });
assert.equal(searchResult.sourceMode, "embedded_browser");
assert.equal(searchResult.readOnly, true, "桥接响应不能覆盖 Agent 浏览器的只读边界");
assert.equal(searchResult.results[0]?.url, "https://example.com/rank");
assert.equal(searchBridgeCalls[0]?.path, "/search");
assert.equal(searchBridgeCalls[0]?.body.maxResults, 3);
assert.equal(fallbackSearchCalls, 0, "桌面运行时搜索必须优先使用隐藏内置浏览器");

const cancelledCalls = [];
const cancelledBrowser = createAgentBrowserService({
  bridgeUrl: "http://127.0.0.1:41235",
  bridgeToken: "test-bridge-token",
  validate: publicUrl,
  read: async () => ({ text: "验证码" }),
  fetchImpl: async (url) => {
    cancelledCalls.push(new URL(url).pathname);
    return url.endsWith("/open")
      ? Response.json({ ok: true, status: "waiting_user", sessionId: "browser-session-b" })
      : Response.json({ ok: true, status: "closed" });
  },
});
const cancelled = await cancelledBrowser("open", { url: "https://example.com/private" }, {
  ask: async () => ({ answer: "取消本次网页读取" }),
});
assert.equal(cancelled.status, "cancelled");
assert.deepEqual(cancelledCalls, ["/open", "/close"]);

const interruptedCalls = [];
const interruptedBrowser = createAgentBrowserService({
  bridgeUrl: "http://127.0.0.1:41237",
  bridgeToken: "test-bridge-token",
  validate: publicUrl,
  fetchImpl: async (url) => {
    interruptedCalls.push(new URL(url).pathname);
    return url.endsWith("/open")
      ? Response.json({ ok: true, status: "waiting_user", sessionId: "browser-session-interrupted" })
      : Response.json({ ok: true, status: "closed" });
  },
});
await assert.rejects(() => interruptedBrowser("open", { url: "https://example.com/private" }, {
  ask: async () => { throw Object.assign(new Error("任务已取消"), { name: "AbortError" }); },
}), /任务已取消/u);
assert.deepEqual(interruptedCalls, ["/open", "/close"], "等待登录期间取消 Agent 时必须关闭并清理浏览器会话");

await assert.rejects(() => hiddenBrowser("open", { url: "http://example.com/rank" }), /只允许读取 HTTPS/u);
await assert.rejects(() => hiddenBrowser("open", { url: "https://service.internal/rank" }), /不允许访问/u);
await assert.rejects(() => createAgentBrowserService({
  bridgeUrl: "https://remote.example.com",
  bridgeToken: "must-not-leave-machine",
  validate: publicUrl,
  read: async () => ({ text: "请先登录" }),
})("open", { url: "https://example.com/rank" }, { ask: async () => ({ answer: "继续" }) }), /本机回环地址/u);

const root = await mkdtemp(join(tmpdir(), "shensi-agent-browser-"));
try {
  const service = createConversationAgentService({
    appRoot: root,
    storageRoot: join(root, "runs"),
    skillCatalog: async () => [],
    readRoute: async () => "Agent 自主决定何时读取网页。",
    browser: async (_name, _args, { ask }) => ask({
      question: "网页需要登录，是否继续？",
      options: ["登录完成，继续", "取消读取"],
      presentation: "browser_login",
      metadata: { sessionId: "browser-session-c", url: "https://example.com/rank" },
    }),
    run: async ({ workspaceToolRuntime }) => {
      const result = await workspaceToolRuntime.invoke({ namespace: "web_browser", tool: "open", arguments: { url: "https://example.com/rank" } });
      return { text: JSON.parse(result.contentItems[0].text).answer };
    },
  });
  const started = await service.start({
    workspacePath: join(root, "workspace"),
    workspaceKind: "notebook",
    conversationId: "browser-conversation",
    sourceMessageId: "browser-message",
    messages: [{ role: "user", content: "读取这个榜单" }],
    settings: { id: "limited", agentEngine: "codex_api", model: "mock" },
  });
  let question;
  for (let index = 0; index < 100 && !question; index += 1) {
    question = (await service.status(started.id)).events.find((event) => event.type === "question")?.payload;
    if (!question) await new Promise((done) => setTimeout(done, 10));
  }
  assert.equal(question?.presentation, "browser_login");
  assert.equal(question?.metadata?.sessionId, "browser-session-c");
  await service.answer(started.id, question.id, "登录完成，继续");
  for (let index = 0; index < 100; index += 1) {
    const status = await service.status(started.id);
    if (status.status === "completed") {
      assert.equal(status.text, "登录完成，继续");
      break;
    }
    await new Promise((done) => setTimeout(done, 10));
  }
} finally {
  const rel = relative(resolve(tmpdir()), resolve(root));
  assert.ok(rel && !rel.startsWith("..") && !isAbsolute(rel));
  await rm(root, { recursive: true, force: true });
}

const [mainSource, preloadSource, appSource, serverSource, rankingSkillSource] = await Promise.all([
  readFile(new URL("../packaging/windows/desktop-app/main.mjs", import.meta.url), "utf8"),
  readFile(new URL("../packaging/windows/desktop-app/preload.cjs", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../packaging/bundled/skill/神思/bestseller-ranking-scan/SKILL.md", import.meta.url), "utf8"),
]);
assert.match(mainSource, /show:\s*false[\s\S]{0,600}sandbox:\s*true[\s\S]{0,120}devTools:\s*false/u, "普通读取窗口必须隐藏并禁用开发工具");
assert.match(mainSource, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/u);
assert.match(mainSource, /setPermissionCheckHandler\(\(\) => false\)/u);
assert.match(mainSource, /will-download", \(event\) => event\.preventDefault\(\)/u);
assert.match(mainSource, /webRequest\.onBeforeRequest/u);
assert.match(mainSource, /validateAgentBrowserNetworkUrl/u);
assert.match(mainSource, /setAlwaysOnTop\(true, "floating"\)/u, "只有登录确认窗口需要悬浮显示");
assert.match(mainSource, /reason: "user_closed"/u, "用户关闭临时窗口必须形成取消信号");
assert.match(mainSource, /requestMessage\.url === "\/search"[\s\S]{0,120}createAgentBrowserSearchSession/u, "联网搜索必须经过隐藏内置浏览器桥接");
assert.match(mainSource, /AGENT_BROWSER_LOAD_TIMEOUT_MS = 30_000/u, "隐藏浏览器加载必须有明确超时");
assert.match(mainSource, /内置浏览器页面加载超时/u, "隐藏浏览器超时必须形成明确失败");
assert.match(mainSource, /requestMessage\.once\("aborted", abortRequest\)/u, "Agent 中止桥接请求时必须通知浏览器生命周期");
assert.match(mainSource, /client_disconnected/u, "桥接断开后不得残留等待登录的临时会话");
assert.match(mainSource, /!record\.interactive[\s\S]{0,180}\["GET", "HEAD", "OPTIONS"\]/u, "隐藏读取阶段只允许只读请求方法");
assert.match(mainSource, /record\.interactive = false[\s\S]{0,160}const result =/u, "用户确认后再次读取必须恢复只读模式");
assert.match(preloadSource, /agentBrowser:[\s\S]{0,420}state:[\s\S]{0,180}onState/u);
assert.doesNotMatch(preloadSource, /agentBrowser:[\s\S]{0,420}\bopen\s*:/u, "内置浏览器不得提供手动打开入口");
assert.match(appSource, /connectDesktopAgentBrowser\(\)/u);
assert.match(appSource, /cancelNativeBrowserQuestion[\s\S]{0,1500}取消本次网页读取/u);
assert.match(appSource, /agentBrowserConfirmation/u);
assert.doesNotMatch(appSource, /rankingScanDialog|\/api\/ranking-scan/u, "旧扫榜面板和专用请求不得回流");
assert.doesNotMatch(serverSource, /\/api\/ranking-scan|RankingScanRunner|rankingAgentExecutor/u, "旧扫榜后端、运行器和接口不得回流");
assert.match(rankingSkillSource, /web_browser\.search[\s\S]{0,500}web_browser\.open/u, "扫榜 Skill 必须通过统一 Agent 浏览器执行");
assert.doesNotMatch(rankingSkillSource, /可信采集器|官方采集器|不可变快照|签名校验/u, "扫榜 Skill 不得继续要求已经删除的专用执行框架");

console.log("Agent browser: hidden public reads, isolated login confirmation, cancellation, public HTTPS boundary, dynamic choice metadata and desktop lifecycle passed");
