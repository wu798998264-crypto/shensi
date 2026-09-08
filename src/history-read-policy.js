const text = (value = "") => String(value ?? "").trim();

const EXPLICIT_HISTORY_INTENT = /(?:比较|对比|核对).{0,18}(?:改稿前后|修改前后|新旧稿|历史版本|旧版本|版本差异)|(?:恢复|找回|还原).{0,18}(?:被删|删掉|删除|旧稿|旧版本|历史版本|细节)|(?:追溯|查找|寻找|看看).{0,18}(?:伏笔|线索|设定|情节|人物).{0,18}(?:最初|原始|第一次|旧版|历史)|(?:分析|梳理|判断).{0,18}(?:人物|角色|设定|剧情|情节).{0,18}(?:演变|变化|改动过程|版本变化)|(?:compare|restore|recover|trace|evolution).{0,24}(?:revision|version|draft|history)/iu;

const historyVersionSelectors = (instruction = "") => {
  const value = text(instruction);
  const selectors = new Set();
  for (const match of value.matchAll(/(?:^|[^A-Za-z0-9])((?:v(?:ersion)?[-_ ]?)[A-Za-z0-9._:-]{1,80})/giu)) selectors.add(text(match[1]).replace(/\s+/gu, ""));
  for (const match of value.matchAll(/(?:历史)?版本[：:\s]*([A-Za-z0-9._:-]{1,80})/gu)) selectors.add(text(match[1]));
  if (/(?:最初|原始|第一次|最早)(?:的)?(?:版本|旧稿|稿件)?/u.test(value)) selectors.add("oldest");
  if (/(?:上一个版本|上一版|修改前|改稿前|更新前|覆盖前|旧版本|旧稿)/u.test(value)) selectors.add("previous");
  if (/(?:最新历史版本|最近的?历史版本)/u.test(value)) selectors.add("latest");
  if (!selectors.size && historyReadIntent(value)) selectors.add("previous");
  return [...selectors];
};

export const historyReadIntent = (instruction = "") => EXPLICIT_HISTORY_INTENT.test(text(instruction));

export const createHistoryReadAuthorization = ({
  instruction = "",
  requestedBy = "user",
  reason = "",
  gapId = "",
  allowed = undefined,
  documentIds = [],
  versionSelectors = [],
} = {}) => {
  const actor = requestedBy === "agent" ? "agent" : "user";
  const explicit = historyReadIntent(instruction);
  const normalizedReason = text(reason) || (explicit ? "user_explicit_history_request" : "");
  const normalizedGapId = text(gapId);
  const agentDiscoveryValid = actor === "agent" && Boolean(normalizedReason && normalizedGapId);
  const permitted = allowed === false ? false : actor === "user" ? explicit || allowed === true : agentDiscoveryValid && allowed === true;
  return {
    allowed: permitted,
    requestedBy: actor,
    reason: permitted ? normalizedReason : "",
    gapId: permitted ? normalizedGapId : "",
    canonLevel: permitted ? "historical_non_canon" : "",
    readOnly: permitted,
    commitBaselineEligible: false,
    allowedDocumentIds: permitted ? [...new Set((Array.isArray(documentIds) ? documentIds : []).map(text).filter(Boolean))].slice(0, 64) : [],
    allowedVersionSelectors: permitted ? [...new Set([
      ...historyVersionSelectors(instruction),
      ...(Array.isArray(versionSelectors) ? versionSelectors : []).map(text).filter(Boolean),
    ])].slice(0, 32) : [],
  };
};

export const authorizeHistoryToolCall = ({ defaultAuthorization = null, reason = "", gapId = "" } = {}) => {
  const inherited = defaultAuthorization?.allowed === true
    ? createHistoryReadAuthorization({
        requestedBy: defaultAuthorization.requestedBy || "user",
        reason: defaultAuthorization.reason,
        gapId: defaultAuthorization.gapId,
        allowed: true,
        instruction: defaultAuthorization.requestedBy === "user" ? "比较历史版本" : "",
        documentIds: defaultAuthorization.allowedDocumentIds,
        versionSelectors: defaultAuthorization.allowedVersionSelectors,
      })
    : null;
  if (inherited?.allowed) return inherited;
  return createHistoryReadAuthorization({ requestedBy: "agent", reason, gapId, allowed: true });
};
