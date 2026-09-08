const SOURCE_PRIORITY = Object.freeze({
  shensi_default: 10,
  automatic_skill: 20,
  explicit_skill: 30,
  creative_contract: 40,
  current_instruction: 50,
});

const clean = (value = "", maximum = 200_000) => String(value ?? "").trim().slice(0, maximum);
const unique = (values = []) => [...new Set(values.filter(Boolean))];

const chineseNumber = (value = "") => {
  const source = clean(value, 12);
  if (/^\d+$/u.test(source)) return Number(source);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (source === "十") return 10;
  if (source.includes("十")) {
    const [left, right] = source.split("十");
    return (left ? digits[left] ?? 0 : 1) * 10 + (right ? digits[right] ?? 0 : 0);
  }
  return digits[source] ?? Number.NaN;
};

const inferredType = (value = "") => {
  const source = clean(value, 120);
  if (/(?:……|…{2,}|\.\.\.)/u.test(source)) return "sentence_pattern";
  return [...source].length <= 4 ? "word" : "phrase";
};

export const normalizeWritingStyleRule = (value = {}, fallbackSource = "shensi_default") => {
  const ruleValue = clean(value?.value, 120);
  if (!ruleValue) return null;
  const type = ["word", "phrase", "sentence_pattern"].includes(value?.type) ? value.type : inferredType(ruleValue);
  const source = SOURCE_PRIORITY[value?.source] ? value.source : fallbackSource;
  const maxOccurrences = Number.isFinite(Number(value?.maxOccurrences))
    ? Math.max(0, Math.floor(Number(value.maxOccurrences))) : null;
  const maxPerThousandChars = Number.isFinite(Number(value?.maxPerThousandChars))
    ? Math.max(0, Number(value.maxPerThousandChars)) : null;
  if (maxOccurrences === null && maxPerThousandChars === null) return null;
  return {
    type,
    value: ruleValue,
    maxOccurrences,
    maxPerThousandChars,
    scope: value?.scope === "current_document" ? "current_document" : "generated_text",
    source,
    exceptions: unique((Array.isArray(value?.exceptions) ? value.exceptions : []).map((item) => clean(item, 120))),
  };
};

const quoteMatches = (text = "") => {
  const matches = [];
  const pattern = /[“「『"]([^”」』"\r\n]{1,80})[”」』"]/gu;
  for (const match of String(text).matchAll(pattern)) matches.push({ value: clean(match[1], 120), index: match.index ?? 0, length: match[0].length });
  return matches;
};

const limitNear = ({ before = "", after = "" } = {}) => {
  const following = String(after).slice(0, 48);
  const leading = String(before).slice(-48);
  const maximum = following.match(/^[^。！？；\n]{0,16}最多(?:允许)?(?:出现|使用|采用|写)?\s*([0-9零〇一二两三四五六七八九十]+)\s*次/u);
  if (maximum) return { maxOccurrences: chineseNumber(maximum[1]) };
  const allowed = following.match(/^[^。！？；\n]{0,16}允许(?:出现|使用|采用|写)?\s*([0-9零〇一二两三四五六七八九十]+)\s*次/u)
    || (/(?:允许|可用|可以使用)\s*$/u.test(leading) && following.match(/^(?:出现|使用|采用|写)?\s*([0-9零〇一二两三四五六七八九十]+)\s*次/u))
    || following.match(/^[^。！？；\n]{0,16}([0-9零〇一二两三四五六七八九十]+)\s*次(?:即可|以内|就够|上限)/u);
  if (allowed) return { maxOccurrences: chineseNumber(allowed[1]) };
  const perThousand = `${leading}${following}`.match(/每(?:一)?千(?:个)?字[^。！？；\n]{0,20}(?:最多|不超过|允许)?\s*([0-9零〇一二两三四五六七八九十]+)\s*次/u);
  if (perThousand) return { maxPerThousandChars: chineseNumber(perThousand[1]) };
  if (/(?:禁止|禁用|不要(?:再)?|不得|避免|杜绝|不准|不能)[^。！？；\n]{0,16}(?:使用|出现|采用|写|重复)?\s*$/u.test(leading)
    || /^(?:禁止|禁用|不要(?:再)?|不得|避免|杜绝|不准|不能)/u.test(following)) return { maxOccurrences: 0 };
  return null;
};

export const extractWritingStyleRules = (text = "", { source = "shensi_default" } = {}) => {
  const body = clean(text);
  if (!body) return [];
  const rules = [];
  for (const quoted of quoteMatches(body)) {
    const before = body.slice(Math.max(0, quoted.index - 48), quoted.index);
    const after = body.slice(quoted.index + quoted.length, Math.min(body.length, quoted.index + quoted.length + 64));
    const limit = limitNear({ before, after });
    if (!limit) continue;
    rules.push(normalizeWritingStyleRule({ type: inferredType(quoted.value), value: quoted.value, source, ...limit }, source));
  }
  const unquoted = /(?:禁止|禁用|不要(?:再)?|不得|避免|杜绝)\s*(?:使用|出现|采用|写)?\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9_-]{0,19})(?=[，。；;、\s]|$)/gu;
  for (const match of body.matchAll(unquoted)) {
    if (/^(?:这个词|这种|以下|上述|同类|相关|任何|自检|检查|审查|验收|复核|校对|落盘|写入)$/u.test(match[1])) continue;
    rules.push(normalizeWritingStyleRule({ value: match[1], maxOccurrences: 0, source }, source));
  }
  return rules.filter(Boolean);
};

const ruleKey = (rule = {}) => `${rule.type}:${rule.value}`;

export const compileWritingStyleConstraints = ({
  currentInstruction = "",
  creativeContractRules = [],
  creativeContractText = "",
  explicitSkills = [],
  automaticSkills = [],
  defaultRules = [],
} = {}) => {
  const sources = [
    ...defaultRules.map((rule) => normalizeWritingStyleRule({ ...rule, source: "shensi_default" }, "shensi_default")),
    ...automaticSkills.flatMap((skill) => [
      ...extractWritingStyleRules(skill?.content, { source: "automatic_skill" }),
      ...(skill?.ruleFiles ?? []).flatMap((file) => extractWritingStyleRules(file?.content, { source: "automatic_skill" })),
    ]),
    ...explicitSkills.flatMap((skill) => [
      ...extractWritingStyleRules(skill?.content, { source: "explicit_skill" }),
      ...(skill?.ruleFiles ?? []).flatMap((file) => extractWritingStyleRules(file?.content, { source: "explicit_skill" })),
    ]),
    ...extractWritingStyleRules(creativeContractText, { source: "creative_contract" }),
    ...creativeContractRules.map((rule) => normalizeWritingStyleRule({ ...rule, source: "creative_contract" }, "creative_contract")),
    ...extractWritingStyleRules(currentInstruction, { source: "current_instruction" }),
  ].filter(Boolean);
  const selected = new Map();
  for (const rule of sources) {
    const current = selected.get(ruleKey(rule));
    if (!current || SOURCE_PRIORITY[rule.source] >= SOURCE_PRIORITY[current.source]) selected.set(ruleKey(rule), rule);
  }
  const skills = [...explicitSkills, ...automaticSkills];
  const failures = skills.flatMap((skill) => (skill?.skillReadFailures ?? []).map((failure) => ({
    skillId: skill.id || skill.name || "unknown",
    ...failure,
  })));
  return {
    rules: [...selected.values()],
    trace: {
      loadedSkills: unique(skills.map((skill) => clean(skill?.id || skill?.name, 240))),
      ruleFiles: unique(skills.flatMap((skill) => (skill?.ruleFiles ?? []).map((file) => clean(file?.path, 500)))),
      activeRules: [...selected.values()].map((rule) => ({ ...rule })),
      failures,
      missing: failures.map((failure) => failure.path).filter(Boolean),
    },
  };
};

export const writingStyleRulesPrompt = (bundle = {}) => {
  const rules = Array.isArray(bundle?.rules) ? bundle.rules : [];
  if (!rules.length) return "";
  return [
    "# 本轮有效语言约束",
    "以下是按‘当前指令 > 创作合同 > 显式 Skill > 自动 Skill > 默认规则’合并后的精简清单。只约束表达，不改变剧情事实；对白口癖、专名、引用和作者要求保留的固定表达默认不改。",
    ...rules.map((rule) => {
      const limits = [
        rule.maxOccurrences !== null && `最多 ${rule.maxOccurrences} 次`,
        rule.maxPerThousandChars !== null && `每千字最多 ${rule.maxPerThousandChars} 次`,
      ].filter(Boolean).join("；");
      return `- ${rule.type}:${rule.value}｜${limits}｜来源:${rule.source}`;
    }),
  ].join("\n");
};

export const writingStyleSourcePriority = (source = "") => SOURCE_PRIORITY[source] ?? 0;
