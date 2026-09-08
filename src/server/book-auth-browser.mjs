import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import { machineLocalDataRoot } from "./app-data.mjs";
import { officialBookSourceForUrl } from "./official-book-sources.mjs";

const activeSessions = new Map();
const AUTH_SESSION_TTL_MS = 30 * 60 * 1000;
const STALE_PROFILE_MS = 24 * 60 * 60 * 1000;
const MAX_CAPTURE_CHARACTERS = 3 * 1024 * 1024;

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

const firstExisting = async (paths) => {
  for (const path of paths) {
    if (!path) continue;
    try {
      await access(path);
      return path;
    } catch {}
  }
  return "";
};

const chromiumPath = () => firstExisting(process.platform === "win32" ? [
  join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
] : process.platform === "darwin" ? [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
] : [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
]);

const machineSessionRoot = () => join(machineLocalDataRoot(), "machine-sessions", "book-auth");

const safeSessionProfilePath = (sessionId) => {
  const root = resolve(machineSessionRoot());
  const target = resolve(root, String(sessionId));
  const rel = relative(root, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("登录会话目录无效");
  return target;
};

const reservePort = () => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.unref();
  server.once("error", rejectPort);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close(() => port ? resolvePort(port) : rejectPort(new Error("无法分配浏览器调试端口")));
  });
});

class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolveReady, rejectReady) => {
      this.socket.addEventListener("open", resolveReady, { once: true });
      this.socket.addEventListener("error", () => rejectReady(new Error("无法连接登录浏览器")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let payload;
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!payload.id || !this.pending.has(payload.id)) return;
      const pending = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message || "浏览器命令失败"));
      else pending.resolve(payload.result || {});
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("登录浏览器已关闭"));
      this.pending.clear();
    });
  }

  async call(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolveCall, rejectCall) => {
      this.pending.set(id, { resolve: resolveCall, reject: rejectCall });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

const debugJson = async (port, path, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { ...options, signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`登录浏览器调试接口返回 HTTP ${response.status}`);
  return response.json();
};

const waitForBrowserTarget = async (port, child, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("登录浏览器启动失败");
    try {
      const targets = await debugJson(port, "/json/list");
      const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await delay(120);
  }
  throw new Error("登录浏览器启动超时");
};

const documentSnapshot = async (client) => {
  const expression = `(() => ({
    readyState: document.readyState,
    textLength: (document.body?.innerText || '').length,
    html: (document.documentElement?.outerHTML || '').slice(0, ${MAX_CAPTURE_CHARACTERS}),
    url: location.href,
    title: document.title || ''
  }))()`;
  const result = await client.call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "登录浏览器页面读取失败");
  return result.result?.value || {};
};

const navigateAndRead = async (session, value, { timeoutMs = 20_000 } = {}) => {
  const target = new URL(String(value));
  if (!officialBookSourceForUrl(target) || officialBookSourceForUrl(target)?.id !== session.sourceId) throw new Error("登录会话只允许读取当前正版小说网站");
  session.lastUsedAt = Date.now();
  const navigation = await session.client.call("Page.navigate", { url: target.href });
  if (navigation.errorText) throw new Error(`小说页面打开失败：${navigation.errorText}`);
  const deadline = Date.now() + timeoutMs;
  let previousLength = -1;
  let stableCount = 0;
  let snapshot = {};
  while (Date.now() < deadline) {
    snapshot = await documentSnapshot(session.client);
    if (snapshot.readyState === "complete" || snapshot.readyState === "interactive") {
      stableCount = snapshot.textLength === previousLength ? stableCount + 1 : 0;
      previousLength = snapshot.textLength;
      if (stableCount >= 2) break;
    }
    await delay(180);
  }
  if (!snapshot.html) throw new Error("登录浏览器没有取得可读取网页");
  return snapshot;
};

const navigateLoginWindow = async (session, value = session.loginUrl) => {
  const candidate = officialBookSourceForUrl(value)?.id === session.sourceId ? String(value) : session.returnUrl;
  await session.client.call("Page.bringToFront");
  await session.client.call("Page.navigate", { url: candidate });
  session.lastUsedAt = Date.now();
  return candidate;
};

const cleanupStaleProfiles = async () => {
  const root = machineSessionRoot();
  await mkdir(root, { recursive: true });
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || activeSessions.has(entry.name)) continue;
    const path = safeSessionProfilePath(entry.name);
    const info = await stat(path).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_PROFILE_MS) await rm(path, { recursive: true, force: true }).catch(() => {});
  }
};

const requireSession = (sessionId) => {
  const session = activeSessions.get(String(sessionId || ""));
  if (!session || session.closed || Date.now() - session.createdAt > AUTH_SESSION_TTL_MS) {
    const error = new Error("小说登录会话已失效，请重新登录");
    error.statusCode = 410;
    throw error;
  }
  return session;
};

export const startBookAuthentication = async ({ sourceId = "", sourceName = "", loginUrl = "", returnUrl = "" } = {}) => {
  const verifiedSource = officialBookSourceForUrl(returnUrl);
  if (!verifiedSource || verifiedSource.id !== sourceId) {
    const error = new Error("小说登录地址不属于已登记的正版来源");
    error.statusCode = 400;
    throw error;
  }
  const executable = await chromiumPath();
  if (!executable) {
    const error = new Error("未找到可用于正版网站登录的 Chrome 或 Edge 浏览器");
    error.statusCode = 503;
    throw error;
  }
  await cleanupStaleProfiles();
  const sessionId = `bookauth_${randomUUID()}`;
  const profilePath = safeSessionProfilePath(sessionId);
  await mkdir(profilePath, { recursive: true });
  const port = await reservePort();
  const safeLoginUrl = officialBookSourceForUrl(loginUrl)?.id === sourceId ? String(loginUrl) : String(returnUrl);
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profilePath}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-mode",
    "--disable-sync",
    "about:blank",
  ], { stdio: "ignore", windowsHide: false });
  try {
    const target = await waitForBrowserTarget(port, child);
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.call("Page.enable");
    await client.call("Runtime.enable");
    const session = {
      id: sessionId,
      sourceId,
      sourceName: sourceName || verifiedSource.name,
      loginUrl: safeLoginUrl,
      returnUrl: String(returnUrl),
      profilePath,
      port,
      child,
      client,
      closed: false,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      queue: Promise.resolve(),
      expiryTimer: null,
    };
    activeSessions.set(sessionId, session);
    child.once("exit", () => {
      session.closed = true;
      session.client.close();
      clearTimeout(session.expiryTimer);
      if (activeSessions.get(session.id) === session) activeSessions.delete(session.id);
      rm(session.profilePath, { recursive: true, force: true }).catch(() => {});
    });
    session.expiryTimer = setTimeout(() => closeBookAuthentication({ sessionId: session.id }).catch(() => {}), AUTH_SESSION_TTL_MS);
    session.expiryTimer.unref?.();
    await navigateLoginWindow(session, safeLoginUrl);
    return {
      sessionId,
      sourceId,
      sourceName: session.sourceName,
      loginUrl: safeLoginUrl,
      returnUrl: session.returnUrl,
      expiresInMs: AUTH_SESSION_TTL_MS,
      message: `已打开${session.sourceName}登录页面`,
    };
  } catch (error) {
    child.kill();
    await rm(profilePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};

export const reopenBookAuthentication = async ({ sessionId } = {}) => {
  const session = requireSession(sessionId);
  const loginUrl = await navigateLoginWindow(session);
  return { sessionId: session.id, sourceId: session.sourceId, sourceName: session.sourceName, loginUrl, returnUrl: session.returnUrl };
};

export const authenticatedBookFetch = (sessionId) => {
  const session = requireSession(sessionId);
  return async (url, options = {}) => {
    if (options.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const task = session.queue.then(() => navigateAndRead(session, url));
    session.queue = task.catch(() => {});
    const page = await task;
    return new Response(page.html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "X-Shensi-Final-URL": String(page.url || url),
        "X-Shensi-Extraction-Mode": "controlled_browser_dom",
      },
    });
  };
};

export const closeBookAuthentication = async ({ sessionId } = {}) => {
  const session = activeSessions.get(String(sessionId || ""));
  if (!session) return { closed: false };
  activeSessions.delete(session.id);
  session.closed = true;
  clearTimeout(session.expiryTimer);
  try {
    await session.client.call("Browser.close");
  } catch {}
  session.client.close();
  if (session.child.exitCode === null) session.child.kill();
  await delay(80);
  await rm(session.profilePath, { recursive: true, force: true }).catch(() => {});
  return { closed: true, sourceId: session.sourceId };
};

export const closeAllBookAuthentications = async () => {
  const ids = [...activeSessions.keys()];
  await Promise.all(ids.map((sessionId) => closeBookAuthentication({ sessionId })));
  return { closed: ids.length };
};

export const bookAuthenticationStatus = ({ sessionId } = {}) => {
  const session = requireSession(sessionId);
  return {
    sessionId: session.id,
    sourceId: session.sourceId,
    sourceName: session.sourceName,
    loginUrl: session.loginUrl,
    returnUrl: session.returnUrl,
    active: !session.closed,
    expiresAt: new Date(session.createdAt + AUTH_SESSION_TTL_MS).toISOString(),
  };
};
