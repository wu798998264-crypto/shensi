const CLAUSE_BREAK = /[，,。！？!?；;\n]+|(?:并且|同时|然后|随后|接着|以及)|并(?=(?:请|再|生成|创建|制作|绘制|画|渲染|输出|总结|归纳|分析|说明|检查|写|撰写))/u;

const MEDIA_WORDS = {
  image: /(?:图片|图像|插画|海报|封面(?:图)?|头像|壁纸|照片|画面|人物图|角色图|场景图|视觉图|视觉资产(?:图)?|成品图|效果图|logo|标志|生图|出图|(?:一|1|几|多|这|那|上|下)张图)/iu,
  video: /(?:视频|短片|动画|动态影像|镜头片段|影片|出视频)/iu,
};

const MEDIA_EXECUTION = {
  image: /(?:生成|创建|绘制|画出|画|制作|创作|渲染|输出|出图|生图)/iu,
  video: /(?:生成|创建|制作|创作|渲染|输出|做成|转成|变成|出视频)/iu,
};

const EXPLICIT_RETRY = /(?:重新|再次|重试|再来)(?:生成|制作|创建|绘制|画|渲染|输出|出图|生图|出视频)/iu;
const NEGATED_OR_STOPPED = /(?:不要|不需要|无需|暂不|先不|禁止|停止|取消|放弃|不想|并非|不是)[^，,。！？!?；;\n]{0,24}(?:生成|创建|制作|绘制|画|渲染|输出|出图|生图|出视频|做成|转成|变成)|(?:^|[，,。！？!?；;\s])(?:请)?别[^，,。！？!?；;\n]{0,24}(?:生成|创建|制作|绘制|画|渲染|输出|出图|生图|出视频|做成|转成|变成)|\b(?:do\s+not|don't|dont|no\s+need\s+to|never|stop|cancel)\b/iu;
const DEFERRED_OR_CONDITIONAL = /^(?:请问)?(?:如果|假如|假设|若|要是)|(?:等|待)[^，,。！？!?；;\n]{0,16}(?:确认|同意|审核|批准|准备好|连接好)[^，,。！？!?；;\n]{0,8}(?:后|之后|再)|(?:稍后|晚点|待会|过会儿|以后再|后面再|暂缓)[^，,。！？!?；;\n]{0,24}(?:生成|创建|制作|绘制|画|渲染|输出|出图|生图|出视频)/iu;
const PROMPT_OR_TEXT_DELIVERABLE = /(?:提示词|prompt|文案|文章|教程|方法|方案|说明|分析|报告|列表|清单|脚本|分镜|镜头设计)/iu;
const INFORMATION_ACTION = /(?:总结|归纳|复盘|比较|对比|评价|评估|说明|解释|列出|查看|查询|告诉|统计|记录|分析|诊断|排查|检查|研究|复制|剪切|移动|删除|重命名|下载|导出|管理|整理|找回|恢复)/iu;
const PROCESS_OR_METADATA = /(?:(?:生成|制作|创建|绘制|渲染|输出)(?:的|过的)?(?:图片|图像|插画|视频|短片|动画)|(?:图片|图像|插画|视频|短片|动画)(?:的)?(?:生成|制作|创建|绘制|渲染|输出))[^，,。！？!?；;\n]{0,16}(?:结果|状态|进度|时间|耗时|参数|模型|配置|额度|队列|失败|报错|错误|问题|原因|能力|流程|原理|记录|历史|提示|页面|按钮|工作方式|工作原理)/iu;
const MEDIA_TASK_STATUS = /(?:正在|已经|已|刚刚|刚才)[^，,。！？!?；;\n]{0,8}(?:生成|创建|制作|绘制|渲染|输出)[^，,。！？!?；;\n]{0,16}(?:图片|图像|插画|视频|短片|动画)|(?:生成|创建|制作|绘制|渲染|输出)(?:成功|完成|完毕)?(?:的)[^，,。！？!?；;\n]{0,8}(?:图片|图像|插画|视频|短片|动画)|(?:生成|创建|制作|绘制|渲染|输出)[^，,。！？!?；;\n]{0,16}(?:图片|图像|插画|视频|短片|动画)(?:中|过程中|进行中|排队中|找回中|回填中|成功|完成|完毕|失败)|(?:图片|图像|插画|视频|短片|动画)[^，,。！？!?；;\n]{0,12}(?:正在|已经|已)?(?:生成|创建|制作|绘制|渲染|输出)[^，,。！？!?；;\n]{0,8}(?:成功|完成|完毕|好了|返回|回填|找回|排队|等待)/iu;
const CAPABILITY_QUESTION = /(?:请问|想问|咨询|了解|告诉我)?[^，,。！？!?；;\n]{0,12}(?:是否|能否|可否|可不可以|能不能|可以|支持|会不会|会)(?:[^，,。！？!?；;\n]{0,24})(?:生成|创建|制作|绘制|画|渲染|输出|出图|生图|出视频)[^，,。！？!?；;\n]{0,24}(?:吗|么|呢|\?|？)?$/iu;
const POLITE_EXECUTION = /(?:帮我|替我|为我|给我)[^，,。！？!?；;\n]{0,12}(?:生成|创建|制作|绘制|画|渲染|输出|出图|生图|出视频)/iu;
const REFERENCE_OR_EXAMPLE = /^(?:引用|示例|例子|例如|比如|假设|假定|规划|计划|讨论)[^，,。！？!?；;\n]{0,48}(?:生成|创建|制作|绘制|画|渲染|输出|出图|生图|出视频)/iu;
const PLANNED_OR_PREPARATORY = /(?:制定|规划|计划|准备|打算|考虑)[^，,。！？!?；;\n]{0,32}(?:生成|创建|制作|绘制|画|渲染|输出|出图|生图|出视频)/iu;
const LOCAL_MEDIA_OPERATION = /(?:提取|截取|抽取)[^，,。！？!?；;\n]{0,24}(?:关键帧|帧|音轨|字幕)|(?:播放|暂停|预览|打开|关闭)[^，,。！？!?；;\n]{0,24}(?:图片|图像|视频|短片|动画)/iu;
const AMBIGUOUS_DESIGN_ONLY = /^(?:请)?(?:帮我)?(?:设计|做|制作)(?:一下|一个|个)?[^，,。！？!?；;\n]{0,24}(?:封面|海报)(?:方案|设计)?$/iu;

export const splitMediaIntentClauses = (value = "") => String(value ?? "")
  .split(CLAUSE_BREAK)
  .map((item) => item.trim())
  .filter(Boolean);

export const mediaIntentClauseIsBlocked = (value = "", channel = "image") => {
  const clause = String(value ?? "").trim();
  const mediaWords = MEDIA_WORDS[channel] || MEDIA_WORDS.image;
  const execution = MEDIA_EXECUTION[channel] || MEDIA_EXECUTION.image;
  if (!clause || !mediaWords.test(clause)) return false;
  if (NEGATED_OR_STOPPED.test(clause) || DEFERRED_OR_CONDITIONAL.test(clause)) return true;
  if (REFERENCE_OR_EXAMPLE.test(clause) || PLANNED_OR_PREPARATORY.test(clause) || LOCAL_MEDIA_OPERATION.test(clause)) return true;
  if (channel === "image" && AMBIGUOUS_DESIGN_ONLY.test(clause)) return true;
  if (EXPLICIT_RETRY.test(clause)) return false;
  if (MEDIA_TASK_STATUS.test(clause)) return true;
  if (PROCESS_OR_METADATA.test(clause)) return true;
  if (INFORMATION_ACTION.test(clause) && execution.test(clause)) return true;
  if (CAPABILITY_QUESTION.test(clause) && !POLITE_EXECUTION.test(clause)) return true;
  if (PROMPT_OR_TEXT_DELIVERABLE.test(clause) && !/(?:根据|按照|使用|用|拿|把|将)[^，,。！？!?；;\n]{0,36}(?:提示词|prompt|文案|脚本|剧本|分镜|镜头设计|描述|内容)[^，,。！？!?；;\n]{0,24}(?:生成|制作成|出图|生图|出视频|做成|转成|转换成)/iu.test(clause)) return true;
  return false;
};
