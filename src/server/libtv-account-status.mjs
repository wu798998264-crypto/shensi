// Account listing is read-only. `account info` also recalibrates the CLI's
// active scope, so it must not be used by a passive status panel.
const clean = (value) => String(value ?? "").trim().slice(0, 240);
const numberField = (object, fields) => {
  for (const field of fields) {
    const value = object?.[field];
    if (value == null || value === "" || typeof value === "boolean" || typeof value === "object") continue;
    if (typeof value === "string" && !value.trim()) continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
};

export const normalizeLibTvAccountStatus = (payload = {}, { checkedAt = new Date().toISOString() } = {}) => {
  const accounts = payload.accounts ?? payload.data?.accounts;
  if (!Array.isArray(accounts)) throw new Error("LibTV 账号查询没有返回账户列表，不能据此判断登录状态");
  const account = accounts.find((item) => item?.isActive === true || item?.isActive === 1);
  const credit = numberField(account, ["remainingCredits", "creditBalance", "availableCredits", "remainingPoints", "pointBalance", "credit", "credits"]);
  const consumed = numberField(account, ["consumedCredits", "totalConsumedCredits", "usedCredits"]);
  const membership = account?.memberAccount;
  return {
    checkedAt, source: "libtv_account_list", loggedIn: accounts.length > 0,
    activeAccountAvailable: Boolean(account), generationPermissionChecked: false,
    accountId: clean(account?.accountId), accountName: clean(account?.accountName),
    accountType: account?.accountType ?? null,
    membership: membership?.effective === false ? "会员未生效" : clean(membership?.memberName) || "未返回会员信息",
    credit, consumed, creditAvailable: credit !== null,
    creditReason: credit === null ? "官方 CLI 当前未返回积分余额；套餐名称中的积分不是剩余积分" : "",
  };
};

export const probeLibTvAccountStatus = async ({ driver, settings = {}, cwd }) => {
  if (driver?.id !== "libtv-cli" || settings.adapter !== "cli" || clean(settings.provider).toLowerCase() !== "libtv") {
    throw new Error("账号查询仅适用于 LibTV CLI 配置");
  }
  const payload = await driver.invoke(["account", "list"], {
    cwd, settings, timeoutMs: 30_000, phase: "查询账号状态",
  });
  return normalizeLibTvAccountStatus(payload);
};
