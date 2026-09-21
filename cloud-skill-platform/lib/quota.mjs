import { createId } from "./security.mjs";

export const ensureQuotaAccount = (state, userId) => {
  let account = state.quotaAccounts.find((entry) => entry.userId === userId);
  if (!account) {
    account = { id: createId("quota"), userId, available: 0, reserved: 0, updatedAt: Date.now() };
    state.quotaAccounts.push(account);
  }
  return account;
};

const ledgerEntry = ({ userId, type, amount, balance, reason, referenceId = "", actorUserId = "system" }) => ({
  id: createId("quota_tx"), userId, type, amount, balance, reason: String(reason || "").slice(0, 240), referenceId, actorUserId, createdAt: Date.now(),
});

export const adjustQuota = ({ state, userId, amount, reason, actorUserId }) => {
  const units = Number(amount);
  if (!Number.isSafeInteger(units) || units === 0 || Math.abs(units) > 10_000_000) throw new Error("额度调整值无效");
  const account = ensureQuotaAccount(state, userId);
  if (account.available + units < 0) throw new Error("额度不能低于 0");
  account.available += units;
  account.updatedAt = Date.now();
  state.quotaLedger.push(ledgerEntry({ userId, type: units > 0 ? "grant" : "debit", amount: units, balance: account.available, reason, actorUserId }));
  return account;
};

export const reserveQuota = ({ state, userId, amount, idempotencyKey, reason = "文字 AI 请求" }) => {
  const units = Number(amount);
  const key = String(idempotencyKey || "").trim();
  if (!Number.isSafeInteger(units) || units <= 0 || units > 10_000_000 || !key || key.length > 160) throw new Error("额度预留参数无效");
  const existing = state.quotaLedger.find((entry) => entry.type === "reserve" && entry.referenceId === key && entry.userId === userId);
  if (existing) return { account: ensureQuotaAccount(state, userId), reservationId: existing.reservationId, idempotent: true };
  const account = ensureQuotaAccount(state, userId);
  if (account.available < units) throw new Error("可用文字 AI 额度不足");
  account.available -= units;
  account.reserved += units;
  account.updatedAt = Date.now();
  const reservationId = createId("reservation");
  state.quotaLedger.push({ ...ledgerEntry({ userId, type: "reserve", amount: -units, balance: account.available, reason, referenceId: key }), reservationId, reservedUnits: units });
  return { account, reservationId, idempotent: false };
};

export const settleQuota = ({ state, userId, reservationId, usedAmount }) => {
  const reservation = state.quotaLedger.find((entry) => entry.type === "reserve" && entry.reservationId === reservationId && entry.userId === userId);
  if (!reservation || reservation.settledAt) throw new Error("额度预留不存在或已结算");
  const used = Number(usedAmount);
  if (!Number.isSafeInteger(used) || used < 0 || used > reservation.reservedUnits) throw new Error("实际用量无效");
  const refund = reservation.reservedUnits - used;
  const account = ensureQuotaAccount(state, userId);
  account.reserved -= reservation.reservedUnits;
  account.available += refund;
  account.updatedAt = Date.now();
  reservation.settledAt = Date.now();
  reservation.usedAmount = used;
  if (refund) state.quotaLedger.push(ledgerEntry({ userId, type: "refund", amount: refund, balance: account.available, reason: "文字 AI 请求未使用额度退回", referenceId: reservationId }));
  return account;
};

export const refundQuota = ({ state, userId, reservationId }) => settleQuota({ state, userId, reservationId, usedAmount: 0 });

