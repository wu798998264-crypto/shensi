const normalized = (value = "") => String(value ?? "").trim();

const ALTERNATE_PATTERN = /平行(?:版本|结局|世界|支线)|备选世界线|alternate/iu;
const REWRITE_CANON_PATTERN = /(?:写入|改写|重写|修改|替换|更新).{0,12}正典|正典.{0,12}(?:替换|改写|重写|修改|更新)|替换旧(?:规则|设定|正典)/u;
const DISCUSSION_PATTERN = /分析|评价|评估|诊断|讨论|脑暴|推演|假设|可能性|为什么|怎么样|建议/u;
const FORMAL_PUBLISH_PATTERN = /正式发布|发布终稿|出版|交付终稿/u;
const LONG_FORM_PATTERN = /整卷|全书|长篇|批量(?:生成|创作|续写)/u;

export const canonModeForTask = ({ text = "", action = "discuss" } = {}) => {
  const instruction = normalized(text);
  if (ALTERNATE_PATTERN.test(instruction)) return "alternate";
  if (REWRITE_CANON_PATTERN.test(instruction)) return "rewrite_canon";
  if (["analyze", "discuss"].includes(action) || DISCUSSION_PATTERN.test(instruction) && !["generate", "modify"].includes(action)) return "advisory";
  if (["generate", "modify"].includes(action)) return "strict";
  return "advisory";
};

export const reviewTierForTask = ({ text = "", action = "discuss", route = {} } = {}) => {
  if (!["generate", "modify"].includes(action)) return "none";
  const instruction = normalized(text);
  if (route.longForm === true
    || route.unattended === true
    || route.formalPublish === true
    || route.batch === true
    || route.reviewDelivery?.active === true
    || FORMAL_PUBLISH_PATTERN.test(instruction)
    || LONG_FORM_PATTERN.test(instruction)) return "full";
  return "basic";
};

export const compileCanonTaskPolicy = ({ text = "", action = "discuss", route = {} } = {}) => {
  const canonMode = canonModeForTask({ text, action });
  const reviewTier = reviewTierForTask({ text, action, route });
  return {
    canonMode,
    reviewTier,
    canonGate: "mode_metadata",
    autoCommitAllowed: ["strict", "rewrite_canon"].includes(canonMode) && ["generate", "modify"].includes(action),
    preservePreviousCanon: canonMode === "rewrite_canon",
    requireCurrentRevision: ["strict", "rewrite_canon"].includes(canonMode),
    continuityFailure: reviewTier === "full" ? "block" : "warning",
  };
};
