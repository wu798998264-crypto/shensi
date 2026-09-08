// “把上面的提示词都生成出来”本身没有声明视频产物。这里必须要求
// 明确的视频名词，否则图片/视觉资产批量请求会同时命中图片和视频通道。
const PROMPT_EXECUTION = /(?:根据|按照|使用|用|拿|把|将)[^。！？!?\n]{0,36}(?:提示词|prompt)[^。！？!?\n]{0,24}(?:生成(?:视频|短片|动画|镜头片段)|出视频|做成视频|转成视频)|(?:提示词|prompt)[^。！？!?\n]{0,24}(?:直接)?(?:生成视频|出视频|做视频|转视频)/i;
const PROMPT_ONLY = /(?:生成|写|撰写|制作|创作|输出|整理|优化|改写|润色|完善)[^。！？!?\n]{0,18}(?:视频|短片|动画|分镜)?提示词|(?:write|create|generate|improve|rewrite)\s+(?:a\s+)?video\s+prompt/i;
const DIAGNOSTIC_OR_METHOD = /(?:如何|怎么|为什么|为何|原因|失败|报错|不可用|无法)[^。！？!?\n]{0,28}(?:生成视频|出视频|制作视频)|(?:how|why|whether|can\s+it|is\s+it\s+possible)[^.!?\n]{0,36}(?:generate|create|render)[^.!?\n]{0,18}(?:video|clip|animation)/i;
const TEXTUAL_VIDEO_DELIVERABLE = /(?:视频|短片|动画)[^。！？!?\n]{0,12}(?:提示词|文案|脚本|教程|方法|方案|说明|分析|报告|列表)|(?:video|animation)[^.!?\n]{0,16}(?:prompt|script|tutorial|guide|analysis|report|copy)/i;
const DIRECT_VIDEO_OUTPUT = /(?:生成|创建|制作|创作|渲染|输出|做)(?:给我|一下|一段|一个|几段|多个|这段|成|为|出)?[^。！？!?\n]{0,48}(?:视频|短片|动画|动态影像|镜头片段|影片)|(?:出视频|做成视频|生成成?视频|转成视频)|(?:把|将|根据|按照)[^。！？!?\n]{1,80}(?:做成|生成成?|制作成|转成|转换成|变成)(?:视频|短片|动画|动态影像)/i;
const REQUESTED_VIDEO_OUTPUT = /(?:给我|我要|我想要|来|给出|交付|提供)(?:看)?(?:一段|一个|一条|几段|多个)[^。！？!?\n]{0,40}(?:视频|短片|动画|动态影像|镜头片段|影片)/i;
const ENGLISH_VIDEO_OUTPUT = /\b(?:generate|create|render|make|produce)\s+(?:me\s+)?(?:a|the|this|that|some|\d+)?\s*(?:video|clip|animation|movie)\b/i;

export const isVideoGenerationIntent = (value = "") => {
  const text = String(value ?? "").trim();
  if (!text) return false;
  return splitMediaIntentClauses(text).some((clause) => {
    if (mediaIntentClauseIsBlocked(clause, "video")) return false;
    const executesPrompt = PROMPT_EXECUTION.test(clause);
    const executesDirectly = DIRECT_VIDEO_OUTPUT.test(clause) || REQUESTED_VIDEO_OUTPUT.test(clause) || ENGLISH_VIDEO_OUTPUT.test(clause);
    if (PROMPT_ONLY.test(clause) || DIAGNOSTIC_OR_METHOD.test(clause)) return false;
    if (TEXTUAL_VIDEO_DELIVERABLE.test(clause) && !executesPrompt && !executesDirectly) return false;
    return executesPrompt || executesDirectly;
  });
};
import { mediaIntentClauseIsBlocked, splitMediaIntentClauses } from "./media-generation-intent-guards.js";
