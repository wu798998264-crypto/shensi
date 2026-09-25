const clean = (value = "") => String(value ?? "").trim();

const firstValue = (source, keys = []) => {
  const queue = [source];
  const visited = new Set();
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== "object" || visited.has(value)) continue;
    visited.add(value);
    for (const key of keys) {
      const candidate = value[key];
      if (candidate !== undefined && candidate !== null && clean(candidate)) return candidate;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return "";
};

const truthyFlag = (source, keys = []) => {
  const value = firstValue(source, keys);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  return /^(?:1|true|yes|active|valid|enabled)$/iu.test(clean(value));
};

const PREMIUM_LEVEL_PATTERN = /(?:ultra|maestro|premium|pro|professional|advanced|vip|svip|member|会员|高级)/iu;
const FREE_LEVEL_PATTERN = /^(?:free|basic|normal|ordinary|guest|none|普通|免费)$/iu;

export const dreaminaMembershipFromPayload = (payload = {}, fallback = {}) => {
  const rawLevel = clean(firstValue(payload, [
    "vip_level", "vipLevel", "member_level", "memberLevel", "membership_level", "membershipLevel",
    "member_type", "memberType", "membership", "vip_type", "vipType", "plan_name", "planName",
    "plan", "package_name", "packageName", "product_name", "productName", "tier",
  ]) || fallback.vipLevel || fallback.rawLevel);
  const expiresAt = clean(firstValue(payload, [
    "vip_expires_at", "vipExpiresAt", "vip_expire_time", "vipExpireTime", "membership_expires_at",
    "membershipExpiresAt", "member_expire_time", "memberExpireTime", "expire_time", "expiresAt",
  ]) || fallback.vipExpiresAt || fallback.expiresAt);
  const premiumFlag = truthyFlag(payload, [
    "is_vip", "isVip", "is_member", "isMember", "is_premium", "isPremium", "vip_valid", "vipValid",
    "is_pro", "isPro", "is_advanced", "isAdvanced", "premium_member", "premiumMember",
  ]);
  const tier = premiumFlag || PREMIUM_LEVEL_PATTERN.test(rawLevel)
    ? "advanced"
    : FREE_LEVEL_PATTERN.test(rawLevel)
      ? "standard"
      : clean(fallback.membershipTier) || "unknown";
  return {
    rawLevel,
    tier,
    label: tier === "advanced" ? "高级会员" : tier === "standard" ? "普通账号" : "会员等级待核验",
    expiresAt,
  };
};

export const dreaminaMembershipDisplay = (value = {}) => {
  const normalized = dreaminaMembershipFromPayload(value, {
    vipLevel: value.vipLevel,
    vipExpiresAt: value.vipExpiresAt,
    membershipTier: value.membershipTier,
  });
  return normalized.label;
};
