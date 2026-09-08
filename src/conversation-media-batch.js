const STRUCTURED_ASSET_HEADING = /^(?:#{1,6}\s*)?(?:\*\*)?([A-Z]{1,4}\d{2,3})\s*[｜|:：\-]\s*(.+?)(?:\*\*)?\s*$/gmu;
const STRUCTURED_VIDEO_ASSET_HEADING = /^(?:#{1,6}\s*)?(?:\*\*)?(?:(?:视频|镜头|片段|分镜)\s*)?(?:(?:V|VID|VIDEO)[-_ ]?)?(\d{1,3})\s*[｜|:：\-]\s*(.+?)(?:\*\*)?\s*$/gmu;
const NUMBERED_ASSET_HEADING = /^(?:#{1,4}\s*)?(\d{1,3})\s*[.、．)]\s*(?:\*\*)?(.+?)(?:\*\*)?\s*$/gmu;
const NUMBERED_ASSET_SECTION = /^(?:#{1,4}\s*)?(?:\*\*)?([一二三四五六七八九十百]+)\s*[、.．)]\s*(.+?)(?:\*\*)?\s*$/gmu;
const ANY_MARKDOWN_HEADING = /^#{1,6}\s+/mu;
const GLOBAL_VISUAL_SPECIFICATION_HEADING = /^(?:#{1,6}\s*)?(?:\*\*)?(?:(?:0?1\s*[｜|:：\-]\s*)?(?:全局|统一|通用|整体)(?:视觉规范|视觉基线|风格规范|风格基线)|视觉统一规范|统一风格锚点)(?:\*\*)?\s*$/mu;
const BATCH_IMAGE_REQUEST = /(?:这些|那些|上述|上面|以上|前面|刚才|其余|剩下(?:的)?)[^。！？!?\n]{0,24}(?:图片|图像|插画|视觉资产|资产)[^。！？!?\n]{0,32}(?:都|全部|逐一|分别|依次|批量)?[^。！？!?\n]{0,12}(?:生成(?:出来)?|出图|画出来|绘制出来)|(?:批量|逐一|分别|依次)[^。！？!?\n]{0,16}(?:生成|出图|绘制)/u;
const BATCH_VIDEO_REQUEST = /(?:这些|那些|上述|上面|以上|前面|刚才|其余|剩下(?:的)?)[^。！？!?\n]{0,24}(?:视频|短片|动画|动态影像|镜头片段)[^。！？!?\n]{0,32}(?:都|全部|逐一|分别|依次|批量)?[^。！？!?\n]{0,12}(?:生成(?:出来)?|制作|输出|做出来)|(?:批量|逐一|分别|依次)[^。！？!?\n]{0,16}(?:生成|制作|输出|做)(?:[^。！？!?\n]{0,10})(?:视频|短片|动画|镜头片段)/u;
const ANAPHORIC_IMAGE_REQUEST = /(?:生成|创建|绘制|画出|制作|渲染|输出)[^。！？!?\n]{0,12}(?:上面|上方|上述|以上|前面|刚才|上文|这些|那些)[^。！？!?\n]{0,16}(?:提示词|内容|清单|资产|描述)[^。！？!?\n]{0,8}(?:(?:所)?对应(?:的)?|相应(?:的)?|配套(?:的)?|匹配(?:的)?|的)?[^。！？!?\n]{0,6}(?:图片|图像|插画|视觉资产|成品图)|(?:生成|创建|绘制|画出|制作|渲染|输出)[^。！？!?\n]{0,48}(?:对应|相应|配套|匹配)[^。！？!?\n]{0,12}(?:图片|图像|插画|视觉资产|成品图)|(?:把|将)?(?:上面|上方|上述|以上|前面|刚才|上文|这些|那些)[^。！？!?\n]{0,36}(?:提示词|内容|清单|资产|描述)?[^。！？!?\n]{0,20}(?:逐一|分别|依次|批量)?(?:生成|创建|绘制|画出|制作|渲染|出图)[^。！？!?\n]{0,12}(?:图片|图像|插画|视觉资产|成品图)?/u;
const ANAPHORIC_VIDEO_REQUEST = /(?:生成|创建|制作|输出|做)[^。！？!?\n]{0,16}(?:上面|上方|上述|以上|前面|刚才|上文|这些|那些)[^。！？!?\n]{0,20}(?:提示词|内容|清单|描述|镜头|分镜|片段)[^。！？!?\n]{0,16}(?:对应|相应|配套|匹配|的)?[^。！？!?\n]{0,10}(?:视频|短片|动画|镜头片段)|(?:把|将)?(?:上面|上方|上述|以上|前面|刚才|上文|这些|那些)[^。！？!?\n]{0,36}(?:提示词|内容|清单|描述|镜头|分镜|片段)?[^。！？!?\n]{0,20}(?:逐一|分别|依次|批量)?(?:生成|制作|输出|做)[^。！？!?\n]{0,12}(?:视频|短片|动画|镜头片段)/u;
const CONTEXTUAL_IMAGE_EXECUTION = /(?:生成|创建|绘制|画出|制作|渲染|输出|生图|出图)[^。！？!?\n]{0,24}(?:图片|图像|插画|视觉资产|成品图|效果图)?|(?:我)?(?:需要|要|想要)(?:的)?(?:是)?(?:实际|真正|直接可用|成品)?(?:图片|图像|插画|视觉资产|成品图)/u;
const CONTEXTUAL_VIDEO_EXECUTION = /(?:生成|创建|制作|输出|做|渲染)[^。！？!?\n]{0,28}(?:视频|短片|动画|动态影像|镜头片段)|(?:我)?(?:需要|要|想要)(?:的)?(?:是)?(?:实际|真正|直接可用|成品)?(?:视频|短片|动画|镜头片段)/u;
const CONTEXTUAL_IMAGE_NOISE = /(?:我|请|麻烦|帮忙|帮我|给我|需要|想要|要的|要|的是|应该是|是|实际|真正|直接可用|直接|现在|这次|就|只|全部|所有|都|批量|逐一|分别|依次|对应|相应|配套|匹配|上面|上方|上述|以上|前面|刚才|上文|这些|那些|内容|结果|提示词|清单|描述|资产|视觉资产|成品图|效果图|图片|图像|插画|生成|创建|绘制|画出|制作|渲染|输出|生图|出图|出来|而不是|不是)/gu;
const VISUAL_DESCRIPTION_SIGNAL = /视觉|图片|图像|提示词|画面|镜头|构图|景别|风格|电影感|材质|质感|颜色|色调|光线|灯光|阴影|背景|前景|全身|侧面|正面|服装|发型|表情|姿态|场景|环境|建筑|道具|武器|载具|炮台|导弹|雷达|机甲|人物|角色|生物|巨物|森林|城市|天空|夜空|雨夜|剪影|轮廓|形态|结构|设计|钢铁|高墙/u;
const NON_VISUAL_NUMBERED_TITLE = /^(?:步骤|说明|注意|要求|规则|总结|建议|方案|流程|原因|问题|结论|检查|设置|安装|操作)(?:\s|$|[:：])/u;
const STANDALONE_DESCRIPTION_AFTER_SEPARATOR = /[：:]\s*([\s\S]{10,})$/u;

export const conversationImageRequestUsesBatchDirectory = (requestCount = 0) => Math.max(0, Number(requestCount) || 0) > 1;

const normalizeMatchText = (value = "") => String(value)
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]/gu, "");

const messageCreativeText = (message = {}) => {
  const candidateDocuments = Array.isArray(message.candidateDocuments)
    ? message.candidateDocuments.map((item) => item?.content).filter(Boolean).join("\n\n")
    : "";
  return [message.candidate, candidateDocuments, message.generationPrompt, message.content]
    .map((value) => String(value || "").trim())
    .sort((left, right) => right.length - left.length)[0] || "";
};

const assistantMessageIsGeneratedMedia = (message = {}) => Boolean(
  message.mediaBatch
  || message.execution?.mediaBatch
  || message.execution?.generationJobId
  || (Array.isArray(message.generatedImages) && message.generatedImages.length)
  || (Array.isArray(message.generatedVideos) && message.generatedVideos.length)
  || (Array.isArray(message.generatedAudios) && message.generatedAudios.length)
  || ["image", "video", "audio"].includes(String(message.execution?.strength || "")),
);

const globalVisualSpecification = (text = "") => {
  const source = String(text || "");
  const heading = GLOBAL_VISUAL_SPECIFICATION_HEADING.exec(source);
  if (!heading) return "";
  const start = Number(heading.index) || 0;
  const bodyStart = start + heading[0].length;
  const tail = source.slice(bodyStart);
  const nextMarkdownHeading = tail.search(ANY_MARKDOWN_HEADING);
  const nextAssetHeading = tail.search(new RegExp(STRUCTURED_ASSET_HEADING.source, "mu"));
  const boundaries = [nextMarkdownHeading, nextAssetHeading].filter((index) => index >= 0);
  const end = boundaries.length ? bodyStart + Math.min(...boundaries) : source.length;
  return source.slice(start, end).trim().slice(0, 4_000);
};

export const parseStructuredImageAssetItems = (value = "") => {
  const text = String(value || "").replace(/\r\n?/g, "\n");
  const globalSpecification = globalVisualSpecification(text);
  const matches = [...text.matchAll(STRUCTURED_ASSET_HEADING)];
  return matches.map((match, index) => {
    const code = String(match[1] || "").trim();
    const title = String(match[2] || "").replace(/^\*+|\*+$/g, "").trim();
    const bodyStart = Number(match.index) + match[0].length;
    const nextHeading = text.slice(bodyStart).search(ANY_MARKDOWN_HEADING);
    const nextAsset = index + 1 < matches.length ? Number(matches[index + 1].index) : text.length;
    const bodyEnd = Math.min(nextAsset, nextHeading >= 0 ? bodyStart + nextHeading : text.length);
    const body = text.slice(bodyStart, bodyEnd).trim();
    const assetPrompt = [`${code}｜${title}`, body].filter(Boolean).join("\n");
    return {
      code,
      title,
      label: `${code}｜${title}`,
      prompt: [globalSpecification, assetPrompt].filter(Boolean).join("\n\n").slice(0, 14_000),
    };
  }).filter((item) => item.prompt.length >= 20);
};

export const parseStructuredVideoAssetItems = (value = "") => {
  const text = String(value || "").replace(/\r\n?/g, "\n");
  const globalSpecification = globalVisualSpecification(text);
  const matches = [...text.matchAll(STRUCTURED_VIDEO_ASSET_HEADING)];
  return matches.map((match, index) => {
    const number = Math.max(1, Number(match[1]) || index + 1);
    const title = String(match[2] || "").replace(/^\*+|\*+$/g, "").trim();
    const bodyStart = Number(match.index) + match[0].length;
    const nextHeading = text.slice(bodyStart).search(ANY_MARKDOWN_HEADING);
    const nextAsset = index + 1 < matches.length ? Number(matches[index + 1].index) : text.length;
    const bodyEnd = Math.min(nextAsset, nextHeading >= 0 ? bodyStart + nextHeading : text.length);
    const body = text.slice(bodyStart, bodyEnd).trim();
    const code = `V${String(number).padStart(2, "0")}`;
    const assetPrompt = [`${code}｜${title}`, body].filter(Boolean).join("\n");
    return {
      code,
      title,
      label: `${code}｜${title}`,
      prompt: [globalSpecification, assetPrompt].filter(Boolean).join("\n\n").slice(0, 14_000),
    };
  }).filter((item) => item.title.length >= 2 && item.prompt.length >= 12);
};

export const parseNumberedImageAssetItems = (value = "") => {
  const text = String(value || "").replace(/\r\n?/g, "\n");
  const matches = [...text.matchAll(NUMBERED_ASSET_HEADING)];
  if (matches.length < 2) return [];
  const sections = [...text.matchAll(NUMBERED_ASSET_SECTION)].map((match, index) => ({
    index: Number(match.index) || 0,
    end: (Number(match.index) || 0) + match[0].length,
    code: `S${String(index + 1).padStart(2, "0")}`,
    ordinal: String(match[1] || "").trim(),
    title: String(match[2] || "").replace(/^\*+|\*+$/g, "").trim(),
    heading: String(match[0] || "").trim(),
  }));
  const firstBoundary = Math.min(
    Number(matches[0].index) || 0,
    sections[0]?.index ?? Number.POSITIVE_INFINITY,
  );
  const sharedContext = text.slice(0, Number.isFinite(firstBoundary) ? firstBoundary : 0).trim().slice(-4_000);
  const items = matches.map((match, index) => {
    const number = Math.max(1, Number(match[1]) || index + 1);
    const title = String(match[2] || "").replace(/^\*+|\*+$/g, "").trim();
    const matchIndex = Number(match.index) || 0;
    const section = [...sections].reverse().find((candidate) => candidate.index < matchIndex) || null;
    const bodyStart = Number(match.index) + match[0].length;
    const nextItemIndex = index + 1 < matches.length ? Number(matches[index + 1].index) : text.length;
    const nextSectionIndex = sections.find((candidate) => candidate.index > matchIndex)?.index ?? text.length;
    const bodyEnd = Math.min(nextItemIndex, nextSectionIndex);
    const body = text.slice(bodyStart, bodyEnd).trim();
    const sectionLabel = section?.title || "";
    return {
      number,
      code: `${section?.code || "N"}N${String(number).padStart(2, "0")}`,
      title,
      label: [sectionLabel, `${number}. ${title}`].filter(Boolean).join(" · "),
      body,
      prompt: [sharedContext, section?.heading || "", `${number}. ${title}`, body].filter(Boolean).join("\n\n").slice(0, 14_000),
    };
  }).filter((item) => (
    item.title.length >= 2
    && item.title.length <= 96
    && item.body.length >= 12
    && !NON_VISUAL_NUMBERED_TITLE.test(item.title)
  ));
  if (items.length < 2) return [];
  const visualItemCount = items.filter((item) => VISUAL_DESCRIPTION_SIGNAL.test(`${item.title}\n${item.body}`)).length;
  if (!VISUAL_DESCRIPTION_SIGNAL.test(text) && visualItemCount < Math.ceil(items.length / 2)) return [];
  return items.map(({ body: _body, number: _number, ...item }) => item);
};

const parseImageAssetItems = (value = "") => {
  const structured = parseStructuredImageAssetItems(value);
  return structured.length ? structured : parseNumberedImageAssetItems(value);
};

const parseVideoAssetItems = (value = "") => {
  const videoStructured = parseStructuredVideoAssetItems(value);
  if (videoStructured.length) return videoStructured;
  const genericStructured = parseStructuredImageAssetItems(value);
  return genericStructured.length ? genericStructured : parseNumberedImageAssetItems(value);
};

export const isAnaphoricConversationImageRequest = (instruction = "") => (
  ANAPHORIC_IMAGE_REQUEST.test(String(instruction || "").trim())
);

export const isAnaphoricConversationVideoRequest = (instruction = "") => (
  ANAPHORIC_VIDEO_REQUEST.test(String(instruction || "").trim())
);

export const isImplicitConversationImageContinuation = (instruction = "") => {
  const text = String(instruction || "").trim();
  if (!text || !CONTEXTUAL_IMAGE_EXECUTION.test(text)) return false;
  const remainder = text
    .replace(/(?:\d{1,3}|[一二三四五六七八九十百]+)\s*张/gu, "")
    .replace(CONTEXTUAL_IMAGE_NOISE, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  return remainder.length === 0;
};

export const isImplicitConversationVideoContinuation = (instruction = "") => {
  const text = String(instruction || "").trim();
  if (!text || !CONTEXTUAL_VIDEO_EXECUTION.test(text)) return false;
  // A plain “制作一个视频” is a direct request, not a request to reuse
  // prior prompts. Continuation requires an explicit contextual reference.
  if (!/(?:上面|上方|上述|以上|前面|刚才|上文|这些|那些|对应|相应|配套|匹配|实际|真正|直接可用)/u.test(text)) return false;
  const remainder = text
    .replace(/(?:\d{1,3}|[一二三四五六七八九十百]+)\s*(?:个|段|条)?\s*(?:视频|短片|动画|镜头片段)/gu, "")
    .replace(/(?:我|请|麻烦|帮忙|帮我|给我|需要|想要|要|的是|应该是|是|实际|真正|直接可用|直接|现在|这次|就|只|全部|所有|都|批量|逐一|分别|依次|对应|相应|配套|匹配|上面|上方|上述|以上|前面|刚才|上文|这些|那些|内容|结果|提示词|清单|描述|镜头|分镜|片段|视频|短片|动画|生成|创建|制作|输出|做|渲染|出来|而不是|不是)/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  return remainder.length === 0;
};

export const hasStandaloneConversationImageDescription = (instruction = "") => {
  const description = String(instruction || "").match(STANDALONE_DESCRIPTION_AFTER_SEPARATOR)?.[1]?.trim() || "";
  return description.length >= 10 && VISUAL_DESCRIPTION_SIGNAL.test(description);
};

const exclusionPhrases = (instruction = "") => {
  const text = String(instruction || "");
  const phrases = [];
  for (const pattern of [
    /除了\s*([^，。；!?！？\n]{1,48}?)(?=(?:都|全部|其余|之外|以外|外|不要|不生成|生成|出图))/gu,
    /(?:不要|不生成|排除)\s*([^，。；!?！？\n]{1,48})/gu,
  ]) {
    for (const match of text.matchAll(pattern)) phrases.push(String(match[1] || ""));
  }
  const needles = [];
  for (const phrase of phrases.flatMap((item) => item.split(/[、,，和及与/]/u))) {
    const normalized = normalizeMatchText(phrase);
    if (normalized) needles.push(normalized);
    const withoutGenericRole = normalizeMatchText(phrase.replace(/(?:主角|角色|人物|图片|图像|插画|视觉资产|资产|相关|所有)/gu, ""));
    if (withoutGenericRole) needles.push(withoutGenericRole);
  }
  return [...new Set(needles)].filter((item) => item.length >= 2);
};

const explicitImageCount = (instruction = "") => {
  const text = String(instruction || "");
  const arabic = text.match(/(?:生成|出|画|绘制)\s*(\d{1,2})\s*张/u);
  if (arabic) return Math.max(1, Math.min(64, Number(arabic[1]) || 1));
  const chinese = text.match(/(?:生成|出|画|绘制)\s*([两二三四五六七八九十])\s*张/u)?.[1];
  const values = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return values[chinese] || 1;
};

const explicitVideoCount = (instruction = "") => {
  const text = String(instruction || "");
  const match = text.match(/(?:生成|制作|创建|输出|做)\s*(\d{1,2}|[两二三四五六七八九十])\s*(?:个|段|条)?\s*(?:视频|短片|动画|镜头片段)/u);
  if (!match) return 1;
  const values = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  return Math.max(1, Math.min(32, Number(match[1]) || values[match[1]] || 1));
};

export const isConversationImageBatchRequest = (instruction = "") => {
  const text = String(instruction || "").trim();
  return BATCH_IMAGE_REQUEST.test(text)
    || isAnaphoricConversationImageRequest(text)
    || isImplicitConversationImageContinuation(text)
    || conversationImageRepeatRequest(text)
    || parseImageAssetItems(text).length > 1
    || explicitImageCount(text) > 1;
};

export const isConversationVideoBatchRequest = (instruction = "") => {
  const text = String(instruction || "").trim();
  const hasVideoOutput = /(?:视频|短片|动画|动态影像|镜头片段)/u.test(text);
  return hasVideoOutput && (
    BATCH_VIDEO_REQUEST.test(text)
    || isAnaphoricConversationVideoRequest(text)
    || isImplicitConversationVideoContinuation(text)
    || parseVideoAssetItems(text).length > 1
    || explicitVideoCount(text) > 1
  );
};

export const planConversationImageBatch = ({ instruction = "", messages = [], maxItems = 64 } = {}) => {
  const text = String(instruction || "").trim();
  if (!isConversationImageBatchRequest(text)) return [];
  const anaphoric = isAnaphoricConversationImageRequest(text);
  const implicitContinuation = isImplicitConversationImageContinuation(text);
  const repeatPrevious = conversationImageRepeatRequest(text);
  const contextualContinuation = anaphoric || implicitContinuation || repeatPrevious;
  const standaloneDescription = hasStandaloneConversationImageDescription(text);
  const currentItems = parseImageAssetItems(text);
  let items = currentItems;
  let priorSource = "";
  let sourceMessageIndex = -1;
  const messageList = Array.isArray(messages) ? messages : [];
  if (repeatPrevious) {
    const generatedMediaIndex = [...messageList].map((message, index) => ({ message, index })).reverse()
      .find(({ message }) => message?.role === "assistant" && message?.pending !== true && assistantMessageIsGeneratedMedia(message))?.index ?? -1;
    if (generatedMediaIndex > 0) {
      const previousUser = [...messageList.slice(0, generatedMediaIndex)].reverse().find((message) => message?.role === "user") || null;
      priorSource = messageCreativeText(previousUser);
      sourceMessageIndex = previousUser ? messageList.indexOf(previousUser) : -1;
    }
  }
  if (!priorSource && items.length < 2 && !standaloneDescription && (contextualContinuation || BATCH_IMAGE_REQUEST.test(text))) {
    const priorCandidates = [...messageList]
      .map((message, messageIndex) => ({ message, messageIndex }))
      .reverse()
      .filter(({ message }) => message?.role === "assistant" && message?.pending !== true)
      .map(({ message, messageIndex }) => {
        const source = messageCreativeText(message);
        return {
          source,
          messageIndex,
          sourceMessageId: String(message?.id || ""),
          generatedMedia: assistantMessageIsGeneratedMedia(message),
          items: parseImageAssetItems(source),
        };
      })
      .filter((candidate) => candidate.source);
    const nonMediaPriorCandidates = priorCandidates.filter((candidate) => !candidate.generatedMedia);
    const contextualCandidates = implicitContinuation ? nonMediaPriorCandidates.slice(0, 4) : priorCandidates;
    const structuredSource = contextualCandidates.find((candidate) => !candidate.generatedMedia && candidate.items.length > 1);
    items = (structuredSource?.items || []).map((item) => ({
      ...item,
      ...(structuredSource?.sourceMessageId ? { sourceMessageId: structuredSource.sourceMessageId } : {}),
    }));
    sourceMessageIndex = Number.isInteger(structuredSource?.messageIndex) ? structuredSource.messageIndex : -1;
    priorSource = structuredSource?.source
      || contextualCandidates.find((candidate) => (
        !candidate.generatedMedia
        && candidate.source.length >= 20
        && VISUAL_DESCRIPTION_SIGNAL.test(candidate.source)
      ))?.source
      || contextualCandidates.find((candidate) => (
        candidate.source.length >= 20
        && VISUAL_DESCRIPTION_SIGNAL.test(candidate.source)
      ))?.source
      || "";
  }
  const sourceRequest = sourceMessageIndex > 0
    ? [...messageList.slice(0, sourceMessageIndex)].reverse().find((message) => message?.role === "user")?.content || ""
    : "";
  const excluded = exclusionPhrases(`${sourceRequest}\n${text}`);
  if (items.length > 1 || (contextualContinuation && items.length === 1)) {
    return items.filter((item) => {
      const identity = normalizeMatchText(`${item.code}${item.title}`);
      return !excluded.some((needle) => identity.includes(needle));
    }).map((item) => ({
      ...item,
      prompt: contextualContinuation && currentItems.length === 0
        ? `严格依据以下上文已确认的视觉提示词生成“${item.label}”。不得替换主体、添加无关商品或改成其他题材。\n\n${item.prompt}`.slice(0, 14_000)
        : item.prompt,
    })).slice(0, Math.max(1, Number(maxItems) || 64));
  }
  if (standaloneDescription) {
    const count = explicitImageCount(text);
    if (count <= 1) return [];
    return Array.from({ length: Math.min(count, Math.max(1, Number(maxItems) || 64)) }, (_, index) => ({
      code: `IMG${String(index + 1).padStart(2, "0")}`,
      title: `图片 ${index + 1}`,
      label: `图片 ${index + 1}`,
      prompt: text,
    }));
  }
  if (contextualContinuation && priorSource.length >= (repeatPrevious ? 4 : 20)) {
    return [{
      code: "CTX01",
      title: "上文视觉内容",
      label: "上文视觉内容",
      prompt: `严格依据以下上文内容生成对应视觉资产。保持其中的主体、场景、风格、材质、色彩与数量要求，不得替换成无关主题。\n\n${priorSource}`.slice(0, 14_000),
    }];
  }
  if (contextualContinuation) {
    return [{
      code: "CTX01",
      title: "上文视觉内容",
      label: "上文视觉内容",
      prompt: "",
      missingContext: true,
    }];
  }
  const count = explicitImageCount(text);
  if (count <= 1) return [];
  return Array.from({ length: Math.min(count, Math.max(1, Number(maxItems) || 64)) }, (_, index) => ({
    code: `IMG${String(index + 1).padStart(2, "0")}`,
    title: `图片 ${index + 1}`,
    label: `图片 ${index + 1}`,
    prompt: text,
  }));
};

export const planConversationVideoBatch = ({ instruction = "", messages = [], maxItems = 32 } = {}) => {
  const text = String(instruction || "").trim();
  if (!isConversationVideoBatchRequest(text)) return [];
  const anaphoric = isAnaphoricConversationVideoRequest(text);
  const implicitContinuation = isImplicitConversationVideoContinuation(text);
  const explicitCount = explicitVideoCount(text);
  const contextualContinuation = (anaphoric || implicitContinuation) && explicitCount <= 1;
  const currentItems = parseVideoAssetItems(text);
  let items = currentItems;
  let priorSource = "";
  const messageList = Array.isArray(messages) ? messages : [];
  if (items.length < 2 && (contextualContinuation || BATCH_VIDEO_REQUEST.test(text))) {
    const priorCandidates = [...messageList]
      .map((message) => ({ message, source: messageCreativeText(message) }))
      .reverse()
      .filter(({ message, source }) => message?.role === "assistant" && message?.pending !== true && source)
      .map(({ message, source }) => ({
        source,
        sourceMessageId: String(message?.id || ""),
        items: parseVideoAssetItems(source),
      }));
    const structuredSource = priorCandidates.find((candidate) => candidate.items.length > 1);
    items = (structuredSource?.items || []).map((item) => ({
      ...item,
      ...(structuredSource?.sourceMessageId ? { sourceMessageId: structuredSource.sourceMessageId } : {}),
    }));
    priorSource = structuredSource?.source
      || priorCandidates.find((candidate) => candidate.source.length >= 20 && VISUAL_DESCRIPTION_SIGNAL.test(candidate.source))?.source
      || "";
  }
  if (items.length > 1) {
    return items.slice(0, Math.max(1, Number(maxItems) || 32)).map((item) => ({
      ...item,
      prompt: contextualContinuation && currentItems.length === 0
        ? `严格依据以下上文已确认的视频提示词生成“${item.label}”。保持人物身份、场景空间、动作顺序、镜头语言与风格连续，不得替换成无关主题。\n\n${item.prompt}`.slice(0, 14_000)
        : item.prompt,
    }));
  }
  if (contextualContinuation && priorSource.length >= 20) {
    return [{
      code: "VCTX01",
      title: "上文视频内容",
      label: "上文视频内容",
      prompt: `严格依据以下上文内容生成对应视频资产，保持主体、动作、场景、镜头、节奏与风格一致。\n\n${priorSource}`.slice(0, 14_000),
    }];
  }
  if (contextualContinuation) {
    return [{ code: "VCTX01", title: "上文视频内容", label: "上文视频内容", prompt: "", missingContext: true }];
  }
  const count = explicitCount;
  if (count <= 1) return [];
  return Array.from({ length: Math.min(count, Math.max(1, Number(maxItems) || 32)) }, (_, index) => ({
    code: `VID${String(index + 1).padStart(2, "0")}`,
    title: `视频 ${index + 1}`,
    label: `视频 ${index + 1}`,
    prompt: text,
  }));
};
import { conversationImageRepeatRequest } from "./conversation-image-settings.js?v=0.45.0-conversation-parameter-selection";
