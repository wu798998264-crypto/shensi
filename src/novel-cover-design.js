export const NOVEL_COVER_CONTRACT_VERSION = 1;

export const NOVEL_COVER_DIRECTIONS = Object.freeze([
  Object.freeze({
    id: "character-conflict",
    label: "人物冲突方向",
    focus: "以主角、关键关系和核心冲突构成第一视觉焦点",
    composition: "人物占画面中下部，面部与关键动作避开标题区，背景只保留能证明题材的高辨识度线索",
  }),
  Object.freeze({
    id: "world-spectacle",
    label: "世界奇观方向",
    focus: "以世界观奇观、关键地点或决定性事件形成类型承诺",
    composition: "大场景建立纵深，主体位于中央安全区，书名区保持低细节和稳定明暗对比",
  }),
  Object.freeze({
    id: "symbolic-typography",
    label: "意象字形方向",
    focus: "以代表作品核心命题的单一意象和强字形关系建立识别度",
    composition: "减少叙事元素，保留一个主意象；标题拥有最大视觉权重，作者名与平台标识区互不冲突",
  }),
]);

const clean = (value = "", limit = 240) => String(value || "").trim().slice(0, limit);

const capture = (source, patterns = []) => {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return clean(match[1].replace(/[，,；;。.!！?？].*$/u, ""), 100);
  }
  return "";
};

export const isNovelCoverRequest = (text = "") => {
  const source = clean(text, 4_000);
  if (!/(?:小说|网文|书籍|书名|作品|作者|出版|番茄|起点|晋江|七猫|阅文|书封)/iu.test(source)) return false;
  return /(?:封面|书封)/iu.test(source);
};

export const extractNovelCoverBrief = ({ prompt = "", title = "", authorName = "", platform = "", aspectRatio = "" } = {}) => {
  const source = clean(prompt, 20_000);
  const inferredTitle = clean(title, 100) || capture(source, [
    /(?:小说名|书名|作品名|标题)\s*[：:]\s*[《“"]?([^》”"\n]{1,100})/iu,
    /《([^》\n]{1,100})》/u,
  ]);
  const inferredAuthor = clean(authorName, 100) || capture(source, [
    /(?:作者名|作者|笔名)\s*[：:]\s*[“"]?([^”"\n]{1,100})/iu,
  ]);
  const inferredPlatform = clean(platform, 80) || capture(source, [
    /(?:目标平台|发布平台|平台)\s*[：:]\s*([^\n]{1,80})/iu,
  ]) || (/番茄/iu.test(source) ? "番茄小说" : /起点/iu.test(source) ? "起点读书" : /晋江/iu.test(source) ? "晋江文学城" : "通用网文平台");
  const ratio = clean(aspectRatio, 20)
    || source.match(/\b(\d{1,2}\s*[:：]\s*\d{1,2})\b/u)?.[1]?.replace(/\s|：/gu, (value) => value === "：" ? ":" : "")
    || "2:3";
  return Object.freeze({
    bookTitle: inferredTitle,
    authorName: inferredAuthor,
    platform: inferredPlatform,
    aspectRatio: ratio,
    genreOrSynopsis: source,
  });
};

export const createNovelCoverDesignContract = (input = {}) => {
  const brief = extractNovelCoverBrief(input);
  return Object.freeze({
    assetType: "novel_cover",
    contractVersion: NOVEL_COVER_CONTRACT_VERSION,
    ...brief,
    safeArea: Object.freeze({
      unit: "percent",
      left: 8,
      right: 8,
      top: 8,
      bottom: 10,
      titleBand: Object.freeze({ start: 10, end: 32 }),
      authorBand: Object.freeze({ start: 78, end: 88 }),
    }),
    typography: Object.freeze({
      titleExact: brief.bookTitle,
      authorExact: brief.authorName,
      titlePriority: 1,
      authorPriority: 3,
      forbidGarbledText: true,
      cleanArtworkFallback: true,
    }),
    directions: NOVEL_COVER_DIRECTIONS,
    validation: Object.freeze([
      "书名必须逐字匹配，不得错字、乱码或擅自增删副标题",
      "作者名必须逐字匹配，并与标题形成明确层级",
      "标题、作者名和关键主体必须完整落在文字安全区内",
      "三个方向的主体、构图或视觉语法必须有实质差异",
      "无法可靠生成文字时，保留干净底图并输出可复现的文字叠加规格",
    ]),
  });
};

export const validateNovelCoverDesignContract = (contract = {}) => {
  const errors = [];
  if (contract.assetType !== "novel_cover") errors.push("缺少小说封面资产类型");
  if (!clean(contract.bookTitle)) errors.push("缺少书名，不能进入封面成品生成");
  if (!clean(contract.authorName)) errors.push("缺少作者名，不能进入封面成品生成");
  if (!/^\d{1,2}:\d{1,2}$/.test(clean(contract.aspectRatio))) errors.push("封面画幅比例无效");
  if (!Array.isArray(contract.directions) || contract.directions.length < 3) errors.push("至少需要三个成品方向");
  const safeArea = contract.safeArea || {};
  if ([safeArea.left, safeArea.right, safeArea.top, safeArea.bottom].some((value) => !Number.isFinite(Number(value)) || Number(value) < 5)) {
    errors.push("文字安全区不完整");
  }
  if (!clean(contract.typography?.titleExact) || !clean(contract.typography?.authorExact)) errors.push("标题与作者名排版验证合同不完整");
  return { valid: errors.length === 0, errors };
};

export const novelCoverAssetMetadata = ({ contract, directionId = "character-conflict" } = {}) => {
  if (!contract || contract.assetType !== "novel_cover") return null;
  const direction = (contract.directions || NOVEL_COVER_DIRECTIONS).find((item) => item.id === directionId)
    || contract.directions?.[0]
    || NOVEL_COVER_DIRECTIONS[0];
  return Object.freeze({
    assetType: "novel_cover",
    contractVersion: Number(contract.contractVersion) || NOVEL_COVER_CONTRACT_VERSION,
    bookTitle: clean(contract.bookTitle, 100),
    authorName: clean(contract.authorName, 100),
    platform: clean(contract.platform, 80),
    aspectRatio: clean(contract.aspectRatio, 20),
    directionId: clean(direction.id, 80),
    directionLabel: clean(direction.label, 100),
    safeArea: contract.safeArea || createNovelCoverDesignContract().safeArea,
  });
};

export const normalizeNovelCoverAssetMetadata = (value = null) => {
  if (!value || value.assetType !== "novel_cover") return null;
  return {
    assetType: "novel_cover",
    contractVersion: Math.max(1, Number(value.contractVersion) || NOVEL_COVER_CONTRACT_VERSION),
    bookTitle: clean(value.bookTitle, 100),
    authorName: clean(value.authorName, 100),
    platform: clean(value.platform, 80),
    aspectRatio: clean(value.aspectRatio, 20),
    directionId: clean(value.directionId, 80),
    directionLabel: clean(value.directionLabel, 100),
    safeArea: value.safeArea && typeof value.safeArea === "object" ? {
      unit: value.safeArea.unit === "percent" ? "percent" : "percent",
      left: Math.max(0, Number(value.safeArea.left) || 8),
      right: Math.max(0, Number(value.safeArea.right) || 8),
      top: Math.max(0, Number(value.safeArea.top) || 8),
      bottom: Math.max(0, Number(value.safeArea.bottom) || 10),
      titleBand: value.safeArea.titleBand && typeof value.safeArea.titleBand === "object" ? {
        start: Math.max(0, Number(value.safeArea.titleBand.start) || 10),
        end: Math.min(100, Number(value.safeArea.titleBand.end) || 32),
      } : { start: 10, end: 32 },
      authorBand: value.safeArea.authorBand && typeof value.safeArea.authorBand === "object" ? {
        start: Math.max(0, Number(value.safeArea.authorBand.start) || 78),
        end: Math.min(100, Number(value.safeArea.authorBand.end) || 88),
      } : { start: 78, end: 88 },
    } : createNovelCoverDesignContract().safeArea,
  };
};

export const novelCoverCompilerInstruction = (contract = {}) => {
  const validation = validateNovelCoverDesignContract(contract);
  if (!validation.valid) return "";
  return [
    `这是小说封面成品任务。书名必须精确为“${contract.bookTitle}”，作者名必须精确为“${contract.authorName}”。`,
    `目标平台：${contract.platform}；画幅：${contract.aspectRatio}。`,
    `文字安全区：左右各 ${contract.safeArea.left}%/${contract.safeArea.right}%，顶部 ${contract.safeArea.top}%，底部 ${contract.safeArea.bottom}%；标题位于画面高度 ${contract.safeArea.titleBand.start}%—${contract.safeArea.titleBand.end}%，作者名位于 ${contract.safeArea.authorBand.start}%—${contract.safeArea.authorBand.end}%。`,
    "标题与作者名不得遮挡面部、关键动作和核心意象；必须保留清晰层级与缩略图可读性。",
    "若生图模型不能可靠输出精确中文，生成无乱码、留足文字安全区的干净底图，并保留标题和作者名的后期叠加位置，不得用伪文字冒充。",
  ].join("\n");
};
