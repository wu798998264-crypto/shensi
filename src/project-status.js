import { memoryHealth } from "./memory-health.js";

const decodeEntities = (value) => String(value)
  .replace(/&nbsp;/gi, " ")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, "&");

const textContent = (documentState = {}) => decodeEntities(String(documentState.html ?? documentState.markdown ?? "")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
  .replace(/<[^>]+>/g, ""))
  .replace(/^\s*#\s+[^\n]+/m, "")
  .replace(/\r\n?/g, "\n")
  .replace(/\s+/g, " ")
  .trim();

const sourceContent = (documentState = {}) => decodeEntities(String(documentState.markdown ?? documentState.html ?? "")
  .replace(/<br\s*\/?>(?=\s*\n|$)/gi, "\n")
  .replace(/<\/(?:p|div|li|h[1-6]|blockquote|tr)>/gi, "\n")
  .replace(/<[^>]+>/g, "")
  .replace(/\r\n?/g, "\n"));

const chineseNumber = (value = "") => {
  const source = String(value).trim();
  if (/^\d+$/.test(source)) return Number(source);
  const digits = new Map([["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4], ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9]]);
  if (source === "十") return 10;
  if (source.startsWith("十")) return 10 + (digits.get(source.slice(1)) ?? 0);
  if (source.includes("十")) {
    const [tens, ones] = source.split("十");
    return (digits.get(tens) ?? 0) * 10 + (digits.get(ones) ?? 0);
  }
  return digits.get(source) ?? 0;
};

const inlineOutlineStructure = (documentState) => {
  if (!substantive(documentState)) return { volumeCount: 0, chapterOutlineCount: 0 };
  const source = sourceContent(documentState);
  const volumes = new Set();
  const chapters = new Set();
  for (const match of source.matchAll(/^\s*(?:#{1,6}\s*)?第\s*([0-9一二三四五六七八九十百零两]+)卷(?:\s|《|〈|「|$)/gmu)) {
    const number = chineseNumber(match[1]);
    if (number > 0) volumes.add(number);
  }
  for (const match of source.matchAll(/^\s*(?:#{1,6}\s*)?第\s*([0-9一二三四五六七八九十百零两]+)章(?!至)(?:\s|《|〈|「|$)/gmu)) {
    const number = chineseNumber(match[1]);
    if (number > 0) chapters.add(number);
  }
  return { volumeCount: volumes.size, chapterOutlineCount: chapters.size };
};

const PLACEHOLDER_PATTERN = /^(?:(?:当前)?(?:尚未|暂无|等待|未建立|未开始|没有)|尚未展开|当前没有|等待确认|用于记录|在此建立|按.+承接)/;
const substantive = (documentState, minimum = 24) => {
  const text = textContent(documentState);
  return text.length >= minimum && !PLACEHOLDER_PATTERN.test(text);
};

const itemOptions = (item) => item?.[2] ?? {};
const novelItems = (items = []) => items.filter((item) => !itemOptions(item).workspaceView || itemOptions(item).workspaceView === "novel");
const scriptItems = (items = []) => items.filter((item) => itemOptions(item).workspaceView === "script");
const countSubstantive = (items, documents, minimum = 24) => items.filter(([id]) => substantive(documents[id], minimum)).length;

const settingEntryCount = (documentState) => {
  if (!substantive(documentState)) return 0;
  const source = String(documentState.html ?? documentState.markdown ?? "");
  const stableIds = [...source.matchAll(/\[(?:ENTITY|CHARACTER|LOCATION|ITEM|FACTION|CONCEPT|RULE|EVENT|STATE):([^\]]+)\]/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  if (stableIds.length) return new Set(stableIds).size;
  const htmlHeadings = [...source.matchAll(/<h[23][^>]*>/gi)].length;
  const markdownHeadings = [...source.matchAll(/^#{2,3}\s+\S+/gm)].length;
  const numberedSections = [...sourceContent(documentState).matchAll(/^\s*(?:#{1,6}\s*)?(?:[一二三四五六七八九十百零两]+|\d+)[、.．]\s*\S+/gmu)]
    .map((match) => match[0].replace(/^\s*(?:#{1,6}\s*)?/u, "").trim());
  return Math.max(new Set(numberedSections).size, htmlHeadings, markdownHeadings, 1);
};

const statusOf = (documentState, minimum = 24) => substantive(documentState, minimum) ? "已建立" : "待完善";
const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

export const projectCompilationSummary = ({ moduleItems = {}, documents = {} } = {}) => {
  const memory = memoryHealth({ moduleItems, documents });
  const outlines = novelItems(moduleItems.outline ?? []);
  const manuscript = novelItems(moduleItems.manuscript ?? []);
  const canon = novelItems(moduleItems.canon ?? []).filter(([id]) => /^canon-/.test(id));
  const series = outlines.find(([id]) => id === "outline-series");
  const inlineSeries = inlineOutlineStructure(documents[series?.[0]]);
  const volumes = outlines.filter(([id, , options = {}]) => /^outline-volume-\d+$/.test(id) || options.treeGroup === "volumes");
  const chapterOutlines = outlines.filter(([id, , options = {}]) => /^outline-chapter-\d+$/.test(id) || options.treeGroup === "chapters");
  const chapters = manuscript.filter(([id]) => /^chapter-\d+$/.test(id));
  const writtenChapters = countSubstantive(chapters, documents, 100);
  const volumeNames = new Set(chapters.map(([id, , options = {}]) => (
    options.volumeFolder || options.volumeLabel || documents[id]?.volumeFolder || documents[id]?.volumeLabel
  )).filter(Boolean));
  const completedSettingDocuments = canon.filter(([id]) => substantive(documents[id]));
  const settingEntries = completedSettingDocuments.reduce((sum, [id]) => sum + settingEntryCount(documents[id]), 0);

  const scriptOutlines = scriptItems(moduleItems.outline ?? []);
  const scriptEpisodes = scriptItems(moduleItems.manuscript ?? []).filter(([id]) => /^script-episode-\d+$/.test(id));
  const scriptCanon = scriptItems(moduleItems.canon ?? []).filter(([id]) => /^script-canon-/.test(id));
  const episodeOutlines = scriptOutlines.filter(([id]) => /^script-outline-episode-\d+$/.test(id));
  const hasContinuityDelta = ([id]) => {
    const delta = documents[id]?.continuityDelta;
    return Boolean(delta && (String(delta.summary ?? "").trim() || (delta.nextCarryover ?? []).length || (delta.legacyHistory ?? []).length));
  };

  return {
    seriesOutline: statusOf(documents[series?.[0]]),
    plannedVolumes: Math.max(volumes.length, inlineSeries.volumeCount),
    completedVolumeOutlines: Math.min(
      Math.max(volumes.length, inlineSeries.volumeCount),
      countSubstantive(volumes, documents) + (substantive(documents[series?.[0]]) ? inlineSeries.volumeCount : 0),
    ),
    plannedChapterOutlines: Math.max(chapterOutlines.length, inlineSeries.chapterOutlineCount),
    completedChapterOutlines: Math.min(
      Math.max(chapterOutlines.length, inlineSeries.chapterOutlineCount),
      countSubstantive(chapterOutlines, documents) + (substantive(documents[series?.[0]]) ? inlineSeries.chapterOutlineCount : 0),
    ),
    manuscriptVolumes: Math.max(volumeNames.size, chapters.length ? 1 : 0),
    chapterDocuments: chapters.length,
    writtenChapters,
    settingDocuments: canon.length,
    completedSettingDocuments: completedSettingDocuments.length,
    settingEntries,
    scriptSeriesOutline: statusOf(documents[scriptOutlines.find(([id]) => id === "script-outline-series")?.[0]]),
    episodeOutlines: episodeOutlines.length,
    completedEpisodeOutlines: countSubstantive(episodeOutlines, documents),
    episodeDocuments: scriptEpisodes.length,
    writtenEpisodes: countSubstantive(scriptEpisodes, documents, 80),
    scriptSettingDocuments: scriptCanon.length,
    completedScriptSettingDocuments: countSubstantive(scriptCanon, documents),
    continuity: {
      plotControl: [
        substantive(documents["outline-series"]),
        substantive(documents["memory-foreshadowing"]),
        substantive(documents["memory-information-ledger"])
          || ["memory-first-appearance", "memory-release", "memory-reader"].some((id) => substantive(documents[id])),
      ].filter(Boolean).length,
      snapshot: statusOf(documents["memory-snapshot"]),
      chapterDeltas: chapters.filter(hasContinuityDelta).length,
      episodeDeltas: scriptEpisodes.filter(hasContinuityDelta).length,
      coverage: memory.coverage,
      verifiedCoverage: memory.verifiedCoverage,
      staleUnits: memory.stale,
      missingUnits: memory.missing,
    },
  };
};

export const projectCompilationDecisionSummary = (input = {}) => {
  const summary = projectCompilationSummary(input);
  const actions = [];
  const addAction = (id, severity, value = 0) => actions.push({ id, severity, value });
  const proseUnits = summary.chapterDocuments + summary.episodeDocuments;
  const writtenUnits = summary.writtenChapters + summary.writtenEpisodes;
  const plannedOutlines = summary.plannedChapterOutlines + summary.episodeOutlines;
  const completedOutlines = summary.completedChapterOutlines + summary.completedEpisodeOutlines;
  const expectedOutlines = Math.max(plannedOutlines, proseUnits);

  if (summary.seriesOutline !== "已建立" && summary.chapterDocuments) addAction("series-outline", "blocking");
  if (completedOutlines < expectedOutlines) addAction("outline-coverage", "attention", expectedOutlines - completedOutlines);
  if (writtenUnits < proseUnits) addAction("prose-progress", "progress", proseUnits - writtenUnits);
  if (summary.continuity.staleUnits) addAction("stale-memory", "blocking", summary.continuity.staleUnits);
  if (summary.continuity.missingUnits) addAction("missing-memory", "attention", summary.continuity.missingUnits);
  if (proseUnits && summary.continuity.verifiedCoverage < 0.95) addAction("evidence-coverage", "attention", Math.round(summary.continuity.verifiedCoverage * 1000) / 10);

  const status = actions.some((item) => item.severity === "blocking")
    ? "blocked"
    : actions.some((item) => item.severity === "attention")
      ? "attention"
      : actions.some((item) => item.severity === "progress")
        ? "progress"
        : "ready";

  return {
    status,
    summary,
    actions,
    metrics: {
      outline: { completed: completedOutlines, total: expectedOutlines },
      prose: { completed: writtenUnits, total: proseUnits },
      evidenceCoverage: Math.round(summary.continuity.verifiedCoverage * 1000) / 10,
      actionCount: actions.filter((item) => item.severity !== "progress").length,
    },
    canReviewMemory: actions.some((item) => ["stale-memory", "missing-memory", "evidence-coverage"].includes(item.id)),
  };
};

export const projectCompilationStatusHtml = (input = {}) => {
  const summary = projectCompilationSummary(input);
  const scriptStarted = summary.episodeOutlines || summary.episodeDocuments || summary.completedScriptSettingDocuments;
  return [
    "<h1>项目总览</h1>",
    "<p>本报告由软件根据当前已落地的项目文档实时汇总，反映作品推进程度；它不是历史日志，也不作为故事事实源。</p>",
    "<h2>小说规划</h2>",
    `<p>全集大纲：${escapeHtml(summary.seriesOutline)}</p>`,
    `<p>分卷规划：已规划 ${summary.plannedVolumes} 卷，已完善 ${summary.completedVolumeOutlines} 份卷纲。</p>`,
    `<p>章节规划：已建立 ${summary.plannedChapterOutlines} 份章纲，其中 ${summary.completedChapterOutlines} 份已有实质内容。</p>`,
    "<h2>正文进度</h2>",
    `<p>正文目录包含 ${summary.manuscriptVolumes} 卷、${summary.chapterDocuments} 个章节文档；其中 ${summary.writtenChapters} 章已有实质正文。</p>`,
    "<h2>设定进度</h2>",
    `<p>正史设定共 ${summary.settingDocuments} 个分类文档，${summary.completedSettingDocuments} 个已有实质内容，约包含 ${summary.settingEntries} 个可识别设定条目。</p>`,
    "<h2>连续性资料</h2>",
    `<p>剧情控制：${summary.continuity.plotControl} 项已有内容；状态快照：${escapeHtml(summary.continuity.snapshot)}；后台章节增量：${summary.continuity.chapterDeltas} 章已同步；全单元覆盖率 ${Math.round(summary.continuity.coverage * 1000) / 10}%，证据验证覆盖率 ${Math.round(summary.continuity.verifiedCoverage * 1000) / 10}%，过期 ${summary.continuity.staleUnits} 个、缺失 ${summary.continuity.missingUnits} 个。创作上下文按任务临时编译，不落盘。</p>`,
    ...(scriptStarted ? [
      "<h2>剧本推进</h2>",
      `<p>剧本全集大纲：${escapeHtml(summary.scriptSeriesOutline)}；集纲 ${summary.episodeOutlines} 份（已完善 ${summary.completedEpisodeOutlines} 份）；剧本正文 ${summary.episodeDocuments} 集（已完成 ${summary.writtenEpisodes} 集）；剧本设定 ${summary.completedScriptSettingDocuments}/${summary.scriptSettingDocuments} 个分类已有内容；后台分集增量 ${summary.continuity.episodeDeltas} 集已同步。</p>`,
    ] : []),
  ].join("");
};
