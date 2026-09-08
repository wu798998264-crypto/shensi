const text = (value, max = 20_000) => String(value ?? "").trim().slice(0, max);

const volumeRange = ({ id = "", document = null, content = "" } = {}) => {
  const stored = document?.longFormVolumeRange;
  const storedStart = Number(stored?.startChapter) || 0;
  const storedEnd = Number(stored?.endChapter) || 0;
  const match = String(content).match(/章节范围[：:]\s*第\s*(\d+)\s*章\s*(?:至|到|[-~～—])\s*第\s*(\d+)\s*章/);
  const startChapter = storedStart || Number(match?.[1]) || 0;
  const endChapter = storedEnd || Number(match?.[2]) || 0;
  if (!startChapter || endChapter < startChapter) return null;
  return {
    number: Number(String(id).match(/^outline-volume-(\d+)$/)?.[1]) || Number(document?.longFormVolume?.number) || 0,
    title: text(document?.longFormVolume?.title || document?.title, 100).replace(/^第\d+卷卷纲[\s　]*/, "") || "未命名卷",
    startChapter,
    endChapter,
    summary: text(document?.longFormVolume?.summary || content, 12_000),
    ...(document?.longFormVolume && typeof document.longFormVolume === "object" ? document.longFormVolume : {}),
  };
};

const continuouslyCovers = (volumes, startChapter, endChapter) => {
  let cursor = startChapter;
  for (const volume of volumes) {
    if (volume.endChapter < cursor) continue;
    if (volume.startChapter > cursor) return false;
    cursor = volume.endChapter + 1;
    if (cursor > endChapter) return true;
  }
  return cursor > endChapter;
};

const labeledValue = (content, labels, max = 5000) => {
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${labels.join("|")})[：:]\\s*([^\\n]+)`, "i");
  return text(String(content || "").match(pattern)?.[1], max);
};

export const assessPreparedWorkspaceLongFormPlan = ({
  batch,
  projectTitle = "",
  documents = {},
  contentFor = (document) => document?.content ?? "",
  substantive = (document) => Boolean(text(contentFor(document))),
} = {}) => {
  const issues = [];
  const blocked = (code, message, documentId = "") => ({ ready: false, status: "supplement", issues: [{ code, message, documentId }] });
  const startChapter = Number(batch?.startChapter) || 0;
  const endChapter = Number(batch?.endChapter) || 0;
  if (!startChapter || endChapter < startChapter) return blocked("INVALID_CHAPTER_RANGE", "请求的章节范围无效");
  const seriesDocument = documents["outline-series"];
  if (!seriesDocument || !substantive(seriesDocument)) return blocked("MISSING_SERIES_OUTLINE", "缺少有效的全集大纲", "outline-series");
  const seriesOutline = text(contentFor(seriesDocument), 24_000);
  const storedFoundation = seriesDocument.longFormFoundation && typeof seriesDocument.longFormFoundation === "object"
    ? seriesDocument.longFormFoundation
    : {};
  const explicitGenre = text(storedFoundation.genre, 200) || labeledValue(seriesOutline, ["题材", "类型", "细分赛道"], 200);
  const explicitCorePromise = text(storedFoundation.corePromise, 2000) || labeledValue(seriesOutline, ["核心承诺", "长期看点", "核心看点"], 2000);
  const explicitEnding = text(storedFoundation.ending, 5000) || labeledValue(seriesOutline, ["终局", "结局", "终局兑现"], 5000);
  if (!explicitGenre) issues.push({ code: "MISSING_GENRE", message: "全集大纲未明确题材或细分赛道", documentId: "outline-series" });
  if (!explicitCorePromise) issues.push({ code: "MISSING_CORE_PROMISE", message: "全集大纲未明确可持续兑现的核心承诺", documentId: "outline-series" });
  if (!explicitEnding) issues.push({ code: "MISSING_ENDING", message: "全集大纲未明确终局方向，无法从结局反推铺垫", documentId: "outline-series" });
  const canonIds = ["canon-characters", "canon-world", "canon-factions", "canon-relations", "canon-locations", "canon-items"];
  const hasCharacters = Boolean(documents["canon-characters"] && substantive(documents["canon-characters"]));
  const hasRulesOrRelations = canonIds.slice(1).some((id) => documents[id] && substantive(documents[id]));
  if (!hasCharacters) issues.push({ code: "MISSING_CHARACTER_CANON", message: "缺少有效人物正史", documentId: "canon-characters" });
  if (!hasRulesOrRelations) issues.push({ code: "MISSING_CONTEXT_CANON", message: "缺少世界规则、关系、势力、地点或物品中的至少一类正史", documentId: "canon-world" });
  if (issues.length) return { ready: false, status: "supplement", issues };

  const volumes = Object.entries(documents)
    .filter(([id, document]) => id.startsWith("outline-volume-") && substantive(document))
    .map(([id, document]) => volumeRange({ id, document, content: contentFor(document) }))
    .filter(Boolean)
    .sort((left, right) => left.startChapter - right.startChapter || left.endChapter - right.endChapter)
    .map((volume, index) => ({ ...volume, number: volume.number || index + 1 }));
  if (!volumes.length || !continuouslyCovers(volumes, startChapter, endChapter)) {
    return blocked("VOLUME_COVERAGE_GAP", "分卷范围没有连续覆盖本次请求章节", "outline-series");
  }

  const chapterOutlines = [];
  for (let number = startChapter; number <= endChapter; number += 1) {
    const document = documents[`outline-chapter-${number}`];
    if (!document || !substantive(document)) return blocked("MISSING_CHAPTER_OUTLINE", `缺少第 ${number} 章的有效章纲`, `outline-chapter-${number}`);
    const stored = document.longFormChapterOutline && typeof document.longFormChapterOutline === "object"
      ? document.longFormChapterOutline
      : {};
    const content = text(contentFor(document), 16_000);
    const objective = text(stored.objective, 1600) || labeledValue(content, ["章节目标", "本章目标", "章节功能", "本章功能"], 1600);
    const hook = text(stored.hook, 1600) || labeledValue(content, ["章末钩子", "结尾钩子", "追读钩子", "钩子"], 1600);
    if (!objective || !hook) {
      return blocked(
        "INCOMPLETE_CHAPTER_OUTLINE",
        `第 ${number} 章章纲必须明确章节目标与章末钩子，不能由占位默认值代替`,
        `outline-chapter-${number}`,
      );
    }
    chapterOutlines.push({
      number,
      title: text(stored.title || document.title, 100).replace(/^第\d+章章纲[\s　]*/, "") || "未命名",
      outline: text(stored.outline || content, 8_000),
      objective,
      hook,
      ...stored,
      number,
    });
  }

  const canonContent = (id) => documents[id] && substantive(documents[id]) ? text(contentFor(documents[id]), 16_000) : "";
  const foundation = {
    ...storedFoundation,
    projectTitle: text(projectTitle || "未命名长篇", 100),
    genre: explicitGenre,
    corePromise: explicitCorePromise,
    premise: text(storedFoundation.premise, 8000) || seriesOutline,
    ending: explicitEnding,
    seriesOutline,
    canon: {
      characters: canonContent("canon-characters"),
      world: canonContent("canon-world"),
      factions: canonContent("canon-factions"),
      relations: canonContent("canon-relations"),
      locations: canonContent("canon-locations"),
      items: canonContent("canon-items"),
    },
    volumes,
    source: "workspace",
  };
  const plan = { foundation, chapterOutlines, outlinedVolumes: volumes.map((volume) => volume.number), source: "workspace" };
  return { ready: true, status: "ready", issues: [], plan };
};

export const preparedWorkspaceLongFormPlan = (options = {}) => assessPreparedWorkspaceLongFormPlan(options).plan ?? null;
