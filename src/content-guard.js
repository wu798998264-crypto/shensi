const excerptAround = (source, index, length, radius = 36) => source
  .slice(Math.max(0, index - radius), Math.min(source.length, index + length + radius))
  .replace(/\s+/g, " ")
  .trim();

const literalOccurrences = (source, term) => {
  const results = [];
  let cursor = 0;
  while (term && (cursor = source.indexOf(term, cursor)) >= 0) {
    results.push({ index: cursor, term, excerpt: excerptAround(source, cursor, term.length) });
    cursor += term.length;
  }
  return results;
};

const ABSOLUTE_PATTERNS = [
  { id: "wikilink", label: "正文内部链接", pattern: /\[\[[^\]]+\]\]/g },
  { id: "ai-identity", label: "AI身份或能力声明", pattern: /作为(?:一个|一名)?(?:AI|人工智能|语言模型)|我无法(?:真正|直接)?(?:创作|体验|感受)/gi },
  { id: "assistant-preface", label: "助手式交付套话", pattern: /(?:下面|以下)是(?:我|为你|根据).{0,20}(?:生成|创作|改写|整理)的|根据(?:你的|用户的)要求|希望(?:你|读者)喜欢|如需(?:继续|调整|修改)/g },
  { id: "internal-marker", label: "内部候选或检查标记", pattern: /【候选稿】|【自检报告】|神思双核回执/g },
];

const INTERNAL_ARTIFACT_PATTERNS = [
  { id: "internal-thinking-tag", label: "模型内部思考标记", pattern: /\\?<\/?think(?:ing)?(?:\s[^>]*)?>/giu },
  { id: "internal-chapter-brief", label: "内部章节执行说明", pattern: /(?:^|\n)\s*(?:章节任务|本章任务|叙事模式|结束功能|关键保护元素|近期风险)\s*[：:]/gmu },
  { id: "internal-provenance", label: "内部来源追踪字段", pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?来源\s*[：:]/g },
  { id: "internal-domain-status", label: "内部正文域状态字段", pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:剧本域状态|小说域状态|正文域状态|正史状态|输出状态|生成状态)\s*[：:]/g },
  { id: "internal-duty", label: "内部职责提示", pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?本轮内部职责(?:[：:]|\s)/g },
  { id: "internal-contract", label: "内部生成合同", pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:(?:本轮内部生成合同|动态创作胶囊|本章创作合同|单集写作卡|本集写作卡|本章写作卡)(?:[：:]|\s|$)|写作卡\s*[：:])/g },
  { id: "internal-candidates", label: "内部候选过程", pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:候选方案(?:竞争)?|候选\s*\d+|人物本能版|效果极值版|意外成立版)(?:[：:]|\s|$)/g },
  { id: "internal-review", label: "内部检查内容", pattern: /(?:^|\n)\s*(?:#{1,6}\s*)?(?:自检报告|程序语言扫描|评分表|返修约束|返修协议|记忆增量|问题协议|本集结尾说明|本章结尾说明|本集说明)(?:[：:]|\s|$)/g },
  { id: "internal-routing", label: "内部路由字段", pattern: /\b(?:ruleBundle|routeRevision|authorizedCapabilities|builtinFallbackCapabilities)\b/g },
  { id: "internal-rule-name", label: "内部规则或 Skill 名称", pattern: /\[\[神思-[^\]]+\]\]|(?:^|\n)\s*(?:#{1,6}\s*)?创作理论顾问参考（内部）/g },
  { id: "nested-candidate", label: "嵌套候选标记", pattern: /【候选稿】/g },
];

const uniqueTerms = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => String(item ?? "").trim())
  .filter(Boolean)
  .slice(0, 200))];

export const PROSE_LANGUAGE_MODIFICATION_TIERS = Object.freeze([
  Object.freeze({ id: 1, label: "固定模板硬禁层", action: "按场景因果重写结构，不做同义替换" }),
  Object.freeze({ id: 2, label: "强占位语境裁决层", action: "逐条核验功能、证据与不可替代性" }),
  Object.freeze({ id: 3, label: "普通高频密度控制层", action: "按配额和局部堆叠调整，不机械禁词" }),
]);

const CONTROLLED_LANGUAGE_FAMILIES = Object.freeze([
  { id: "no-immediate", tier: 2, label: "延迟反应占位", terms: ["没有立刻"], quota: 0, ceiling: 1, alwaysReview: true },
  { id: "negative-no", tier: 3, label: "否定占位", terms: ["没有"], quota: 4, ceiling: 8 },
  { id: "negative-not", tier: 2, label: "否定与重定义", terms: ["不是"], quota: 1, ceiling: 3, alwaysReview: true },
  { id: "weakening", tier: 3, label: "弱化解释", terms: ["只是"], quota: 1, ceiling: 3 },
  { id: "gaze", tier: 3, label: "视线反应占位", terms: ["又看了一眼", "看了一眼", "看着"], quota: 2, ceiling: 4, termCeilings: { "又看了一眼": 1 } },
  { id: "fast", tier: 3, label: "急速副词", terms: ["立刻", "马上", "迅速"], quota: 1, ceiling: 3 },
  { id: "gradual", tier: 3, label: "缓速副词", terms: ["一点点", "慢慢", "缓缓"], quota: 1, ceiling: 3 },
  { id: "sudden", tier: 3, label: "突发副词", terms: ["猛地", "忽然", "突然", "骤然"], quota: 2, ceiling: 4 },
  { id: "silence", tier: 3, label: "沉默反应占位", terms: ["沉默"], quota: 1, ceiling: 2 },
  { id: "instinct", tier: 2, label: "本能反应占位", terms: ["第一反应", "下意识", "本能地"], quota: 0, ceiling: 1, alwaysReview: true },
  { id: "meaning", tier: 2, label: "意义封口", terms: ["忽然觉得", "终于明白", "这才明白", "这句话", "真正", "他知道", "她知道"], quota: 0, ceiling: 2, alwaysReview: true, perTermCeiling: 1 },
  { id: "sequence", tier: 3, label: "时序指针", terms: ["这一次", "第一次"], quota: 1, ceiling: 3 },
]);

const CONTROLLED_PATTERN_FAMILIES = Object.freeze([
  {
    id: "negative-redefinition",
    tier: 2,
    label: "否定后重定义句式",
    pattern: /(?:不是(?:因为)?[^。！？\r\n]{0,40}(?:而是|是)|不像[^。！？\r\n]{0,36}更像|不只是[^。！？\r\n]{0,36}(?:也是|还是|更是))/gu,
    quota: 0,
    ceiling: 1,
    alwaysReview: true,
  },
  {
    id: "decorative-negative-triad",
    tier: 2,
    label: "装饰性否定三连",
    pattern: /没有[^。！？\r\n]{0,28}[，,、；;][^。！？\r\n]{0,16}没有[^。！？\r\n]{0,28}[，,、；;][^。！？\r\n]{0,16}没有/gu,
    quota: 0,
    ceiling: 1,
    alwaysReview: true,
  },
]);

const FIXED_TEMPLATE_PATTERNS = Object.freeze([
  { id: "legacy-no-immediate-template", tier: 1, label: "已坍缩的‘没有立刻’固定模板", pattern: /(?:事情|现场|房间|走廊|空气|人群)没有立刻(?:结束|安静|恢复|散去)/gu },
  { id: "legacy-real-not-template", tier: 1, label: "已坍缩的‘真正……不是……而是’固定模板", pattern: /真正的[^，。！？\r\n]{1,18}(?:[，,]\s*)?(?:从来)?不是[^。！？\r\n]{1,48}(?:而是|是)[^。！？\r\n]{1,56}/gu },
  { id: "legacy-finally-understood-template", tier: 1, label: "已坍缩的‘终于明白……从来不是’固定模板", pattern: /[^。！？\r\n]{1,16}终于明白[，,]?自己要面对的从来不是[^。！？\r\n]{1,72}/gu },
  { id: "legacy-disguise-template", tier: 1, label: "已坍缩的‘披着外衣’解释模板", pattern: /[^，。！？\r\n]{1,20}最狡猾的地方[，,]?是(?:它|他|她)?总披着[^。！？\r\n]{1,28}的外衣/gu },
  { id: "legacy-isolated-encounter-template", tier: 1, label: "已坍缩的孤立遭遇模板", pattern: /这不是孤立的一次遭遇/gu },
  { id: "legacy-facing-not-only-template", tier: 1, label: "已坍缩的‘摆在面前的不只是’模板", pattern: /此刻摆在[^，。！？\r\n]{1,24}面前的[，,]?不只是[^。！？\r\n]{1,48}(?:也是|更是)/gu },
  { id: "legacy-look-at-people-template", tier: 1, label: "已坍缩的‘先看人’模板", pattern: /先看人[。！!]看谁/gu },
  { id: "legacy-words-spoken-template", tier: 1, label: "已坍缩的‘有些话一旦说出口’模板", pattern: /有些话一旦说出口/gu },
  { id: "legacy-more-than-ever-template", tier: 1, label: "已坍缩的‘比任何时候都’模板", pattern: /[^，。！？\r\n]{1,16}现在比任何时候都/gu },
  { id: "legacy-next-time-template", tier: 1, label: "已坍缩的‘下一次比这一次更’模板", pattern: /下一次[^。！？\r\n]{0,36}比这一次更/gu },
]);

const TEMPORAL_NAVIGATION_PATTERN = /次日|翌日|第[二三四五六七八九十百千万两\d]+天|当天|当晚|随后|之后|后来|不久后|片刻后|半晌后|没过多久|转眼(?:间)?|与此同时|同一时间|此时|这时|那时|到了(?:清晨|早上|上午|中午|下午|傍晚|黄昏|晚上|深夜|午夜)|(?:子夜|夜半|更深|三更|四更|五更|鸡鸣|平旦|日出|食时|隅中|日中|日昳|晡时|日入|人定)(?:前|后|过后)?|[零〇一二三四五六七八九十百千万两\d]+(?:秒|分钟|小时|天|日|周|月|年)后/gu;
const PRECISE_TIME_ANCHOR_PATTERN = /(?:(?:凌晨|清晨|早上|上午|中午|下午|傍晚|黄昏|晚上|夜里|深夜|午夜|黎明)\s*)?(?:[零〇一二三四五六七八九十两\d]{1,4}(?:点(?:半|[零〇一二三四五六七八九十两\d]{1,3}分)?|时(?:[零〇一二三四五六七八九十两\d]{1,3}分)?)|(?:[01]?\d|2[0-3])[:：][0-5]\d)|[零〇一二三四五六七八九十百千万两\d]{2,4}年[零〇一二三四五六七八九十两\d]{1,3}月[零〇一二三四五六七八九十两\d]{1,3}日/gu;
const TEMPORAL_PARAGRAPH_START_PATTERN = /^(?:次日|翌日|第[二三四五六七八九十百千万两\d]+天|当天|当晚|随后|之后|后来|不久后|片刻后|半晌后|没过多久|转眼(?:间)?|与此同时|同一时间|此时|这时|那时|到了(?:清晨|早上|上午|中午|下午|傍晚|黄昏|晚上|深夜|午夜)|(?:凌晨|清晨|早上|上午|中午|下午|傍晚|黄昏|晚上|夜里|深夜|午夜|黎明)(?:[零〇一二三四五六七八九十两\d点时分半刻]+)?|(?:子夜|夜半|更深|三更|四更|五更|鸡鸣|平旦|日出|食时|隅中|日中|日昳|晡时|日入|人定)(?:前|后|过后)?|[零〇一二三四五六七八九十百千万两\d]+(?:秒|分钟|小时|天|日|周|月|年)后)(?:[，,。；;：:]|\s)/u;
const CAUSAL_TIME_FUNCTION_PATTERN = /倒计时|(?:只剩|还剩|不足).{0,12}(?:秒|分钟|小时|天|日|周|月|年|刻钟)|截止|期限|限时|来不及|迟到|错过|最后期限|必须.{0,10}(?:前|内|赶到)|不得.{0,10}(?:晚于|超过)|(?:不在场|证词).{0,12}(?:时间|时段|日期|记录|证明|核对|冲突)|(?:时间|时刻|日期|时段|顺序).{0,12}(?:证词|不在场|记录|证明|核对|冲突)|(?:死亡|案发).{0,4}时间|(?:钟|表|时钟|屏幕|记录|票据|监控).{0,10}(?:停在|定格|显示|写着|标着).{0,10}(?:点|时|[:：])|(?:后|前|内).{0,14}(?:将|即将|就会|会在|必须|不得|开始|结束|失效|爆炸|处决|封锁|开启|关闭|发车|起飞|手术|交付)/u;
const TEMPORAL_OPENING_LEAD_PATTERN = /^(?:(?:凌晨|清晨|早晨|上午|中午|下午|傍晚|黄昏|夜里|晚上|深夜|午夜|黎明|拂晓)(?:[零〇一二三四五六七八九十两\d点时分半刻]+)?|(?:子夜|夜半|更深|三更|四更|五更|鸡鸣|平旦|日出|食时|隅中|日中|日昳|晡时|日入|人定)(?:前|后|过后)?|(?:[01]?\d|2[0-3])[:：][0-5]\d|[^，。！？!?\n]{2,52}(?:之时|的时候|之际|时))[，,]/u;
const GENERIC_TEMPORAL_OPENING_BODY_PATTERN = /(?:一片|格外|十分|显得|渐渐|已经|依旧|仍旧)?(?:寂静|安静|宁静|漆黑|空荡|空无一人|万籁俱寂|夜深人静)|(?:太阳|阳光|晨光|暮色|夜幕).{0,10}(?:升起|落下|洒下|照进|降临|笼罩)/u;

const sentenceAround = (source, index, length) => {
  const before = source.slice(0, index);
  const after = source.slice(index + length);
  const start = Math.max(before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"), before.lastIndexOf("\n")) + 1;
  const endings = [after.indexOf("。"), after.indexOf("！"), after.indexOf("？"), after.indexOf("\n")].filter((value) => value >= 0);
  const end = endings.length ? index + length + Math.min(...endings) + 1 : Math.min(source.length, index + length + 72);
  return source.slice(start, end).replace(/\s+/gu, " ").trim();
};

const temporalNarrationLimits = (chineseCharacters) => {
  if (chineseCharacters <= 1200) return { quota: 0, ceiling: 1 };
  if (chineseCharacters <= 5000) return { quota: 1, ceiling: 2 };
  const quota = Math.max(1, Math.ceil(chineseCharacters / 3500));
  return { quota, ceiling: quota + 1 };
};

const temporalNarrationScan = (proseSource, chineseCharacters, excerptSource = proseSource) => {
  const source = String(proseSource || "");
  TEMPORAL_NAVIGATION_PATTERN.lastIndex = 0;
  PRECISE_TIME_ANCHOR_PATTERN.lastIndex = 0;
  const raw = [
    ...[...source.matchAll(TEMPORAL_NAVIGATION_PATTERN)].map((match) => ({
      index: match.index ?? 0,
      length: match[0].length,
      term: match[0],
      kind: "navigation",
    })),
    ...[...source.matchAll(PRECISE_TIME_ANCHOR_PATTERN)].map((match) => ({
      index: match.index ?? 0,
      length: match[0].length,
      term: match[0],
      kind: "precise",
    })),
  ].sort((left, right) => left.index - right.index || right.length - left.length);
  const nonOverlapping = [];
  for (const item of raw) {
    if (nonOverlapping.some((existing) => item.index < existing.index + existing.length && existing.index < item.index + item.length)) continue;
    const sentence = sentenceAround(source, item.index, item.length);
    nonOverlapping.push({
      ...item,
      excerpt: excerptAround(excerptSource, item.index, item.length),
      sentence,
      causal: CAUSAL_TIME_FUNCTION_PATTERN.test(sentence),
    });
  }
  const nonCausal = nonOverlapping.filter((item) => !item.causal);
  const limits = temporalNarrationLimits(chineseCharacters);
  const paragraphs = source.split(/\r?\n\s*\r?\n/u).map((text) => text.trim()).filter(Boolean);
  const paragraphStarts = paragraphs.map((text, index) => ({
    index,
    text: text.slice(0, 100),
    temporal: TEMPORAL_PARAGRAPH_START_PATTERN.test(text),
    causal: CAUSAL_TIME_FUNCTION_PATTERN.test(text.slice(0, 180)),
  }));
  let longestTimeLedRun = 0;
  let currentRun = 0;
  for (const paragraph of paragraphStarts) {
    currentRun = paragraph.temporal && !paragraph.causal ? currentRun + 1 : 0;
    longestTimeLedRun = Math.max(longestTimeLedRun, currentRun);
  }
  const violations = [];
  if (nonCausal.length > limits.ceiling) violations.push({
    id: "timeline-navigation-density",
    tier: 2,
    label: "流水账式时间导航",
    count: nonCausal.length,
    ceiling: limits.ceiling,
    message: `非因果性时间锚点共 ${nonCausal.length} 处，超过当前篇幅条件上限 ${limits.ceiling} 处`,
  });
  if (longestTimeLedRun >= 2) violations.push({
    id: "consecutive-time-led-paragraphs",
    tier: 1,
    label: "连续时间词领起段落",
    count: longestTimeLedRun,
    ceiling: 1,
    message: `连续 ${longestTimeLedRun} 个段落由时间词领起，叙事已退化为时间线播报`,
  });
  const requiresReview = nonCausal.length > limits.quota;
  return {
    occurrences: nonOverlapping.map((item) => ({
      ...item,
      familyId: item.kind === "precise" ? "precise-time-anchor" : "timeline-navigation",
      familyLabel: item.kind === "precise" ? "精确时间锚点" : "时序导航锚点",
      tier: 2,
      requiresReview: !item.causal && requiresReview,
    })),
    paragraphStarts,
    nonCausalCount: nonCausal.length,
    causalCount: nonOverlapping.length - nonCausal.length,
    longestTimeLedRun,
    quota: limits.quota,
    ceiling: limits.ceiling,
    violations,
  };
};

const OPENING_CONTROLLED_TERMS = Object.freeze([...new Set(CONTROLLED_LANGUAGE_FAMILIES
  .flatMap(({ terms }) => terms))].sort((left, right) => right.length - left.length));
const CONTROLLED_TERM_TIERS = new Map(CONTROLLED_LANGUAGE_FAMILIES
  .flatMap((family) => family.terms.map((term) => [term, family.tier])));

const isProseMetadataLine = (line) => !line
  || /^#{1,6}\s/u.test(line)
  || /^(?:【(?:候选稿|正文)】|[-*_]{3,})$/u.test(line)
  || /^第[零〇一二三四五六七八九十百千万两\d]+章(?:\s|　|$)/u.test(line)
  || /^【?第[零〇一二三四五六七八九十百千万两\d]+集(?:[^】\r\n]*)】?$/u.test(line)
  || /^\d+(?:-\d+){1,2}[\s　]+(?:日|夜|晨|昏|内|外|室内|室外)(?:[\s　]|$)/u.test(line)
  || /^(?:场景|时间|地点|出场人物|人物)[：:][^。！？!?]*$/u.test(line);

const maskProseMetadataLines = (value) => String(value ?? "")
  .split(/(\r?\n)/u)
  .map((part) => /\r?\n/u.test(part) || !isProseMetadataLine(part.trim()) ? part : part.replace(/[^\r\n]/gu, " "))
  .join("");

const firstNovelProseLocation = (value) => {
  const source = String(value ?? "");
  const linePattern = /.*(?:\r?\n|$)/gu;
  for (const match of source.matchAll(linePattern)) {
    const raw = match[0].replace(/\r?\n$/u, "");
    const trimmed = raw.trim();
    if (isProseMetadataLine(trimmed)) continue;
    const leading = raw.indexOf(trimmed);
    return { line: trimmed, index: (match.index ?? 0) + Math.max(0, leading) };
  }
  return { line: "", index: -1 };
};

const openingProseWindow = (value) => {
  const source = String(value ?? "");
  const first = firstNovelProseLocation(source);
  if (first.index < 0) return { index: -1, text: "", chineseCharacters: 0 };
  const prose = source.slice(first.index);
  let sentenceCount = 0;
  let thirdSentenceEnd = 0;
  for (let index = 0; index < prose.length; index += 1) {
    if (!/[。！？!?]/u.test(prose[index])) continue;
    sentenceCount += 1;
    if (sentenceCount === 3) {
      thirdSentenceEnd = index + 1;
      break;
    }
  }
  let chineseCharacters = 0;
  let hanLimitEnd = prose.length;
  for (let index = 0; index < prose.length; index += 1) {
    if (!/\p{Script=Han}/u.test(prose[index])) continue;
    chineseCharacters += 1;
    if (chineseCharacters === 150) {
      hanLimitEnd = index + 1;
      break;
    }
  }
  const fallbackSentenceEnd = thirdSentenceEnd || Math.min(prose.length, Math.max(hanLimitEnd, 240));
  const end = Math.max(fallbackSentenceEnd, hanLimitEnd);
  const text = prose.slice(0, end);
  return { index: first.index, text, chineseCharacters: (text.match(/\p{Script=Han}/gu) ?? []).length };
};

const classifyTemporalOpening = (value) => {
  const source = String(value ?? "");
  const first = firstNovelProseLocation(source);
  if (!first.line) return null;
  const match = first.line.match(TEMPORAL_OPENING_LEAD_PATTERN);
  if (!match) return null;
  const firstSentence = first.line.split(/[。！？!?]/u, 1)[0];
  const body = firstSentence.slice(match[0].length).trim();
  const causal = CAUSAL_TIME_FUNCTION_PATTERN.test(firstSentence);
  const formulaic = !causal && GENERIC_TEMPORAL_OPENING_BODY_PATTERN.test(body);
  return {
    category: causal ? "causal" : formulaic ? "formulaic" : "contextual",
    term: match[0],
    length: match[0].length,
    index: first.index,
    excerpt: first.line.slice(0, 96),
    body,
  };
};

const nonOverlappingLiteralOccurrences = (source, terms) => {
  const candidates = terms.flatMap((term) => literalOccurrences(source, term)
    .map((occurrence) => ({ ...occurrence, length: term.length })))
    .sort((left, right) => left.index - right.index || right.length - left.length);
  const accepted = [];
  for (const candidate of candidates) {
    if (accepted.some((item) => candidate.index < item.index + item.length && item.index < candidate.index + candidate.length)) continue;
    accepted.push(candidate);
  }
  return accepted;
};

const scaledLanguageLimits = ({ quota, ceiling }, chineseCharacters) => {
  let factor = 1;
  if (chineseCharacters <= 1200) factor = 0.5;
  else if (chineseCharacters <= 3200) factor = 1;
  else if (chineseCharacters <= 5000) factor = 1.5;
  else factor = Math.ceil(chineseCharacters / 2500);
  return {
    quota: quota === 0 ? 0 : Math.floor(quota * factor),
    ceiling: Math.max(1, Math.floor(ceiling * factor)),
    factor,
  };
};

const rollingHanWindows = (source, size = 2500) => {
  const windows = [];
  let start = 0;
  let hanCount = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (!/\p{Script=Han}/u.test(source[index])) continue;
    hanCount += 1;
    if (hanCount < size) continue;
    windows.push({ start, end: index + 1 });
    start = index + 1;
    hanCount = 0;
  }
  if (start < source.length) windows.push({ start, end: source.length });
  return windows;
};

const patternOccurrences = (source, rule, excerptSource = source) => {
  rule.pattern.lastIndex = 0;
  return [...source.matchAll(rule.pattern)].map((match) => ({
    index: match.index ?? 0,
    length: match[0].length,
    term: match[0],
    excerpt: excerptAround(excerptSource, match.index ?? 0, match[0].length),
  }));
};

const repeatedParagraphViolations = (source) => {
  const seen = new Map();
  const violations = [];
  let searchFrom = 0;
  for (const paragraph of source.split(/\r?\n\s*\r?\n/u)) {
    const trimmed = paragraph.trim();
    const index = source.indexOf(trimmed, searchFrom);
    if (index >= 0) searchFrom = index + trimmed.length;
    const normalized = trimmed.replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "");
    const hanCount = (normalized.match(/\p{Script=Han}/gu) ?? []).length;
    if (hanCount < 40) continue;
    if (!seen.has(normalized)) {
      seen.set(normalized, index);
      continue;
    }
    violations.push({
      id: "intra-document-paragraph-reuse",
      tier: 1,
      label: "同篇重复长段落",
      term: trimmed.slice(0, 48),
      index: Math.max(0, index),
      excerpt: excerptAround(source, Math.max(0, index), Math.min(trimmed.length, 96), 24),
      firstIndex: seen.get(normalized),
    });
  }
  return violations;
};

const normalizedTemplateText = (value) => String(value ?? "")
  .replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, "")
  .toLowerCase();

const proseParagraphUnits = (value) => String(value ?? "")
  .split(/\r?\n\s*\r?\n/u)
  .map((text) => text.split(/\r?\n/u).filter((line) => !isProseMetadataLine(line.trim())).join("\n").trim())
  .map((text) => ({ text, normalized: normalizedTemplateText(text) }))
  .filter(({ text, normalized }) => text && (normalized.match(/\p{Script=Han}/gu) ?? []).length >= 20);

const characterNgrams = (value, size = 3) => {
  const grams = new Set();
  for (let index = 0; index + size <= value.length; index += 1) grams.add(value.slice(index, index + size));
  return grams;
};

const diceSimilarity = (left, right) => {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftGrams = characterNgrams(left);
  const rightGrams = characterNgrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let shared = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) shared += 1;
  return (2 * shared) / (leftGrams.size + rightGrams.size);
};

const commonPrefixLength = (left, right) => {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
};

const crossDocumentReuseViolations = (source, referenceTexts = []) => {
  const references = uniqueTerms(referenceTexts).slice(-30);
  if (!source || !references.length) return [];
  const candidateParagraphs = proseParagraphUnits(source);
  const paragraphReferences = references.slice(-20);
  const referenceParagraphs = paragraphReferences.flatMap((text, referenceIndex) => proseParagraphUnits(text)
    .map((paragraph) => ({ ...paragraph, referenceIndex })));
  const violations = [];
  const seenCandidateParagraphs = new Set();
  for (const paragraph of candidateParagraphs) {
    if (seenCandidateParagraphs.has(paragraph.normalized)) continue;
    seenCandidateParagraphs.add(paragraph.normalized);
    const hanCount = (paragraph.normalized.match(/\p{Script=Han}/gu) ?? []).length;
    const exact = referenceParagraphs.find((reference) => reference.normalized === paragraph.normalized);
    if (exact) {
      violations.push({
        id: "cross-document-exact-paragraph-reuse",
        tier: 1,
        label: "跨篇精确段落复用",
        term: paragraph.text.slice(0, 56),
        index: Math.max(0, source.indexOf(paragraph.text)),
        excerpt: paragraph.text.slice(0, 120),
        referenceIndex: exact.referenceIndex,
        similarity: 1,
      });
      continue;
    }
    if (hanCount < 40) continue;
    let nearest = null;
    for (const reference of referenceParagraphs) {
      const ratio = Math.min(paragraph.normalized.length, reference.normalized.length) / Math.max(paragraph.normalized.length, reference.normalized.length);
      if (ratio < 0.72) continue;
      const similarity = diceSimilarity(paragraph.normalized, reference.normalized);
      if (similarity < 0.82 || similarity <= (nearest?.similarity ?? 0)) continue;
      nearest = { reference, similarity };
    }
    if (nearest) violations.push({
      id: "cross-document-near-paragraph-reuse",
      tier: 1,
      label: "跨篇近似段落骨架复用",
      term: paragraph.text.slice(0, 56),
      index: Math.max(0, source.indexOf(paragraph.text)),
      excerpt: paragraph.text.slice(0, 120),
      referenceIndex: nearest.reference.referenceIndex,
      similarity: Number(nearest.similarity.toFixed(3)),
    });
  }

  const candidateOpening = normalizedTemplateText(openingProseWindow(source).text);
  if (candidateOpening) {
    references.forEach((reference, referenceIndex) => {
      const referenceOpening = normalizedTemplateText(openingProseWindow(reference).text);
      if (!referenceOpening) return;
      const prefixLength = commonPrefixLength(candidateOpening, referenceOpening);
      const similarity = diceSimilarity(candidateOpening, referenceOpening);
      if (prefixLength < 12 && similarity < 0.75) return;
      violations.push({
        id: "cross-document-opening-reuse",
        tier: 1,
        label: "跨篇开头模板复用",
        term: openingProseWindow(source).text.replace(/\s+/gu, " ").trim().slice(0, 56),
        index: openingProseWindow(source).index,
        excerpt: openingProseWindow(source).text.replace(/\s+/gu, " ").trim().slice(0, 120),
        referenceIndex,
        similarity: Number(similarity.toFixed(3)),
        sharedPrefixCharacters: prefixLength,
      });
    });
  }
  return violations.slice(0, 20);
};

const mergeControlledOccurrences = (items) => {
  const sorted = [...items].sort((left, right) => left.index - right.index || right.length - left.length);
  const merged = [];
  for (const item of sorted) {
    const overlap = merged.find((existing) => item.index < existing.index + existing.length && existing.index < item.index + item.length);
    if (overlap) {
      overlap.relatedFamilies = [...new Set([...overlap.relatedFamilies, item.familyId])];
      overlap.tier = Math.min(overlap.tier ?? 3, item.tier ?? 3);
      overlap.requiresReview ||= item.requiresReview;
      continue;
    }
    merged.push({ ...item, relatedFamilies: [item.familyId] });
  }
  return merged;
};

export const scanNovelLanguage = (value, { absoluteTerms = [], referenceTexts = [] } = {}) => {
  const source = String(value ?? "");
  const proseSource = maskProseMetadataLines(source);
  const chineseCharacters = (proseSource.match(/\p{Script=Han}/gu) ?? []).length;
  const absoluteViolations = [];
  for (const rule of [...ABSOLUTE_PATTERNS, ...FIXED_TEMPLATE_PATTERNS]) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      absoluteViolations.push({
        id: rule.id,
        tier: rule.tier ?? 1,
        label: rule.label,
        term: match[0],
        index: match.index ?? 0,
        excerpt: excerptAround(source, match.index ?? 0, match[0].length),
      });
    }
  }
  absoluteViolations.push(...repeatedParagraphViolations(source));
  const reuseViolations = crossDocumentReuseViolations(source, referenceTexts);
  absoluteViolations.push(...reuseViolations);

  const openingWindow = openingProseWindow(source);
  const temporalOpening = classifyTemporalOpening(source);
  if (temporalOpening?.category === "formulaic") absoluteViolations.push({
    ...temporalOpening,
    id: "formulaic-temporal-opening",
    tier: 1,
    label: "可替换、无叙事功能的模板报时开头",
  });
  if (openingWindow.index >= 0) {
    for (const occurrence of nonOverlappingLiteralOccurrences(openingWindow.text, OPENING_CONTROLLED_TERMS)) {
      absoluteViolations.push({
        ...occurrence,
        id: `opening-controlled:${occurrence.term}`,
        tier: 1,
        sourceTier: CONTROLLED_TERM_TIERS.get(occurrence.term) ?? 3,
        label: "开头窗口绝对禁用的高频表达",
        index: openingWindow.index + occurrence.index,
        excerpt: excerptAround(source, openingWindow.index + occurrence.index, occurrence.term.length),
      });
    }
  }
  for (const term of uniqueTerms(absoluteTerms)) {
    for (const occurrence of literalOccurrences(source, term)) {
      absoluteViolations.push({ ...occurrence, id: `project:${term}`, tier: 1, label: "项目绝对禁用词" });
    }
  }

  const frequencySummary = [];
  const frequencyViolations = [];
  const controlledItems = [];
  if (temporalOpening?.category === "contextual") controlledItems.push({
    ...temporalOpening,
    familyId: "temporal-opening",
    familyLabel: "叙事性时间开场",
    tier: 2,
    requiresReview: true,
  });
  const temporalNarration = temporalNarrationScan(proseSource, chineseCharacters, source);
  frequencySummary.push({
    id: "timeline-navigation",
    tier: 2,
    label: "非因果性时间导航",
    count: temporalNarration.nonCausalCount,
    quota: temporalNarration.quota,
    ceiling: temporalNarration.ceiling,
    terms: [],
    status: temporalNarration.nonCausalCount > temporalNarration.ceiling
      ? "blocked"
      : temporalNarration.nonCausalCount > temporalNarration.quota ? "review" : "within_quota",
  });
  frequencyViolations.push(...temporalNarration.violations);
  controlledItems.push(...temporalNarration.occurrences);
  const longFormWindows = chineseCharacters > 5000 ? rollingHanWindows(proseSource) : [];
  for (const family of CONTROLLED_LANGUAGE_FAMILIES) {
    const occurrences = nonOverlappingLiteralOccurrences(proseSource, family.terms)
      .map((occurrence) => ({ ...occurrence, excerpt: excerptAround(source, occurrence.index, occurrence.term.length) }));
    const limits = scaledLanguageLimits(family, chineseCharacters);
    const requiresFamilyReview = family.alwaysReview === true || family.quota === 0 || occurrences.length > limits.quota;
    frequencySummary.push({
      id: family.id,
      tier: family.tier,
      label: family.label,
      count: occurrences.length,
      quota: limits.quota,
      ceiling: limits.ceiling,
      terms: family.terms,
      status: occurrences.length > limits.ceiling ? "blocked" : occurrences.length > limits.quota ? "review" : "within_quota",
    });
    if (occurrences.length > limits.ceiling) {
      frequencyViolations.push({
        id: family.id,
        tier: family.tier,
        label: family.label,
        count: occurrences.length,
        ceiling: limits.ceiling,
        message: `${family.label}共 ${occurrences.length} 处，超过当前篇幅条件上限 ${limits.ceiling} 处`,
      });
    }
    if (longFormWindows.length) {
      const windowLimits = scaledLanguageLimits(family, 2500);
      longFormWindows.forEach((window, windowIndex) => {
        const count = occurrences.filter(({ index }) => index >= window.start && index < window.end).length;
        if (count <= windowLimits.ceiling) return;
        frequencyViolations.push({
          id: `${family.id}:window-${windowIndex + 1}`,
          tier: family.tier,
          label: `${family.label}滚动窗口`,
          count,
          ceiling: windowLimits.ceiling,
          message: `${family.label}在第 ${windowIndex + 1} 个 2500 汉字窗口出现 ${count} 处，超过条件上限 ${windowLimits.ceiling} 处`,
        });
      });
    }
    for (const [term, limit] of Object.entries(family.termCeilings ?? {})) {
      const count = literalOccurrences(proseSource, term).length;
      const scaledLimit = Math.max(1, Math.floor(limit * limits.factor));
      if (count > scaledLimit) frequencyViolations.push({
        id: `${family.id}:${term}`,
        tier: family.tier,
        label: `${family.label}中的“${term}”`,
        count,
        ceiling: scaledLimit,
        message: `“${term}”共 ${count} 处，超过当前篇幅条件上限 ${scaledLimit} 处`,
      });
    }
    if (family.perTermCeiling) {
      for (const term of family.terms) {
        const count = literalOccurrences(proseSource, term).length;
        const scaledLimit = Math.max(1, Math.floor(family.perTermCeiling * limits.factor));
        if (count > scaledLimit) frequencyViolations.push({
          id: `${family.id}:${term}`,
          tier: family.tier,
          label: `${family.label}中的“${term}”`,
          count,
          ceiling: scaledLimit,
          message: `“${term}”共 ${count} 处，超过当前篇幅单词条件上限 ${scaledLimit} 处`,
        });
      }
    }
    controlledItems.push(...occurrences.map((occurrence) => ({
      ...occurrence,
      familyId: family.id,
      familyLabel: family.label,
      tier: family.tier,
      requiresReview: requiresFamilyReview,
    })));
  }

  for (const family of CONTROLLED_PATTERN_FAMILIES) {
    const occurrences = patternOccurrences(proseSource, family, source);
    const limits = scaledLanguageLimits(family, chineseCharacters);
    frequencySummary.push({
      id: family.id,
      tier: family.tier,
      label: family.label,
      count: occurrences.length,
      quota: limits.quota,
      ceiling: limits.ceiling,
      terms: [],
      status: occurrences.length > limits.ceiling ? "blocked" : occurrences.length > limits.quota ? "review" : "within_quota",
    });
    if (occurrences.length > limits.ceiling) frequencyViolations.push({
      id: family.id,
      tier: family.tier,
      label: family.label,
      count: occurrences.length,
      ceiling: limits.ceiling,
      message: `${family.label}共 ${occurrences.length} 处，超过当前篇幅条件上限 ${limits.ceiling} 处`,
    });
    if (longFormWindows.length) {
      const windowLimits = scaledLanguageLimits(family, 2500);
      longFormWindows.forEach((window, windowIndex) => {
        const count = occurrences.filter(({ index }) => index >= window.start && index < window.end).length;
        if (count <= windowLimits.ceiling) return;
        frequencyViolations.push({
          id: `${family.id}:window-${windowIndex + 1}`,
          tier: family.tier,
          label: `${family.label}滚动窗口`,
          count,
          ceiling: windowLimits.ceiling,
          message: `${family.label}在第 ${windowIndex + 1} 个 2500 汉字窗口出现 ${count} 处，超过条件上限 ${windowLimits.ceiling} 处`,
        });
      });
    }
    controlledItems.push(...occurrences.map((occurrence) => ({
      ...occurrence,
      familyId: family.id,
      familyLabel: family.label,
      tier: family.tier,
      requiresReview: true,
    })));
  }

  const controlledOccurrences = mergeControlledOccurrences(controlledItems)
    .map((occurrence, controlledIndex) => ({ ...occurrence, controlledIndex }));
  const contextualOccurrences = controlledOccurrences
    .filter((occurrence) => occurrence.requiresReview)
    .map((occurrence, occurrenceIndex) => ({ ...occurrence, occurrenceIndex }));
  const densityRisks = frequencySummary
    .filter(({ status }) => status !== "within_quota")
    .map(({ label, count, quota, ceiling, status }) => status === "blocked"
      ? `${label}共 ${count} 处，超过条件上限 ${ceiling} 处`
      : `${label}共 ${count} 处，超过默认配额 ${quota} 处，超额命中须逐条举证`);

  return {
    absoluteViolations,
    controlledOccurrences,
    contextualOccurrences,
    frequencySummary,
    frequencyViolations,
    reuseViolations,
    densityRisks,
    openingWindow: {
      index: openingWindow.index,
      chineseCharacters: openingWindow.chineseCharacters,
      excerpt: openingWindow.text.replace(/\s+/gu, " ").trim().slice(0, 240),
    },
    temporalOpening,
    temporalNarration,
    requiresContextReview: contextualOccurrences.length > 0,
  };
};

export const languageReviewCoversOccurrences = (review, scan) => {
  const decisions = Array.isArray(review?.decisions) ? review.decisions : [];
  const required = scan?.contextualOccurrences?.length ?? 0;
  if (!required) return true;
  if (review?.pass !== true || decisions.length < required) return false;
  return scan.contextualOccurrences.every(({ occurrenceIndex }) => {
    const decision = decisions.find((item) => Number(item?.occurrenceIndex) === occurrenceIndex);
    const reason = String(decision?.reason ?? "").trim();
    const functionLabel = String(decision?.function || reason).trim();
    const evidence = String(decision?.evidence || reason).trim();
    return decision?.allowed === true && reason.length >= 4 && functionLabel.length >= 2 && evidence.length >= 4;
  });
};

export const blockingLanguageIssues = ({ scan, review = null } = {}) => {
  const issues = (scan?.absoluteViolations ?? []).map(({ label, term, excerpt }) => `${label}“${term}”：${excerpt}`);
  issues.push(...(scan?.frequencyViolations ?? []).map(({ message }) => message));
  if (!languageReviewCoversOccurrences(review, scan)) issues.push("受控高频表达存在未完成或未通过的逐条语境裁决");
  return issues;
};

export const scanInternalArtifactLeakage = (value = "") => {
  const source = String(value ?? "");
  const violations = [];
  for (const rule of INTERNAL_ARTIFACT_PATTERNS) {
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      violations.push({
        id: rule.id,
        label: rule.label,
        term: match[0].trim(),
        index: match.index ?? 0,
        excerpt: excerptAround(source, match.index ?? 0, match[0].length, 56),
      });
    }
  }
  return {
    pass: violations.length === 0,
    violations,
    issues: violations.map(({ label, term, excerpt }) => `${label}“${term}”：${excerpt}`).slice(0, 12),
  };
};
