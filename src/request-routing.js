import { compileAgentDispatchContract, routeUsesShensiOrchestrator, routeUsesWorkspaceAgent } from "./agent-dispatch-contract.js";
import { compileAgentTaskPolicy } from "./agent-task-policy.js";
import { chapterNumberValue, isLocalWriteCapabilityQuestion } from "./chapter-target.js";
import { reviewDeliveryPolicy, reviewIncludesContentMutation } from "./review-delivery-policy.js";
import { createHistoryReadAuthorization } from "./history-read-policy.js";
import { hasFormalAssetWriteIntent } from "./artifact-ontology.js";
import { createFormalWriteAuthorization } from "./formal-write-authorization.js";
import { shouldSuppressAutomaticFormalLanding } from "./formal-write-confirmation.js";
import { normalizeTaskContract, validateTaskContractForExecution } from "./task-contract.js";
import { buildIntentEnvelope } from "./intent-envelope.js";
import { isImageAssetSourceExtractionRequest } from "./image-asset-routing.js";

const PLOT_OR_CRAFT_PATTERN = /剧情|情节|故事线|人物|角色|主角|配角|男主|女主|反派|白月光|关系线|人物弧|动机|人设|设定|世界观|伏笔|线索|信息释放|爽点|虐点|冲突|反转|高潮|结局|桥段|场景|对白|台词|描写|文风|叙事|视角|节奏|张力|情绪拉扯|不够刺激|更刺激|更自然|不自然|更爽|不够爽|更虐|追读|读者|开篇|章尾|(?:这段|这章|本章|上一章|下一章|前文|后文|这场戏).{0,16}(?:怎么写|如何写|发展|发生|问题|合理|自然|效果|修改|改写|续写|衔接|结尾)/;
const CREATIVE_ACTION_PATTERN = /写作|创作|续写|扩写|改写|重写|润色|精修|(?:写|撰写|制作|输出|修改|优化|生成|转换|转化|转成|改成).{0,18}(?:小说|故事|短篇|正文|章|集|大纲|卷纲|章纲|集纲|剧本|短剧|短视频|分镜|提示词|公众号文章|公众号推文|微信推文|视觉资产)|(?:自检|审稿|诊断|验收|检查|评估).{0,16}(?:小说|正文|章节|第\s*\d+\s*章|剧情|人物|设定|大纲|剧本|文案)|(?:小说|正文|章节|第\s*\d+\s*章|剧情|人物|设定|大纲|剧本|文案).{0,16}(?:自检|审稿|诊断|验收|检查|评估)|小说|正文|大纲|卷纲|章纲|集纲|剧本|短剧|漫剧|分镜|视觉资产|提示词|改编|落盘|候选稿|正史|canon/i;
const THEORY_REQUIRED_ACTION_PATTERN = /(?:写作|创作|续写|扩写|重写|精修)|(?:改写|润色|生成).{0,18}(?:小说|正文|句子|段落|章节|第\s*[零一二两三四五六七八九十百千万\d]+\s*章|大纲|卷纲|章纲|集纲|人物|角色|人设|设定|世界观|剧本|短剧|漫剧|分镜|视觉资产|提示词)|(?:自检|审稿|诊断|验收|评估).{0,20}(?:小说|正文|章节|第\s*[零一二两三四五六七八九十百千万\d]+\s*章|剧情|情节|人物|角色|设定|大纲|剧本)|检查.{0,20}(?:逻辑|连续性|人物动机|角色动机|剧情|情节|设定冲突|结构|节奏|张力|信息泄露|伏笔)|(?:剧情|情节|故事线|人物弧|人物动机|角色动机|关系线|设定|世界观|伏笔|信息释放|节奏|张力|爽点|虐点|冲突|反转|高潮|结局).{0,20}(?:问题|怎么|如何|应该|合理|自然|发展|设计|修改|改写|优化|增强|调整|自检|检查|评估)|(?:下一章|下章|后续).{0,16}(?:怎么|如何|应该|发展|写|安排|设计)/;
const DOCUMENT_UTILITY_PATTERN = /总结|概括|摘要|提取|摘录|归纳|整理|列出|统计|字数|多少字|计算|查找|检索|定位|搜索|出现几次|比较|对比|区别|解释|说明|什么意思|翻译|转写|格式化|转换|校对错别字|校对标点|回答.{0,8}(?:问题|疑问)|根据.{0,12}(?:文档|资料|正文|章节|上下文).{0,12}(?:回答|解答)|(?:文中|文档里|资料里|正文里|这一章里).{0,16}(?:有哪些|是什么|谁|哪里|何时|多少)|(?:第\s*[零一二两三四五六七八九十百千万\d]+\s*章|本章|这章|当前文档).{0,20}(?:讲了什么|发生了什么|写了什么|有哪些|是什么|谁|哪里|何时|多少|是否出现|提到)/;
const READ_ONLY_PROJECT_QUERY_PATTERN = /(?:不要|无需|不用|禁止|不得).{0,8}(?:生成|改写|重写|续写|创作|落盘|修改).{0,24}(?:正文|章节|作品|内容)|(?:只|仅)(?:需要)?(?:读取|查看|查询|核对|回答).{0,40}(?:项目|作品|正文|章节|设定|记忆|资料)|(?:冷启动|长篇记忆|事实|设定|连续性).{0,16}(?:测试|问答|核对|查询|回答)/;
const READ_ONLY_QUERY_ACTION_PATTERN = /回答|问答|查询|核对|列出|说明|概括|总结|是什么|哪(?:个|些|一)|谁|何时|哪里|多少|是否|有没有|确认到什么程度/;
const READ_ONLY_NETWORK_QUERY_PATTERN = /(?:联网|网络|网页|官网|最新(?:版本|消息|新闻|公告|价格|规则)|实时(?:数据|消息|新闻|价格)).{0,56}(?:查询|搜索|查找|核对|回答|结果|来源)|(?:查询|搜索|查找|核对|回答).{0,56}(?:联网|网络|网页|官网|最新(?:版本|消息|新闻|公告|价格|规则)|实时(?:数据|消息|新闻|价格))/iu;
const EXPLICIT_WRITE_NEGATION_PATTERN = /(?:不要|无需|不用|禁止|不得)(?:再|直接|进行)?[^，。！？；\n]{0,28}(?:保存|写入|落盘|覆盖|修改).{0,24}(?:文档|正文|章节|作品|内容)?/u;
const EXPLICIT_DOCUMENT_TASK_PATTERN = /(?:读取|阅读|查看|浏览|参考|识别|解析|处理).{0,24}(?:全文|全书|整部作品|全部(?:正文|章节|文档)|文档|文件|资料|正文|章节|大纲|设定|内容|文章)|(?:全文|全书|整部作品|全部(?:正文|章节|文档)|文档|文件|资料|正文|章节|大纲|设定|内容|文章).{0,24}(?:读取|阅读|查看|浏览|参考|识别|解析|处理|分类|转换|转成|整理|提取|统计|说明|写|生成|创作)/;
const MECHANICAL_DOCUMENT_TASK_PATTERN = /(?:文档|文件|资料|正文|章节|大纲|设定|内容|文章).{0,30}(?:格式|字数|字符|错别字|标点|标题层级|Markdown|表格|链接|字段|JSON|XML|CSV|排序|去重|编码|文件结构)|(?:格式|字数|字符|错别字|标点|标题层级|Markdown|表格|链接|字段|JSON|XML|CSV|排序|去重|编码|文件结构).{0,30}(?:文档|文件|资料|正文|章节|大纲|设定|内容|文章)/i;
const CREATIVE_DIAGNOSTIC_INTENT_PATTERN = /检查|诊断|自检|审稿|评估|验收|审查|分析|找出.{0,10}(?:问题|硬伤|漏洞|不足|风险)|看看.{0,10}(?:问题|硬伤|漏洞|不足|风险)|(?:有没有|有无|是否存在|哪些|什么).{0,8}(?:问题|硬伤|漏洞|不足|风险)|(?:这篇|那篇|这章|那章|这段|正文|文章|稿件|候选稿).{0,12}(?:怎么样|如何|好不好)|为什么.{0,24}(?:这样写|这么写|写成这样)/;
const CREATIVE_DIAGNOSTIC_TARGET_PATTERN = /小说|网文|故事|正文|文章|稿件|候选稿|章节|第\s*[零一二两三四五六七八九十百千万\d]+\s*章|这一章|那一章|这章|那章|本章|当前章节|这篇(?:正文|小说|故事|文章)?|那篇(?:正文|小说|故事|文章)?|剧情|情节|人物|角色|人设|设定|世界观|大纲|卷纲|章纲|集纲|剧本|短剧|漫剧|分镜|提示词|视觉资产|公众号文章|公众号推文/;
const CREATIVE_QUALITY_DIMENSION_PATTERN = /剧情|情节|故事线|逻辑|因果|连续性|人物|角色|动机|人设|设定|世界观|结构|节奏|张力|冲突|反转|高潮|爽点|虐点|情绪|伏笔|信息释放|文笔|文风|叙事|视角|台词|对白|描写|开篇|结尾|追读|读者体验/;
const PURE_PROOFREADING_PATTERN = /(?:检查|校对|查找|修正|找出).{0,30}(?:错别字|标点|格式|字数|字符|标题层级|Markdown|表格|链接|字段|编码|文件结构)|(?:错别字|标点|格式|字数|字符|标题层级|Markdown|表格|链接|字段|编码|文件结构).{0,30}(?:检查|校对|查找|修正|找出)/i;
const CONTEXTUAL_CREATIVE_TARGET_PATTERN = /当前文档|这个文档|这份文档|本文|当前内容|这篇|那篇|之前那篇|此前那篇|这一章|那一章|这章|那章|本章|当前章节|这一段|那一段|这段|那段|这部分|上面(?:这段|这篇|这章)?|刚才(?:这段|这篇|这章)?/;
const NON_CREATIVE_DIAGNOSTIC_TARGET_PATTERN = /软件|程序|系统|界面|页面|按钮|功能|版本更新|更新按钮|API|CLI|模型连接|网络|服务器|电脑|安装|路径|文件夹|保存状态|运行状态|(?:图片|图像|视频|音频|生图|出图|媒体).{0,16}(?:生成失败|任务失败|失败|报错|不可用|抓取不到|没有结果)|(?:生成|出图|生图).{0,16}(?:失败|报错|不可用|抓取不到)/i;
const OBJECTLESS_DIAGNOSTIC_PATTERN = /^(?:请|帮我|麻烦)?(?:检查|诊断|自检|审稿|评估|验收|审查|看看|看一下)(?:一下|下)?(?:有没有|有无|是否存在)?(?:什么|哪些)?(?:问题|硬伤|漏洞|不足|风险)?[。！!？?]*$|^(?:有没有|有无|是否存在)(?:什么|哪些)?(?:问题|硬伤|漏洞|不足|风险)[。！!？?]*$/;
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
const CAPABILITY_ROUTE_INSPECTION_PATTERN = /(?:读取|查看|检查|核对|展示|列出|告诉我|说明).{0,28}(?:面板|模组|模块).{0,12}(?:路由|结构|直接成员|直接模块|成员清单)|(?:面板|模组|模块).{0,16}(?:路由|结构|直接成员|直接模块|成员清单).{0,28}(?:读取|查看|检查|核对|展示|列出|告诉我|说明)/iu;
const CAPABILITY_ROUTE_MUTATION_PATTERN = /(?:修改|优化|更新|重写|新增|删除|创建|保存|编译).{0,24}(?:面板|模组|模块|路由)|(?:面板|模组|模块|路由).{0,24}(?:修改|优化|更新|重写|新增|删除|创建|保存|编译)/iu;
const CREATIVE_GENRE_PATTERN = /女频(?:虐文|爽文|甜宠文|言情文|网文|小说|短剧|剧本|文)?|男频(?:爽文|升级流|系统流|网文|小说|短剧|剧本|文)?|(?:虐文|爽文|甜文|宠文|成长文|复仇文|群像文)|(?:玄幻|仙侠|修仙|都市|悬疑|推理|科幻|末世|无限流|系统流|穿越|重生|古言|现言|宫斗|宅斗|甜宠|虐恋|追妻火葬场|真假千金|赘婿|种田|年代|校园|职场|娱乐圈|权谋|武侠|历史|恐怖|惊悚|灵异|乙女|群像)(?:文|小说|网文|短剧|剧本|故事)?/;
const SHENSI_CREATIVE_TARGET_PATTERN = /小说|网文|故事|短篇|微型小说|中篇|长篇|连载|正文|章节|大纲|卷纲|章纲|集纲|剧集大纲|人物设定|角色设定|世界观|剧本|短剧|漫剧|剧情短视频|AI\s*短片|分镜|视频提示词|图片(?:资产)?提示词|角色定妆(?:图)?提示词|场景提示词|道具提示词|视觉资产|全景调度|站位图|公众号文章|公众号长文|公众号推文|微信推文|推文/;
const CREATIVE_PRODUCTION_VERB_PATTERN = /完成|产出|生成|创作|撰写|编写|制作|改编|续写|改写|重写|定稿|成稿|出稿|写出|写成|写|形成|完善为|整理成|转换(?:成|为)|转化(?:成|为)|转成/;
const CREATIVE_PRODUCTION_REQUEST_CUE_PATTERN = /请|帮我|给我|替我|需要你|我要|我想要|希望你|麻烦|务必|必须|直接|立即|开始|继续|按照|根据|基于|结合|研究|读取|参考|使用|调用|启用|用|把|将/;
const CREATIVE_COMPLETION_STATUS_QUERY_PATTERN = /(?:小说|网文|故事|短篇|正文|章节|大纲|卷纲|章纲|集纲|剧本|脚本|短剧|漫剧|分镜|提示词|文案|稿件|正式稿).{0,16}(?:完成|生成|写好|产出|定稿)(?:了|了吗|没有|没|到哪|进度|情况|到什么程度)|(?:完成|生成|写好|产出|定稿)(?:了吗|没有|没|到哪|进度|情况).{0,16}(?:小说|网文|故事|正文|大纲|剧本|脚本|短剧|漫剧|分镜|提示词|稿件)/;
const PROJECT_FACT_QUERY_ACTION_PATTERN = /是什么|指什么|有哪些|包含什么|谁|哪(?:个|些|里|一)|何时|什么时候|多少|几(?:个|次|章|集|幕|场)|是否(?:出现|提到|写到|存在|包含)|有没有(?:出现|提到|写到|包含)|发生了什么|写了什么|讲了什么/;
const CREATIVE_HELP_PATTERN = /(?:我|本人)?(?:想|要|需要|希望|准备|打算|计划|尝试|试着|正在考虑)(?:要|来)?(?:写|创作|做)|(?:能不能|可以不可以|可不可以|可以|请|麻烦)?(?:帮我|带我|教我)(?:写|创作|构思|设计|开始|梳理)?|(?:不知道|不清楚|没想好|没有头绪|没头绪).{0,16}(?:怎么|如何|从哪|该从哪|写|创作|构思|开始|展开|推进)?|(?:怎么|如何|该怎么|应该怎么|从哪|该从哪)(?:写|创作|构思|开始|展开|推进|设计)|(?:创作|写作|构思|开篇|剧情|人物|设定).{0,12}(?:建议|思路|方向|帮助)|(?:有什么|给我|提供).{0,8}(?:创作|写作|构思|开篇|剧情|人物|设定)?(?:建议|思路|方向)|^(?:写|创作|构思|设计|做)(?:一部|一个|一篇|个|部)?/;
const EXPLICIT_DIRECT_CREATION_PATTERN = /直接(?:写|撰写|产出|完成|生成|创作|做|转换|出)|立即(?:写|撰写|产出|完成|生成|创作)|必须直出|不要(?:追问|询问)|无需(?:追问|询问)|不用(?:追问|询问)|不要创作引导|跳过创作引导|全自动|按现有.{0,10}(?:写|撰写|产出|完成|生成|创作|转换)|(?:使用|用|调用|启用).{0,24}(?:skill|技能).{0,12}(?:重新生成|重生成|重做|生成|输出)|(?:从现在|现在|从头|从开头|从第一章|由第一章).{0,6}(?:开始)?(?:写|撰写|创作|开篇)/i;
const EXPLICIT_FRESH_CREATIVE_START_PATTERN = /从零开始(?:继续执行(?:上一条任务)?)?|(?:不是|并非|不要|无需).{0,6}(?:续写|继续写|接着写|承接前文)|(?:从现在|现在|从头|从开头|从第一章|由第一章).{0,6}(?:开始)?(?:写|创作|开篇)|(?:新故事|新小说|新作品|新作).{0,10}(?:开始|开篇|写|创作)|(?:开始|开篇|写|创作).{0,10}(?:新故事|新小说|新作品|新作)/;
const CREATIVE_GUIDANCE_ONLY_PATTERN = /(?:先|现在|本轮|这次|当前)?\s*(?:不要|无需|不必|先不|暂不|禁止|不得)\s*.{0,16}(?:写|生成|创作|落盘|创建|新建)(?:正文|章节|文档|稿件|成稿|正式内容)?|(?:只|仅)(?:需要|要|先)?\s*.{0,12}(?:提问|追问|讨论|梳理|确认|创作引导)|(?:开启|进入|进行|继续).{0,8}创作引导/u;
const EXPLICIT_CONTINUATION_CORRECTION_PATTERN = /(?:不是|并非|不要).{0,8}(?:从现在|从头|从开头|从第一章|新故事|新小说|新作品|新作).{0,12}(?:而是|是|要).{0,6}(?:续写|继续写|接着写)/;
const NEGATED_FRESH_CREATIVE_START_PATTERN = /(?:不|不要|不用|无需|不必|别).{0,4}(?:从现在|从头|从开头|从第一章|由第一章).{0,8}(?:开始|重新|另)?(?:写|创作|开篇|生成|重做)|(?:保留|沿用|基于|根据).{0,12}(?:上方|已有|当前|原有|已保留).{0,8}(?:候选|稿件|正文).{0,12}(?:不|不要|无需|不用|别).{0,4}(?:从头|重写|另写|重做)/;
const GENRE_INFORMATION_PATTERN = /(?:是什么|什么意思|如何定义|怎么定义|定义|区别|差别|起源|历史|市场|代表作|推荐|有哪些类型|分类|受众|读者画像|特点是什么|特征是什么)/;
const SENTENCE_REVISION_PATTERN = /(?:这句话|这句(?:话|台词)?|一句话|这一句|一句台词).{0,24}(?:怎么改|如何改|改得|改成|更自然|自然一点|顺一点|润色|精简|调整)|(?:把|将).{0,30}(?:这句话|这句(?:话|台词)?|一句话|这一句|一句台词).{0,16}(?:改|润色|精简|调整)|(?:改|润色|精简|调整).{0,16}(?:这句话|这句(?:话|台词)?|一句话|这一句|一句台词)/;
const CREATIVE_WORK_TERM_PATTERN = /作品|小说|正文|章节|第\s*\d+\s*章|本章|前文|后文|剧情|情节|角色|人物|主角|配角|男主|女主|反派|对白|台词|人设|设定|世界观|规则|体系|势力|地点|道具|法术|能力|境界|伏笔|信息释放|章纲|卷纲|大纲|剧本|短剧|漫剧|分镜|镜头|场次|旁白|画外音|视觉资产|视频提示词|全景调度|站位图|术语|专有名词|正史|canon/i;
const VIDEO_OR_BLOCKING_PROMPT_PATTERN = /(?:视频|分镜|漫剧|镜头|图片|角色|场景|道具|定妆|视觉资产|全景调度(?:图)?|站位(?:图|线稿图)?).{0,8}提示词|多人站位|空间调度/;
const PROMPT_QUALITY_GUIDANCE_PATTERN = /(?:提示词|分镜|镜头|视觉资产|图片资产|站位|全景调度).{0,36}(?:效果不够|不到位|不满意|不对|重做|重新做|优化|改进|站位不清|动作不准)|(?:提示词|分镜|镜头).{0,36}(?:运镜|景别|光源|质感).{0,8}(?:不对|不符|有问题|不到位|调整|优化|改进)|(?:站位不清|动作不准|运镜不对|景别不对|光源不对|质感不对).{0,24}(?:提示词|分镜|镜头|转换|生成)/;
const CREATIVE_TRANSFORMATION_PATTERN = /(?:把|将|根据|基于).{0,48}(?:小说|故事|文章|剧本|章节|大纲|当前内容|第一集|第\s*\d+\s*集).{0,24}(?:改编成|改编为|改成|改写成|转换成|转换为|转化成|转化为|转成|制作成|生成)(?:一篇|一个|一部|为)?.{0,4}(?:小说|故事|短篇|剧本|短剧|漫剧|剧情短视频|分镜|提示词|公众号文章|公众号推文)|(?:改编成|改编为|改成|改写成|转换成|转换为|转化成|转化为|转成).{0,12}(?:短剧|漫剧|剧本|视频提示词|分镜提示词|图片提示词|公众号文章|短视频剧本)|(?:小说|剧本|脚本|短视频剧本|短视频脚本|漫剧).{0,12}(?:转\s*AI|转视频|视频化|视觉化|生成视觉提示词)/i;
const CREATIVE_REVISION_PATTERN = /(?:把|将).{0,24}(?:当前章节|这章|本章|正文|剧本|大纲|卷纲|剧情走向).{0,32}(?:改得|改成|改写|重写|重构|优化|润色)|(?:去掉|去除|降低).{0,8}(?:AI味|机器味|生成腔)|(?:真人作者|作者化|人工写作感).{0,16}(?:改写|优化|润色)|(?:把|将)?(?:当前卷|本卷|剧情|走向|大纲)?.{0,16}(?:按|依照|采用)?(?:三幕(?:式|结构)|四幕(?:式|结构)|英雄之旅|起承转合).{0,16}(?:重新规划|规划|重构|调整|优化)/;
const CONTEXTUAL_CREATIVE_REVISION_ACTION_PATTERN = /微调|润色|精修|改写|重写|重构|调整|修改|优化|收紧|压缩|精简|缩减|删减|缩短|浓缩|扩写|扩充|扩展|补写|补足|续写|删改|打磨|弱化|强化|改得|改成|换一种|更克制|克制一点|更自然|自然一点|更顺|顺一点|更有张力|控制.{0,16}(?:字数|篇幅|长度|时长|\d\s*(?:字|字符|词|分钟|秒))|限制.{0,16}(?:字数|篇幅|长度|时长|\d\s*(?:字|字符|词|分钟|秒))|降低.{0,8}(?:AI味|机器味|生成腔)|去(?:掉|除).{0,8}(?:AI味|机器味|生成腔)/;
const STRONG_CREATIVE_REVISION_COMMAND_PATTERN = /微调|润色|精修|改写|重写|重构|修改|优化|压缩|精简|缩减|删减|缩短|浓缩|扩写|扩充|扩展|补写|补足|续写|删改|打磨|控制.{0,16}(?:字数|篇幅|长度|时长|\d\s*(?:字|字符|词|分钟|秒))|限制.{0,16}(?:字数|篇幅|长度|时长|\d\s*(?:字|字符|词|分钟|秒))|降低.{0,8}(?:AI味|机器味|生成腔)|去(?:掉|除).{0,8}(?:AI味|机器味|生成腔)/;
const EXPLICIT_CREATIVE_REVISION_TARGET_PATTERN = /当前(?:正文|章节|文档|内容|剧本|大纲|文章|推文|稿件|文案)|现有(?:正文|章节|剧本|大纲|候选|文章|推文|稿件|文案)|已有(?:正文|章节|剧本|大纲|候选|文章|推文|稿件|文案)|原有(?:正文|章节|剧本|大纲|候选|文章|推文|稿件|文案)|这篇(?:文章|推文|稿件|文案)|本文|这一章|这章|本章|这一段|这段|这部分|上面(?:这段|这篇|这章)?|刚才(?:这段|这篇|这章)?|第\s*[零一二两三四五六七八九十百千万\d]+\s*[章节集]/;
const NON_CREATIVE_REVISION_TARGET_PATTERN = /(?:修复|调整|修改|优化|微调).{0,20}(?:软件|程序|系统|界面|页面|按钮|功能|布局|快捷键|API|CLI|网络|服务器|安装|路径|目录|弹窗|窗口|面板|组件|代码)|(?:软件|程序|系统|界面|页面|按钮|功能|布局|快捷键|API|CLI|网络|服务器|安装|路径|目录|弹窗|窗口|面板|组件|代码).{0,20}(?:修复|调整|修改|优化|微调)|\b(?:src|server|scripts)[\\/]|\.(?:js|mjs|cjs|ts|tsx|jsx|css|html|json)\b/i;
const STRUCTURAL_NUMBERING_REVISION_PATTERN = /(?:场次|场景|镜头|章节|章次|集数|幕次|段落).{0,16}(?:数字|编号|序号|顺序).{0,20}(?:修正|校正|更正|调整|修改|重排|重编|重新(?:编号|排序|排列|修正|校正))|(?:修正|校正|更正|调整|修改|重新(?:修正|校正)).{0,20}(?:后续|后面|之后|以下|全部|所有|当前|现有|已有)?.{0,8}(?:场次|场景|镜头|章节|章次|集数|幕次|段落)(?:的)?(?:数字|编号|序号|顺序)|(?:重排|重编|重新(?:编号|排序|排列)).{0,20}(?:后续|后面|之后|以下|全部|所有|当前|现有|已有)?.{0,8}(?:场次|场景|镜头|章节|章次|集数|幕次|段落)/;
const EXISTING_ASSET_REOUTPUT_PATTERN = /(?:连带|连同|带上).{0,10}(?:正文|全文|剧本|章节|内容).{0,16}(?:重新|完整|原样)?(?:输出|贴出|发出|展示)|(?:把|将|给我)?(?:当前|现有|已有|原有|上面|刚才|这篇|这章|本章)?(?:正文|全文|剧本|章节|内容).{0,20}(?:重新|完整|原样)(?:输出|贴出|发出|展示)|(?:重新|完整|原样)(?:输出|贴出|发出|展示).{0,12}(?:当前|现有|已有|原有|上面|刚才|这篇|这章|本章)?(?:正文|全文|剧本|章节|内容)/;
const EXISTING_ASSET_DELIVERY_ACTION_PATTERN = /(?:给我|发我|发给我|贴出|输出|展示|返回|提供|呈现)/;
const EXISTING_ASSET_VERSIONED_TEXT_PATTERN = /(?:新版|新版本|最新版|修订版|修改后|调整后|优化后|改好后|改完后|最终版|定稿版|完整|全部|全篇|整篇|整章|全章).{0,12}(?:正文|全文|文章|稿件|剧本|脚本|内容)|(?:正文|全文|文章|稿件|剧本|脚本|内容).{0,12}(?:新版|新版本|最新版|修订版|修改后|调整后|优化后|改好后|改完后|最终版|定稿版|完整|全部|全篇|整篇|整章|全章)/;
const CONTEXT_BACKED_CREATIVE_FOLLOWUP_PATTERN = /(?:给我|发我|发给我|贴出|输出|展示|返回|提供).{0,18}(?:正文|全文|完整|新版|修订版|修改后|调整后|优化后|最终版|定稿版)|(?:就)?按(?:这个|这样|上面|刚才|你说的).{0,8}(?:改|修改|调整|重写|输出)|(?:那就|就)(?:这么|这样).{0,6}(?:改|修改|调整|重写)|(?:继续|接着).{0,8}(?:改|修改|重写|润色|处理)|(?:依次|逐一|逐章|全部|按顺序).{0,8}(?:修复|修改|调整|改好|处理)/;
const SETTING_CREATION_PATTERN = /(?:设计|创建|构建|建立|生成|规划|完善|补充|新增|修改|重做).{0,24}(?:人物设定|角色设定|人物档案|世界观|世界规则|力量体系|能力体系|修炼体系|等级体系|时间线|势力设定|地点设定|物品设定|概念设定|规则设定|种族设定|术语表)|(?:人物设定|角色设定|人物档案|世界观|世界规则|力量体系|能力体系|修炼体系|等级体系|时间线|势力设定|地点设定|物品设定|概念设定|规则设定|种族设定|术语表).{0,24}(?:设计|创建|构建|建立|生成|规划|完善|补充|新增|修改|重做)/;
const CREATIVE_KNOWLEDGE_PATTERN = /(?:小说|网文|故事|短篇|短剧|漫剧|剧本|分镜|提示词|公众号文章|剧情短视频).{0,24}(?:是什么|什么意思|如何定义|怎么定义|有哪些类型|有什么区别|起源|历史|代表作|推荐)|(?:是什么|什么意思|如何定义|怎么定义|有哪些类型|有什么区别).{0,24}(?:小说|网文|故事|短篇|短剧|漫剧|剧本|分镜|提示词|公众号文章|剧情短视频)/;
const WHOLE_PROJECT_CONTEXT_PATTERN = /(?:读取|阅读|查看|浏览|参考|根据|基于|结合|使用|用|分析|总结|梳理).{0,32}(?:全文|全书|整部(?:作品|小说|剧本)?|完整(?:作品|小说|剧本)|全部(?:正文|章节|文档))|(?:全文|全书|整部(?:作品|小说|剧本)?|完整(?:作品|小说|剧本)|全部(?:正文|章节|文档)).{0,32}(?:写|生成|创作|制作|总结|分析|提取|改写|转换)/;
const COMMON_PROJECT_NGRAMS = new Set(["这句话", "怎么改", "如何改", "更自然", "自然一点", "顺一点", "帮我改", "改一下", "一句话", "这一句", "有什么", "为什么", "现在的", "目前的"]);

const hasAffirmativeContextualRevisionAction = (source = "") => {
  const matcher = new RegExp(CONTEXTUAL_CREATIVE_REVISION_ACTION_PATTERN.source, "g");
  for (const match of String(source).matchAll(matcher)) {
    const before = String(source).slice(Math.max(0, Number(match.index) - 36), Number(match.index));
    const clausePrefix = before.slice(Math.max(before.lastIndexOf("，"), before.lastIndexOf("。"), before.lastIndexOf("！"), before.lastIndexOf("？"), before.lastIndexOf("；"), before.lastIndexOf("\n")) + 1);
    if (/(?:不要|不需要|无需|不必|禁止|不得|避免|别|不是|并非)(?:再|直接|进行|做)?[^，。！？；\n]{0,24}$/u.test(clausePrefix)) continue;
    return true;
  }
  return false;
};

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
const PREPARED_NOVEL_PRODUCTION_PATTERN = /(?:开始|继续|接着|马上|现在|请|帮我)?(?:直接)?(?:写|续写|生成|创作).{0,16}(?:第\s*[零一二两三四五六七八九十百千万\d]+\s*章|本章|这一章|当前章|下一章|下章|小说正文|正文)|(?:第\s*[零一二两三四五六七八九十百千万\d]+\s*章|本章|这一章|当前章|下一章|下章|小说正文|正文).{0,16}(?:开始|继续|接着|写|续写|生成|创作)|主笔.{0,8}(?:开写|开始写|续写)/;
const BOOK_DECONSTRUCTION_ACTION_PATTERN = /^(?:请|帮我|麻烦)?(?:开始|进行|做|执行|完整|全面|深度)?(?:爆款)?(?:拆书|拆文|拆小说)(?:分析|报告)?[。！!]*$|(?:请|帮我|把|将|开始|进行|做|执行|完整|全面|深度).{0,20}(?:爆款拆书|拆书|拆文|拆解(?:这|该|本|整)?(?:本书|部作品|篇小说|篇文章|个故事))|(?:爆款拆书|拆书报告|完整拆解这本书|全书逆向分析|逆向分析(?:这|该|本)?(?:部作品|本书|篇小说)|提取.{0,12}(?:爆款机制|追读机制))/;
const BOOK_DECONSTRUCTION_KNOWLEDGE_PATTERN = /(?:拆书|拆文).{0,18}(?:是什么|什么意思|定义|作用|用途|方法|怎么学|如何学|有哪些理论)|(?:是什么|什么意思|介绍|解释).{0,18}(?:拆书|拆文)/;

export const isExplicitFreshCreativeStart = ({ text = "" } = {}) => {
  const source = String(text).trim();
  return Boolean(source
    && EXPLICIT_FRESH_CREATIVE_START_PATTERN.test(source)
    && !NEGATED_FRESH_CREATIVE_START_PATTERN.test(source)
    && !EXPLICIT_CONTINUATION_CORRECTION_PATTERN.test(source));
};

export const isExplicitDirectCreationRequest = ({ text = "" } = {}) => {
  const source = String(text).trim();
  // “现在开启创作引导” used to match the broad “现在…创作” direct-production
  // clause. Remove only the guidance directive before looking for an actual
  // direct-write command; any separate “直接写/不要追问” instruction remains.
  const withoutGuidanceDirective = source.replace(
    /(?:现在|本轮|这次|当前)?\s*(?:开启|进入|进行|继续).{0,8}?创作引导/gu,
    " ",
  );
  return EXPLICIT_DIRECT_CREATION_PATTERN.test(withoutGuidanceDirective);
};

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

export const creativeContextRequiredIds = ({ freshStart = false, defaultIds = [], explicitReferenceIds = [] } = {}) => [
  ...new Set([
    ...(freshStart ? [] : defaultIds),
    ...explicitReferenceIds,
  ].map(String).filter(Boolean)),
];

export const blockingCreativeContextIds = ({ text = "", targetDocumentId = "", missingRequiredIds = [], existingAssetIntent = false, sourceBackedAssetIntent = false } = {}) => {
  const source = String(text).trim();
  const missing = [...new Set(missingRequiredIds.map(String).filter(Boolean))];
  const freshStart = isExplicitFreshCreativeStart({ text: source });
  const direct = isExplicitDirectCreationRequest({ text: source });
  const target = String(targetDocumentId);
  // Ordinary outlines, canon notes and neighbouring chapters are valuable
  // context, but absence of one of them is not permission to deadlock the
  // writer. Explicit @ references are added by the caller as hard
  // dependencies. Here only a missing current target for an actual revision
  // remains terminal; creation can proceed with warnings and model fallback.
  if (existingAssetIntent === true) {
    // A deleted/uninitialized target is a recoverable routing ambiguity. An
    // explicit create/overwrite instruction can still materialize it; when
    // the user meant to revise an existing asset, the caller can ask for a
    // target correction instead of turning the whole task into a hard gate.
    const explicitWriteOrCreate = /(?:新建|创建|另建|新文档|直接(?:写入|落盘|覆盖)|(?:写入|落盘|覆盖)(?:当前|目标)?文档)/u.test(source);
    return explicitWriteOrCreate ? [] : missing.filter((id) => id === target);
  }
  if (!freshStart && !direct) return [];
  const targetChapter = Number(target.match(/^chapter-(\d+)$/)?.[1] ?? 0);
  const ordinaryScaffoldIds = new Set([
    ...(freshStart || direct || sourceBackedAssetIntent === true ? [target] : []),
    ...(targetChapter ? [`outline-chapter-${targetChapter}`] : []),
    ...(freshStart ? ["chapter-1", "outline-chapter-1"] : []),
  ].filter(Boolean));
  return missing.filter((id) => id === target && !ordinaryScaffoldIds.has(id));
};

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
const SKILL_ROUTE_INSPECTION_PATTERN = /(?:(?:有没有|是否|用没用|有没有用|为什么(?:没|没有|未)|为何(?:没|没有|未)|调用(?:了|过|到)?|启用(?:了|过)?|用了哪个|调用哪个).{0,36}(?:skill|技能|模块))|(?:(?:skill|技能|模块).{0,36}(?:有没有|是否|用没用|调用(?:了|过|到)?|启用(?:了|过)?|为什么(?:没|没有|未)))/i;

const deliverableTypeFromText = (source = "") => {
  const text = String(source).trim();
  if (!text) return "";
  // 提示词和明确的独立短篇必须先于其来源文体，避免“短视频提示词”
  // 或“短剧改成短篇小说”被来源词污染。
  if (GENERIC_PROMPT_DELIVERABLE_PATTERN.test(text) || VISUAL_ASSET_SKILL_DELIVERABLE_PATTERN.test(text)) return "visual_prompt";
  if (PUBLIC_ACCOUNT_DELIVERABLE_PATTERN.test(text)) return "public_account";
  if (SHORT_FICTION_DELIVERABLE_PATTERN.test(text)) return "short_fiction";
  if (SHORT_VIDEO_SCRIPT_DELIVERABLE_PATTERN.test(text)) return "short_video_script";
  if (SHORT_DRAMA_SCRIPT_DELIVERABLE_PATTERN.test(text) || GENERIC_SCRIPT_PRODUCTION_PATTERN.test(text)) return "short_drama_script";
  if (/小说|网文|长篇|中篇|正文|章节|大纲|卷纲|章纲|细纲|详细大纲/.test(text) || CREATIVE_GENRE_PATTERN.test(text)) return "novel";
  return "";
};

const transformedDeliverableType = (source = "") => {
  const segments = String(source).split(/改编成|改编为|改成|改写成|转换成|转换为|转化成|转化为|转成|制作成|生成为|生成成/u);
  return segments.length > 1 ? deliverableTypeFromText(segments.at(-1)) : "";
};

export const creativeDeliverableType = ({ text = "", targetDocumentId = "" } = {}) => {
  const source = String(text);
  if (isBookDeconstructionRequest({ text: source })) return "book_deconstruction";
  const transformed = transformedDeliverableType(source);
  if (transformed) return transformed;
  const explicit = deliverableTypeFromText(source);
  if (explicit) return explicit;
  // 当前目标只能在本轮没有明确成品类型时兜底，绝不能把“600字短篇”
  // 因为当前打开的是长篇正文而重新解释成长篇。
  const targetId = String(targetDocumentId);
  if (targetId.startsWith("prompt-")) return "visual_prompt";
  if (/^script-(?:episode|outline)-/.test(targetId)) return "short_drama_script";
  if (/^(?:chapter-|outline-(?:general|volume|chapter)-)/.test(targetId)) return "novel";
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

// A review step that follows creation is a quality stage inside the same
// production task, not the primary task itself.  Keep the initial structured
// route on the writer so the task card and the Agent agree about the real
// deliverable; the Agent may still read the review module after the draft.
export const reviewIsPostwriteStepOfFormalCreation = ({ text = "", targetDocumentId = "" } = {}) => {
  const source = String(text).trim();
  if (!source || !hasExplicitCreativeProductionIntent({ text: source, targetDocumentId })) return false;
  const reviewIndex = source.search(CREATIVE_DIAGNOSTIC_INTENT_PATTERN);
  if (reviewIndex < 0) return false;
  const productionMatch = source.match(/(?:创作|生成|撰写|编写|写出|写成|制作).{0,36}(?:一篇|一部|一个|小说|故事|短篇|正文|文章|稿件|章节|剧本|脚本)/u);
  const productionIndex = Number(productionMatch?.index ?? -1);
  if (productionIndex < 0 || productionIndex >= reviewIndex) return false;
  const sequence = source.slice(productionIndex, reviewIndex);
  return /(?:完成|写完|写好|生成|成稿|定稿|落盘|写入)(?:后|之后|以后)|(?:然后|随后|接着|再|下一步|第[二三四五六七八九十\d]+步)/u.test(sequence);
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

const CAPABILITY_BRANCHES_BY_DELIVERABLE = Object.freeze({
  novel: Object.freeze({
    topLevel: "group:novel",
    guidance: "module:novel-guidance",
    planning: "module:novel-planning",
    produce: "module:novel-writer",
    review: "module:novel-review",
    theory: "group:novel-theory",
    memory: "module:shared-memory",
  }),
  short_fiction: Object.freeze({ topLevel: "group:short-fiction", guidance: "module:short-fiction-guidance", produce: "module:short-fiction-writer", review: "module:short-fiction-review", theory: "module:short-fiction-theory" }),
  public_account: Object.freeze({ topLevel: "group:public-account", guidance: "module:public-account-guidance", produce: "module:public-account-writer", theory: "module:public-account-theory", illustration: "module:public-account-illustration" }),
  short_drama_script: Object.freeze({ topLevel: "group:short-drama", guidance: "module:short-drama-guidance", produce: "group:short-drama-writers", review: "module:short-drama-review", theory: "group:novel-theory", memory: "module:shared-memory" }),
  short_video_script: Object.freeze({ topLevel: "group:short-video", guidance: "module:short-video-guidance", produce: "module:short-video-writer", review: "module:short-video-review", theory: "module:short-video-theory" }),
  visual_prompt: Object.freeze({ topLevel: "group:prompt-engineering", guidance: "module:prompt-guidance", produce: "module:prompt-writer", panorama: "module:prompt-panorama-writer", video: "module:video-prompt-writer" }),
});

export const creativeCapabilityRouteDecision = ({ text = "", deliverableType = "", mode = "", diagnosisIntent = false } = {}) => {
  const branch = CAPABILITY_BRANCHES_BY_DELIVERABLE[deliverableType];
  if (!branch || !["creative", "creative_guidance", "visual_prompt", "quick_revision"].includes(mode)) return {};
  const source = String(text);
  const postwriteReview = reviewIsPostwriteStepOfFormalCreation({ text: source });
  let stage = mode === "creative_guidance" ? "guidance"
    : !postwriteReview && (diagnosisIntent || /(?:自检|质检|审稿|诊断|检查|评估).{0,18}(?:正文|文章|小说|故事|剧本|脚本|成稿|候选)/u.test(source)) ? "review"
      : /(?:更新|整理|维护|校准|检查).{0,18}(?:记忆|连续性|人物状态|伏笔)/u.test(source) ? "memory"
        : /(?:理论|方法论|创作规律|题材规律)/u.test(source) && !hasExplicitCreativeProductionIntent({ text: source }) ? "theory"
          : /(?:规划|设计|制定|生成|撰写|修改|更新).{0,18}(?:大纲|卷纲|章纲|集纲|人物设定|角色设定|世界观|剧情结构)/u.test(source) ? "planning"
            : "produce";
  if (deliverableType === "public_account" && /(?:配图|插图|图片规划|图文规划)/u.test(source)) stage = "illustration";
  if (deliverableType === "visual_prompt") {
    if (mode === "creative_guidance") stage = "guidance";
    else if (/(?:全景调度|多人站位|站位图|站位线稿)/u.test(source)) stage = "panorama";
    else if (/(?:视频提示词|分镜提示词|镜头提示词|运镜|Seedance)/iu.test(source)) stage = "video";
    else stage = "produce";
  }
  const selectedCapabilityNodeId = branch[stage] || branch.produce || branch.topLevel;
  return {
    routeStage: stage,
    selectedCapabilityTopLevelId: branch.topLevel,
    selectedCapabilityNodeId,
    routeReason: `交付类型=${deliverableType}；阶段=${stage}；主分支=${selectedCapabilityNodeId}`,
  };
};

export const hasSufficientCreativeBrief = ({ text = "", deliverableType = "", hasResources = false } = {}) => {
  const source = String(text).trim();
  if (!source || !deliverableType) return false;
  if (isExplicitDirectCreationRequest({ text: source })) return true;
  if (CREATIVE_TRANSFORMATION_PATTERN.test(source) && (hasResources || /根据|基于|把|将|读取|参考|现有|附件|全文|大纲|剧本|素材/.test(source))) return true;

  const requiredGroups = ({
    public_account: [
      /主题|选题|核心问题|讨论|围绕|关于|讲清|观点|立场/,
      /读者|受众|面向|给.{0,10}看|职场人|家长|学生|女性|男性|创业者|管理者/,
      /收益|目的|看完|读完|解决|说服|打动|传播|转化|涨粉/,
      /观点文|故事文|经验文|案例文|方法文|科普|争议辨析|人物文|文章类型|切口/,
      /语气|口吻|文风|风格|作者人格|个人经历|独特观察|差异化|犀利|克制|温暖|幽默|专业|不要说教/,
      /案例|经历|数据|来源|事实|证据|反常识|争议|强共鸣|核心看点|方法|清单|不需要外部资料/,
      /结构|节奏|开头|开场|钩子|信息密度|情绪曲线|段落|结尾/,
      /标题|题目|主标题|备选标题|标题策略/,
      /结尾|行动|评论|转发|关注|互动|余味|回扣/,
    ],
    short_video_script: [
      /\d+\s*(?:秒|分钟)|时长|单条|连续|单集|竖屏|横屏|抖音|视频号|快手/,
      /视频风格|写实|生活流|喜剧|悬疑|短剧感|表演形式|口播|对手戏|群像|无台词/,
      /口癖|声口|说话习惯|台词风格|语气|方言|不要口癖/,
      /观众|受众|爽|笑|怕|心疼|好奇|治愈|情绪|压抑|感动|核心看点|主要满足/,
      /主角|主人公|人物|角色|情侣|父子|母女|同事|朋友/,
      /冲突|阻碍|对抗|目标|欲望|必须|危机|困境|反击|状态变化/,
      /开场|开头|第一秒|第一眼|第一画面|第一动作|一上来|异常|钩子/,
      /中段|升级|兑现|反转依据|看点次数|代价递增|反击/,
      /结尾|收尾|反转|悬念|尾钩|追更|下一条|最后/,
      /真人|AI\s*制作|场景数|人物数|低成本|单场景|制作限制|不能出现/,
    ],
    short_fiction: [
      /\d+\s*字|篇幅|短篇|微型|小小说|反常小故事|质量文|情绪型|悬疑型|现实观察/,
      /前提|脑洞|概念|设定|规则|时间|地点|异常处境|围绕|关于/,
      /主角|主人公|人物|角色|谁/,
      /想要|欲望|目标|必须|选择|决定/,
      /冲突|阻碍|代价|困境|危机|关系/,
      /结构|线性|结果前置|倒计时|双线|循环|认知翻转|第一人称|第三人称|视角|叙事方式|顺叙|倒叙/,
      /核心看点|主题|深度|抓眼球|反常|主要情绪|余味|价值问题/,
      /中段|升级|信息释放|误导|反转依据|高潮|场景数量|节奏/,
      /结尾|收尾|反转|余味|悲剧|喜剧|开放式|最后/,
      /文风|风格|句式|克制|浓烈|冷峻|幽默|诗性|解释量|不要|禁区/,
    ],
    visual_prompt: [
      /视频提示词|分镜提示词|图片资产|站位图|\d+\s*(?:秒|分钟)|比例|横屏|竖屏|模型|平台|Seedance|可灵|即梦|Sora|Midjourney/i,
      /质感|材质|写实|风格|纪实|广告|胶片|动画|国漫|颗粒|色彩/,
      /主体|人物|角色|物体|场景|地点|画面中心|构图|站位|前景|中景|后景|景别|机位|焦段|景深/,
      /光线|光源|侧光|逆光|色温|冷暖|明暗|轮廓光|环境光|曝光/,
      /动作|姿态|表情|视线|手部|重心|微表情|走|跑|转身|推门|抬头|速度/,
      /运镜|固定镜头|推|拉|摇|移|跟拍|环绕|升降|起点|终点|镜头路径/,
      /台词|口型|语气|背景音乐|音乐|环境声|音效|字幕|不需要字幕|不要音乐|不适用/,
      /禁止|不要|避免|水印|文字|漂移|变形|连续性|服装一致|道具一致|动作承接/,
    ],
    novel: [
      /题材|类型|女频|男频|玄幻|都市|悬疑|科幻|言情|虐文|爽文/,
      /主角|主人公|人物|角色|男主|女主/,
      /目标|欲望|想要|必须|选择/,
      /冲突|阻碍|代价|对手|危机|困境/,
      /结局|结尾|终局|反转|阶段兑现/,
      /\d+\s*章|\d+\s*字|篇幅|长篇|中篇|短篇/,
    ],
  })[deliverableType] ?? [];
  const compactLength = source.replace(/\s+/g, "").length;
  return compactLength >= 60 && requiredGroups.length > 0 && requiredGroups.every((pattern) => pattern.test(source));
};

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
    expandedPrompt: `${prompt}。按照上一轮自检结论，逐章修复现有第${range.startChapter}章至第${range.endChapter}章的正文。必须返回 ${count} 份完整修订后正文，由神思执行一次批量落盘事务；不得直接编辑 Markdown 文件。每章写入成功后的完整结果都要成为最新历史版本，任一章缺失、revision 冲突或批量回执不完整时不得宣称修改完成。`,
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

export const isQuickSentenceRevision = ({ text = "", inlineEdit = false } = {}) => (
  Boolean(inlineEdit) || SENTENCE_REVISION_PATTERN.test(String(text))
);

export const isUncheckedVisualPromptRequest = ({ text = "", targetDocumentId = "" } = {}) => (
  String(targetDocumentId).startsWith("prompt-video-")
  || String(targetDocumentId).startsWith("prompt-visual-")
  || String(targetDocumentId).startsWith("prompt-panorama-")
  || VIDEO_OR_BLOCKING_PROMPT_PATTERN.test(String(text))
);

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

export const isCreativeGuidanceRequest = ({ text = "" } = {}) => {
  const source = String(text).trim();
  if (!source || isExplicitDirectCreationRequest({ text: source })) return false;
  if (isNonShensiDeliverable({ text: source })) return false;
  if (!(CREATIVE_GENRE_PATTERN.test(source) || SHENSI_CREATIVE_TARGET_PATTERN.test(source) || creativeDeliverableType({ text: source })) || !CREATIVE_HELP_PATTERN.test(source)) return false;
  const hasExplicitCreationIntent = /(?:我)?(?:想|要|需要|希望|准备|打算|计划|尝试|试着)(?:要|来)?(?:写|创作|做|构思|设计)|(?:帮我|带我|教我)(?:写|创作|构思|设计|开始|梳理)?|^(?:写|创作|构思|设计|做)/.test(source);
  return hasExplicitCreationIntent || !GENRE_INFORMATION_PATTERN.test(source);
};

export const isCreativeAssetDiagnosis = ({
  text = "",
  targetDocumentId = "",
  targetModuleId = "",
  workspaceKind = "project",
} = {}) => {
  const source = String(text).trim();
  if (!source || !CREATIVE_DIAGNOSTIC_INTENT_PATTERN.test(source)) return false;
  if (reviewIsPostwriteStepOfFormalCreation({ text: source, targetDocumentId })) return false;
  const diagnosedDeliverableType = creativeDeliverableType({ text: source, targetDocumentId });
  if (isExplicitDirectCreationRequest({ text: source })
    || (PREPARED_NOVEL_PRODUCTION_PATTERN.test(source) && (!diagnosedDeliverableType || diagnosedDeliverableType === "novel"))) return false;
  // 纯错别字、标点和格式校对是机械任务；一旦同时检查剧情或表达质量，就升级为创作诊断。
  if ((MECHANICAL_DOCUMENT_TASK_PATTERN.test(source) || PURE_PROOFREADING_PATTERN.test(source)) && !CREATIVE_QUALITY_DIMENSION_PATTERN.test(source)) return false;
  if (CREATIVE_DIAGNOSTIC_TARGET_PATTERN.test(source)) return true;
  if (NON_CREATIVE_DIAGNOSTIC_TARGET_PATTERN.test(source)) return false;

  const currentTargetIsCreativeAsset = (
    CREATIVE_ASSET_MODULES.has(String(targetModuleId))
    || CREATIVE_ASSET_DOCUMENT_PATTERN.test(String(targetDocumentId))
  );
  return currentTargetIsCreativeAsset && (
    CONTEXTUAL_CREATIVE_TARGET_PATTERN.test(source)
    || OBJECTLESS_DIAGNOSTIC_PATTERN.test(source)
  );
};

export const isContextualCreativeRevision = ({
  text = "",
  targetDocumentId = "",
  targetModuleId = "",
  workspaceKind = "project",
  continuesCreativeThread = false,
  hasSelection = false,
} = {}) => {
  const source = String(text).trim();
  if (!source || !hasAffirmativeContextualRevisionAction(source)) return false;
  if (isReadOnlyProjectQuery({ text: source })) return false;
  if (NON_CREATIVE_REVISION_TARGET_PATTERN.test(source)) return false;
  if ((MECHANICAL_DOCUMENT_TASK_PATTERN.test(source) || PURE_PROOFREADING_PATTERN.test(source)) && !CREATIVE_QUALITY_DIMENSION_PATTERN.test(source)) return false;
  if (hasExplicitCreativeProductionIntent({ text: source, targetDocumentId }) && !STRONG_CREATIVE_REVISION_COMMAND_PATTERN.test(source)) return false;
  if (EXPLICIT_CREATIVE_REVISION_TARGET_PATTERN.test(source)) return true;
  const currentTargetIsCreativeAsset = (
    CREATIVE_ASSET_MODULES.has(String(targetModuleId))
    || CREATIVE_ASSET_DOCUMENT_PATTERN.test(String(targetDocumentId))
  );
  return currentTargetIsCreativeAsset && (
    hasSelection === true
    || continuesCreativeThread === true
    || CONTEXTUAL_CREATIVE_TARGET_PATTERN.test(source)
    || source.replace(/\s+/g, "").length <= 48
  );
};

const isDirectGenreCreationRequest = (source) => (
  CREATIVE_GENRE_PATTERN.test(source) && isExplicitDirectCreationRequest({ text: source })
);

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

export const shouldUseGeneralChat = ({ text = "", hasSelection = false, hasResources = false, inlineEdit = false, continuesCreativeThread = false, hasProjectTerms = false, targetDocumentId = "", targetModuleId = "", workspaceKind = "project" } = {}) => {
  if (inlineEdit) return false;
  const source = String(text).trim();
  if (!source) return false;
  if (isBookDeconstructionRequest({ text: source })) return false;
  if (looksLikeWorkspaceOperation(source)) return false;
  if (continuesCreativeThread && isCreativeContinuationResponse({ text: source, hasResources })) return false;
  if (isReadOnlyProjectQuery({ text: source })) return true;
  if (FAST_STATUS_PATTERN.test(source) || GENERAL_META_PATTERN.test(source)) return true;
  if (CREATIVE_KNOWLEDGE_PATTERN.test(source) && !CREATIVE_HELP_PATTERN.test(source)) return true;
  if (isCreativeAssetDiagnosis({ text: source, targetDocumentId, targetModuleId, workspaceKind })) return false;
  if (isContextualCreativeRevision({ text: source, targetDocumentId, targetModuleId, workspaceKind, continuesCreativeThread, hasSelection })) return false;
  if (isCreativeGuidanceRequest({ text: source })) return false;
  if (isDirectGenreCreationRequest(source)) return false;
  if (CREATIVE_TRANSFORMATION_PATTERN.test(source)) return false;
  if (CREATIVE_REVISION_PATTERN.test(source)) return false;
  if (SETTING_CREATION_PATTERN.test(source)) return false;
  if (isExplicitDirectCreationRequest({ text: source }) && SHENSI_CREATIVE_TARGET_PATTERN.test(source)) return false;
  if (SENTENCE_REVISION_PATTERN.test(source)) return !hasProjectTerms;
  if (MECHANICAL_DOCUMENT_TASK_PATTERN.test(source)) return true;
  // 最终产物优先于来源材料和动作词。读取小说来写歌仍是通用任务；写小说本身才进入神思。
  if (isNonShensiDeliverable({ text: source })) return true;
  if (hasExplicitCreativeProductionIntent({ text: source, targetDocumentId })) return false;
  if (THEORY_REQUIRED_ACTION_PATTERN.test(source)) return false;
  if (DOCUMENT_UTILITY_PATTERN.test(source) || EXPLICIT_DOCUMENT_TASK_PATTERN.test(source) || CURRENT_DOCUMENT_CONTEXT_PATTERN.test(source)) return true;
  if (PLOT_OR_CRAFT_PATTERN.test(source)) return false;
  return !CREATIVE_ACTION_PATTERN.test(source);
};

const generalRouteReason = ({ text = "", hasResources = false } = {}) => {
  const source = String(text).trim();
  if (FAST_STATUS_PATTERN.test(source) || GENERAL_META_PATTERN.test(source)) return "软件、状态或一般问题，不生成创作资产";
  if (isNonShensiDeliverable({ text: source })) return "最终产物不属于神思创作资产";
  if (MECHANICAL_DOCUMENT_TASK_PATTERN.test(source) || DOCUMENT_UTILITY_PATTERN.test(source) || EXPLICIT_DOCUMENT_TASK_PATTERN.test(source)) {
    return "仅执行资料读取或机械处理，不改动创作资产";
  }
  if (isReadOnlyProjectQuery({ text: source })) return "只读取项目事实并回答，不生成、修改或落盘创作资产";
  if (hasResources) return "当前问题可结合指定资料回答，但资料存在本身不改变任务模式";
  return "当前问题不生成、修改或诊断神思创作资产";
};

export const classifyRequestMode = ({
  text = "",
  workspaceOperation = false,
  longForm = false,
  landing = false,
  inlineEdit = false,
  targetDocumentId = "",
  hasSelection = false,
  hasResources = false,
  continuesCreativeThread = false,
  hasProjectTerms = false,
  preparedCreativeContext = false,
  targetModuleId = "",
  workspaceKind = "project",
} = {}) => {
  const source = String(text).trim();
  const deliverableType = creativeDeliverableType({ text: source, targetDocumentId });
  const deliverableLabel = creativeDeliverableLabel(deliverableType);
  const deliverableMeta = deliverableType ? { deliverableType, deliverableLabel } : {};
  const briefReady = hasSufficientCreativeBrief({ text: source, deliverableType, hasResources });
  const freshStart = isExplicitFreshCreativeStart({ text: source });
  const explicitFormalAssetWrite = hasExplicitFormalAssetWriteIntent({ text: source });
  const directCreationRequested = isExplicitDirectCreationRequest({ text: source });
  const guidanceOnlyThisTurn = CREATIVE_GUIDANCE_ONLY_PATTERN.test(source)
    && !directCreationRequested
    && Boolean(deliverableType || CREATIVE_GENRE_PATTERN.test(source) || SHENSI_CREATIVE_TARGET_PATTERN.test(source));
  const preparedNovelProduction = deliverableType === "novel"
    && preparedCreativeContext === true
    && /^chapter-\d+$/.test(String(targetDocumentId))
    && (!targetModuleId || targetModuleId === "manuscript")
    && PREPARED_NOVEL_PRODUCTION_PATTERN.test(source);
  if (workspaceOperation) return { mode: "operation", reason: "请求将由本地软件执行结构或文件操作", shensiLed: false };
  // An explicit guidance-only instruction describes a question/decision
  // deliverable, even when the active target is a chapter document or the
  // request mentions a long-form work. Resolve it before existing-document
  // and long-form production heuristics so a target hint cannot authorize a
  //正文 write that the user explicitly prohibited.
  if (guidanceOnlyThisTurn && !explicitFormalAssetWrite) {
    return {
      mode: "creative_guidance",
      reason: deliverableType
        ? `用户明确要求本轮只进行${deliverableLabel}创作引导，不生成或写入正式内容`
        : "用户明确要求本轮只进行创作引导，不生成或写入正式内容",
      shensiLed: true,
      freshStart,
      ...deliverableMeta,
    };
  }
  if (longForm) return { mode: "creative", reason: "请求将生成长篇神思创作资产", shensiLed: true, ...deliverableMeta };
  if (landing) return { mode: "creative", reason: "请求包含作品内容落盘或替换", shensiLed: true, ...deliverableMeta };
  if (inlineEdit) return { mode: "quick_revision", reason: "仅修改当前选中文字，使用局部快速链", shensiLed: true };
  const currentInstruction = currentConversationInstruction(source);
  if (isLocalWriteCapabilityQuestion(currentInstruction)) {
    return { mode: "general", reason: "当前任务分析或改造神思的软件写入能力，不生成、修改或落盘创作资产", shensiLed: false, runtimeDiagnosisIntent: true };
  }
  if (NON_CREATIVE_DIAGNOSTIC_TARGET_PATTERN.test(currentInstruction)
    && /为什么|为何|怎么|如何|检查|诊断|修复|解决|失败|报错|不可用|没有结果|抓取不到/i.test(currentInstruction)) {
    return { mode: "general", reason: "当前具体问题是软件或媒体运行诊断，保留较早任务上下文但调用运行诊断能力", shensiLed: false, runtimeDiagnosisIntent: true };
  }
  if (isExistingCreativeAssetRevisionRequest({
    text: source,
    targetDocumentId,
    targetModuleId,
    workspaceKind,
  })) {
    return {
      mode: "creative",
      reason: isStructuralNumberingRevisionRequest({ text: source })
        ? "已识别只调整现有正文结构编号的请求；读取当前正文并保持正文内容不变"
        : "已识别重新输出当前正文的请求；沿用现有正文而非启动新作引导",
      shensiLed: true,
      revisionIntent: true,
      existingAssetIntent: true,
      sourceBackedAssetIntent: hasSubstantiveInlineCreativeSource({ text: source }),
      contentPreservingIntent: isStructuralNumberingRevisionRequest({ text: source }),
      ...deliverableMeta,
    };
  }
  if (deliverableType === "book_deconstruction") {
    return { mode: "creative", reason: "已识别爆款拆书指令，将按实际来源覆盖范围执行完整或样本逆向拆解", shensiLed: true, ...deliverableMeta };
  }
  if (freshStart && !guidanceOnlyThisTurn) {
    return {
      mode: "creative",
      reason: deliverableType === "novel"
        ? "用户明确开始新作，已清除续写前提并进入第一章主笔链"
        : "用户明确开始新的创作任务，已清除上一轮续写前提",
      shensiLed: true,
      freshStart: true,
      ...deliverableMeta,
    };
  }
  if (isContextualCreativeRevision({
    text: source,
    targetDocumentId,
    targetModuleId,
    workspaceKind,
    continuesCreativeThread,
    hasSelection,
  })) {
    return {
      mode: deliverableType === "visual_prompt" ? "visual_prompt" : "creative",
      reason: "已识别对当前创作正文或局部表达的微调请求，进入主笔候选、检查与确认落盘闭环",
      shensiLed: true,
      revisionIntent: true,
      existingAssetIntent: true,
      ...deliverableMeta,
    };
  }
  if (SKILL_ROUTE_INSPECTION_PATTERN.test(source)) {
    return { mode: "general", reason: "当前问题是在核对 Skill 或模块的实际路由结果，不生成或修改创作资产", shensiLed: false, routeInspectionIntent: true, ...deliverableMeta };
  }
  if (CREATIVE_KNOWLEDGE_PATTERN.test(source) && !CREATIVE_HELP_PATTERN.test(source)) {
    return { mode: "general", reason: "当前是创作类型知识问题，不生成创作资产", shensiLed: false };
  }
  if (isCreativeAssetDiagnosis({ text: source, targetDocumentId, targetModuleId, workspaceKind })) {
    return { mode: "creative", reason: "已识别创作质量诊断意图，目标是当前神思创作资产", shensiLed: true, diagnosisIntent: true, existingAssetIntent: true, ...deliverableMeta };
  }
  if (isReadOnlyProjectQuery({ text: source })) {
    return { mode: "general", reason: "只读取项目事实并回答，不生成、修改或落盘创作资产", shensiLed: false };
  }
  if (isNonShensiDeliverable({ text: source })) {
    return { mode: "general", reason: "最终产物不属于神思创作资产", shensiLed: false };
  }
  const explicitProductionIntent = hasExplicitCreativeProductionIntent({ text: source, targetDocumentId });
  const explicitDirectCreation = directCreationRequested;
  // A concrete production verb is already an executable instruction. Missing
  // optional creative dimensions are choices the writer may make, not a reason
  // to replace the requested generation with a guidance interview.
  const imageAssetSourceExtraction = isImageAssetSourceExtractionRequest(source);
  const directProductionCommand = /^(?:(?:请|帮我|麻烦)\s*)?(?:正式\s*)?(?:直接\s*)?(?:写|撰写|生成|制作|创作|改写|重写|续写|输出|产出)/u.test(source)
    || imageAssetSourceExtraction;
  const sourceBackedProduction = DOCUMENT_SOURCE_DEPENDENCY_PATTERN.test(source)
    || imageAssetSourceExtraction
    || (hasResources && /根据|依据|基于|结合|参考|读取|使用|用|现有|已有|附件|全文|大纲|剧本|素材/.test(source));
  const sparseProductionNeedsGuidance = explicitProductionIntent
    && Boolean(deliverableType)
    && !explicitFormalAssetWrite
    && !briefReady
    && !explicitDirectCreation
    && !directProductionCommand
    && !preparedNovelProduction
    && !sourceBackedProduction
    && !CREATIVE_TRANSFORMATION_PATTERN.test(source)
    && !CREATIVE_REVISION_PATTERN.test(source)
    && !SETTING_CREATION_PATTERN.test(source);
  const visualPromptStillNeedsContract = deliverableType === "visual_prompt"
    && !briefReady
    && !explicitDirectCreation
    && !directProductionCommand
    && !sourceBackedProduction
    && !CREATIVE_TRANSFORMATION_PATTERN.test(source);
  if (sparseProductionNeedsGuidance) {
    return {
      mode: "creative_guidance",
      reason: `已识别${deliverableLabel}生产意图，但当前只形成了方向声明；推荐先补齐一个最影响成品的决策，运行中发现现有资料已足够时可直接改道主笔`,
      shensiLed: true,
      productionIntent: true,
      ...deliverableMeta,
    };
  }
  if (explicitProductionIntent && !visualPromptStillNeedsContract) {
    return {
      mode: deliverableType === "visual_prompt" ? "visual_prompt" : "creative",
      reason: deliverableType
        ? `已识别明确的${deliverableLabel}生产目标，资料只作为创作依据，不改变任务模式`
        : "已识别明确的创作资产生产目标",
      shensiLed: true,
      productionIntent: true,
      ...deliverableMeta,
    };
  }
  if (SETTING_CREATION_PATTERN.test(source)) {
    return {
      mode: "creative",
      reason: "请求生成或修改作品设定，进入设定规划主笔与设定规则链",
      shensiLed: true,
      ...deliverableMeta,
    };
  }
  if (preparedNovelProduction) {
    return {
      mode: "creative",
      reason: "当前章纲、前序正文与长篇资料已达到主笔条件，跳过创作引导并直接进入逐章写作链",
      shensiLed: true,
      ...deliverableMeta,
    };
  }
  if (!isExplicitDirectCreationRequest({ text: source }) && PROMPT_QUALITY_GUIDANCE_PATTERN.test(source)) {
    return { mode: "creative_guidance", reason: "提示词效果反馈表明关键视觉控制量尚未明确，进入提示词专项创作引导", shensiLed: true, deliverableType: "visual_prompt", deliverableLabel: creativeDeliverableLabel("visual_prompt") };
  }
  if (!directProductionCommand && isCreativeGuidanceRequest({ text: source })) {
    if (deliverableType && (briefReady || preparedNovelProduction)) {
      return {
        mode: deliverableType === "visual_prompt" ? "visual_prompt" : "creative",
        reason: preparedNovelProduction
          ? "当前章纲、前序正文与长篇资料已达到主笔条件，跳过创作引导并直接进入逐章写作链"
          : `已识别最终产物为${deliverableLabel}且创作信息充分，直接调用${deliverableLabel}专项写作技能`,
        shensiLed: true,
        ...deliverableMeta,
      };
    }
    return {
      mode: "creative_guidance",
      reason: deliverableType
        ? `已识别最终产物为${deliverableLabel}，创作信息仍有关键缺口，进入${deliverableLabel}专项创作引导`
        : "已识别创作意图，进入对应类型的创作引导",
      shensiLed: true,
      ...deliverableMeta,
    };
  }
  if (deliverableType === "visual_prompt"
    && isUncheckedVisualPromptRequest({ text: source, targetDocumentId })
    && !isExplicitDirectCreationRequest({ text: source })
    && !directProductionCommand
    && !CREATIVE_TRANSFORMATION_PATTERN.test(source)
    && !briefReady) {
    return {
      mode: "creative_guidance",
      reason: "目标产物是提示词，但质感、构图、光线、表演、运镜、声音或连续性合同仍不完整，进入提示词专项创作引导",
      shensiLed: true,
      ...deliverableMeta,
    };
  }
  if (isUncheckedVisualPromptRequest({ text: source, targetDocumentId })) {
    return { mode: "visual_prompt", reason: "目标产物是视觉或调度提示词，使用专项快速链", shensiLed: true, deliverableType: "visual_prompt", deliverableLabel: creativeDeliverableLabel("visual_prompt") };
  }
  if (CREATIVE_TRANSFORMATION_PATTERN.test(source)) {
    return {
      mode: deliverableType === "visual_prompt" ? "visual_prompt" : "creative",
      reason: deliverableType
        ? `请求把现有材料转换为${deliverableLabel}，直接调用对应专项写作技能`
        : "请求把现有材料转换为新的创作资产",
      shensiLed: true,
      ...deliverableMeta,
    };
  }
  if (CREATIVE_REVISION_PATTERN.test(source)) {
    return {
      mode: "creative",
      reason: "请求重写或重构现有创作资产，进入对应主笔与返修链",
      shensiLed: true,
      ...deliverableMeta,
    };
  }
  if (shouldUseGeneralChat({ text: source, hasSelection, hasResources, inlineEdit, continuesCreativeThread, hasProjectTerms, targetDocumentId, targetModuleId, workspaceKind })) {
    return { mode: "general", reason: generalRouteReason({ text: source, hasResources }), shensiLed: false };
  }
  if (isQuickSentenceRevision({ text: source, inlineEdit })) {
    return { mode: "quick_revision", reason: "目标是单句或局部文字，使用快速修改链", shensiLed: true };
  }
  return {
    mode: "creative",
    reason: isExplicitDirectCreationRequest({ text: source })
      ? deliverableType ? `用户要求直接生成${deliverableLabel}，调用对应专项写作技能` : "用户要求直接生成神思创作资产"
      : "任务将生成、修改或诊断神思创作资产",
    shensiLed: true,
    ...deliverableMeta,
  };
};

const adaptiveRouteConfidence = ({ route = {}, text = "", hasResources = false, preparedCreativeContext = false } = {}) => {
  if (route.mode === "operation" || route.mode === "quick_revision") return 0.98;
  if (isExplicitDirectCreationRequest({ text })) return 0.96;
  if (route.mode === "creative_guidance") return hasResources || preparedCreativeContext ? 0.78 : 0.9;
  if (route.mode === "general") return 0.88;
  return hasResources || preparedCreativeContext ? 0.9 : 0.82;
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

export const buildAdaptiveTaskRoute = (input = {}, { executionSurface = "chat" } = {}) => {
  const surface = executionSurface === "agent" ? "agent" : "chat";
  const semanticDecision = ["guided_dialogue", "task_execution"].includes(input.agentDecision?.lane)
    ? input.agentDecision
    : null;
  const taskContract = input.taskContract?.protocol
    ? normalizeTaskContract(input.taskContract, { sourceMessageId: input.sourceMessageId })
    : null;
  const taskContractDecision = validateTaskContractForExecution(taskContract);
  const authoritativeTaskContract = taskContractDecision.authoritative ? taskContract : null;
  const classifiedRoute = classifyRequestMode(input);
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
    || semanticCapabilities.some((capability) => ["effect_reviewer", "strong_story_reviewer", "regular_progress_reviewer"].includes(capability));
  const semanticRoute = semanticMode ? {
    mode: semanticQualityReview && semanticMode === "general" ? "creative" : semanticMode,
    taskKind: String(semanticDecision.taskKind || (semanticQualityReview ? "quality_review" : "task_execution")),
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
  // A writing/discussion contract without a formal deliverable describes
  // persistence, not whether the user needs creative guidance. Let an
  // exploratory creative request enter guidance instead of being flattened
  // into a long general reply merely because no target document exists yet.
  const route = semanticRoute || (contractRoute?.mode === "general" && classifiedRoute.mode === "creative_guidance"
    ? {
        ...classifiedRoute,
        reason: `${classifiedRoute.reason}；当前 TaskContract 尚未声明正式写入，不阻断创作引导`,
      }
    : contractRoute
      || blockedRouteFromTaskContract(authoritativeTaskContract, taskContractDecision)
      || classifiedRoute);
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
  const reviewContextDomain = contractContextDomain || (requestedContextDomain === "script-adaptation"
    || String(input.targetDocumentId || "") === "report-adaptation"
    || (Array.isArray(input.targetDocumentIds) && input.targetDocumentIds.includes("report-adaptation"))
    || /小说.{0,20}(?:改编|改成|改写成|转换成|转成).{0,10}(?:短剧|剧本|漫剧)|改编剧本|改编报告|小说改剧本/u.test(String(input.text || ""))
    ? "script-adaptation"
    : requestedContextDomain === "script" || String(input.targetDocumentId || "").startsWith("script-")
      ? "script"
      : "novel");
  const reviewDelivery = reviewDeliveryFromTaskContract(taskContract, taskContractDecision)
    || (taskContractDecision.authoritative
      ? { active: false, reportRequested: false, landingEligible: false, candidatePreviewRequired: false, target: null, reason: "TaskContract 未声明报告交付物" }
      : reviewDeliveryPolicy({ text: input.text, contextDomain: reviewContextDomain }));
  const guidancePolicy = route.mode === "creative_guidance"
    ? "recommended"
    : route.shensiLed ? "available" : "not_applicable";
  const explicitCapabilitySelection = (Array.isArray(input.skillIds) && input.skillIds.length)
    || input.selectedModulePlacementId
    || input.selectedRoutePlacementId;
  const capabilityRouteDecision = explicitCapabilitySelection ? {} : creativeCapabilityRouteDecision({
    text: input.text,
    deliverableType: route.deliverableType || classifiedRoute.deliverableType || "",
    mode: route.mode,
    diagnosisIntent: route.diagnosisIntent === true,
  });
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
  const reviewMutatesContent = taskContractDecision.authoritative
    ? taskContract?.taskType === "modification"
      && contractDeliverables.some((item) => !["report", "review_report"].includes(String(item?.kind || "")))
    : reviewIncludesContentMutation(input.text);
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
  const confirmWhenLandingUncertain = !taskContractDecision.authoritative
    && route.shensiLed === true
    && ["creative", "visual_prompt", "quick_revision"].includes(route.mode)
    && shouldSuppressAutomaticFormalLanding({
      instruction: input.authorizationInstruction ?? input.text,
      target,
      contentType: route.deliverableType || reviewDelivery.kind || "",
    }) !== true
    && (
      input.continuesCreativeThread === true
      || route.revisionIntent === true
      || hasExplicitCreativeProductionIntent({ text: input.text, targetDocumentId: target?.documentId })
    );
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
    confirmWhenLandingUncertain,
    semanticWritePlan: semanticDecision?.writePlan ?? null,
    guidanceOnly: route.mode === "creative_guidance"
      && !taskContractDecision.authoritative
      && !["candidate", "commit"].includes(semanticWriteIntent)
      && !hasExplicitFormalAssetWriteIntent({ text: input.authorizationInstruction ?? input.text }),
  });
  const landingConfirmationRequired = writeAuthorization.reason === "landing_intent_uncertain";
  const explicitCandidateGeneration = writeAuthorization.state === "candidate_only"
    && !landingConfirmationRequired;
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
          reason: landingConfirmationRequired
            ? "正式内容的落盘意图不明确，先生成受控候选并等待用户选择"
            : "明确要求生成多份创作候选，进入候选查看与选择链",
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
  const capabilityRouteSource = String(input.text || "");
  const affirmativeCapabilityRouteSource = capabilityRouteSource.replace(/(?:不要|无需|不用|禁止|不得|不需要).{0,24}(?:修改|优化|更新|重写|新增|删除|创建|保存|编译)[^，。！？；\n]{0,24}/gu, "");
  const capabilityInspectionOnly = CAPABILITY_ROUTE_INSPECTION_PATTERN.test(capabilityRouteSource)
    && !CAPABILITY_ROUTE_MUTATION_PATTERN.test(affirmativeCapabilityRouteSource)
    && managedRoute.mode === "general"
    && managedRoute.shensiLed !== true
    && !formalArtifactExpected;
  const taskPolicy = compileAgentTaskPolicy({
    text: input.text,
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
    candidateCount: input.candidateCount ?? 1,
    writeAuthorization,
    taskContract: authoritativeTaskContract,
  });
  const intentEnvelope = buildIntentEnvelope({
    instruction: input.text,
    sourceMessageId: input.sourceMessageId,
    route: {
      ...managedRoute,
      ...capabilityRouteDecision,
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
    ...(capabilityInspectionOnly ? { taskKind: "capability_inspection", capabilityInspectionOnly: true } : {}),
    recommendedMode: managedRoute.mode,
    confidence: semanticRoute
      ? Number(semanticDecision.confidence) || 0
      : taskContractDecision.authoritative && taskContractDecision.valid
      ? 1
      : adaptiveRouteConfidence({
          route: managedRoute,
          text: input.text,
          hasResources: input.hasResources === true,
          preparedCreativeContext: input.preparedCreativeContext === true,
        }),
    guidancePolicy,
    ...capabilityRouteDecision,
    maxBlockingQuestions: 1,
    executionSurface: surface,
    runtimeRerouteAllowed: !taskContractDecision.authoritative && !["operation", "quick_revision"].includes(route.mode),
    toolPolicy: surface === "agent" ? "task_and_permission" : "none",
    candidatePreviewRequired: managedCandidatePreviewRequired,
    landingConfirmationRequired,
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

export const resolveRequestedMode = ({
  requestedMode = "creative",
  text = "",
  targetDocumentId = "",
  hasResources = false,
  inlineEdit = false,
  continuesCreativeThread = false,
  workspaceOperation = false,
  landing = false,
  preparedCreativeContext = false,
  targetModuleId = "",
  workspaceKind = "project",
  taskContract = null,
} = {}) => {
  const taskContractDecision = validateTaskContractForExecution(taskContract);
  if (taskContractDecision.authoritative) {
    const contractRoute = routeFromTaskContract(taskContract, taskContractDecision)
      || blockedRouteFromTaskContract(taskContract, taskContractDecision);
    return contractRoute?.mode === "operation" ? "workspace_operation" : contractRoute?.mode || "general";
  }
  const inferredRoute = classifyRequestMode({
    text,
    targetDocumentId,
    hasResources,
    inlineEdit,
    continuesCreativeThread,
    workspaceOperation,
    landing,
    preparedCreativeContext,
    targetModuleId,
    workspaceKind,
  });
  if (workspaceOperation && requestedMode === "workspace_operation") return "workspace_operation";
  if (inlineEdit && requestedMode === "quick_revision") return "quick_revision";
  // The client may have resolved an elliptical follow-up against the complete
  // conversation (for example: “生成剧本的视觉提示词” -> “目前是短视频剧本转AI”).
  // Do not downgrade that persisted output contract merely because the final
  // clarification, viewed in isolation, names its source document type.
  if (requestedMode === "visual_prompt"
    && (["creative", "creative_guidance", "visual_prompt"].includes(inferredRoute.mode)
      || (continuesCreativeThread && inferredRoute.mode === "general"))) return "visual_prompt";
  return inferredRoute.mode;
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
import { looksLikeWorkspaceOperation } from "./workspace-operations.js";
