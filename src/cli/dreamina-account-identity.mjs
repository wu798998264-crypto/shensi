const identityError = (message, code) => Object.assign(new Error(message), { code });

const profileId = () => {
  const id = String(process.env.SHENSI_DREAMINA_PROFILE_ID || "").trim();
  if (!id) throw identityError("当前即梦运行环境缺少明确账号配置", "DREAMINA_PROFILE_REQUIRED");
  return id;
};
const expectedUserId = () => String(process.env.SHENSI_DREAMINA_EXPECTED_USER_ID || "").trim();

const nestedValue = (value, keys) => {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = nestedValue(child, keys);
    if (found !== "") return found;
  }
  return "";
};

export const assertDreaminaAccountIdentity = (credit = {}) => {
  const id = profileId();
  const expected = expectedUserId();
  // Official CLI releases have returned the same account payload both at the
  // root and inside data/result envelopes. Read only explicit identity keys;
  // never fall back to a generic nested id that could belong to a task.
  const actual = String(nestedValue(credit, ["user_id", "userId", "uid"]) || "").trim();
  if (!actual) throw identityError(`即梦配置“${id}”未返回真实账号 user_id，已阻止提交以避免扣错账号`, "DREAMINA_ACCOUNT_ID_MISSING");
  if (!expected) {
    throw identityError(`即梦配置“${id}”尚未完成独立账号绑定与身份确认`, "DREAMINA_PROFILE_UNVERIFIED");
  }
  if (expected && actual !== expected) {
    throw identityError(`即梦配置“${id}”账号串号：预期 user_id=${expected}，实际 user_id=${actual}；已阻止提交`, "DREAMINA_ACCOUNT_MISMATCH");
  }
  const rawCredit = nestedValue(credit, ["total_credit", "totalCredit", "credit", "credits"]);
  const parsedCredit = rawCredit === "" || rawCredit === null || rawCredit === undefined
    ? null
    : Number(rawCredit);
  return {
    profileId: id,
    userId: actual,
    expectedUserId: expected || actual,
    credit: Number.isFinite(parsedCredit) && parsedCredit >= 0 ? parsedCredit : null,
    vipLevel: String(nestedValue(credit, ["vip_level", "vipLevel"]) || ""),
  };
};
