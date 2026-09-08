import * as http from "node:http";

const providerRouteByHost = new Map();
let directDispatcherPromise = null;

const proxyValue = (environment = process.env) => String(
  environment.HTTPS_PROXY
  || environment.https_proxy
  || environment.HTTP_PROXY
  || environment.http_proxy
  || environment.ALL_PROXY
  || environment.all_proxy
  || "",
).trim();

const directDispatcher = async (loadUndici = () => import("undici")) => {
  directDispatcherPromise ??= loadUndici().then(({ Agent }) => {
    if (typeof Agent !== "function") throw new Error("当前运行时无法创建直连网络通道");
    return new Agent({ connect: { timeout: 15_000 } });
  });
  return directDispatcherPromise;
};

const networkFailureCode = (error) => String(error?.cause?.code || error?.code || "").toUpperCase();
const isTransportFailure = (error) => error?.name === "TypeError"
  || error?.name === "TimeoutError"
  || ["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(networkFailureCode(error));

const safeProviderUrl = (value) => {
  const url = value instanceof URL ? value : new URL(String(value));
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("模型服务只允许使用 HTTPS；本机回环测试接口可以使用 HTTP");
  }
  return url;
};

const friendlyProviderNetworkError = (error, { proxyConfigured = false, directTried = false } = {}) => {
  const code = networkFailureCode(error) || error?.name || "NETWORK_ERROR";
  const suffix = proxyConfigured
    ? directTried
      ? "系统代理和直连均失败，请检查 VPN 节点、防火墙或网络运营商限制"
      : "系统代理链路失败，请检查 VPN 节点或重新测试以启用安全直连回退"
    : "请检查网络、DNS、防火墙或 VPN 设置";
  return Object.assign(new Error(`模型接口网络连接失败（${code}）：${suffix}`), {
    code: "PROVIDER_NETWORK_FAILED",
    cause: error,
  });
};

export const providerNetworkRoute = (value) => providerRouteByHost.get(safeProviderUrl(value).host) || "proxy_or_direct";

export const fetchProvider = async (value, options = {}, {
  allowDirectFallback = false,
  environment = process.env,
  fetchImpl = globalThis.fetch,
  directFetchImpl = null,
  loadUndici = () => import("undici"),
} = {}) => {
  const url = safeProviderUrl(value);
  const proxyConfigured = Boolean(proxyValue(environment));
  const rememberedRoute = providerRouteByHost.get(url.host);
  const runDirect = async () => {
    if (typeof directFetchImpl === "function") return directFetchImpl(url, options);
    return fetchImpl(url, { ...options, dispatcher: await directDispatcher(loadUndici) });
  };
  if (rememberedRoute === "direct") {
    try {
      return await runDirect();
    } catch (error) {
      throw friendlyProviderNetworkError(error, { proxyConfigured, directTried: true });
    }
  }
  try {
    const response = await fetchImpl(url, options);
    providerRouteByHost.set(url.host, proxyConfigured ? "proxy" : "direct");
    return response;
  } catch (error) {
    if (!allowDirectFallback || !proxyConfigured || !isTransportFailure(error)) {
      throw friendlyProviderNetworkError(error, { proxyConfigured, directTried: false });
    }
    try {
      const response = await runDirect();
      providerRouteByHost.set(url.host, "direct");
      return response;
    } catch (directError) {
      throw friendlyProviderNetworkError(directError, { proxyConfigured, directTried: true });
    }
  }
};

export const resetProviderNetworkRoutesForTest = () => providerRouteByHost.clear();

export const configureGlobalFetchProxy = async ({
  environment = process.env,
  httpModule = http,
  loadUndici = () => import("undici"),
} = {}) => {
  const proxy = proxyValue(environment);
  if (!proxy) return { configured: false, mode: "direct" };
  if (typeof httpModule?.setGlobalProxyFromEnv === "function") {
    httpModule.setGlobalProxyFromEnv(environment);
    return { configured: true, mode: "node-native" };
  }
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await loadUndici();
  if (typeof EnvHttpProxyAgent !== "function" || typeof setGlobalDispatcher !== "function") {
    throw new Error("当前运行时无法启用系统代理，小说书目来源将不可访问");
  }
  setGlobalDispatcher(new EnvHttpProxyAgent({
    httpProxy: environment.HTTP_PROXY || environment.http_proxy || proxy,
    httpsProxy: environment.HTTPS_PROXY || environment.https_proxy || proxy,
    noProxy: environment.NO_PROXY || environment.no_proxy || "127.0.0.1,localhost",
  }));
  return { configured: true, mode: "undici-env-agent" };
};
