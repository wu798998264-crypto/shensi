const CONDITION_KEYS = new Set(["workspace", "module", "domain", "deliverable", "document_prefix", "text_all", "text_any"]);
const WORKSPACES = new Set(["project", "notebook", "general"]);
const MODULES = new Set(["manuscript", "outline", "canon", "memory", "reports", "library", "index"]);
const DOMAINS = new Set(["novel", "script", "script-adaptation", "reference", "general"]);

const normalizedText = (value) => String(value ?? "").trim().toLowerCase();
const uniqueLimited = (values, limit, maxLength) => [...new Set((Array.isArray(values) ? values : [])
  .map((item) => String(item ?? "").trim())
  .filter(Boolean)
  .map((item) => item.slice(0, maxLength)))]
  .slice(0, limit);

export const normalizeTriggerKeywords = (values) => uniqueLimited(values, 24, 40);
export const normalizeTriggerConditions = (values) => uniqueLimited(values, 16, 120);

const conditionParts = (condition) => {
  const match = String(condition ?? "").trim().match(/^([a-z_]+)\s*:\s*(.+)$/i);
  return match ? { key: match[1].toLowerCase(), value: match[2].trim() } : null;
};

export const validateTriggerDeclaration = ({ triggerKeywords = [], triggerConditions = [], required = false } = {}) => {
  const keywords = normalizeTriggerKeywords(triggerKeywords);
  const conditions = normalizeTriggerConditions(triggerConditions);
  const errors = [];
  if (required && !keywords.length && !conditions.length) errors.push("自定义插槽必须声明 trigger_keywords 或 trigger_conditions");
  for (const keyword of keywords) if (normalizedText(keyword).length < 2) errors.push(`触发关键词过短：${keyword}`);
  for (const condition of conditions) {
    const parsed = conditionParts(condition);
    if (!parsed || !CONDITION_KEYS.has(parsed.key)) {
      errors.push(`不支持的触发条件：${condition}`);
      continue;
    }
    const alternatives = parsed.value.split("|").map(normalizedText).filter(Boolean);
    if (!alternatives.length) errors.push(`触发条件缺少值：${condition}`);
    if (parsed.key === "workspace" && alternatives.some((item) => !WORKSPACES.has(item))) errors.push(`workspace 条件值无效：${condition}`);
    if (parsed.key === "module" && alternatives.some((item) => !MODULES.has(item))) errors.push(`module 条件值无效：${condition}`);
    if (parsed.key === "domain" && alternatives.some((item) => !DOMAINS.has(item))) errors.push(`domain 条件值无效：${condition}`);
    if (["text_all", "text_any"].includes(parsed.key)) {
      const separator = parsed.key === "text_all" ? "+" : "|";
      const terms = parsed.value.split(separator).map(normalizedText).filter(Boolean);
      if (!terms.length || terms.some((item) => item.length < 2)) errors.push(`文本触发词必须至少两个字符：${condition}`);
    }
    if (parsed.key === "document_prefix" && !/^[a-z0-9_-]{2,80}$/i.test(parsed.value)) errors.push(`document_prefix 条件值无效：${condition}`);
  }
  return { valid: errors.length === 0, errors, keywords, conditions };
};

export const compatibleTriggerDeclaration = ({ triggerKeywords = [], triggerConditions = [] } = {}) => {
  const keywords = normalizeTriggerKeywords(triggerKeywords);
  const conditions = normalizeTriggerConditions(triggerConditions);
  const acceptedKeywords = keywords.filter((keyword) => validateTriggerDeclaration({ triggerKeywords: [keyword] }).valid);
  const acceptedConditions = conditions.filter((condition) => validateTriggerDeclaration({ triggerConditions: [condition] }).valid);
  return {
    keywords: acceptedKeywords,
    conditions: acceptedConditions,
    ignoredKeywords: keywords.filter((keyword) => !acceptedKeywords.includes(keyword)),
    ignoredConditions: conditions.filter((condition) => !acceptedConditions.includes(condition)),
  };
};

const matchAlternatives = (actual, value) => value.split("|").map(normalizedText).filter(Boolean).includes(normalizedText(actual));

const matchCondition = (condition, context) => {
  const parsed = conditionParts(condition);
  if (!parsed) return false;
  const text = normalizedText(context.text);
  if (parsed.key === "workspace") return matchAlternatives(context.workspaceMode, parsed.value);
  if (parsed.key === "module") return matchAlternatives(context.activeModule, parsed.value);
  if (parsed.key === "domain") return matchAlternatives(context.contextDomain, parsed.value);
  if (parsed.key === "deliverable") return matchAlternatives(context.deliverableType, parsed.value);
  if (parsed.key === "document_prefix") return normalizedText(context.targetDocumentId).startsWith(normalizedText(parsed.value));
  if (parsed.key === "text_all") return parsed.value.split("+").map(normalizedText).filter(Boolean).every((term) => text.includes(term));
  if (parsed.key === "text_any") return parsed.value.split("|").map(normalizedText).filter(Boolean).some((term) => text.includes(term));
  return false;
};

export const matchSkillTrigger = (skill = {}, context = {}) => {
  const declaration = validateTriggerDeclaration({
    triggerKeywords: skill.triggerKeywords,
    triggerConditions: skill.triggerConditions,
    required: true,
  });
  if (!declaration.valid) return { matched: false, score: 0, reasons: [], errors: declaration.errors };
  const text = normalizedText(context.text);
  const keywordMatches = declaration.keywords.filter((keyword) => text.includes(normalizedText(keyword)));
  const keywordsPassed = !declaration.keywords.length || keywordMatches.length > 0;
  const conditionMatches = declaration.conditions.filter((condition) => matchCondition(condition, context));
  const conditionsPassed = conditionMatches.length === declaration.conditions.length;
  const matched = keywordsPassed && conditionsPassed;
  return {
    matched,
    score: matched ? keywordMatches.reduce((sum, item) => sum + normalizedText(item).length * 4, 0) + conditionMatches.length * 20 : 0,
    reasons: matched ? [...keywordMatches.map((item) => `关键词：${item}`), ...conditionMatches.map((item) => `条件：${item}`)] : [],
    errors: [],
  };
};
