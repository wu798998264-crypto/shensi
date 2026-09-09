import { searchPublicWeb } from "./public-web-search.mjs";
import { readPublicWebReference, validatePublicWebUrl } from "./web-reference-reader.mjs";

const MAX_CHARACTERS = 120_000;
const MAX_PAGES = 5;
const INTERACTIVE_SIGNALS = /(?:请先登录|立即登录|登录后|sign\s*in|log\s*in)/iu;
const BLOCKING_INTERACTIVE_SIGNALS = /(?:验证码|人机验证|访问受限|captcha|verify\s+you\s+are\s+human|access\s+denied|unusual\s+traffic)/iu;
const EMPTY_PAGE_SIGNALS = /(?:enable\s+javascript|开启\s*javascript|javascript\s+required)/iu;

const clean = (value, maximum = 2_000) => String(value ?? "").trim().slice(0, maximum);
const safeUrl = async (value, validate = validatePublicWebUrl) => {
  const url = await validate(value);
  if (url.protocol !== "https:") throw new Error("内置浏览器只允许读取 HTTPS 公网页面");
  return url.href;
};

const bridgeEndpoint = (bridgeUrl, path) => {
  let base;
  try { base = new URL(String(bridgeUrl || "")); } catch { throw new Error("桌面内置浏览器桥接地址无效"); }
  if (base.protocol !== "http:" || base.hostname !== "127.0.0.1" || base.username || base.password) throw new Error("桌面内置浏览器桥接必须使用本机回环地址");
  return new URL(path, `${base.origin}/`).href;
};

const bridgeResponse = async (bridgeUrl, bridgeToken, path, payload, { signal, fetchImpl = fetch } = {}) => {
  if (!bridgeUrl || !bridgeToken) throw Object.assign(new Error("桌面内置浏览器桥接尚未连接"), { code: "BROWSER_BRIDGE_UNAVAILABLE" });
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const response = await fetchImpl(bridgeEndpoint(bridgeUrl, path), {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${bridgeToken}`, "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw Object.assign(new Error(clean(result.message || `内置浏览器请求失败（HTTP ${response.status}）`)), { code: result.code || "BROWSER_BRIDGE_FAILED" });
    return result;
  } finally {
    signal?.removeEventListener?.("abort", abort);
  }
};

const needsInteractivePage = (snapshot) => {
  const text = clean(snapshot?.text || snapshot?.html || "", MAX_CHARACTERS);
  return !text.trim()
    || snapshot?.hasPasswordField === true
    || BLOCKING_INTERACTIVE_SIGNALS.test(text)
    || (text.length < 4_000 && (INTERACTIVE_SIGNALS.test(text) || EMPTY_PAGE_SIGNALS.test(text)));
};

const answerCancels = (answer) => /(?:^(?:取消|不用|不继续|停止|cancel|no)\b|取消.{0,12}(?:读取|任务|网页|本次)|(?:cancel|stop).{0,20}(?:read|task|page)?)/iu.test(String(answer || "").trim());
const answerContinues = (answer) => /(?:完成|好了|可以|已登录|已验证|继续|重试|done|continue|retry|proceed|ready)/iu.test(String(answer || "").trim());

const bridgeRead = async ({
  action,
  path,
  payload,
  bridgeUrl,
  bridgeToken,
  fetchImpl,
  ask,
  emit,
  signal,
}) => {
  const opened = await bridgeResponse(bridgeUrl, bridgeToken, path, payload, { signal, fetchImpl });
  const source = action === "search" ? { query: clean(payload.query, 500) } : { url: clean(payload.url, 2_000) };
  const complete = async (result) => {
    const sourceCount = Array.isArray(result.results) ? result.results.length : Array.isArray(result.links) ? result.links.length : 0;
    await emit("browser_read", {
      action,
      ...source,
      sourceMode: "embedded_browser",
      characters: result.text?.length || 0,
      ...(action === "search" ? { sourceCount } : {}),
    });
    return { ...result, fetchedAt: result.fetchedAt || new Date().toISOString(), readOnly: true, sourceMode: "embedded_browser" };
  };
  if (opened.status === "ready") return complete(opened);

  const question = action === "search"
    ? "搜索页面需要登录或人工确认。请在顶部临时浏览器窗口完成必要验证，然后选择继续读取；神思不会代替你点击、输入或执行网页业务操作。"
    : "这个网页需要登录或人工确认。请在顶部临时浏览器窗口完成必要登录，然后选择继续读取；神思不会代替你点击、输入或执行网页业务操作。";
  if (typeof ask !== "function") return { ...opened, ...source, message: question, readOnly: true, status: "waiting_user", sourceMode: "embedded_browser" };

  let decision;
  try {
    decision = await ask({
      question,
      options: ["已完成登录或验证，继续读取", "取消本次网页读取"],
      multiple: false,
      presentation: "browser_login",
      metadata: { action, ...source, sessionId: opened.sessionId || "" },
    });
  } catch (error) {
    await bridgeResponse(bridgeUrl, bridgeToken, "/close", { sessionId: opened.sessionId }, { fetchImpl }).catch(() => {});
    throw error;
  }
  if (answerCancels(decision?.answer) || !answerContinues(decision?.answer)) {
    await bridgeResponse(bridgeUrl, bridgeToken, "/close", { sessionId: opened.sessionId }, { fetchImpl }).catch(() => {});
    return { readOnly: true, status: "cancelled", sourceMode: "embedded_browser", ...source };
  }

  let continued;
  try {
    continued = await bridgeResponse(bridgeUrl, bridgeToken, "/continue", { sessionId: opened.sessionId, maxCharacters: payload.maxCharacters }, { signal, fetchImpl });
  } catch (error) {
    if (/会话不存在|已关闭/u.test(String(error?.message || ""))) {
      return { readOnly: true, status: "cancelled", sourceMode: "embedded_browser", ...source, message: "用户已关闭临时浏览器，本次网页读取已取消" };
    }
    throw error;
  }
  if (continued.status === "waiting_user") {
    await bridgeResponse(bridgeUrl, bridgeToken, "/close", { sessionId: opened.sessionId }, { fetchImpl }).catch(() => {});
    return { readOnly: true, status: "cancelled", sourceMode: "embedded_browser", ...source, message: "网页仍需要登录或人工验证，本次读取已停止" };
  }
  return complete(continued);
};

export const createAgentBrowserService = ({
  bridgeUrl = process.env.SHENSI_BROWSER_BRIDGE_URL || "",
  bridgeToken = process.env.SHENSI_BROWSER_BRIDGE_TOKEN || "",
  search = searchPublicWeb,
  read = readPublicWebReference,
  validate = validatePublicWebUrl,
  fetchImpl = fetch,
} = {}) => async (name, args = {}, { ask = null, emit = async () => {}, signal } = {}) => {
  if (signal?.aborted) throw Object.assign(new Error("任务已取消"), { name: "AbortError" });
  if (name === "search") {
    const query = clean(args.query, 500);
    if (!query) throw new Error("网页搜索词不能为空");
    const maxResults = Math.max(1, Math.min(8, Number(args.maxResults) || 4));
    const maxCharacters = Math.max(4_000, Math.min(MAX_CHARACTERS, Number(args.maxCharacters) || 80_000));
    if (bridgeUrl && bridgeToken) {
      return bridgeRead({
        action: "search",
        path: "/search",
        payload: { query, maxResults, maxCharacters },
        bridgeUrl,
        bridgeToken,
        fetchImpl,
        ask,
        emit,
        signal,
      });
    }
    const result = await search({ query, maxResults, maxCharacters });
    await emit("browser_read", { action: "search", query, sourceCount: result.sources?.length || 0 });
    return { ...result, readOnly: true, sourceMode: "public_read_fallback" };
  }
  if (name !== "open") throw new Error("未知内置浏览器工具");
  const url = await safeUrl(args.url, validate);
  const maxPages = Math.max(1, Math.min(MAX_PAGES, Number(args.maxPages) || 1));
  const maxCharacters = Math.max(4_000, Math.min(MAX_CHARACTERS, Number(args.maxCharacters) || 80_000));
  if (bridgeUrl && bridgeToken) {
    return bridgeRead({
      action: "open",
      path: "/open",
      payload: { url, maxCharacters },
      bridgeUrl,
      bridgeToken,
      fetchImpl,
      ask,
      emit,
      signal,
    });
  }
  let snapshot;
  let publicReadError = null;
  try {
    snapshot = await read({ url, maxPages, maxCharacters });
  } catch (error) {
    publicReadError = error;
  }
  if (snapshot && !needsInteractivePage(snapshot)) {
    await emit("browser_read", { action: "open", url, sourceMode: "public_read", characters: snapshot.contentCharacters || snapshot.text?.length || 0 });
    return { ...snapshot, readOnly: true, sourceMode: "public_read_fallback" };
  }
  return {
    readOnly: true,
    status: "requires_confirmation",
    sourceMode: "public_read_fallback",
    url,
    message: clean(publicReadError?.message || "页面需要桌面内置浏览器渲染或用户确认", 1_000),
  };
};

export { INTERACTIVE_SIGNALS, needsInteractivePage };
