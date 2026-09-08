const text = (value) => String(value ?? "").trim();

export const DEFAULT_NOVEL_CHAPTER_LENGTH = Object.freeze({
  min: 2000,
  max: 2800,
  targetMin: 2100,
  targetMax: 2700,
});

const RANGE_SEPARATOR = "(?:-|—|–|~|～|至|到)";
const CHAPTER_LABEL = "(?:每(?:一)?章|单章|本章|这章|一章|章节(?:正文)?|第\\s*(?:\\d+|[零〇一二两三四五六七八九十百千]+)\\s*章)";
const LENGTH_NUMBER = "(\\d{3,5})";
const INTERNAL_VARIABLE_PATTERN = new RegExp(`本章字数变量[^。；\\n]{0,32}?目标(?:约为|约|为)?\\s*${LENGTH_NUMBER}\\s*字[^。；\\n]{0,32}?验收范围\\s*${LENGTH_NUMBER}\\s*${RANGE_SEPARATOR}\\s*${LENGTH_NUMBER}\\s*字`, "u");
const CHAPTER_RANGE_PATTERNS = [
  new RegExp(`${CHAPTER_LABEL}[^。；\\n]{0,40}?${LENGTH_NUMBER}\\s*${RANGE_SEPARATOR}\\s*${LENGTH_NUMBER}\\s*(?:个\\s*)?(?:中文字符|汉字|字符|字)`, "u"),
  new RegExp(`${LENGTH_NUMBER}\\s*${RANGE_SEPARATOR}\\s*${LENGTH_NUMBER}\\s*(?:个\\s*)?(?:中文字符|汉字|字符|字)[^。；\\n]{0,32}?${CHAPTER_LABEL}`, "u"),
];
const CHAPTER_EXACT_PATTERNS = [
  new RegExp(`${CHAPTER_LABEL}[^。；\\n]{0,36}?(?:目标字数|字数目标|字数|篇幅|长度)?[^。；\\n]{0,12}?(?:控制在|保持在|写到|约为|大约|约|为|目标)?\\s*${LENGTH_NUMBER}\\s*(?:个\\s*)?(?:中文字符|汉字|字符|字)`, "u"),
  new RegExp(`${LENGTH_NUMBER}\\s*(?:个\\s*)?(?:中文字符|汉字|字符|字)[^。；\\n]{0,28}?${CHAPTER_LABEL}`, "u"),
];
const GENERAL_RANGE_PATTERN = new RegExp(`${LENGTH_NUMBER}\\s*${RANGE_SEPARATOR}\\s*${LENGTH_NUMBER}\\s*(?:个\\s*)?(?:中文字符|汉字|字符|字)`, "u");
const GENERAL_EXACT_PATTERN = new RegExp(`(?:目标字数|字数目标|字数|篇幅|长度)?[^。；\\n]{0,10}?(?:控制在|保持在|写到|约为|大约|约|为|目标)?\\s*${LENGTH_NUMBER}\\s*(?:个\\s*)?(?:中文字符|汉字|字符|字)`, "u");

const stableHash = (value) => {
  let hash = 2166136261;
  for (const character of text(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const roundToTen = (value) => Math.max(10, Math.round(Number(value) / 10) * 10);

const variedInteriorTarget = ({ min, max, seed }) => {
  const span = Math.max(0, max - min);
  if (!span) return min;
  const inset = span >= 200 ? Math.max(50, Math.round(span * 0.12)) : Math.max(1, Math.floor(span * 0.1));
  const step = span >= 100 ? 10 : 1;
  const innerMin = step === 10 ? Math.ceil((min + inset) / 10) * 10 : min + inset;
  const innerMax = step === 10 ? Math.floor((max - inset) / 10) * 10 : max - inset;
  if (innerMax <= innerMin) return Math.round((min + max) / 2);
  const slots = Math.floor((innerMax - innerMin) / step) + 1;
  return Math.min(innerMax, innerMin + (stableHash(seed) % slots) * step);
};

const exactTargetPlan = ({ target, source, seed }) => {
  const tolerance = Math.max(30, roundToTen(target * 0.06));
  return {
    min: Math.max(1, target - tolerance),
    max: target + tolerance,
    target,
    source,
    preference: "target",
    seed,
  };
};

export const parseNovelChapterLengthPreference = (value = "", { source = "user", assumeChapter = false } = {}) => {
  const input = text(value);
  if (!input) return null;
  const internal = input.match(INTERNAL_VARIABLE_PATTERN);
  if (internal && source !== "project") {
    const target = Number(internal[1]);
    const first = Number(internal[2]);
    const second = Number(internal[3]);
    return {
      min: Math.min(first, second),
      max: Math.max(first, second),
      target,
      source,
      preference: "variable",
    };
  }
  for (const pattern of CHAPTER_RANGE_PATTERNS) {
    const match = input.match(pattern);
    if (!match) continue;
    const numbers = match.slice(1).map(Number).filter(Number.isFinite);
    const first = numbers.at(-2);
    const second = numbers.at(-1);
    if (!(first > 0 && second > 0)) continue;
    return {
      min: Math.min(first, second),
      max: Math.max(first, second),
      source,
      preference: "range",
    };
  }
  if (internal) {
    const target = Number(internal[1]);
    const first = Number(internal[2]);
    const second = Number(internal[3]);
    return {
      min: Math.min(first, second),
      max: Math.max(first, second),
      target,
      source,
      preference: "variable",
    };
  }
  if (assumeChapter) {
    const match = input.match(GENERAL_RANGE_PATTERN);
    const first = Number(match?.[1]);
    const second = Number(match?.[2]);
    if (first > 0 && second > 0) return {
      min: Math.min(first, second),
      max: Math.max(first, second),
      source,
      preference: "range",
    };
  }
  for (const pattern of CHAPTER_EXACT_PATTERNS) {
    const match = input.match(pattern);
    const target = Number(match?.at(-1));
    if (target > 0) return { target, source, preference: "target" };
  }
  if (assumeChapter) {
    const target = Number(input.match(GENERAL_EXACT_PATTERN)?.[1]);
    if (target > 0) return { target, source, preference: "target" };
  }
  return null;
};

export const resolveNovelChapterLengthPlan = ({
  userPrompt = "",
  projectContext = "",
  chapterNumber = 0,
  projectSeed = "",
} = {}) => {
  const seed = `${text(projectSeed)}|${Number(chapterNumber) || 0}|chapter-length-v1`;
  const projectSource = text(projectContext);
  const contractIndex = projectSource.search(/(?:作者已确认的长篇)?创作合同/u);
  const projectContractExcerpt = contractIndex >= 0 ? projectSource.slice(contractIndex, contractIndex + 6000) : "";
  const preference = parseNovelChapterLengthPreference(userPrompt, { source: "user", assumeChapter: true })
    ?? parseNovelChapterLengthPreference(projectContractExcerpt, { source: "project" })
    ?? parseNovelChapterLengthPreference(projectSource, { source: "project" });
  if (preference?.preference === "target") return exactTargetPlan({ ...preference, seed });
  if (preference) {
    const min = Number(preference.min);
    const max = Number(preference.max);
    const target = Number(preference.target) || variedInteriorTarget({ min, max, seed });
    return { ...preference, min, max, target, seed };
  }
  const defaults = DEFAULT_NOVEL_CHAPTER_LENGTH;
  return {
    min: defaults.min,
    max: defaults.max,
    target: variedInteriorTarget({ min: defaults.min, max: defaults.max, seed }),
    source: "default",
    preference: "default",
    seed,
  };
};

export const novelChapterLengthInstruction = (plan = null) => {
  if (!plan) return "";
  const sourceLabel = plan.source === "user" ? "作者本轮要求" : plan.source === "project" ? "项目创作合同" : "默认章节策略";
  return [
    `本章字数变量（${sourceLabel}）：自然目标约 ${plan.target} 字，验收范围 ${plan.min}-${plan.max} 字。`,
    plan.source === "default"
      ? "正式正文不得低于 2000 字，也不要机械停在 2000 或 2800 的边界；相邻章节应随场景、节奏和章节功能自然波动。"
      : "作者或项目明确指定的字数优先于软件默认值；只约束本章，不得误当成整本或整卷总字数。",
    "围绕本章动作链、人物选择、关系变化、信息释放和场景结果完成篇幅，不得用重复描写、总结性说明或无功能对白凑字数。",
  ].join("\n");
};

export const serializedNovelChapterLengthVariable = (plan = null) => (
  Number.isFinite(Number(plan?.target))
  && Number.isFinite(Number(plan?.min))
  && Number.isFinite(Number(plan?.max))
    ? `本章字数变量：目标约 ${Number(plan.target)} 字；验收范围 ${Number(plan.min)}-${Number(plan.max)} 字。`
    : ""
);
