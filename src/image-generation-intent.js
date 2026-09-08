import { mediaIntentClauseIsBlocked, splitMediaIntentClauses } from "./media-generation-intent-guards.js";

const PROMPT_EXECUTION = /(?:根据|按照|使用|用|拿|把|将)[^。！？!?\n]{0,36}(?:提示词|prompt)[^。！？!?\n]{0,24}(?:生成\s*(?:(?:\d+|[一二三四五六七八九十]+)\s*)?(?:图片|图像|插画|海报|封面|头像|壁纸|照片|画面|角色图|场景图)|生图|出图|画出|画图|绘制|渲染|转成(?:一张)?(?:图片|图像|图)|转换成(?:一张)?(?:图片|图像|图))|(?:提示词|prompt)[^。！？!?\n]{0,24}(?:直接)?(?:生成\s*(?:(?:\d+|[一二三四五六七八九十]+)\s*)?(?:图片|图像)|生图|出图|画出来|绘制出来|渲染)|(?:生成图片|生成图像|生图|出图)[，,:：]\s*(?:提示词|prompt)/i;
const ANAPHORIC_PROMPT_IMAGE_EXECUTION = /(?:生成|创建|绘制|画出|制作|渲染|输出)[^。！？!?\n]{0,12}(?:上面|上方|上述|以上|前面|刚才|上文|这些|那些)[^。！？!?\n]{0,16}(?:提示词|内容|清单|资产|描述)[^。！？!?\n]{0,8}(?:(?:所)?对应(?:的)?|相应(?:的)?|配套(?:的)?|匹配(?:的)?|的)?[^。！？!?\n]{0,6}(?:图片|图像|插画|视觉资产|成品图)|(?:生成|创建|绘制|画出|制作|渲染|输出)[^。！？!?\n]{0,36}(?:上面|上方|上述|以上|前面|刚才|上文|这些|那些)?[^。！？!?\n]{0,16}(?:提示词|内容|清单|资产|描述)[^。！？!?\n]{0,20}(?:对应|相应|配套|匹配)[^。！？!?\n]{0,10}(?:图片|图像|插画|视觉资产|成品图)/i;
const PROMPT_ONLY = /(?:生成|写|撰写|制作|创作|输出|整理|优化|改写|润色|完善)[^。！？!?\n]{0,18}(?:图片|图像|绘画|生图|视觉资产|视频)?提示词|(?:write|create|generate|improve|rewrite)\s+(?:an?\s+)?(?:image\s+)?prompt/i;
const DIAGNOSTIC_OR_METHOD = /(?:如何|怎么|为什么|为何|原因|失败|报错|不可用|无法)[^。！？!?\n]{0,64}(?:图片|图像|插画|视觉资产|成品图|生图|出图)|(?:how|why|whether|can\s+it|is\s+it\s+possible)[^.!?\n]{0,36}(?:generate|create|render|draw)[^.!?\n]{0,18}(?:image|picture|poster)/i;
const TEXTUAL_IMAGE_DELIVERABLE = /(?:图片|图像|视觉|生图)[^。！？!?\n]{0,12}(?:提示词|文案|文章|教程|方法|方案|说明|分析|报告|列表)|(?:prompt|image)[^.!?\n]{0,16}(?:article|tutorial|guide|analysis|report|copy)/i;
const DIRECT_IMAGE_OUTPUT = /(?:生成|创建|绘制|重绘|画出|画|制作|创作|渲染|输出|出)(?:给我|一下|一张|一幅|一个|几张|几幅|多张|这张|这幅|成|为|出)?[^。！？!?\n]{0,48}(?:图片|图像|插画|海报|封面(?:图)?|头像|壁纸|照片|画面|人物图|角色图|场景图|视觉图|成品图|效果图|logo|标志)|(?:生成|绘制|重绘|画出|画|出)(?:给我|一下)?(?:一张|一幅|几张|几幅|多张)[^。！？!?\n]{0,40}图|(?:生图|出图|画出来|绘制出来|渲染成图)|(?:把|将)[^。！？!?\n]{0,48}(?:图片|图像|插画|海报|封面(?:图)?|头像|壁纸|照片|画面|人物图|成品图|效果图|这张图)[^。！？!?\n]{0,24}(?:重绘(?:为|成)?|重新生成(?:为|成)?|重新绘制(?:为|成)?)|(?:把|将|根据|按照)[^。！？!?\n]{1,80}(?:画出来|绘制成|生成成?|制作成|转成|转换成)(?:一张)?(?:图片|图像|插画|海报|封面(?:图)?|头像|壁纸|照片|画面|人物图|成品图|效果图|图)/i;
const REQUESTED_IMAGE_OUTPUT = /(?:给我|我要|我想要|来|给出|交付|提供)(?:看)?(?:一张|一幅|一组|几张|多张)[^。！？!?\n]{0,40}(?:图片|图像|插画|海报|封面(?:图)?|头像|壁纸|照片|画面|人物图|角色图|场景图|视觉图|成品图|效果图|图)/i;
const OBJECT_FIRST_IMAGE_OUTPUT = /(?:这些|那些|上述|上面|以上|前面|刚才|其余|剩下(?:的)?)[^。！？!?\n]{0,16}(?:图片|图像|插画|视觉资产|资产)[^。！？!?\n]{0,36}(?:都|全部|逐一|分别|依次|批量)?[^。！？!?\n]{0,12}(?:生成出来|生成|出图|画出来|绘制出来)/i;
const CORRECTIVE_IMAGE_OUTPUT = /(?:我)?(?:需要|要|想要)(?:的)?(?:是)?(?:实际|真正|直接可用|成品)?(?:图片|图像|插画|视觉资产|成品图)(?:\s*$|[，,。！!？?])/i;
const RECOVERY_IMAGE_EXECUTION = /(?:图片|图像|插画|视觉资产|成品图|附件)[^。！？!?\n]{0,48}(?:未|没|没有|失败|丢失|缺失)[^。！？!?\n]{0,36}(?:重新|再次|再来|重试)(?:生成|出图|画|绘制|渲染)|(?:重新|再次|再来|重试)(?:生成|出图|画|绘制|渲染)[^。！？!?\n]{0,36}(?:图片|图像|插画|视觉资产|成品图)/i;
const ENGLISH_IMAGE_OUTPUT = /\b(?:generate|create|render|draw|make|design)\s+(?:me\s+)?(?:an?|the|this|that|some|\d+)?\s*(?:image|picture|illustration|poster|cover|portrait|wallpaper|photo|scene|logo)\b/i;
const NEGATED_IMAGE_ACTION = /(?:不要|不需要|无需|暂不|先不|禁止|停止|取消|并非|不是|不想)|(?:^|[，,。！？!?；;\s])(?:请)?别|\b(?:do\s+not|don't|dont|no\s+need\s+to|never)\b/i;

const hasUnnegatedImageAction = (text, pattern) => {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matcher = new RegExp(pattern.source, flags);
  return [...String(text).matchAll(matcher)].some((match) => {
    const index = Number(match.index) || 0;
    const prefixWindow = String(text).slice(Math.max(0, index - 24), index);
    const clausePrefix = prefixWindow.split(/[，,。！？!?；;\n]/).at(-1) ?? "";
    return !NEGATED_IMAGE_ACTION.test(clausePrefix);
  });
};

const hasObjectFirstImageAction = (text) => {
  const match = String(text).match(OBJECT_FIRST_IMAGE_OUTPUT);
  if (!match) return false;
  return !/(?:不要|不需要|无需|先不|别|禁止|停止|取消)[^。！？!?\n]{0,8}(?:生成|出图|画|绘制)/i.test(match[0]);
};

export const isImageGenerationIntent = (value = "") => {
  const text = String(value ?? "").trim();
  if (!text) return false;
  // Recovery instructions commonly put the missing attachment and “重新生成”
  // on opposite sides of a comma. Recognize the complete instruction before
  // clause splitting so that relation is not discarded.
  if (hasUnnegatedImageAction(text, RECOVERY_IMAGE_EXECUTION) && !mediaIntentClauseIsBlocked(text, "image")) return true;
  return splitMediaIntentClauses(text).some((clause) => {
    const segment = clause.trim();
    if (!segment) return false;
    if (mediaIntentClauseIsBlocked(segment, "image")) return false;
    if (DIAGNOSTIC_OR_METHOD.test(segment)) return false;
    const executesPrompt = hasUnnegatedImageAction(segment, PROMPT_EXECUTION)
      || hasUnnegatedImageAction(segment, ANAPHORIC_PROMPT_IMAGE_EXECUTION);
    const executesDirectly = hasUnnegatedImageAction(segment, DIRECT_IMAGE_OUTPUT)
      || hasUnnegatedImageAction(segment, REQUESTED_IMAGE_OUTPUT)
      || hasUnnegatedImageAction(segment, ENGLISH_IMAGE_OUTPUT);
    if (PROMPT_ONLY.test(segment)) return false;
    if (TEXTUAL_IMAGE_DELIVERABLE.test(segment) && !executesPrompt && !executesDirectly) return false;
    if (executesPrompt) return true;
    if (hasUnnegatedImageAction(segment, RECOVERY_IMAGE_EXECUTION)) return true;
    if (hasObjectFirstImageAction(segment)) return true;
    if (CORRECTIVE_IMAGE_OUTPUT.test(segment) && !NEGATED_IMAGE_ACTION.test(segment)) return true;
    return executesDirectly;
  });
};
