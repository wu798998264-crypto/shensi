import { chapterNumberValue } from "./chapter-target.js";
import { CHAPTER_OUTLINE_PATTERN, SERIES_OUTLINE_PATTERN } from "./artifact-ontology.js";
import { explicitReviewReportReference, reviewDeliveryPolicy, reviewReportTarget } from "./review-delivery-policy.js";

const target = (documentId, moduleId, title, extras = {}) => ({
  documentId,
  moduleId,
  viewId: extras.viewId ?? "novel",
  contextDomain: extras.contextDomain ?? "novel",
  title,
  explicitArtifact: true,
  ...(extras.sourceMode ? { sourceMode: extras.sourceMode } : {}),
  ...(extras.treeGroup ? { treeGroup: extras.treeGroup } : {}),
});

const ordinalNumber = (text, unit) => {
  const match = String(text).match(new RegExp(`第\\s*(\\d+|[零〇一二三四五六七八九十百千两]+)\\s*${unit}`));
  return match ? chapterNumberValue(match[1]) : 0;
};

const stableKey = (value) => {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
};

const deconstructionTitle = (text) => {
  const bracketed = String(text).match(/《([^》]{1,80})》/)?.[1];
  const filename = String(text).match(/([^\\/:*?"<>|\r\n]{1,80})\.(?:txt|md|docx?|pdf|epub)/i)?.[1];
  const value = String(bracketed || filename || "").trim().replace(/^(?:请|帮我)?(?:拆书|拆解|分析)[：:\s-]*/, "");
  return value || "未命名作品";
};

const novelCanonTarget = (text) => {
  if (/术语|词汇|名词解释/.test(text)) return target("canon-glossary", "canon", "术语表");
  if (/关系|关系网/.test(text)) return target("canon-relations", "canon", "人物关系");
  if (/势力|阵营|组织/.test(text)) return target("canon-factions", "canon", "势力与组织");
  if (/地点|地图|场景地/.test(text)) return target("canon-locations", "canon", "地图与地点");
  if (/物品|道具|装备/.test(text)) return target("canon-items", "canon", "物品与道具");
  if (/时间线|年表|事件|大事记/.test(text)) return target("canon-events", "canon", "事件与时间线");
  if (/人物|角色|人设/.test(text)) return target("canon-characters", "canon", "人物设定");
  return target("canon-world", "canon", "世界观与基础规则");
};

const scriptCanonTarget = (text) => {
  const base = novelCanonTarget(text);
  const suffix = base.documentId.replace(/^canon-/, "");
  const titles = {
    characters: "人物改编",
    relations: "关系改编",
    world: "世界与规则改编",
    locations: "场景与地点改编",
    factions: "势力与组织改编",
    events: "事件与时间线改编",
    items: "道具改编",
    glossary: "剧本术语",
  };
  return target(`script-canon-${suffix}`, "canon", titles[suffix] ?? "世界与规则改编", {
    viewId: "script",
    contextDomain: "script",
  });
};

const SCRIPT_ADAPTATION_PATTERN = /小说.{0,16}(?:改编|改成|改写成|转换成|转成)(?:为|成)?.{0,8}(?:短剧|剧本|漫剧)|(?:根据|基于).{0,24}(?:小说|原著|原作|章节|原文)|原著改编|原作改编|小说改编短剧/;
const scriptSourceMode = (text) => SCRIPT_ADAPTATION_PATTERN.test(String(text)) ? "adaptation" : "original";
const scriptTarget = (documentId, moduleId, title, text, extras = {}) => target(documentId, moduleId, title, {
  viewId: "script",
  contextDomain: "script",
  sourceMode: scriptSourceMode(text),
  ...extras,
});

export const requestedArtifactTarget = (value = "", { contextDomain = "novel" } = {}) => {
  const text = String(value);
  const script = /剧本|短剧|漫剧/.test(text) || ["script", "script-adaptation"].includes(contextDomain);
  const reviewDelivery = reviewDeliveryPolicy({ text, contextDomain: script ? "script" : contextDomain });
  const episodeNumber = ordinalNumber(text, "集");
  const chapterNumber = ordinalNumber(text, "章");
  const volumeNumber = ordinalNumber(text, "卷");
  const bookDeconstructionIntent = /爆款拆书|拆书报告|完整拆解这本书|全书逆向分析|逆向分析.{0,12}(?:作品|本书|小说)|提取.{0,12}(?:爆款机制|追读机制)|(?:^|[\r\n])(?:请|帮我)?(?:拆书|拆文)(?:[。！!]|$|[\r\n])/.test(text)
    && !/(?:拆书|拆文).{0,18}(?:是什么|什么意思|定义|作用|用途|方法)/.test(text);
  if (bookDeconstructionIntent) {
    const sourceTitle = deconstructionTitle(text);
    const reportTitle = sourceTitle === "未命名作品" ? "爆款拆书报告" : `《${sourceTitle}》爆款拆书报告`;
    return target(`library-deconstruction-${stableKey(sourceTitle)}`, "library", reportTitle, { viewId: "default", contextDomain: "reference" });
  }
  if (/全景调度|站位(?:图|线稿)|空间调度/.test(text)) {
    const number = episodeNumber || 1;
    return target(`prompt-panorama-${number}`, "manuscript", `第${number}集全景调度图提示词`, { viewId: "prompts", contextDomain: "script", treeGroup: "panorama" });
  }
  if (/视觉资产|图片资产|角色资产|场景资产|道具资产/.test(text)) {
    return target("prompt-visual-assets", "manuscript", "视觉资产总表", { viewId: "prompts", contextDomain: "script", treeGroup: "visual" });
  }
  if (/视频提示词|分镜提示词|漫剧提示词|镜头提示词/.test(text)) {
    const number = episodeNumber || 1;
    return target(`prompt-video-${number}`, "manuscript", `第${number}集视频提示词`, { viewId: "prompts", contextDomain: "script", treeGroup: "video" });
  }
  if (/小说.{0,8}改(?:成|编为)?.{0,8}剧本.{0,8}(?:编译|改编)报告|小说改剧本.{0,8}报告|改编报告/.test(text)) {
    return target("report-adaptation", "reports", "小说改剧本编译报告", { contextDomain: "script" });
  }
  if (reviewDelivery.target) return { ...reviewDelivery.target };
  if (explicitReviewReportReference(text)) return reviewReportTarget({ contextDomain: script ? "script" : contextDomain });
  if (/伏笔(?:总表|管理|账本)?|暗线(?:总表|管理|账本)?/.test(text)) {
    return script
      ? target("script-memory-foreshadowing", "memory", "伏笔管理", { viewId: "script", contextDomain: "script" })
      : target("memory-foreshadowing", "memory", "伏笔管理");
  }
  if (/信息(?:释放表|释放|台阶)|读者(?:当前)?知识/.test(text)) {
    return script
      ? target("script-memory-release", "memory", "信息释放表", { viewId: "script", contextDomain: "script" })
      : target("memory-release", "memory", "信息释放表");
  }
  if (/(?:参考|创作|研究)?资料(?:库|文档|汇总|总表)?/.test(text)) {
    return target("library-reference", "library", "参考资料", { viewId: "default", contextDomain: "reference" });
  }
  if ((/集纲|剧集大纲/.test(text)) && episodeNumber) {
    return scriptTarget(`script-outline-episode-${episodeNumber}`, "outline", `第${episodeNumber}集集纲`, text, { treeGroup: "episodes" });
  }
  if (CHAPTER_OUTLINE_PATTERN.test(text) && chapterNumber) {
    return target(`outline-chapter-${chapterNumber}`, "outline", `第${chapterNumber}章章纲`, { treeGroup: "chapters" });
  }
  if (/卷纲/.test(text)) {
    const number = volumeNumber || 1;
    return target(`outline-volume-${number}`, "outline", `第${number}卷卷纲`, { treeGroup: "volumes" });
  }
  if (/剧本设定/.test(text)) return scriptCanonTarget(text);
  if (/(?:小说|作品)?设定|人物(?:设定)?|角色(?:设定)?|世界观|力量体系|能力体系|地图|地点|场景地|概念|规则|时间线|事件|势力|阵营|组织|物品|道具|装备|种族|术语表/.test(text)) {
    return script ? scriptCanonTarget(text) : novelCanonTarget(text);
  }
  if (script && /(?:全集大纲|全剧大纲|整季大纲|总纲|剧本大纲)/.test(text)) {
    return scriptTarget("script-outline-series", "outline", "全集大纲", text, { treeGroup: "series" });
  }
  // “大纲”在复合创作决定里通常省略“全书/全集”等限定词，但仍指向
  // 作品级大纲，而不是一个新的模糊文档。把这个短形式归一到同一正式目标，
  // 让“设定、大纲和记忆”这类多目标决定可以形成完整合同。
  if (SERIES_OUTLINE_PATTERN.test(text) || /(?:^|[\s，,、；;和与及])(?:全书|全集|整书|小说)?大纲(?:文档|内容|模块)?(?:$|[\s，,、；;])/u.test(text)) {
    return target("outline-series", "outline", "全集大纲", { treeGroup: "series" });
  }
  if (script && episodeNumber && /(?:写|生成|创作|续写|剧本|正文|第.+集)/.test(text)) {
    return scriptTarget(`script-episode-${episodeNumber}`, "manuscript", `第${episodeNumber}集`, text, { treeGroup: "scripts" });
  }
  if (/待确认事项/.test(text)) return target("index-pending", "index", "待确认事项");
  if (/创作合同|项目规则|项目禁用词|特别注意事项/.test(text)) return target("index-language-blacklist", "index", "创作合同");
  if (/更新日志/.test(text)) return target("index-update-log", "index", "更新日志");
  return null;
};

export const explicitDeliverableArtifactTargets = (value = "", options = {}) => {
  const source = String(value || "").trim();
  if (!source) return null;
  const items = [];
  let inDeliverables = false;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const direct = line.match(/^交付物\s*(?:[A-Za-z]|[一二三四五六七八九十]+|\d+)\s*[：:]\s*(.+)$/u);
    if (direct) {
      inDeliverables = true;
      items.push(direct[1].trim());
      continue;
    }
    if (/^(?:交付物(?:清单)?|deliverables?)\s*[：:]?\s*$/iu.test(line)) {
      inDeliverables = true;
      continue;
    }
    if (inDeliverables && /^(?:禁止(?:混入)?|排除|验收(?:条件)?|完成条件|通过条件|exclusions?|acceptance(?:\s+criteria)?)\s*[：:]?/iu.test(line)) break;
    if (!inDeliverables) continue;
    const numbered = line.match(/^\s*(?:[-*•]|(?:\d+|[A-Za-z一二三四五六七八九十]+)[.、:)）])\s*(.+)$/u);
    if (numbered) items.push(numbered[1].trim());
    else if (items.length) items[items.length - 1] = `${items[items.length - 1]}\n${line}`;
  }
  if (!inDeliverables) return null;

  const explicitTargets = [];
  for (const item of items) {
    const lead = String(item).split(/[，,。；;\n]/u)[0].trim();
    const requestedTitle = item.match(/标题(?:必须)?(?:为|是|使用|采用)?\s*[：:]?\s*[《“"]([^》”"]{1,100})[》”"]/u)?.[1]?.trim() || "";
    let artifact = null;
    if (/(?:第\s*[一二两三四五六七八九十百千万\d]+\s*章\s*(?:至|到|—|-|~|～)\s*第?\s*[一二两三四五六七八九十百千万\d]+\s*章|前\s*[一二两三四五六七八九十百千万\d]+\s*章).{0,16}(?:正文|章节)|(?:正文|章节).{0,16}(?:第\s*[一二两三四五六七八九十百千万\d]+\s*章\s*(?:至|到|—|-|~|～)|前\s*[一二两三四五六七八九十百千万\d]+\s*章)/u.test(lead)) {
      continue;
    }
    if (/(?:完整)?(?:全书|全集|整书|全剧|整季)?大纲|总纲/u.test(lead) || /[“"]大纲[”"]模块/u.test(item)) {
      artifact = target("outline-series", "outline", "全集大纲", { treeGroup: "series" });
    } else if (/(?:完整)?(?:小说|作品)?设定|世界观/u.test(lead) || /[“"]设定[”"]模块/u.test(item)) {
      artifact = target("canon-world", "canon", "世界观与基础规则");
    } else {
      artifact = requestedArtifactTarget(lead, options);
    }
    if (!artifact?.documentId) continue;
    explicitTargets.push(requestedTitle ? { ...artifact, title: requestedTitle } : artifact);
  }

  const unique = new Map();
  for (const candidate of explicitTargets) {
    if (!candidate?.documentId || unique.has(candidate.documentId)) continue;
    unique.set(candidate.documentId, candidate);
  }
  return [...unique.values()];
};

export const requestedArtifactTargets = (value = "", options = {}) => {
  const source = String(value || "").trim();
  if (!source) return [];
  const segments = source
    .split(/(?:\r?\n|[，,、；;＋+]|(?:和|与|及)(?=(?:人物|角色|世界|地点|地图|场景|势力|阵营|组织|时间|事件|物品|道具|装备|术语|设定|全文大纲|全书大纲|全集大纲|整书大纲|小说大纲|总纲|大纲|章纲|细纲|详细大纲|卷纲|剧本|提示词)))/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const candidates = [
    ...segments.map((segment) => requestedArtifactTarget(segment, options)),
    requestedArtifactTarget(source, options),
  ].filter(Boolean);
  // Conjunctions such as “设定和全书大纲，并记录伏笔与信息台阶” do
  // not always split cleanly into independent clauses. Scan the explicit
  // formal-asset nouns as well so a batch request cannot collapse into the
  // first matching document.
  const explicitAssetHints = [
    /(?:小说|作品)?设定|正史设定|人物设定|角色设定|世界观|基础规则/u.test(source) ? "作品设定" : "",
    (SERIES_OUTLINE_PATTERN.test(source) || /(?:全书|全集|整书|小说)?大纲/u.test(source)) ? "全书大纲" : "",
    CHAPTER_OUTLINE_PATTERN.test(source) && ordinalNumber(source, "章") ? `第${ordinalNumber(source, "章")}章章纲` : "",
    /伏笔(?:总表|管理|账本)?|暗线(?:总表|管理|账本)?/u.test(source) ? "伏笔管理" : "",
    /信息(?:释放表|释放|台阶)|读者(?:当前)?知识/u.test(source) ? "信息释放表" : "",
    // “记忆”是对结构化连续性记忆的总称。模型不能直接写系统聚合账本，
    // 因此展开为两个受正式交付协议支持的可投影目标；后续由可信投影器
    // 生成信息账本、首次出现和读者知识等派生视图。
    /(?:当前作品|作品|相关|必要)?记忆(?:文档|模块|库)?/u.test(source)
      && !/伏笔(?:总表|管理|账本)?|暗线(?:总表|管理|账本)?|信息(?:释放表|释放|台阶)|读者(?:当前)?知识/u.test(source)
      ? "伏笔管理"
      : "",
    /(?:当前作品|作品|相关|必要)?记忆(?:文档|模块|库)?/u.test(source)
      && !/伏笔(?:总表|管理|账本)?|暗线(?:总表|管理|账本)?|信息(?:释放表|释放|台阶)|读者(?:当前)?知识/u.test(source)
      ? "信息释放表"
      : "",
    /(?:当前作品的|作品内的|创作|参考|研究)资料(?:库|文档|汇总|总表)?/u.test(source) ? "参考资料" : "",
  ].filter(Boolean);
  candidates.push(...explicitAssetHints.map((hint) => requestedArtifactTarget(hint, options)).filter(Boolean));
  const unique = new Map();
  for (const candidate of candidates) {
    if (!candidate?.documentId || unique.has(candidate.documentId)) continue;
    unique.set(candidate.documentId, candidate);
  }
  return [...unique.values()];
};
