const CHINESE_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CHINESE_UNITS = { 十: 10, 百: 100, 千: 1000 };

export const chapterNumberValue = (value = "") => {
  const source = String(value).trim();
  if (/^\d+$/.test(source)) return Number(source);
  let total = 0;
  let current = 0;
  for (const character of source) {
    if (character in CHINESE_DIGITS) {
      current = CHINESE_DIGITS[character];
      continue;
    }
    const unit = CHINESE_UNITS[character];
    if (!unit) return 0;
    total += (current || 1) * unit;
    current = 0;
  }
  return total + current;
};

export const requestedChapterTarget = (text = "") => {
  const source = String(text);
  // Chinese-number chapter ordinals must carry 第. Without this boundary,
  // relative prose such as “下一章承接” is misread as the explicit target
  // “第一章” and can redirect a safe landing to chapter-1.
  const matches = [...source.matchAll(/第\s*(\d+|[零〇一二两三四五六七八九十百千]+)\s*章|(?<!\d)(\d+)\s*章/g)];
  if (!matches.length) return null;
  const ranked = matches.map((match, order) => {
    const index = Number(match.index) || 0;
    const prefix = source.slice(Math.max(0, index - 28), index);
    const suffix = source.slice(index + match[0].length, index + match[0].length + 28);
    let score = 0;
    if (/(?:写|写出|生成|续写|创作|撰写|完成|修改|重写|改写|检查|自检|验收|审查|润色|扩写|压缩|优化)(?:出|好|完|到)?[^，。！？；]{0,10}$/u.test(prefix)) score += 12;
    if (/^(?:的)?(?:完整)?(?:正式)?正文|^(?:的)?(?:完整)?候选/u.test(suffix)) score += 5;
    if (/^(?:的)?(?:章纲|细纲|详细大纲)/u.test(suffix)) score -= 40;
    if (/(?:严格依据|依据|承接|参考|对照|已落盘|已经完成)[^，。！？；]{0,10}$/u.test(prefix)) score -= 20;
    if (/(?:第?\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*章?\s*)?(?:到|至|[-~～—])\s*$/u.test(prefix)) score -= 12;
    if (/(?:不得|不要|禁止|避免|无需|不需|不能|不许|别|不)[^，。！？；]{0,8}(?:改写|重写|修改|写|生成|覆盖|推进|涉及|展开|进入|写到|触及)[^，。！？；]{0,4}$/u.test(prefix)) score -= 30;
    return { match, order, score };
  }).sort((left, right) => right.score - left.score || right.order - left.order);
  const exactChapterLabel = /^\s*(?:第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*章|\d+\s*章)(?:\s*[《「“"][^》」”"\r\n]{1,100}[》」”"])?\s*[。.!！]?\s*$/u.test(source);
  // A bare chapter mention inside story facts (for example “第十八章才揭示”)
  // is source content, not a destination. Zero-score matches are accepted only
  // when the whole instruction is the chapter label itself; actionable chapter
  // commands already receive a positive score above.
  if (ranked[0].score < 0 || (ranked[0].score === 0 && !exactChapterLabel)) return null;
  const selected = ranked[0].match;
  const chapterNumber = chapterNumberValue(selected[1] ?? selected[2]);
  if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return null;
  const titleSuffix = source.slice((Number(selected.index) || 0) + selected[0].length);
  const quotedTitle = titleSuffix.match(/^\s*[《「“"]([^》」”"\r\n]{1,100})[》」”"]/u)?.[1]?.trim();
  return {
    chapterNumber,
    documentId: `chapter-${chapterNumber}`,
    ...(quotedTitle ? { chapterTitle: quotedTitle } : {}),
  };
};

export const explicitlyRequestsBoundDocument = ({ text = "", boundDocumentId = "", boundDocumentTitle = "" } = {}) => {
  const source = String(text);
  const title = String(boundDocumentTitle).trim();
  const normalizedChapterOrdinal = (value) => String(value).replace(/第\s*0*(\d+)\s*章/g, (_, number) => `第${Number(number)}章`);
  return Boolean(boundDocumentId && (
    (title && source.includes(title))
    || (title && normalizedChapterOrdinal(source).includes(normalizedChapterOrdinal(title)))
    || /(?:(?:当前|这个|该)(?:关联|绑定|目标|打开|正在编辑)?(?:的)?(?:《[^》]+》)?(?:(?:大纲|规划)?文档|正文|章节|段落|场景|台词|剧本|内容)|本(?:文档|正文|章|章节|段|段落|场景|台词|剧本|内容))/u.test(source)
  ));
};

export const requestedChapterBatch = (text = "", { baseChapterNumber = 0, plannedEndChapter = 0 } = {}) => {
  const source = String(text);
  if (/(?:不|不要|无需|禁止|不得|别).{0,8}(?:启动|执行|创建|进入|使用)?.{0,8}(?:长篇)?(?:批量|自动|无人值守)(?:任务|生成|写作|创作)?/.test(source)) return null;
  const token = "(\\d+|[零〇一二两三四五六七八九十百千]+)";
  const firstUnnegatedMatch = (pattern) => [...source.matchAll(pattern)].find((match) => {
    const prefix = source.slice(Math.max(0, Number(match.index) - 36), Number(match.index));
    return !/(?:不|不要|无需|不得|禁止|避免|不必|别)[^，。！？；]{0,18}$/u.test(prefix)
      && !/(?:已|已经|此前|先前|现有|已有|已落盘|已完成|写完|生成完|完成的)[^，。！？；]{0,18}$/u.test(prefix);
  });
  const openingCount = firstUnnegatedMatch(new RegExp(`(?:前|开头|开篇)\\s*${token}\\s*[章张]`, "g"));
  const openingChapterCount = chapterNumberValue(openingCount?.[1]);
  if (openingChapterCount > 1 && openingChapterCount <= 500) {
    return { startChapter: 1, endChapter: openingChapterCount, count: openingChapterCount };
  }
  const range = firstUnnegatedMatch(new RegExp(`第?\\s*${token}\\s*章\\s*(?:到|至|[-~～—])\\s*第?\\s*${token}\\s*章`, "g"));
  if (range) {
    const startChapter = chapterNumberValue(range[1]);
    const endChapter = chapterNumberValue(range[2]);
    if (startChapter > 0 && endChapter >= startChapter) {
      return { startChapter, endChapter, count: endChapter - startChapter + 1 };
    }
  }
  const toTarget = firstUnnegatedMatch(new RegExp(`(?:从当前|从现在|接着|继续)?(?:逐章)?(?:写|续写|生成|创作)?\\s*(?:一直)?(?:到|至)\\s*第?\\s*${token}\\s*章`, "g"));
  const targetEndChapter = chapterNumberValue(toTarget?.[1]);
  if (targetEndChapter > 0) {
    const startChapter = Math.max(1, Number(baseChapterNumber) + 1);
    if (targetEndChapter >= startChapter) return { startChapter, endChapter: targetEndChapter, count: targetEndChapter - startChapter + 1 };
  }
  const countMatch = firstUnnegatedMatch(new RegExp(`(?:一次性|连续|连着|直接|开始|请)?(?:写|生成|创作|续写)[^第]{0,12}?${token}\\s*[章张]`, "g"));
  const count = chapterNumberValue(countMatch?.[1]);
  if (count > 1 && count <= 500) {
    const startChapter = Math.max(1, Number(baseChapterNumber) + 1);
    return { startChapter, endChapter: startChapter + count - 1, count };
  }
  const plannedCompletion = /全文自动生成|全书自动生成|按(?:现有|当前).{0,12}(?:大纲|卷纲|章纲|规划).{0,12}(?:逐章)?(?:写完|写到完本|完成)|从头到尾.{0,12}(?:逐章)?(?:写|生成|创作)|逐章.{0,12}(?:写到完本|完成全书|写完整本)/.test(source);
  const plannedEnd = Number(plannedEndChapter) || 0;
  if (plannedCompletion && plannedEnd > 0) {
    const startChapter = /从头到尾/.test(source) ? 1 : Math.max(1, Number(baseChapterNumber) + 1);
    if (plannedEnd >= startChapter) return { startChapter, endChapter: plannedEnd, count: plannedEnd - startChapter + 1, source: "planned_outline" };
  }
  return null;
};

export const batchBaseChapterNumber = ({ chapterNumber = 0, chapterText = "" } = {}) => {
  const number = Math.max(0, Number(chapterNumber) || 0);
  const text = String(chapterText).trim();
  const blank = !text || /在右侧对话中.*(?:开始填写|确定)/.test(text);
  return blank ? Math.max(0, number - 1) : number;
};

export const candidateTargetDocumentId = ({ candidateTarget, boundDocumentId, activeDocumentId }) => (
  candidateTarget?.documentId || activeDocumentId || boundDocumentId || null
);

export const stripCandidateChapterHeading = (text = "", targetTitle = "") => {
  const paragraphs = String(text).replace(/\r\n?/g, "\n").split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  if (!paragraphs.length) return "";
  const first = paragraphs[0].replace(/^#+\s*/, "").trim();
  const plainTargetTitle = String(targetTitle).replace(/^第\d+章[\s　:：·-]*/, "").trim();
  const isChapterHeading = first.length <= 60 && /^第(?:\d+|[零〇一二两三四五六七八九十百千]+)章(?:[\s　:：·-]+.+)?$/.test(first);
  const isTitleOnly = plainTargetTitle && first === plainTargetTitle;
  if (isChapterHeading || isTitleOnly) paragraphs.shift();
  return paragraphs.join("\n\n");
};

const LANDING_PATTERN = /落盘|采用这一版|写入正文|写入(?:当前|对应|目标)?(?:第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*[章节集]|文档|章节)|插入到(?:当前|对应|目标)?(?:第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*[章节集]|文档|正文|章节)|保存到(?:当前|对应|目标)?(?:第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*[章节集]|文档|章节)/g;
const NEGATED_LANDING_PATTERN = /不要|不需要|无需|暂不|先不|别|禁止|没有|无法|不能|(?:^|[，、。！？；;\s])不(?:再)?$/;
const COMPLETED_LANDING_REFERENCE = /(?:已经|已|曾经|此前|之前|刚刚|现已)\s*$/;
const GENERATION_AND_LANDING_PATTERN = /直接生成|立即生成|开始生成|生成|创作|续写|改写|重写|转换|转化|改编|替换|覆盖|修复|返修|调整|优化|压缩|扩写|微增|增补|补写|润色|精修|撰写|完成[^，。！？；\r\n]{0,16}(?:正文|文章|长文|稿件|章节|剧本)|写(?:出|完|好|第|正文|章节|本章|下一章|一篇|一章|文章|长文|稿件|剧本)/g;
const EXISTING_CANDIDATE_RECOVERY_PATTERN = /(?:恢复|取回|接回|采用|使用|沿用).{0,18}(?:刚才|刚刚|上次|上一版|已有|已经生成|已生成|已保存|安全草稿|候选稿|候选)|(?:刚才|刚刚|上次|上一版|已有|已经生成|已生成|已保存|安全草稿|候选稿|候选).{0,18}(?:恢复|取回|接回|采用|使用|沿用)/u;
const NO_REGENERATION_PATTERN = /(?:不要|不需要|无需|别|禁止|不必).{0,12}(?:重新生成|再生成|重写|改写|重新创作|返修|修复)/u;
const CANDIDATE_CHANGE_PATTERN = /修复|返修|调整|优化|压缩|扩写|微增|增补|补写|润色|精修|改写|重写/u;

const hasUnnegatedMatch = (text, pattern, negationPattern, lookbehind = 10) => {
  for (const match of text.matchAll(pattern)) {
    const prefix = text.slice(Math.max(0, match.index - lookbehind), match.index);
    if (!negationPattern.test(prefix)) return true;
  }
  return false;
};

export const isLandingRequest = (value = "") => {
  const text = String(value);
  // “落盘能力怎么改”“为什么不能写入文档”是在讨论或改造软件能力，
  // 不是要求把当前创作候选写入作品。先排除这类元任务，避免它们在
  // 到达工作区 Agent 之前被候选稿落盘处理器截走。
  if (isLocalWriteCapabilityQuestion(text)) return false;
  for (const match of text.matchAll(LANDING_PATTERN)) {
    const prefix = text.slice(Math.max(0, match.index - 10), match.index);
    if (NEGATED_LANDING_PATTERN.test(prefix) || COMPLETED_LANDING_REFERENCE.test(prefix)) continue;
    return true;
  }
  return false;
};

export const isGenerationAndLandingRequest = (value = "") => {
  const text = String(value);
  if (EXISTING_CANDIDATE_RECOVERY_PATTERN.test(text)
    && NO_REGENERATION_PATTERN.test(text)
    && !CANDIDATE_CHANGE_PATTERN.test(text.replace(NO_REGENERATION_PATTERN, ""))) return false;
  return isLandingRequest(text)
    && hasUnnegatedMatch(text, GENERATION_AND_LANDING_PATTERN, /不要|不需要|无需|暂不|先不|别|禁止|停止|取消/, 10);
};

const DEFER_CANDIDATE_LANDING_PATTERN = /(?:先|暂时|本轮|这次|当前)?\s*(?:不|不要|(?<![分个差识判类有区])别|先不|暂不|无需|不必|禁止)\s*.{0,12}(?:落盘|写入|存入|保存|替换|覆盖|修改(?:正文|文档|文件)|动(?:正文|原文|文档))|(?:只|仅)(?:要|给|生成|输出|保留|展示|查看)?\s*.{0,8}(?:候选稿|候选|预览稿)|(?:确认|审阅|查看|看完|我说|等我).{0,12}(?:后|之后|以后)?\s*(?:再|才)(?:落盘|写入|保存|替换|覆盖)|(?:保持|保留)(?:当前|原有|原来的)?(?:正文|原文|文档)(?:不变|不动)/u;
const REQUIRE_LANDING_BY_NEGATING_CHAT_ONLY_PATTERN = /(?:不要|不得|禁止|不能|不可|不允许|别)\s*(?:只|仅)\s*[^。；;\n]{0,80}?(?:而|却|但|同时|并且|，|,)?\s*(?:不|未)\s*(?:落盘|写入|存入|保存到(?:目标|对应)?(?:文档|文件)?)/gu;

export const explicitlyDefersCandidateLanding = (value = "", { outputKind = "" } = {}) => {
  const text = outputKind === "report"
    ? String(value || "").replace(/(?:不要|不得|禁止|无需|不必|先不|暂不)\s*(?:再)?(?:覆盖|替换|修改|写入|改动|动)\s*(?:当前|已有|源)?(?:正文|原文|章节)/gu, "")
    : String(value || "");
  // “新建目标文档，不得覆盖当前/源文档”是在保护 Source，不是在
  // 阻止 Target 落盘。若把这类约束当作预览请求，跨文体任务就会
  // 永远停在候选稿。只剔除明确指向 Source 的保护分句；“不要落盘”
  // “不要写入目标文档”等真正的延期指令仍由原规则识别。
  const hasSeparateTarget = /(?:新建|创建|另建|另起|新开|新增|另存).{0,32}(?:文档|文件|正文|稿件)|(?:写入|落盘到|保存到).{0,24}(?:目标|对应|新建)(?:文档|文件|目录)/u.test(text);
  const landingInstruction = (hasSeparateTarget
    ? text.replace(/(?:不得|不要|别|禁止|不可|不能)\s*.{0,8}(?:覆盖|替换|修改|写入)\s*.{0,8}(?:当前|关联|源|原)(?:文档|正文|文件|小说|剧本)/gu, "")
    : text).replace(
      /(?:不|不要|无需|不必|禁止|别|不可|不得)\s*(?:再)?\s*(?:覆盖|替换|修改|写入|改动)\s*(?:任何)?\s*(?:其他|其它|其余|非目标)(?:的)?(?:章节|文档|文件|正文|内容)/gu,
      "",
    ).replace(REQUIRE_LANDING_BY_NEGATING_CHAT_ONLY_PATTERN, "");
  return DEFER_CANDIDATE_LANDING_PATTERN.test(landingInstruction);
};

export const isLocalWriteCapabilityQuestion = (value = "") => {
  const text = String(value);
  return /(?:为什么|为何|怎么|如何|是否|能否|有没有|要怎么样|怎样).{0,24}(?:落盘|写入(?:当前|对应|目标)?(?:文档|正文)|文档(?:编辑|写入)权限|写入能力)|(?:落盘|文档写入).{0,12}(?:权限|能力|开关|模式)|切换到.{0,16}(?:写入|编辑)(?:权限|模式)/.test(text);
};
