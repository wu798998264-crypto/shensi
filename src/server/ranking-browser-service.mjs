const PRIVATE_IPV4 = /^(?:127|10|0)\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./u;

export const assertSafeRankingUrl = (value) => {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error("榜单 URL 无效"); }
  const host = url.hostname.toLowerCase();
  if (["localhost", "::1", "[::1]"].includes(host) || PRIVATE_IPV4.test(host)) throw new Error("本机或内网地址不允许访问");
  if (url.protocol !== "https:") throw new Error("受控浏览器只允许 HTTPS 页面");
  return url;
};

export class RankingBrowserService {
  constructor({ sessionFactory = null, allowedHosts = ["fanqienovel.com", "www.fanqienovel.com", "www.qimao.com", "www.ciweimao.com", "www.dianzhong.com"] } = {}) {
    this.sessionFactory = sessionFactory;
    this.allowedHosts = new Set(allowedHosts);
  }

  async readPage({ url: value, allowBrowserAccess = false, allowAuthenticatedPageAccess = false, signal } = {}) {
    if (allowBrowserAccess !== true) throw new Error("用户未授权受控浏览器访问");
    const url = assertSafeRankingUrl(value);
    if (!this.allowedHosts.has(url.hostname.toLowerCase())) throw new Error("页面域名不在受控浏览器白名单");
    if (!this.sessionFactory) throw new Error("神思受控浏览器尚未连接；不会复用或修改用户现有浏览器");
    const session = await this.sessionFactory({ isolated: true, persistCredentials: false, allowAuthenticatedPageAccess: allowAuthenticatedPageAccess === true, signal });
    try {
      const result = await session.readDom(url.href, { signal, maximumBytes: 2 * 1024 * 1024 });
      const status = result && typeof result === "object" ? String(result.status || "ready") : "ready";
      if (status === "captcha") throw new Error("页面出现验证码，受控扫榜已阻断，不能绕过验证");
      if (status === "waiting_login" && allowAuthenticatedPageAccess !== true) throw new Error("平台需要登录；本轮没有授权认证页面访问");
      const html = result && typeof result === "object" ? result.html : result;
      return { url: url.href, html: String(html || "").slice(0, 2 * 1024 * 1024), sourceMode: "controlled_browser", status };
    } finally {
      await session.close?.();
    }
  }
}
