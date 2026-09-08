const normalize = (value) => String(value ?? "").trim();
const normalizePath = (value) => normalize(value).replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
const fileStem = (value) => normalizePath(value).split("/").at(-1)?.replace(/\.md$/i, "") ?? "";

const numbered = (text, unit) => new RegExp(`第\\s*(?:\\d+|[零〇一二三四五六七八九十百千两]+)\\s*${unit}`).test(text);
const scriptContext = (placement) => ({ ...placement, contextDomain: "script" });
const novelContext = (placement) => ({ ...placement, contextDomain: "novel" });

const OBSOLETE_NAVIGATION_TITLES = new Set([
  "自动索引",
  "文档索引",
  "人物索引",
  "章节索引",
  "伏笔索引",
  "短剧剧本索引",
  "剧本索引",
  "正文索引",
]);

export const isObsoleteNavigationDocument = ({ title = "", sourcePath = "", markdown = "" } = {}) => {
  const name = normalize(title) || fileStem(sourcePath);
  if (!OBSOLETE_NAVIGATION_TITLES.has(name) && !OBSOLETE_NAVIGATION_TITLES.has(fileStem(sourcePath))) return false;
  const body = normalize(markdown);
  if (!body) return true;
  return /(?:索引|导航|目录|单集文档|不承载.{0,8}正文|正式.{0,4}源)/.test(body);
};

const pathPlacement = ({ title = "", sourcePath = "", markdown = "" } = {}) => {
  const path = normalizePath(sourcePath);
  if (!path) return null;
  const name = normalize(title) || fileStem(path);

  if (isObsoleteNavigationDocument({ title: name, sourcePath: path, markdown })) {
    return { excluded: true, reason: "旧导航索引由结构树实时生成，不应作为创作文档展示" };
  }

  if (/^04_正文\/短剧\/(?:视频提示词)\//.test(path)) {
    return { importPrefix: "prompt-video", placement: scriptContext({ moduleId: "manuscript", viewId: "prompts", treeGroup: "video", label: "视频提示词" }), reason: "短剧视频提示词目录" };
  }
  if (/^04_正文\/短剧\/(?:图片资产提示词|视觉资产提示词)\//.test(path)) {
    return { importPrefix: "prompt-visual", placement: scriptContext({ moduleId: "manuscript", viewId: "prompts", treeGroup: "visual", label: "视觉资产提示词" }), reason: "短剧视觉资产提示词目录" };
  }
  if (/^04_正文\/短剧\/(?:全景调度图提示词)\//.test(path)) {
    return { importPrefix: "prompt-panorama", placement: scriptContext({ moduleId: "manuscript", viewId: "prompts", treeGroup: "panorama", label: "全景调度图提示词" }), reason: "短剧全景调度提示词目录" };
  }
  if (/^04_正文\/短剧\/(?:剧本大纲|短剧大纲)\//.test(path)) {
    const episodeOutline = /(?:\/集纲\/|第\s*(?:\d+|[零〇一二三四五六七八九十百千两]+)\s*集|集纲|剧集大纲)/.test(`${path}\n${name}`);
    return {
      importPrefix: "script-outline",
      placement: scriptContext({ moduleId: "outline", viewId: "script", treeGroup: episodeOutline ? "episodes" : "series", label: episodeOutline ? "剧本集纲" : "剧本规划" }),
      reason: "剧本大纲目录",
    };
  }
  if (/^04_正文\/短剧\/(?:剧本连续性|剧本记忆|剧本改编记忆)\//.test(path)) {
    const snapshot = /状态|快照/.test(name);
    return {
      importPrefix: "script-memory",
      placement: scriptContext({ moduleId: "memory", viewId: "script", treeGroup: snapshot ? "state-snapshot" : "plot-control", label: snapshot ? "剧本状态快照" : "剧本连续性" }),
      reason: "剧本连续性目录",
    };
  }
  if (/^04_正文\/短剧\/(?:剧本设定)\//.test(path)) {
    return { importPrefix: "script-canon", placement: scriptContext({ moduleId: "canon", viewId: "script", label: "剧本设定" }), reason: "剧本设定目录" };
  }
  if (/^04_正文\/短剧\/(?:短剧剧本)\//.test(path)) {
    if (/(?:总控大纲|重拆规划|结构规划|剧集规划|分集规划|集纲)/.test(name)) {
      const episodePlan = /(?:第.+集|分集|集纲|重拆)/.test(name) && !/总控大纲/.test(name);
      return {
        importPrefix: "script-outline",
        placement: scriptContext({ moduleId: "outline", viewId: "script", treeGroup: episodePlan ? "episodes" : "series", label: episodePlan ? "剧本集纲" : "剧本规划" }),
        reason: "剧本目录中的规划文档",
      };
    }
    if (/(?:总控卡|状态快照|连续性卡|信息释放|观众知识|伏笔账本)/.test(name)) {
      return { importPrefix: "script-memory", placement: scriptContext({ moduleId: "memory", viewId: "script", treeGroup: /状态|快照/.test(name) ? "state-snapshot" : "plot-control", label: "剧本连续性" }), reason: "剧本目录中的连续性控制文档" };
    }
    if (/(?:剧本|短剧).{0,8}(?:标注规范|格式规范|创作规范|制作规范)$/.test(name)) {
      return { importPrefix: "index", placement: scriptContext({ moduleId: "index", viewId: null, treeGroup: "rules", label: "创作合同" }), reason: "剧本项目规范" };
    }
    return { importPrefix: "script-episode", placement: scriptContext({ moduleId: "manuscript", viewId: "script", treeGroup: "scripts", label: "剧本正文" }), reason: "短剧剧本目录" };
  }
  if (/^04_正文\/短剧\//.test(path)) {
    return { importPrefix: "script-episode", placement: scriptContext({ moduleId: "manuscript", viewId: "script", treeGroup: "scripts", label: "剧本正文" }), reason: "短剧正文目录" };
  }
  if (/^04_正文\/小说\//.test(path) || /^04_正文\/第\d+卷/.test(path)) {
    return { importPrefix: "manuscript", placement: novelContext({ moduleId: "manuscript", viewId: "novel", label: "小说正文" }), reason: "小说正文目录" };
  }
  if (/^01_剧情控制\/(?:章纲)\//.test(path)) {
    return { importPrefix: "outline", placement: novelContext({ moduleId: "outline", viewId: "novel", treeGroup: "chapters", label: "小说章纲" }), reason: "章纲目录" };
  }
  if (/^01_剧情控制\/(?:卷纲)\//.test(path)) {
    return { importPrefix: "outline", placement: novelContext({ moduleId: "outline", viewId: "novel", treeGroup: "volumes", label: "小说卷纲" }), reason: "卷纲目录" };
  }
  if (/^01_剧情控制\//.test(path)) {
    if (/项目禁用词|创作合同/.test(name)) {
      return { importPrefix: "index", placement: { moduleId: "index", viewId: null, treeGroup: "rules", label: "创作合同" }, reason: "项目级创作约束" };
    }
    const memory = /伏笔|信息释放|读者当前|重要信息登场|(?:情绪|爽点|线索|悬念|承诺)账本/.test(`${path}\n${name}`);
    return memory
      ? { importPrefix: "memory", placement: novelContext({ moduleId: "memory", viewId: "novel", treeGroup: "plot-control", label: "小说剧情控制" }), reason: "剧情控制资料目录" }
      : { importPrefix: "outline", placement: novelContext({ moduleId: "outline", viewId: "novel", treeGroup: "series", label: "小说规划" }), reason: "剧情控制目录" };
  }
  if (/^02_正史设定\//.test(path)) return { importPrefix: "canon", placement: novelContext({ moduleId: "canon", viewId: "novel", label: "正史设定" }), reason: "正史设定目录" };
  if (/^(?:03_状态快照|05_章节记忆|06_上下文包)\//.test(path)) return { importPrefix: "memory", placement: novelContext({ moduleId: "memory", viewId: "novel", treeGroup: "state-snapshot", label: "小说记忆" }), reason: "连续性资料目录" };
  if (/^07_编译报告\//.test(path)) return { importPrefix: "report", placement: { moduleId: "reports", viewId: null, label: "编译报告" }, reason: "编译报告目录" };
  if (/^08_资料库\//.test(path)) return { importPrefix: "library", placement: { moduleId: "library", viewId: null, label: "资料库" }, reason: "资料库目录" };
  if (/^09_索引\//.test(path)) return { importPrefix: "index", placement: { moduleId: "index", viewId: null, label: "索引" }, reason: "索引目录" };
  return null;
};

const inferredPlacement = ({ documentId = "", title = "" } = {}) => {
  const id = normalize(documentId);
  const text = normalize(title);

  if (/^prompt-video-/.test(id) || /(?:视频|分镜|漫剧|镜头)提示词/.test(text)) return scriptContext({ moduleId: "manuscript", viewId: "prompts", treeGroup: "video", label: "视频提示词" });
  if (/^prompt-visual-/.test(id) || /(?:视觉|图片|角色|场景|道具)资产(?:总表|提示词)?/.test(text)) return scriptContext({ moduleId: "manuscript", viewId: "prompts", treeGroup: "visual", label: "视觉资产提示词" });
  if (/^prompt-panorama-/.test(id) || /全景调度|站位(?:图|线稿)|空间调度/.test(text)) return scriptContext({ moduleId: "manuscript", viewId: "prompts", treeGroup: "panorama", label: "全景调度图提示词" });
  if (/^script-outline-episode-/.test(id) || /(?:第.+集)?(?:集纲|剧集大纲)/.test(text)) return scriptContext({ moduleId: "outline", viewId: "script", treeGroup: "episodes", label: "剧本集纲" });
  if (id === "script-outline-series" || /剧本(?:全集|全剧|总)大纲/.test(text)) return scriptContext({ moduleId: "outline", viewId: "script", treeGroup: "series", label: "剧本全集大纲" });
  if (/^outline-chapter-/.test(id) || /(?:第.+章)?章纲/.test(text)) return novelContext({ moduleId: "outline", viewId: "novel", treeGroup: "chapters", label: "小说章纲" });
  if (/^outline-volume-/.test(id) || /(?:第.+卷)?卷纲/.test(text)) return novelContext({ moduleId: "outline", viewId: "novel", treeGroup: "volumes", label: "小说卷纲" });
  if (id === "outline-series" || /(?:小说|全书|全集)(?:总)?大纲|^全集大纲$|^总纲$/.test(text)) return { moduleId: "outline", viewId: /剧本|短剧|漫剧/.test(text) ? "script" : "novel", treeGroup: "series", label: "全集大纲", contextDomain: /剧本|短剧|漫剧/.test(text) ? "script" : "novel" };
  if (/^script-episode-/.test(id) || numbered(text, "集")) return scriptContext({ moduleId: "manuscript", viewId: "script", treeGroup: "scripts", label: "剧本正文" });
  if (/^chapter-\d+$/.test(id) || numbered(text, "章")) return novelContext({ moduleId: "manuscript", viewId: "novel", label: "小说正文" });
  if (/^script-canon-/.test(id) || /剧本.{0,8}(?:设定|人物|关系|势力|地点|物品|时间线|世界观)/.test(text)) return scriptContext({ moduleId: "canon", viewId: "script", label: "剧本设定" });
  if (/^canon-/.test(id) || /(?:综合设定|人物总表|关系总表|势力总表|地点总表|物品总表|事件总表|时间线|世界观|力量体系|能力体系)/.test(text)) return novelContext({ moduleId: "canon", viewId: null, label: "正史设定" });
  if (/^script-memory-/.test(id) || /剧本(?:状态快照|信息释放|读者知识|观众知识)/.test(text)) return scriptContext({ moduleId: "memory", viewId: "script", label: "剧本记忆" });
  if (/^memory-/.test(id) || /状态快照|信息释放表|读者当前知识库|重要信息登场账本|伏笔/.test(text)) return novelContext({ moduleId: "memory", viewId: null, label: "小说记忆" });
  if (/^report-/.test(id) || /(?:编译报告|自检报告|小说自检|改编报告)/.test(text)) return { moduleId: "reports", viewId: null, label: "编译报告" };
  if (/^index-/.test(id) || /(?:文档索引|待确认事项|更新日志|术语表)/.test(text)) return { moduleId: "index", viewId: null, label: "索引" };
  if (/^library-/.test(id) || /资料|素材|参考/.test(text)) return { moduleId: "library", viewId: null, label: "资料库" };
  return null;
};

export const classifyStructuredDocument = ({ documentId = "", title = "", sourcePath = "", markdown = "" } = {}) => {
  const fromPath = pathPlacement({ title, sourcePath, markdown });
  if (fromPath) return { source: "path", ...fromPath };
  const placement = inferredPlacement({ documentId, title });
  return placement ? { source: "identity", placement } : null;
};

export const inferredStructurePlacement = ({ documentId = "", title = "", sourcePath = "", markdown = "" } = {}) => {
  const classification = classifyStructuredDocument({ documentId, title, sourcePath, markdown });
  if (!classification || classification.excluded) return null;
  const { contextDomain: _contextDomain, ...placement } = classification.placement;
  return placement;
};

export const structurePlacementAllows = ({ documentId = "", title = "", sourcePath = "", markdown = "", moduleId = "", viewId = "novel" } = {}) => {
  const expected = inferredStructurePlacement({ documentId, title, sourcePath, markdown });
  if (!expected) return { allowed: true, expected: null };
  const allowed = expected.moduleId === moduleId && (!expected.viewId || expected.viewId === viewId);
  return { allowed, expected };
};

export const structurePlacementMessage = ({ title = "该文档", expected } = {}) => {
  if (!expected) return "无法确定目标结构位置";
  const viewLabel = expected.viewId === "script" ? "剧本分类" : expected.viewId === "prompts" ? "提示词分类" : expected.viewId === "novel" ? "小说分类" : "对应分类";
  return `“${title}”应位于${expected.label}对应的 ${expected.moduleId} 板块（${viewLabel}）`;
};
