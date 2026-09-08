import { isImageGenerationIntent } from "./image-generation-intent.js";
import { isVideoGenerationIntent } from "./video-generation-intent.js";
import { splitMediaIntentClauses } from "./media-generation-intent-guards.js";

const TEXT_DELIVERABLE_ACTION = /(?:分析|诊断|排查|检查|解释|说明|总结|归纳|复盘|研究|评估|比较|对比|制定|给出|生成|整理|输出|撰写|写)(?:一下|一份|一个|具体的|完整的|详细的)?/i;
const TEXT_DELIVERABLE_NOUN = /(?:原因|问题|错误|漏洞|隐患|方案|建议|规则|方法|报告|总结|说明|教程|文档|文件|清单|脚本|提示词|文案|答复|回答|结论|正文|章节|小说|故事|剧本|大纲|设定|笔记)/i;
const MEDIA_OUTPUT_NOUN = /(?:图片|图像|插画|海报|封面|头像|壁纸|照片|画面|角色图|场景图|视觉图|视觉资产(?:图)?|成品图|效果图|logo|标志|视频|短片|动画|动态影像|镜头片段)/i;
const LANDING_ONLY = /(?:落盘|写入|插入|保存到|放到)(?:当前|对应|目标)?(?:文档|正文|作品|笔记)?/i;
const IMAGE_OUTPUT_NOUN = /(?:图片|图像|插画|海报|封面|头像|壁纸|照片|角色图|场景图|视觉图|视觉资产(?:图)?|成品图|效果图|logo|标志)/i;
const VIDEO_OUTPUT_NOUN = /(?:视频|短片|动画|动态影像|镜头片段)/i;
const IMAGE_OUTPUT_ACTION = /(?:生成|制作|创建|绘制|画|设计|出)(?:一张|一幅|一组|多张|\d+张|若干)?(?:[^，,。！？!?；;]{0,16})/i;
const VIDEO_OUTPUT_ACTION = /(?:生成|制作|创建|剪成|转成|改成|做成|合成|输出)(?:一段|一个|一条|\d+秒)?(?:[^，,。！？!?；;]{0,16})/i;
const GENERAL_CAPABILITY_ACTION = /(?:搜索|联网|查找|读取|分析|检查|诊断|解释|总结|整理|撰写|写|修改|修复|优化|重构|移动|复制|删除|打包|安装|打开|保存|落盘|导出|转换|执行)/i;
const GENERAL_CAPABILITY_TARGET = /(?:资料|参考|信息|网页|链接|代码|软件|界面|项目|目录|文件|文档|正文|章节|小说|故事|剧本|大纲|设定|笔记|报告|方案|清单|脚本|提示词|问题|错误|漏洞|输入框|按钮|任务)/i;

const clauses = (text) => splitMediaIntentClauses(text);

const independentTextDeliverables = (text) => clauses(text).filter((clause) => (
  TEXT_DELIVERABLE_ACTION.test(clause)
  && TEXT_DELIVERABLE_NOUN.test(clause)
  && !MEDIA_OUTPUT_NOUN.test(clause)
  && !LANDING_ONLY.test(clause)
));

const clauseOutputKind = (clause = "") => {
  const source = String(clause || "").trim();
  if (/(?:检查|排查|诊断|分析|解释|为什么|原因).{0,32}(?:失败|错误|问题|不可用|没生成|无法生成|不能生成)|(?:失败|错误|问题|不可用).{0,24}(?:原因|方案|建议|怎么|如何)/i.test(source)) return "text";
  // Reuse the executable-intent modules here. The previous noun/action
  // regexes also matched explanatory text such as “视频生成的原理”.
  if (isVideoGenerationIntent(source)) return "video";
  if (isImageGenerationIntent(source)) return "image";
  if (TEXT_DELIVERABLE_ACTION.test(source) && TEXT_DELIVERABLE_NOUN.test(source) && !LANDING_ONLY.test(source)) return "text";
  if (GENERAL_CAPABILITY_ACTION.test(source) && (GENERAL_CAPABILITY_TARGET.test(source) || MEDIA_OUTPUT_NOUN.test(source)) && !LANDING_ONLY.test(source)) return "text";
  return "";
};

const capabilitySteps = ({ text = "", imageIntent = false, videoIntent = false } = {}) => {
  const parsed = clauses(text).map((instruction, index) => ({
    kind: clauseOutputKind(instruction),
    instruction,
    index,
  })).filter((step) => step.kind);
  if (!parsed.length && imageIntent) {
    parsed.push({ kind: "image", instruction: String(text || "").trim(), index: parsed.length + 100 });
  }
  if (!parsed.length && videoIntent) {
    parsed.push({ kind: "video", instruction: String(text || "").trim(), index: parsed.length + 100 });
  }
  const ordered = parsed.sort((left, right) => left.index - right.index);
  const executable = ordered.length > 1 && ordered.every((step) => step.kind === "text")
    ? [{ kind: "text", instruction: String(text || "").trim(), index: 0 }]
    : ordered;
  return executable
    .map((step, index) => ({
      id: `step-${index + 1}`,
      kind: step.kind,
      channel: step.kind === "image" || step.kind === "video" ? step.kind : "",
      instruction: step.instruction,
      label: step.kind === "image" ? "图片生成" : step.kind === "video" ? "视频生成" : "文字任务",
    }));
};

export const arbitrateConversationIntent = ({ text = "", imageIntent = false, videoIntent = false } = {}) => {
  const steps = capabilitySteps({ text, imageIntent, videoIntent });
  if (steps.length > 1) {
    return {
      kind: "composite",
      directMediaChannel: "",
      capabilitySteps: steps,
      reason: `已按原始顺序拆分为 ${steps.length} 个能力步骤，必须逐项执行直到全部终止`,
    };
  }
  if (steps[0]?.kind === "image" || steps[0]?.kind === "video") {
    return {
      kind: "media",
      directMediaChannel: steps[0].channel,
      capabilitySteps: steps,
      reason: `存在唯一、明确的${steps[0].kind === "video" ? "视频" : "图片"}成品意图`,
    };
  }
  const textualDeliverables = independentTextDeliverables(text);
  return { kind: "text", directMediaChannel: "", capabilitySteps: steps, textualDeliverables, reason: "使用 Codex 通用或已命中的文字能力继续处理" };
};
