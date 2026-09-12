import { compileAgentDispatchContract, routeUsesShensiOrchestrator, routeUsesWorkspaceAgent } from "./agent-dispatch-contract.js";
import { compileAgentTaskPolicy } from "./agent-task-policy.js";
import { chapterNumberValue } from "./chapter-target.js";
import { createHistoryReadAuthorization } from "./history-read-policy.js";
import { hasFormalAssetWriteIntent } from "./artifact-ontology.js";
import { createFormalWriteAuthorization } from "./formal-write-authorization.js";
import { normalizeTaskContract, validateTaskContractForExecution } from "./task-contract.js";
import { buildIntentEnvelope } from "./intent-envelope.js";

const DOCUMENT_UTILITY_PATTERN = /总结|概括|摘要|提取|摘录|归纳|整理|列出|统计|字数|多少字|计算|查找|检索|定位|搜索|出现几次|比较|对比|区别|解释|说明|什么意思|翻译|转写|格式化|转换|校对错别字|校对标点|回答.{0,8}(?:问题|疑问)|根据.{0,12}(?:文档|资料|正文|章节|上下文).{0,12}(?:回答|解答)|(?:文中|文档里|资料里|正文里|这一章里).{0,16}(?:有哪些|是什么|谁|哪里|何时|多少)|(?:第\s*[零一二两三四五六七八九十百千万\d]+\s*章|本章|这章|当前文档).{0,20}(?:讲了什么|发生了什么|写了什么|有哪些|是什么|谁|哪里|何时|多少|是否出现|提到)/;
const READ_ONLY_PROJECT_QUERY_PATTERN = /(?:不要|无需|不用|禁止|不得).{0,8}(?:生成|改写|重写|续写|创作|落盘|修改).{0,24}(?:正文|章节|作品|内容)|(?:只|仅)(?:需要)?(?:读取|查看|查询|核对|回答).{0,40}(?:项目|作品|正文|章节|设定|记忆|资料)|(?:冷启动|长篇记忆|事实|设定|连续性).{0,16}(?:测试|问答|核对|查询|回答)/;
const READ_ONLY_QUERY_ACTION_PATTERN = /回答|问答|查询|核对|列出|说明|概括|总结|是什么|哪(?:个|些|一)|谁|何时|哪里|多少|是否|有没有|确认到什么程度/;
const READ_ONLY_NETWORK_QUERY_PATTERN = /(?:联网|网络|网页|官网|最新(?:版本|消息|新闻|公告|价格|规则)|实时(?:数据|消息|新闻|价格)).{0,56}(?:查询|搜索|查找|核对|回答|结果|来源)|(?:查询|搜索|查找|核对|回答).{0,56}(?:联网|网络|网页|官网|最新(?:版本|消息|新闻|公告|价格|规则)|实时(?:数据|消息|新闻|价格))/iu;
const EXPLICIT_WRITE_NEGATION_PATTERN = /(?:不要|无需|不用|禁止|不得)(?:再|直接|进行)?[^，。！？；\n]{0,28}(?:保存|写入|落盘|覆盖|修改).{0,24}(?:文档|正文|章节|作品|内容)?/u;
const EXPLICIT_DOCUMENT_TASK_PATTERN = /(?:读取|阅读|查看|浏览|参考|识别|解析|处理).{0,24}(?:全文|全书|整部作品|全部(?:正文|章节|文档)|文档|文件|资料|正文|章节|大纲|设定|内容|文章)|(?:全文|全书|整部作品|全部(?:正文|章节|文档)|文档|文件|资料|正文|章节|大纲|设定|内容|文章).{0,24}(?:读取|阅读|查看|浏览|参考|识别|解析|处理|分类|转换|转成|整理|提取|统计|说明|写|生成|创作)/;
const MECHANICAL_DOCUMENT_TASK_PATTERN = /(?:文档|文件|资料|正文|章节|大纲|设定|内容|文章).{0,30}(?:格式|字数|字符|错别字|标点|标题层级|Markdown|表格|链接|字段|JSON|XML|CSV|排序|去重|编码|文件结构)|(?:格式|字数|字符|错别字|标点|标题层级|Markdown|表格|链接|字段|JSON|XML|CSV|排序|去重|编码|文件结构).{0,30}(?:文档|文件|资料|正文|章节|大纲|设定|内容|文章)/i;
const CREATIVE_ASSET_DOCUMENT_PATTERN = /^(?:chapter-|script-episode-|prompt-|outline-|script-outline-|canon-|script-canon-|memory-|script-memory-)/;
const CREATIVE_ASSET_MODULES = new Set(["manuscript", "outline", "canon", "memory"]);
const NON_SHENSI_OUTPUT_NAME = "(?:一首|首)?(?:歌|歌曲|歌词|主题曲|诗歌|现代诗|古诗|对联)|宣传语|广告语|广告文案|营销文案|海报文案|社媒文案|演讲稿|邮件|求职信|说明书|新闻稿|解说词|播客稿|采访稿|问卷|试题|读后感|书评|推荐语|评论|摘要|报告|论文|简历|合同|课程|讲义|FAQ|常见问题|表格|清单|知识卡片";
const NON_SHENSI_DELIVERABLE_PATTERN = new RegExp(
  `(?:写|撰写|生成|创作|制作|输出|整理(?:成|为)?|改成|转换成|转成).{0,28}(?:${NON_SHENSI_OUTPUT_NAME})|(?:把|将).{0,40}(?:改写|改成|转换|转成|整理)(?:成|为).{0,8}(?:${NON_SHENSI_OUTPUT_NAME})|(?:${NON_SHENSI_OUTPUT_NAME}).{0,8}(?:创作|生成|制作)$`,
);
const CURRENT_DOCUMENT_CONTEXT_PATTERN = /当前文档|这个文档|这份文档|当前资料|这份资料|本文|本章|这章|当前章节|上一章|上章|前文|下一章|下章|后文|上下章|前后章|相邻章节|上下文|选中文字|这段文字|这句话|(?:当前|现在|目前).{0,10}(?:打开|查看|编辑|选中)|(?:打开|查看|编辑|选中)(?:的)?(?:这个|这份|当前)?(?:文档|文件|内容|文章|正文|大纲|设定|资料)|正在(?:看|查看|编辑)(?:的)?|(?:文中|其中|里面|这里面|这上面)/;
const DOCUMENT_SOURCE_DEPENDENCY_PATTERN = /(?:根据|依据|基于|结合|参考|读取|阅读|查看|浏览|从|使用|用).{0,36}(?:作品|小说|剧本|正文|章节|文档|文件|资料|大纲|卷纲|章纲|设定|内容|全文|全书|故事|情节|人物)|(?:作品|小说|剧本|正文|章节|文档|文件|资料|大纲|卷纲|章纲|设定|内容|全文|全书|故事|情节|人物).{0,28}(?:改写|转换|转化|创作|生成|制作|整理|提取|回答)/;
const FAST_STATUS_PATTERN = /(?:当前|现在|目前|刚才).{0,20}(?:打开|选择|运行|状态|进度|任务|模型|服务商|文档|文件|页面|按钮|功能|版本|保存|连接|调用|字数|多少字|哪一章)|(?:能不能|是否|有没有|为什么|如何|怎么).{0,20}(?:功能|按钮|软件|系统|模型|API|CLI|连接|调用|保存|打开|显示)/i;
const GENERAL_META_PATTERN = /(?:为什么|为何|怎么|如何|是否|能否|有没有|解释|介绍|什么意思|区别|作用|用途).{0,40}(?:神思|创作引导|问答|任务|模式|软件|系统|功能|按钮|模型|API|CLI|调用|设置|界面|文件|文档)|(?:日常|普通|通用)(?:问题|问答)|(?:不涉及|无关)(?:剧情|写作|创作)|(?:不用|无需|不要)(?:调用|使用|读取|加载)?.{0,8}(?:神思|作品文档|创作框架)/i;
const CREATIVE_GENRE_PATTERN = /女频(?:虐文|爽文|甜宠文|言情文|网文|小说|短剧|剧本|文)?|男频(?:爽文|升级流|系统流|网文|小说|短剧|剧本|文)?|(?:虐文|爽文|甜文|宠文|成长文|复仇文|群像文)|(?:玄幻|仙侠|修仙|都市|悬疑|推理|科幻|末世|无限流|系统流|穿越|重生|古言|现言|宫斗|宅斗|甜宠|虐恋|追妻火葬场|真假千金|赘婿|种田|年代|校园|职场|娱乐圈|权谋|武侠|历史|恐怖|惊悚|灵异|乙女|群像)(?:文|小说|网文|短剧|剧本|故事)?/;
const CREATIVE_PRODUCTION_VERB_PATTERN = /完成|产出|生成|创作|撰写|编写|制作|改编|续写|改写|重写|定稿|成稿|出稿|写出|写成|写|形成|完善为|整理成|转换(?:成|为)|转化(?:成|为)|转成/;
const CREATIVE_PRODUCTION_REQUEST_CUE_PATTERN = /请|帮我|给我|替我|需要你|我要|我想要|希望你|麻烦|务必|必须|直接|立即|开始|继续|按照|根据|基于|结合|研究|读取|参考|使用|调用|启用|用|把|将/;
const CREATIVE_COMPLETION_STATUS_QUERY_PATTERN = /(?:小说|网文|故事|短篇|正文|章节|大纲|卷纲|章纲|集纲|剧本|脚本|短剧|漫剧|分镜|提示词|文案|稿件|正式稿).{0,16}(?:完成|生成|写好|产出|定稿)(?:了|了吗|没有|没|到哪|进度|情况|到什么程度)|(?:完成|生成|写好|产出|定稿)(?:了吗|没有|没|到哪|进度|情况).{0,16}(?:小说|网文|故事|正文|大纲|剧本|脚本|短剧|漫剧|分镜|提示词|稿件)/;
const PROJECT_FACT_QUERY_ACTION_PATTERN = /是什么|指什么|有哪些|包含什么|谁|哪(?:个|些|里|一)|何时|什么时候|多少|几(?:个|次|章|集|幕|场)|是否(?:出现|提到|写到|存在|包含)|有没有(?:出现|提到|写到|包含)|发生了什么|写了什么|讲了什么/;
const EXPLICIT_DIRECT_CREATION_PATTERN = /直接(?:写|撰写|产出|完成|生成|创作|做|转换|出)|立即(?:写|撰写|产出|完成|生成|创作)|必须直出|不要追问|无需追问|不用追问|不要创作引导|跳过创作引导|全自动|按现有.{0,10}(?:写|撰写|产出|完成|生成|创作|转换)|(?:使用|用|调用|启用).{0,24}(?:skill|技能).{0,12}(?:重新生成|重生成|重做|生成|输出)|(?:从现在|现在|从头|从开头|从第一章|由第一章).{0,6}(?:开始)?(?:写|撰写|创作|开篇)/i;
const EXPLICIT_FRESH_CREATIVE_START_PATTERN = /从零开始(?:继续执行(?:上一条任务)?)?|(?:不是|并非|不要|无需).{0,6}(?:续写|继续写|接着写|承接前文)|(?:从现在|现在|从头|从开头|从第一章|由第一章).{0,6}(?:开始)?(?:写|创作|开篇)|(?:新故事|新小说|新作品|新作).{0,10}(?:开始|开篇|写|创作)|(?:开始|开篇|写|创作).{0,10}(?:新故事|新小说|新作品|新作)/;
const EXPLICIT_CONTINUATION_CORRECTION_PATTERN = /(?:不是|并非|不要).{0,8}(?:从现在|从头|从开头|从第一章|新故事|新小说|新作品|新作).{0,12}(?:而是|是|要).{0,6}(?:续写|继续写|接着写)/;
const NEGATED_FRESH_CREATIVE_START_PATTERN = /(?:不|不要|不用|无需|不必|别).{0,4}(?:从现在|从头|从开头|从第一章|由第一章).{0,8}(?:开始|重新|另)?(?:写|创作|开篇|生成|重做)|(?:保留|沿用|基于|根据).{0,12}(?:上方|已有|当前|原有|已保留).{0,8}(?:候选|稿件|正文).{0,12}(?:不|不要|无需|不用|别).{0,4}(?:从头|重写|另写|重做)/;
const CREATIVE_WORK_TERM_PATTERN = /作品|小说|正文|章节|第\s*\d+\s*章|本章|前文|后文|剧情|情节|角色|人物|主角|配角|男主|女主|反派|对白|台词|人设|设定|世界观|规则|体系|势力|地点|道具|法术|能力|境界|伏笔|信息释放|章纲|卷纲|大纲|剧本|短剧|漫剧|分镜|镜头|场次|旁白|画外音|视觉资产|视频提示词|全景调度|站位图|术语|专有名词|正史|canon/i;
const CREATIVE_TRANSFORMATION_PATTERN = /(?:把|将|根据|基于).{0,48}(?:小说|故事|文章|剧本|章节|大纲|当前内容|第一集|第\s*\d+\s*集).{0,24}(?:改编成|改编为|改成|改写成|转换成|转换为|转化成|转化为|转成|制作成|生成)(?:一篇|一个|一部|为)?.{0,4}(?:小说|故事|短篇|剧本|短剧|漫剧|剧情短视频|分镜|提示词|公众号文章|公众号推文)|(?:改编成|改编为|改成|改写成|转换成|转换为|转化成|转化为|转成).{0,12}(?:短剧|漫剧|剧本|视频提示词|分镜提示词|图片提示词|公众号文章|短视频剧本)|(?:小说|剧本|脚本|短视频剧本|短视频脚本|漫剧).{0,12}(?:转\s*AI|转视频|视频化|视觉化|生成视觉提示词)/i;
const CREATIVE_REVISION_PATTERN = /(?:把|将).{0,24}(?:当前章节|这章|本章|正文|剧本|大纲|卷纲|剧情走向).{0,32}(?:改得|改成|改写|重写|重构|优化|润色)|(?:去掉|去除|降低).{0,8}(?:AI味|机器味|生成腔)|(?:真人作者|作者化|人工写作感).{0,16}(?:改写|优化|润色)|(?:把|将)?(?:当前卷|本卷|剧情|走向|大纲)?.{0,16}(?:按|依照|采用)?(?:三幕(?:式|结构)|四幕(?:式|结构)|英雄之旅|起承转合).{0,16}(?:重新规划|规划|重构|调整|优化)/;
const NON_CREATIVE_REVISION_TARGET_PATTERN = /(?:修复|调整|修改|优化|微调).{0,20}(?:软件|程序|系统|界面|页面|按钮|功能|布局|快捷键|API|CLI|网络|服务器|安装|路径|目录|弹窗|窗口|面板|组件|代码)|(?:软件|程序|系统|界面|页面|按钮|功能|布局|快捷键|API|CLI|网络|服务器|安装|路径|目录|弹窗|窗口|面板|组件|代码).{0,20}(?:修复|调整|修改|优化|微调)|\b(?:src|server|scripts)[\\/]|\.(?:js|mjs|cjs|ts|tsx|jsx|css|html|json)\b/i;
const STRUCTURAL_NUMBERING_REVISION_PATTERN = /(?:场次|场景|镜头|章节|章次|集数|幕次|段落).{0,16}(?:数字|编号|序号|顺序).{0,20}(?:修正|校正|更正|调整|修改|重排|重编|重新(?:编号|排序|排列|修正|校正))|(?:修正|校正|更正|调整|修改|重新(?:修正|校正)).{0,20}(?:后续|后面|之后|以下|全部|所有|当前|现有|已有)?.{0,8}(?:场次|场景|镜头|章节|章次|集数|幕次|段落)(?:的)?(?:数字|编号|序号|顺序)|(?:重排|重编|重新(?:编号|排序|排列)).{0,20}(?:后续|后面|之后|以下|全部|所有|当前|现有|已有)?.{0,8}(?:场次|场景|镜头|章节|章次|集数|幕次|段落)/;
const EXISTING_ASSET_REOUTPUT_PATTERN = /(?:连带|连同|带上).{0,10}(?:正文|全文|剧本|章节|内容).{0,16}(?:重新|完整|原样)?(?:输出|贴出|发出|展示)|(?:把|将|给我)?(?:当前|现有|已有|原有|上面|刚才|这篇|这章|本章)?(?:正文|全文|剧本|章节|内容).{0,20}(?:重新|完整|原样)(?:输出|贴出|发出|展示)|(?:重新|完整|原样)(?:输出|贴出|发出|展示).{0,12}(?:当前|现有|已有|原有|上面|刚才|这篇|这章|本章)?(?:正文|全文|剧本|章节|内容)/;
const EXISTING_ASSET_DELIVERY_ACTION_PATTERN = /(?:给我|发我|发给我|贴出|输出|展示|返回|提供|呈现)/;
const EXISTING_ASSET_VERSIONED_TEXT_PATTERN = /(?:新版|新版本|最新版|修订版|修改后|调整后|优化后|改好后|改完后|最终版|定稿版|完整|全部|全篇|整篇|整章|全章).{0,12}(?:正文|全文|文章|稿件|剧本|脚本|内容)|(?:正文|全文|文章|稿件|剧本|脚本|内容).{0,12}(?:新版|新版本|最新版|修订版|修改后|调整后|优化后|改好后|改完后|最终版|定稿版|完整|全部|全篇|整篇|整章|全章)/;
const CONTEXT_BACKED_CREATIVE_FOLLOWUP_PATTERN = /(?:给我|发我|发给我|贴出|输出|展示|返回|提供).{0,18}(?:正文|全文|完整|新版|修订版|修改后|调整后|优化后|最终版|定稿版)|(?:就)?按(?:这个|这样|上面|刚才|你说的).{0,8}(?:改|修改|调整|重写|输出)|(?:那就|就)(?:这么|这样).{0,6}(?:改|修改|调整|重写)|(?:继续|接着).{0,8}(?:改|修改|重写|润色|处理)|(?:依次|逐一|逐章|全部|按顺序).{0,8}(?:修复|修改|调整|改好|处理)/;
const WHOLE_PROJECT_CONTEXT_PATTERN = /(?:读取|阅读|查看|浏览|参考|根据|基于|结合|使用|用|分析|总结|梳理).{0,32}(?:全文|全书|整部(?:作品|小说|剧本)?|完整(?:作品|小说|剧本)|全部(?:正文|章节|文档))|(?:全文|全书|整部(?:作品|小说|剧本)?|完整(?:作品|小说|剧本)|全部(?:正文|章节|文档)).{0,32}(?:写|生成|创作|制作|总结|分析|提取|改写|转换)/;
const COMMON_PROJECT_NGRAMS = new Set(["这句话", "怎么改", "如何改", "更自然", "自然一点", "顺一点", "帮我改", "改一下", "一句话", "这一句", "有什么", "为什么", "现在的", "目前的"]);

const CREATIVE_CONTINUATION_PATTERN = /^(?:\d+(?:\s*[+.,，、]\s*\d+)*|可以|就这样|按这个来|三个都要|都要)$/;
const HISTORICAL_CREATIVE_CONTINUATION_PATTERN = /(?:回到|继续|接着|承接|恢复|完成|处理|优化|修改|改写|重写|续写|生成|创作|撰写|写|执行).{0,32}(?:之前|此前|前面|早先|上次|上文|前文|刚才|先前).{0,24}(?:任务|要求|指令|文章|正文|章节|稿|版本|方案|内容|结果|提示词|那篇|那章)?|(?:之前|此前|前面|早先|上次|上文|前文|刚才|先前).{0,28}(?:任务|要求|指令|文章|正文|章节|稿|版本|方案|内容|结果|提示词|那篇|那章).{0,24}(?:继续|接着|完成|处理|优化|修改|改写|重写|续写|生成|创作|写|执行)/;
const CREATIVE_CONTEXT_CORRECTION_PATTERN = /(?:资料|内容|大纲|设定|附件|参考|原文|素材).{0,18}(?:已经|就在|放在|写在|存在|有|提供了|给了|附上了|上传了)|(?:你|刚才|上一轮|前一轮).{0,18}(?:没读|未读|漏读|忽略|找错|理解错|没有读取|没有找到|没找到)/;
const PASSIVE_ACKNOWLEDGEMENT_PATTERN = /^(?:好|好的|好吧|谢谢|多谢|明白|明白了|知道了|了解|了解了|收到|嗯|嗯嗯|继续)[。！!，,\s]*$/;
const CREATIVE_THREAD_MODES = new Set(["creative", "creative_guidance", "visual_prompt", "quick_revision"]);
const currentConversationInstruction = (text = "") => {
  const source = String(text || "");
  const marker = "【本轮具体问题】";
  return source.includes(marker) ? source.slice(source.lastIndexOf(marker) + marker.length).trim() : source.trim();
};
const BOOK_DECONSTRUCTION_ACTION_PATTERN = /^(?:请|帮我|麻烦)?(?:开始|进行|做|执行|完整|全面|深度)?(?:爆款)?(?:拆书|拆文|拆小说)(?:分析|报告)?[。！!]*$|(?:请|帮我|把|将|开始|进行|做|执行|完整|全面|深度).{0,20}(?:爆款拆书|拆书|拆文|拆解(?:这|该|本|整)?(?:本书|部作品|篇小说|篇文章|个故事))|(?:爆款拆书|拆书报告|完整拆解这本书|全书逆向分析|逆向分析(?:这|该|本)?(?:部作品|本书|篇小说)|提取.{0,12}(?:爆款机制|追读机制))/;
const BOOK_DECONSTRUCTION_KNOWLEDGE_PATTERN = /(?:拆书|拆文).{0,18}(?:是什么|什么意思|定义|作用|用途|方法|怎么学|如何学|有哪些理论)|(?:是什么|什么意思|介绍|解释).{0,18}(?:拆书|拆文)/;

export const isExplicitFreshCreativeStart = ({ text = "" } = {}) => {
  const source = String(text).trim();
  return Boolean(source
    && EXPLICIT_FRESH_CREATIVE_START_PATTERN.test(source)
    && !NEGATED_FRESH_CREATIVE_START_PATTERN.test(source)
    && !EXPLICIT_CONTINUATION_CORRECTION_PATTERN.test(source));
};

export const isExplicitDirectCreationRequest = ({ text = "" } = {}) => EXPLICIT_DIRECT_CREATION_PATTERN.test(String(text).trim());

export const freshNovelOpeningTarget = ({ text = "", workspaceKind = "project", deliverableType = "novel" } = {}) => (
  workspaceKind !== "notebook" && deliverableType === "novel" && isExplicitFreshCreativeStart({ text })
    ? { documentId: "chapter-1", chapterNumber: 1, explicitChapter: true, freshStart: true, contextDomain: "novel" }
    : null
);

export const canonicalNovelChapterRequestTarget = ({
  currentTarget = {},
  explicitChapterTarget = null,
  freshOpeningTarget = null,
  existingTitle = "",
} = {}) => {
  const chapterTarget = explicitChapterTarget ?? freshOpeningTarget;
  if (!chapterTarget?.documentId) return { ...(currentTarget ?? {}) };
  const sourceAssociationDocumentId = String(currentTarget?.sourceAssociationDocumentId || "").trim();
  const chapterNumber = Number(chapterTarget.chapterNumber) || null;
  const chapterName = String(chapterTarget.chapterTitle || existingTitle || "")
    .replace(/^第\s*(?:\d+|[零〇一二两三四五六七八九十百千]+)\s*章[\s　:：·-]*/u, "")
    .trim();
  const title = chapterNumber ? `第${chapterNumber}章${chapterName ? ` ${chapterName}` : ""}` : chapterName;
  return {
    documentId: String(chapterTarget.documentId),
    chapterNumber,
    ...(chapterTarget.batchRequest ? { batchRequest: chapterTarget.batchRequest } : {}),
    ...(sourceAssociationDocumentId ? { sourceAssociationDocumentId } : {}),
    explicitChapter: true,
    freshStart: chapterTarget.freshStart === true,
    contextDomain: "novel",
    moduleId: "manuscript",
    viewId: "novel",
    title,
    chapterTitle: chapterName,
    explicitArtifact: true,
  };
};

export const creativeContextRequiredIds = ({ explicitReferenceIds = [] } = {}) => [
  ...new Set(explicitReferenceIds.map(String).filter(Boolean)),
];

export const blockingCreativeContextIds = ({ targetDocumentId = "", missingRequiredIds = [], existingAssetIntent = false, operation = "" } = {}) => existingAssetIntent && operation !== "create"
  ? [...new Set(missingRequiredIds)].filter(id => id === targetDocumentId)
  : [];

export const hasSubstantiveInlineCreativeSource = ({ text = "" } = {}) => {
  const source = String(text).trim();
  if (source.length < 600) return false;
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const structuredCreativeSignals = source.match(/(?:^|\n)(?:第\s*[零一二两三四五六七八九十百千万\d]+\s*[章节集幕]|场次\s*[零一二两三四五六七八九十百千万\d]+|人物[：:]|对白[：:]|动作[：:]|内景|外景|画外音|黑底片名)/g) ?? [];
  return lines.length >= 8 && (structuredCreativeSignals.length >= 2 || source.split(/\n\s*\n/).filter((part) => part.trim()).length >= 6);
};

export const isExistingCreativeAssetRevisionRequest = ({
  text = "",
  targetDocumentId = "",
  targetModuleId = "",
  workspaceKind = "project",
} = {}) => {
  const source = String(text).trim();
  if (!source || workspaceKind === "notebook" || NON_CREATIVE_REVISION_TARGET_PATTERN.test(source)) return false;
  const currentTargetIsCreativeAsset = CREATIVE_ASSET_MODULES.has(String(targetModuleId))
    || CREATIVE_ASSET_DOCUMENT_PATTERN.test(String(targetDocumentId));
  if (!currentTargetIsCreativeAsset) return false;
  return isStructuralNumberingRevisionRequest({ text: source })
    || EXISTING_ASSET_REOUTPUT_PATTERN.test(source)
    || (EXISTING_ASSET_DELIVERY_ACTION_PATTERN.test(source) && EXISTING_ASSET_VERSIONED_TEXT_PATTERN.test(source));
};

export const isStructuralNumberingRevisionRequest = ({ text = "" } = {}) => (
  STRUCTURAL_NUMBERING_REVISION_PATTERN.test(String(text).trim())
);

export const isBookDeconstructionRequest = ({ text = "" } = {}) => {
  const source = String(text).trim();
  return Boolean(source && BOOK_DECONSTRUCTION_ACTION_PATTERN.test(source) && !BOOK_DECONSTRUCTION_KNOWLEDGE_PATTERN.test(source));
};

export const CREATIVE_DELIVERABLE_LABELS = Object.freeze({
  market_scan_report: "爆款扫榜报告",
  book_deconstruction: "爆款拆书报告",
  visual_prompt: "提示词",
  public_account: "公众号推文",
  short_video_script: "短视频剧本",
  short_drama_script: "短剧剧本",
  short_fiction: "短篇小说",
  novel: "小说",
});

const PUBLIC_ACCOUNT_DELIVERABLE_PATTERN = /公众号(?:文章|长文|推文)?|微信公众号|微信推文|公号(?:文章|推文)/;
const SHORT_FICTION_DELIVERABLE_PATTERN = /短篇小说|短篇故事|微型小说|微小说|小小说|科幻短篇|短篇科幻|(?:悬疑|现实|情感|言情|恐怖|推理|治愈|反转|虐心|温情)短篇|(?:\d{3,6}|[一二两三四五六七八九十百千万]{2,8})\s*字.{0,8}(?:故事|小说)|反转小故事|现实小故事|情感小故事/;
const SHORT_VIDEO_SCRIPT_DELIVERABLE_PATTERN = /短视频(?:剧本|脚本|剧情)|剧情(?:类)?短视频|AI\s*(?:剧情视频|剧情短片)|抖音剧情|剧情号|单条剧情视频|连续剧情号/;
const SHORT_DRAMA_SCRIPT_DELIVERABLE_PATTERN = /(?:原创|改编|小说改编)?(?:微短剧|短剧|漫剧|竖屏短剧|真人短剧|AI\s*短剧)(?:剧本|脚本|全集大纲|整季大纲|剧集大纲|集纲|第\s*[零一二两三四五六七八九十百千万\d]+\s*集)?|(?:原创|改编)剧本|小说改编.{0,8}(?:剧本|短剧|漫剧)|(?:影视|电影|电视剧|网剧|网络电影|院线电影|广播剧)(?:类)?(?:剧本|脚本)/;
const GENERIC_SCRIPT_PRODUCTION_PATTERN = /(?:写|写成|生成|创作|制作|改编|改写|转换|转成|改为|改成|整理成).{0,24}(?:剧本|脚本)|(?:剧本|脚本).{0,18}(?:格式|正文|成稿|定稿|新版本|新版)/;
const GENERIC_PROMPT_DELIVERABLE_PATTERN = /(?:视频|分镜|漫剧|镜头|图片|图像|角色|场景|道具|定妆|视觉资产|全景调度(?:图)?|站位(?:图|线稿图)?).{0,10}提示词|提示词(?:创作|生成|设计|优化|改写)|(?:写|生成|制作|设计|优化|改写).{0,12}提示词|多人站位|空间调度/;
const VISUAL_ASSET_SKILL_DELIVERABLE_PATTERN = /(?:(?:视觉|图片|图像|人物|角色|场景|道具|定妆)资产|全景调度|多人站位|站位线稿图?).{0,12}(?:skill|技能)|(?:skill|技能).{0,12}(?:(?:视觉|图片|图像|人物|角色|场景|道具|定妆)资产|全景调度|多人站位|站位线稿图?)/i;

export const creativeDeliverableType = ({ text = "", targetDocumentId = "" } = {}) => {
  const source = `${String(text)} ${String(targetDocumentId)}`;
  if (isBookDeconstructionRequest({ text: source })) return "book_deconstruction";
  // 提示词必须先于短视频判断，避免“短视频提示词”被误判成短视频剧本。
  if (String(targetDocumentId).startsWith("prompt-") || GENERIC_PROMPT_DELIVERABLE_PATTERN.test(source) || VISUAL_ASSET_SKILL_DELIVERABLE_PATTERN.test(source)) return "visual_prompt";
  if (PUBLIC_ACCOUNT_DELIVERABLE_PATTERN.test(source)) return "public_account";
  if (SHORT_FICTION_DELIVERABLE_PATTERN.test(source)) return "short_fiction";
  if (SHORT_VIDEO_SCRIPT_DELIVERABLE_PATTERN.test(source)) return "short_video_script";
  if (SHORT_DRAMA_SCRIPT_DELIVERABLE_PATTERN.test(source) || GENERIC_SCRIPT_PRODUCTION_PATTERN.test(source) || /^script-(?:episode|outline)-/.test(String(targetDocumentId))) return "short_drama_script";
  if (/小说|网文|长篇|中篇|正文|章节|大纲|卷纲|章纲|细纲|详细大纲/.test(source) || CREATIVE_GENRE_PATTERN.test(source)) return "novel";
  return "";
};

export const hasExplicitCreativeProductionIntent = ({ text = "", targetDocumentId = "" } = {}) => {
  const source = String(text).trim();
  if (!source) return false;
  if (hasExplicitFormalAssetWriteIntent({ text: source })) return true;
  if (!creativeDeliverableType({ text: source, targetDocumentId })) return false;
  if (READ_ONLY_PROJECT_QUERY_PATTERN.test(source) && READ_ONLY_QUERY_ACTION_PATTERN.test(source)) return false;
  if (CREATIVE_COMPLETION_STATUS_QUERY_PATTERN.test(source)) return false;
  if (!CREATIVE_PRODUCTION_VERB_PATTERN.test(source)) return false;
  return CREATIVE_PRODUCTION_REQUEST_CUE_PATTERN.test(source)
    || /^(?:完成|产出|生成|创作|撰写|编写|制作|改编|续写|改写|重写|定稿|成稿|出稿|写出|写成|形成)/.test(source);
};

export const hasExplicitFormalAssetWriteIntent = ({ text = "" } = {}) => {
  return hasFormalAssetWriteIntent(text);
};

const PROJECT_CONTEXT_REUSE_PATTERN = /(?:沿用|承接|延续|续写|继续写|接着写|改编|重写|改写).{0,32}(?:当前|现有|已有|原有|前文|本章|作品|小说|故事|正文|章节|设定|世界观|人物|角色)|(?:当前|现有|已有|原有|前文|本章|作品|小说|故事|正文|章节|设定|世界观|人物|角色).{0,32}(?:沿用|承接|延续|续写|继续写|接着写|改编|重写|改写)/;
const EXPLICIT_PROJECT_SOURCE_DEPENDENCY_PATTERN = /(?:根据|依据|基于|结合|参考|读取|阅读|查看|浏览).{0,28}(?:当前|现有|已有|原有|本项目|本作|这部|该部|前文|本章|当前文档|人物设定|角色设定|世界观|大纲|卷纲|章纲|正文|章节)|(?:当前|现有|已有|原有|本项目|本作|这部|该部|前文|本章|当前文档).{0,28}(?:改写|转换|创作|生成|制作|续写|参考|读取)/;

export const usesStandaloneCreativeContext = ({
  text = "",
  deliverableType = "",
  hasExplicitProjectReferences = false,
} = {}) => {
  const source = String(text).trim();
  const resolvedDeliverableType = deliverableType || creativeDeliverableType({ text: source });
  if (!source || !["short_fiction", "public_account", "short_video_script", "visual_prompt"].includes(resolvedDeliverableType) || hasExplicitProjectReferences) return false;
  if (!hasExplicitCreativeProductionIntent({ text: source }) && !isExplicitDirectCreationRequest({ text: source })) return false;
  return !EXPLICIT_PROJECT_SOURCE_DEPENDENCY_PATTERN.test(source)
    && !CURRENT_DOCUMENT_CONTEXT_PATTERN.test(source)
    && !CREATIVE_TRANSFORMATION_PATTERN.test(source)
    && !CREATIVE_REVISION_PATTERN.test(source)
    && !PROJECT_CONTEXT_REUSE_PATTERN.test(source);
};

export const creativeDeliverableLabel = (type = "") => CREATIVE_DELIVERABLE_LABELS[type] ?? "创作资产";

export const isCreativeContinuationResponse = ({ text = "", hasResources = false, allowImplicitAnswer = true } = {}) => {
  const source = String(text).trim();
  if (!source) return false;
  if (/^【继续同一创作任务】/.test(source)) return true;
  if (isExplicitFreshCreativeStart({ text: source })) return false;
  if (PASSIVE_ACKNOWLEDGEMENT_PATTERN.test(source)) return false;
  if (HISTORICAL_CREATIVE_CONTINUATION_PATTERN.test(source)) return true;
  if (FAST_STATUS_PATTERN.test(source) || GENERAL_META_PATTERN.test(source) || isNonShensiDeliverable({ text: source })) return false;
  if (CREATIVE_CONTINUATION_PATTERN.test(source)) return true;
  if (CREATIVE_CONTEXT_CORRECTION_PATTERN.test(source)) return true;
  if (hasResources && /(?:查看|参考|读取|结合|使用|用).{0,12}(?:资料|文档|文件|附件|内容)|附带(?:的)?资料/.test(source)) return true;
  return allowImplicitAnswer && source.length <= 48
    && !/[？?]/.test(source)
    && !DOCUMENT_UTILITY_PATTERN.test(source)
    && !MECHANICAL_DOCUMENT_TASK_PATTERN.test(source);
};

export const continuesPriorCreativeTask = ({
  text = "",
  previousRequestMode = "",
  previousAssistantAwaitingChoice = false,
  previousAssistantHasCreativeContext = false,
  hasResources = false,
} = {}) => {
  const contextBackedFollowup = previousAssistantHasCreativeContext === true
    && CONTEXT_BACKED_CREATIVE_FOLLOWUP_PATTERN.test(String(text).trim());
  if (!CREATIVE_THREAD_MODES.has(String(previousRequestMode)) && !contextBackedFollowup) return false;
  return isCreativeContinuationResponse({
    text,
    hasResources,
    allowImplicitAnswer: previousAssistantAwaitingChoice === true || contextBackedFollowup,
  });
};

const chapterRangeInText = (value = "") => {
  const source = String(value || "");
  const token = "(\\d+|[零〇一二两三四五六七八九十百千]+)";
  const range = source.match(new RegExp(`(?:第\\s*)?${token}\\s*(?:章)?\\s*(?:到|至|[-~～—])\\s*(?:第\\s*)?${token}\\s*章`, "u"));
  if (range) {
    const startChapter = chapterNumberValue(range[1]);
    const endChapter = chapterNumberValue(range[2]);
    if (startChapter > 0 && endChapter >= startChapter && endChapter - startChapter < 100) return { startChapter, endChapter };
  }
  const chapterNumbers = [...source.matchAll(new RegExp(`第\\s*${token}\\s*章`, "gu"))]
    .map((match) => chapterNumberValue(match[1]))
    .filter((number) => number > 0);
  if (chapterNumbers.length >= 2) return { startChapter: Math.min(...chapterNumbers), endChapter: Math.max(...chapterNumbers) };
  return null;
};

const ELLIPTICAL_REPAIR_COMMAND = /^(?:请|麻烦)?(?:就|那就)?(?:按(?:照)?(?:上面|上述|刚才|这个|这些|自检结论)?\s*)?(?:依次|逐一|逐章|全部|都|按顺序)?\s*(?:修复|修改|调整|改好|处理)(?:一下|好|完)?(?:这些|上述|前述)?(?:问题)?[。！!]*$/u;
const CREATIVE_DIAGNOSIS_CONTEXT = /(?:自检|检查|诊断|审查|评估|问题|不足|硬伤|修复|修改|调整|章节|正文|剧情|设定|人物|动机|节奏|伏笔)/u;

export const contextualCreativeRepairFollowup = ({ text = "", previousUserText = "", previousAssistantText = "" } = {}) => {
  const prompt = String(text || "").trim();
  const priorUser = String(previousUserText || "").trim();
  const priorAssistant = String(previousAssistantText || "").trim();
  if (!ELLIPTICAL_REPAIR_COMMAND.test(prompt) || !CREATIVE_DIAGNOSIS_CONTEXT.test(`${priorUser}\n${priorAssistant}`)) return null;
  const range = chapterRangeInText(`${priorUser}\n${priorAssistant}`);
  if (!range) return null;
  const count = range.endChapter - range.startChapter + 1;
  const documentIds = Array.from({ length: count }, (_, index) => `chapter-${range.startChapter + index}`);
  return {
    expandedPrompt: `${prompt}。按照上一轮自检结论，逐章修复现有第${range.startChapter}章至第${range.endChapter}章的正文。必须返回 ${count} 份完整修订后正文，由神思执行一次批量落盘事务；不得直接编辑 Markdown 文件。每章都要保存修改前历史版本，任一章缺失、revision 冲突或批量回执不完整时不得宣称修改完成。`,
    batchRequest: {
      startChapter: range.startChapter,
      endChapter: range.endChapter,
      count,
      documentIds,
      operation: "modify",
      source: "diagnosis_followup",
    },
  };
};

const occurrenceCount = (source, value) => {
  let count = 0;
  let cursor = 0;
  while (value && (cursor = source.indexOf(value, cursor)) >= 0) {
    count += 1;
    cursor += value.length;
  }
  return count;
};

export const hasProjectTerminology = ({ text = "", projectCorpus = "" } = {}) => {
  const source = String(text).replace(/\s+/g, "");
  const corpus = String(projectCorpus).replace(/\s+/g, "");
  if (!source) return false;
  if (CREATIVE_WORK_TERM_PATTERN.test(source)) return true;
  if (!corpus) return false;

  const latinTerms = source.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) ?? [];
  if (latinTerms.some((term) => corpus.toLowerCase().includes(term.toLowerCase()))) return true;

  const chineseRuns = source.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  for (const run of chineseRuns) {
    for (let size = Math.min(8, run.length); size >= 4; size -= 1) {
      for (let index = 0; index + size <= run.length; index += 1) {
        const term = run.slice(index, index + size);
        if (!COMMON_PROJECT_NGRAMS.has(term) && corpus.includes(term)) return true;
      }
    }
    for (const size of [3, 2]) {
      for (let index = 0; index + size <= run.length; index += 1) {
        const term = run.slice(index, index + size);
        if (!COMMON_PROJECT_NGRAMS.has(term) && occurrenceCount(corpus, term) >= 2) return true;
      }
    }
  }
  return false;
};

export const isNonShensiDeliverable = ({ text = "" } = {}) => NON_SHENSI_DELIVERABLE_PATTERN.test(String(text).trim());

export const isReadOnlyProjectQuery = ({ text = "" } = {}) => {
  const source = String(text).trim();
  if (!source) return false;
  if (READ_ONLY_NETWORK_QUERY_PATTERN.test(source)
    && EXPLICIT_WRITE_NEGATION_PATTERN.test(source)
    && READ_ONLY_QUERY_ACTION_PATTERN.test(source)) return true;
  const explicitlyReadOnly = READ_ONLY_PROJECT_QUERY_PATTERN.test(source)
    && READ_ONLY_QUERY_ACTION_PATTERN.test(source);
  if (explicitlyReadOnly) return true;
  return Boolean(
    DOCUMENT_SOURCE_DEPENDENCY_PATTERN.test(source)
    && PROJECT_FACT_QUERY_ACTION_PATTERN.test(source)
    && !CREATIVE_PRODUCTION_VERB_PATTERN.test(source),
  );
};

export const isWholeProjectContextRequest = ({ text = "", projectName = "" } = {}) => {
  const source = String(text).replace(/\s+/g, "");
  if (!WHOLE_PROJECT_CONTEXT_PATTERN.test(source)) return false;
  const normalizedProjectName = String(projectName).replace(/[《》〈〉「」『』“”\s]/g, "");
  return !normalizedProjectName || source.includes(normalizedProjectName) || /全文|全书|整部|完整作品|全部(?:正文|章节|文档)/.test(source);
};

export const isEntityProfileQuery = ({ text = "" } = {}) => {
  const source = String(text).replace(/\s+/g, "");
  if (!source || /人物设定文档|文档结构|包含哪些字段|全部人物|人物名单|角色名单/.test(source)) return false;
  const asksToRead = /只(?:需要)?(?:读取|查看|调用|调取|加载)|仅(?:读取|查看|调用|调取|加载)|(?:读取|查看|调用|调取|加载|分析)/.test(source);
  const entityTarget = /(?:人物|角色|物品|道具|地点|势力|组织|概念|规则|事件|伏笔).{0,12}(?:档案|设定|资料|状态)|[\p{Script=Han}A-Za-z0-9·_-]{2,20}(?:完整当前档案|当前档案|人物档案|角色档案|档案)/u.test(source);
  return asksToRead && entityTarget;
};

export const namedGeneralDocumentIds = ({ text = "", documents = [], limit = 8 } = {}) => {
  const source = String(text).replace(/[《》〈〉「」『』“”'`\s]/g, "").toLowerCase();
  return documents
    .map((document) => ({
      id: String(document?.id ?? ""),
      title: String(document?.title ?? ""),
      normalizedTitle: String(document?.title ?? "").replace(/[《》〈〉「」『』“”'`\s]/g, "").toLowerCase(),
    }))
    .filter(({ id, normalizedTitle }) => id && normalizedTitle.length >= 2 && source.includes(normalizedTitle))
    .sort((left, right) => right.normalizedTitle.length - left.normalizedTitle.length || left.id.localeCompare(right.id))
    .slice(0, Math.max(0, Number(limit) || 0))
    .map(({ id }) => id);
};

const routeFromTaskContract = (contract = null, decision = validateTaskContractForExecution(contract)) => {
  if (!decision.authoritative || !decision.valid) return null;
  const taskType = String(contract?.taskType || "discussion");
  const deliverables = decision.deliverables.filter((item) => item?.required !== false);
  const primaryKind = String(deliverables[0]?.kind || "");
  const deliverableType = primaryKind === "visual_prompt"
    ? "visual_prompt"
    : ["script", "script_prose"].includes(primaryKind) ? "short_drama"
      : primaryKind === "prose" ? "novel" : "";
  const formal = decision.persistence !== "none" && deliverables.length > 0;
  const mode = formal
    ? deliverableType === "visual_prompt" ? "visual_prompt" : "creative"
    : ["operation", "export"].includes(taskType) ? "operation" : "general";
  return {
    mode,
    reason: `TaskContract 已完成一次语义理解：${taskType} / ${decision.persistence} / ${deliverables.length} 个交付物`,
    shensiLed: formal,
    revisionIntent: taskType === "modification",
    diagnosisIntent: taskType === "diagnosis",
    productionIntent: ["writing", "modification"].includes(taskType) && formal,
    ...(deliverableType ? { deliverableType, deliverableLabel: creativeDeliverableLabel(deliverableType) } : {}),
  };
};

const blockedRouteFromTaskContract = (contract = null, decision = validateTaskContractForExecution(contract)) => {
  if (!decision.authoritative || decision.valid) return null;
  return {
    mode: "general",
    reason: `TaskContract 硬性校验未通过：${decision.issues.join("、")}`,
    shensiLed: false,
    revisionIntent: false,
    diagnosisIntent: false,
    productionIntent: false,
  };
};

export const reviewDeliveryFromTaskContract = (contract = null, decision = validateTaskContractForExecution(contract)) => {
  if (!decision.authoritative || !decision.valid) return null;
  const report = decision.deliverables.find((item) => ["report", "review_report"].includes(String(item?.kind || "")));
  if (!report) return null;
  return {
    active: true,
    reportRequested: true,
    landingEligible: decision.persistence === "commit",
    candidatePreviewRequired: false,
    kind: String(report.kind || "report"),
    target: {
      ...(report.target && typeof report.target === "object" ? report.target : {}),
      documentId: String(report.targetDocumentId || report.targetDocument || report.target?.documentId || ""),
      title: String(report.title || report.target?.title || ""),
      moduleId: String(report.target?.moduleId || "reports"),
    },
    reason: "TaskContract 已绑定正式报告交付物",
  };
};

export const buildAdaptiveTaskRoute = (input = {}, { executionSurface = "agent" } = {}) => {
  const surface = "agent";
  const semanticDecision = ["guided_dialogue", "task_execution"].includes(input.agentDecision?.lane)
    ? input.agentDecision
    : null;
  const taskContract = input.taskContract?.protocol
    ? normalizeTaskContract(input.taskContract, { sourceMessageId: input.sourceMessageId })
    : null;
  const taskContractDecision = validateTaskContractForExecution(taskContract);
  const authoritativeTaskContract = taskContractDecision.authoritative ? taskContract : null;
  const contractRoute = routeFromTaskContract(authoritativeTaskContract, taskContractDecision);
  const semanticMode = ["general", "creative_guidance", "creative", "quick_revision", "workspace_operation", "visual_prompt"].includes(semanticDecision?.requestMode)
    ? semanticDecision.requestMode
    : "";
  const semanticWriteIntent = String(semanticDecision?.writePlan?.intent || "none");
  const semanticOperation = String(semanticDecision?.writePlan?.operation || "none");
  const semanticCapabilities = Array.isArray(semanticDecision?.skillCapabilities)
    ? semanticDecision.skillCapabilities
    : [];
  const semanticQualityReview = semanticDecision?.taskKind === "quality_review"
    || semanticCapabilities.includes("effect_reviewer");
  const semanticRoute = semanticMode ? {
    mode: semanticQualityReview && semanticMode === "general" ? "creative" : semanticMode,
    taskKind: String(semanticDecision.taskKind || (semanticQualityReview ? "quality_review" : "task_execution")),
    semanticAuthority: true,
    semanticExecutionPlan: semanticDecision.executionPlan ?? null,
    sourceMode: String(semanticDecision.sourceMode || ""),
    reason: `统一 Agent 决策：${String(semanticDecision.objective || semanticMode)}`,
    shensiLed: semanticQualityReview || ["creative_guidance", "creative", "quick_revision", "visual_prompt"].includes(semanticMode),
    revisionIntent: ["append", "patch", "replace", "rename"].includes(semanticOperation),
    diagnosisIntent: semanticQualityReview || semanticDecision.relation === "inspect_task" || semanticDecision.deliverableType === "report",
    productionIntent: ["candidate", "commit"].includes(semanticWriteIntent),
    ...(semanticDecision.deliverableType ? {
      deliverableType: semanticDecision.deliverableType,
      deliverableLabel: creativeDeliverableLabel(semanticDecision.deliverableType),
    } : {}),
  } : null;
  const route = semanticRoute || contractRoute
    || blockedRouteFromTaskContract(authoritativeTaskContract, taskContractDecision)
    || { mode: "general", reason: "由 Agent 理解任务并选择所需能力", shensiLed: false, semanticAuthority: true };
  const contractDeliverables = Array.isArray(authoritativeTaskContract?.deliverables)
    ? authoritativeTaskContract.deliverables.filter((item) => item?.required !== false && item?.targetDocumentId)
    : [];
  const contractFormalDelivery = taskContractDecision.authoritative && taskContractDecision.valid && contractDeliverables.length > 0;
  const requestedContextDomain = String(input.contextDomain || "");
  const contractTargetIds = contractDeliverables.map((item) => String(item.targetDocumentId || ""));
  const contractContextDomain = taskContractDecision.authoritative && taskContractDecision.valid
    ? contractTargetIds.includes("report-adaptation")
      ? "script-adaptation"
      : contractTargetIds.some((id) => id.startsWith("script-"))
        || contractDeliverables.some((item) => ["script", "script_prose"].includes(String(item.kind || "")))
        ? "script"
        : "novel"
    : "";
  const semanticAuthority = true;
  const reviewContextDomain = contractContextDomain || requestedContextDomain || "general";
  const reviewDelivery = reviewDeliveryFromTaskContract(taskContract, taskContractDecision)
    || { active: false, reportRequested: false, landingEligible: false, candidatePreviewRequired: false, target: null, reason: "尚未声明报告交付物" };
  const guidancePolicy = route.mode === "creative_guidance"
    ? "recommended"
    : route.shensiLed ? "available" : "not_applicable";
  const suppliedTarget = input.target ?? {
    documentId: input.targetDocumentId ?? "",
    revision: input.targetRevision ?? "",
    managed: input.targetManaged !== false,
    ambiguous: input.targetAmbiguous === true,
  };
  const contractPrimaryDeliverable = contractFormalDelivery
    ? contractDeliverables.find((item) => item.targetDocumentId === suppliedTarget?.documentId) || contractDeliverables[0]
    : null;
  const contractPrimaryTarget = contractPrimaryDeliverable ? {
    ...suppliedTarget,
    ...(contractPrimaryDeliverable.target && typeof contractPrimaryDeliverable.target === "object"
      ? contractPrimaryDeliverable.target
      : {}),
    documentId: String(contractPrimaryDeliverable.targetDocumentId || ""),
    title: String(contractPrimaryDeliverable.title || contractPrimaryDeliverable.target?.title || suppliedTarget?.title || ""),
    revision: input.expectedRevisions?.[contractPrimaryDeliverable.targetDocumentId]
      ?? (suppliedTarget?.documentId === contractPrimaryDeliverable.targetDocumentId ? suppliedTarget?.revision : ""),
    managed: true,
    ambiguous: false,
  } : null;
  const formalReviewTarget = reviewDelivery.reportRequested === true && reviewDelivery.target?.documentId
    ? reviewDelivery.target
    : null;
  const reviewMutatesContent = semanticDecision?.taskKind === "content_revision"
    || (taskContractDecision.authoritative && taskContract?.taskType === "modification"
      && contractDeliverables.some((item) => !["report", "review_report"].includes(String(item?.kind || ""))));
  const target = formalReviewTarget && !reviewMutatesContent
    ? {
        ...formalReviewTarget,
        managed: true,
        ambiguous: false,
        revision: input.expectedRevisions?.[formalReviewTarget.documentId]
          ?? (suppliedTarget.documentId === formalReviewTarget.documentId ? suppliedTarget.revision : ""),
      }
    : contractPrimaryTarget || suppliedTarget;
  const suppliedTargetDocumentIds = Array.isArray(input.targetDocumentIds) && input.targetDocumentIds.length
    ? input.targetDocumentIds
    : [suppliedTarget?.documentId].filter(Boolean);
  const targetDocumentIds = contractFormalDelivery
    ? contractDeliverables.map((item) => item.targetDocumentId)
    : formalReviewTarget
      ? reviewMutatesContent
        ? [...new Set([...suppliedTargetDocumentIds, formalReviewTarget.documentId])]
        : [formalReviewTarget.documentId]
      : suppliedTargetDocumentIds;
  const expectedRevisions = input.expectedRevisions && typeof input.expectedRevisions === "object"
    ? input.expectedRevisions
    : Object.fromEntries(targetDocumentIds.map((id) => [id, id === target?.documentId ? target?.revision ?? "" : ""]));
  const writeAuthorization = createFormalWriteAuthorization({
    instruction: input.authorizationInstruction ?? input.text,
    sourceMessageId: input.sourceMessageId,
    targetDocumentIds,
    expectedRevisions,
    targetExists: input.targetExists !== false,
    targetTitle: input.targetTitle ?? target?.title ?? "",
    hasSelection: input.hasSelection === true || input.inlineEdit === true,
    contextualWriteAction: input.contextualWriteAction,
    candidate: input.candidate,
    candidateAuthorization: input.candidateAuthorization,
    taskContract: authoritativeTaskContract,
    semanticWritePlan: semanticDecision?.writePlan ?? (taskContractDecision.authoritative ? null : { intent: "none", operation: "none" }),
    guidanceOnly: route.mode === "creative_guidance"
      && !taskContractDecision.authoritative
      && !["candidate", "commit"].includes(semanticWriteIntent),
  });
  const explicitCandidateGeneration = writeAuthorization.state === "candidate_only";
  const managedRoute = writeAuthorization.state === "commit" && writeAuthorization.action === "rename"
    ? {
        ...route,
        mode: "quick_revision",
        reason: "明确要求为当前目标文档生成并写入标题",
        shensiLed: true,
        revisionIntent: true,
      }
    : explicitCandidateGeneration
      ? {
          ...route,
          mode: "creative",
          reason: "Agent 决策声明候选交付",
          shensiLed: true,
        }
      : contractFormalDelivery && ["commit", "candidate_only"].includes(writeAuthorization.state)
        ? {
            ...route,
            mode: "creative",
            reason: `TaskContract 已绑定 ${contractDeliverables.length} 个正式交付物`,
            shensiLed: true,
          }
        : route;
  // A candidate window is a user-requested review mode, not a prerequisite for
  // ordinary formal writing. The formal artifact still uses the managed
  // transaction path, but it lands directly when authorization is commit.
  const managedCandidatePreviewRequired = explicitCandidateGeneration
    || (reviewDelivery.active && reviewDelivery.candidatePreviewRequired === true);
  const formalArtifactExpected = managedRoute.shensiLed === true
    && ["commit", "candidate_only"].includes(writeAuthorization.state)
    && ["creative", "visual_prompt", "quick_revision"].includes(managedRoute.mode);
  const taskPolicy = compileAgentTaskPolicy({
    text: "",
    route: {
      ...managedRoute,
      writeAuthorization,
      taskContract: authoritativeTaskContract,
      reviewDelivery,
      longForm: input.longForm === true,
      unattended: input.unattended === true,
      formalPublish: input.formalPublish === true,
      batch: input.batch === true,
    },
    target,
    candidateCount: semanticDecision?.executionPlan?.candidateCount ?? input.candidateCount ?? 1,
    writeAuthorization,
    taskContract: authoritativeTaskContract,
    semanticAuthority,
    semanticExecutionPlan: semanticDecision?.executionPlan ?? null,
  });
  const intentEnvelope = buildIntentEnvelope({
    instruction: input.text,
    sourceMessageId: input.sourceMessageId,
    route: {
      ...managedRoute,
      formalArtifactExpected,
      contextDomain: reviewContextDomain,
    },
    taskContract: authoritativeTaskContract,
    reviewDelivery,
    taskPolicy,
    writeAuthorization,
    target,
    targetDocumentIds,
    requiredContextDocumentIds: input.requiredContextDocumentIds,
    optionalReferenceDocumentIds: input.optionalReferenceDocumentIds,
    skillIds: input.skillIds,
  });
  const historyAuthorization = createHistoryReadAuthorization({
    instruction: input.text,
    requestedBy: "user",
    documentIds: targetDocumentIds.length
      ? targetDocumentIds
      : [String(input.target?.documentId ?? input.targetDocumentId ?? "")].filter(Boolean),
  });
  const enrichedRoute = {
    ...managedRoute,
    recommendedMode: managedRoute.mode,
    confidence: semanticRoute
      ? Number(semanticDecision.confidence) || 0
      : taskContractDecision.authoritative && taskContractDecision.valid
      ? 1
      : 0,
    guidancePolicy,
    executionSurface: surface,
    runtimeRerouteAllowed: !taskContractDecision.authoritative && !["operation", "quick_revision"].includes(route.mode),
    toolPolicy: surface === "agent" ? "task_and_permission" : "none",
    candidatePreviewRequired: managedCandidatePreviewRequired,
    landingConfirmationRequired: false,
    formalArtifactExpected,
    reviewDelivery,
    targetDocumentId: String(target?.documentId ?? ""),
    targetRevision: String(target?.revision ?? ""),
    taskPolicy,
    writeAuthorization,
    taskContract: authoritativeTaskContract,
    provisionalTaskContract: authoritativeTaskContract ? null : taskContract,
    intentEnvelope,
    historyAuthorization: historyAuthorization.allowed ? historyAuthorization : null,
    ...taskPolicy,
    hardBlocked: taskContractDecision.authoritative && !taskContractDecision.valid,
    taskContractValidation: taskContractDecision.recognized ? {
      valid: taskContractDecision.valid,
      authoritative: taskContractDecision.authoritative,
      issues: taskContractDecision.issues,
    } : null,
    hardGates: ["workspace_boundary", "history_snapshot", "revision", "idempotency", "readback"],
  };
  return {
    ...enrichedRoute,
    ...compileAgentDispatchContract(enrichedRoute, { executionSurface: surface }),
  };
};

export const agentRouteUsesShensi = (route = {}) => routeUsesShensiOrchestrator(route);
export const agentRouteUsesWorkspaceAgent = (route = {}) => routeUsesWorkspaceAgent(route);

export const resolveRequestedMode = ({ requestedMode = "general", agentDecision = null, taskContract = null } = {}) => {
  if (agentDecision) return buildAdaptiveTaskRoute({ agentDecision, taskContract }).mode;
  const decision = validateTaskContractForExecution(taskContract);
  if (decision.authoritative) {
    const route = routeFromTaskContract(taskContract, decision) || blockedRouteFromTaskContract(taskContract, decision);
    return route?.mode === "operation" ? "workspace_operation" : route?.mode || "general";
  }
  return ["general", "creative", "creative_guidance", "visual_prompt", "quick_revision", "workspace_operation"].includes(requestedMode) ? requestedMode : "general";
};

export const generalDocumentContextIds = ({
  text = "",
  currentDocumentId = "",
  referenceIds = [],
  existingDocumentIds = [],
  documents = [],
  limit = 8,
} = {}) => {
  const source = String(text);
  const existing = new Set(existingDocumentIds);
  const result = [];
  const add = (documentId) => {
    const normalized = String(documentId ?? "").trim();
    if (!normalized || result.includes(normalized) || (existing.size && !existing.has(normalized)) || result.length >= limit) return;
    result.push(normalized);
  };
  const explicitCurrent = explicitCurrentDocumentRequest(source);
  if (explicitCurrent) add(currentDocumentId);
  referenceIds.forEach(add);
  const namedIds = namedGeneralDocumentIds({ text: source, documents, limit });
  namedIds.forEach(add);

  const currentChapter = Number(String(currentDocumentId).match(/^chapter-(\d+)$/)?.[1] ?? 0);
  if (!explicitCurrent && (CURRENT_DOCUMENT_CONTEXT_PATTERN.test(source)
    || (DOCUMENT_SOURCE_DEPENDENCY_PATTERN.test(source) && !namedIds.length && !referenceIds.length)
    || (EXPLICIT_DOCUMENT_TASK_PATTERN.test(source) && !namedIds.length))) add(currentDocumentId);

  for (const match of source.matchAll(/第\s*(\d+)\s*章/g)) add(`chapter-${Number(match[1])}`);

  if (currentChapter) {
    if (/上下章|前后章|相邻章节|上下文/.test(source)) {
      add(`chapter-${currentChapter - 1}`);
      add(`chapter-${currentChapter + 1}`);
    } else {
      if (/上一章|上章|前文/.test(source)) add(`chapter-${currentChapter - 1}`);
      if (/下一章|下章|后文/.test(source)) add(`chapter-${currentChapter + 1}`);
    }
  }
  return result;
};

export const explicitCurrentDocumentRequest = (text = "") => (
  /(?:当前|正在|刚打开|新打开|选中的).{0,12}(?:文档|正文|章节|笔记)|(?:这个|这份).{0,6}(?:打开的)?(?:文档|笔记)/u.test(String(text))
);

export const notebookDocumentContextIds = ({
  currentDocumentId = "",
  referenceIds = [],
  existingDocumentIds = [],
} = {}) => {
  const existing = new Set(existingDocumentIds);
  const result = [];
  const add = (documentId) => {
    const normalized = String(documentId ?? "").trim();
    if (!normalized || result.includes(normalized) || (existing.size && !existing.has(normalized))) return;
    result.push(normalized);
  };
  add(currentDocumentId);
  referenceIds.forEach(add);
  return result;
};
