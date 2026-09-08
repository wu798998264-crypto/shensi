export const IMAGE_ASSET_SOURCE_EXTRACTION_PATTERN = /(?:(?:从|根据|基于|读取|分析|扫描|提取|抽取|识别|整理).{0,56}(?:小说|剧本|章节|脚本|原文|正文|文本|视频提示词|分镜提示词|镜头提示词)|(?:小说|剧本|章节|脚本|原文|正文|文本|视频提示词|分镜提示词|镜头提示词)(?:中|里|内|中的|里的|以上)?.{0,48}(?:提取|抽取|识别|整理|转换|生成))/iu;

export const IMAGE_ASSET_EXTRACTION_OUTPUT_PATTERN = /(?:提取|抽取|识别|整理|拆分|拆成|转换|转化).{0,72}(?:(?:视觉|图片|图像|人物|角色|场景|环境|道具|物品|物件|服装|载具|生物|怪物)资产(?:提示词|总表)?|(?:人物|角色|场景|环境|地点|空间|建筑|道具|物品|物件|服装|载具|生物|怪物).{0,12}提示词|图片提示词|图像提示词)/iu;

export const isImageAssetSourceExtractionRequest = (text = "") => {
  const source = String(text || "");
  return IMAGE_ASSET_SOURCE_EXTRACTION_PATTERN.test(source)
    && IMAGE_ASSET_EXTRACTION_OUTPUT_PATTERN.test(source);
};
