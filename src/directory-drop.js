const unique = (values = []) => [...new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean))];

export const directoryOrderWithPlacement = ({
  siblings = [],
  movingTokens = [],
  targetToken = "",
  placement = "after",
} = {}) => {
  const moving = unique(movingTokens);
  const movingSet = new Set(moving);
  const next = unique(siblings).filter((token) => !movingSet.has(token));
  const targetIndex = next.indexOf(String(targetToken || ""));
  const insertIndex = targetIndex < 0
    ? placement === "before" ? 0 : next.length
    : targetIndex + (placement === "after" ? 1 : 0);
  next.splice(insertIndex, 0, ...moving);
  return next;
};

export const directoryRootDropIntent = ({
  parentKey = "",
  siblings = [],
  movingTokens = [],
  edge = "after",
} = {}) => {
  const movingSet = new Set(unique(movingTokens));
  const available = unique(siblings).filter((token) => !movingSet.has(token));
  if (!String(parentKey || "") || !available.length) return null;
  const placement = edge === "before" ? "before" : "after";
  return {
    type: "root",
    parentKey: String(parentKey),
    targetToken: placement === "before" ? available[0] : available.at(-1),
    placement,
  };
};
