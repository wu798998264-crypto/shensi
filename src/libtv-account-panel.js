export const libTvAccountPanelMarkup = () => `<section class="wide dreamina-account-panel libtv-account-panel" id="libTvAccountPanel" hidden aria-live="polite">
  <div class="dreamina-account-main"><strong data-libtv-account-title>LibTV 账号</strong><p data-libtv-account-status>正在读取 CLI 当前登录账号…</p>
    <div class="dreamina-account-metrics"><span class="dreamina-current-credit"><button class="icon-button bare" data-libtv-account-refresh type="button" title="刷新账号状态" aria-label="刷新 LibTV 账号状态">↻</button><small>当前积分</small><b data-libtv-metric="credit">—</b></span><span><small>累计消耗</small><b data-libtv-metric="consumed">—</b></span><span><small>会员</small><b data-libtv-metric="membership">—</b></span></div>
  </div><div class="settings-inline-actions"><button class="secondary-button" data-libtv-account-verify type="button" title="只读取 CLI 当前账号信息，不切换账号；不代表生成权限已经核验">核验账号</button></div>
</section>`;

export const createLibTvAccountPanel = ({ panel, snapshot, request, now = Date.now }) => {
  const cache = new Map();
  const pending = new Map();
  const context = () => {
    const current = snapshot();
    const settings = current.settings || {};
    return { ...current, key: `${current.channel}:${settings.connectionId || settings.id || ""}:${settings.cliPath || ""}`,
      visible: current.visible && settings.adapter === "cli" && String(settings.provider || "").toLowerCase() === "libtv" };
  };
  const metric = (name, value, title = "") => {
    const element = panel.querySelector(`[data-libtv-metric="${name}"]`);
    if (element) { element.textContent = value == null ? "—" : String(value); element.title = title; }
  };
  const render = () => {
    const current = context();
    panel.hidden = !current.visible;
    if (!current.visible) return;
    const saved = cache.get(current.key);
    const result = saved?.result;
    panel.querySelector("[data-libtv-account-title]").textContent = `LibTV 账号${result?.accountName ? ` · ${result.accountName}` : ""}`;
    const status = saved?.error
      ? `账号状态暂时读取失败：${saved.error}${result ? "；保留上次查询结果，不等同于退出登录" : "；尚不能判断登录状态"}`
      : !result ? "正在读取 CLI 当前登录账号…"
        : !result.loggedIn ? "CLI 未返回保存的账号，请先完成 LibTV CLI 登录"
          : !result.activeAccountAvailable ? "CLI 返回了保存的账号，但未返回当前生效账号；未自动切换账号"
            : `已读取 CLI 当前账号；账号 ID：${result.accountId || "未返回"}；${result.creditAvailable ? `积分 ${result.credit}` : "官方 CLI 未返回积分余额"}；本次查询不代表生成权限已核验`;
    panel.querySelector("[data-libtv-account-status]").textContent = status;
    metric("credit", result?.credit, result?.creditReason || "");
    metric("consumed", result?.consumed, result?.consumed == null ? "官方 CLI 未返回累计积分消耗，不按套餐额度推算" : "");
    metric("membership", result?.membership, result?.membership || "");
    for (const button of panel.querySelectorAll("button")) button.disabled = pending.has(current.key);
  };
  const refresh = async ({ force = false } = {}) => {
    const current = context();
    render();
    if (!current.visible) return null;
    if (pending.has(current.key)) return pending.get(current.key);
    if (!force && now() - (cache.get(current.key)?.at || 0) < 30_000) return cache.get(current.key)?.result || null;
    const task = Promise.resolve().then(() => request(current)).then((result) => {
      cache.set(current.key, { result, at: now() });
      return result;
    }).catch((error) => {
      cache.set(current.key, { ...cache.get(current.key), at: now(), error: error.message || "账号查询失败" });
      return null;
    }).finally(() => { pending.delete(current.key); render(); });
    pending.set(current.key, task);
    render();
    return task;
  };
  panel.addEventListener("click", (event) => {
    if (event.target.closest("[data-libtv-account-refresh], [data-libtv-account-verify]")) void refresh({ force: true });
  });
  return { render, refresh };
};
