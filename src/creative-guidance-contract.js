import { creativeGuidanceDepthPrompt } from "./pending-decision-policy.js";

const SPECIAL_CLUSTER = Object.freeze({
  enhancement: "__enhancement__",
  confirmation: "__confirmation__",
});

const schema = (label, clusters, enhancementQuestion, confirmationQuestion) => Object.freeze({
  label,
  clusters: Object.freeze(clusters.map((item) => Object.freeze(item))),
  enhancementQuestion,
  confirmationQuestion,
});

export const CREATIVE_GUIDANCE_SCHEMAS = Object.freeze({
  public_account: schema("公众号推文", [
    { id: "audience-purpose", label: "读者与传播目的", question: "这篇文章最先要打动哪类读者，他们现在最典型的处境是什么，读完后希望他们采取什么行动？我会据此确定解释深度、共情入口和转化方式。" },
    { id: "topic-promise", label: "选题与阅读承诺", question: "围绕这个主题，你更希望文章兑现哪种承诺：解决一个具体问题、修正一个常见误解，还是让读者重新理解一段经历？我建议选一个能在正文前 20% 首次兑现的承诺。" },
    { id: "type-angle", label: "文章类型与切口", question: "这篇文章更适合走观点论证、故事带观点，还是方法/科普路线？我会根据你现有材料推荐一个主类型和一个明确切口。" },
    { id: "voice-difference", label: "作者个性与差异化", question: "你希望读者记住怎样的作者人格，以及你能提供哪种别人难以复制的经验、观察或判断？如果暂时没有，我可以按主题推荐一种可执行声线。" },
    { id: "evidence-attraction", label: "证据、核心看点与反常识", question: "这篇文章靠什么最抓人：真实案例、可验证的反常识、强共鸣故事，还是可立即使用的方法？我会同时划清事实、经验和作者观点的边界。" },
    { id: "structure-rhythm", label: "结构、开头与叙事节奏", question: "你更希望文章以冲突场景、反常识判断还是读者痛点开场？我会据此安排看点出现顺序、信息密度和情绪曲线。" },
    { id: "title-package", label: "标题策略", question: "标题更应该优先强化明确收益、身份代入、冲突悬念还是反常识？我会先按一种主机制设计，再保留不同机制的备选标题。" },
    { id: "ending-action", label: "结尾余味与行动", question: "结尾更希望读者获得行动方案、价值回扣、讨论冲动还是关注/转发动力？我会让结尾回应开头承诺，而不是突然喊口号。" },
  ], "基础方案已经成立。下一步我建议从真实故事锚点、反方视角、反常识证据、实用工具或前置兑现中选一项增强；你想采用哪一项，还是按我的推荐处理？", "我会先用一段压缩合同复述读者、选题承诺、文章类型、作者声线、核心看点、结构节奏、标题策略和结尾动作。确认按这套方案生成，还是还要调整其中一项？"),
  short_video_script: schema("短视频剧本", [
    { id: "format-platform", label: "平台与内容形态", question: "这条内容主要发在哪个平台，目标时长、横竖屏、单条完结或连续更新、真人或 AI 分别怎么定？我会据此控制节拍密度和制作格式。" },
    { id: "style-performance", label: "视频风格与表演形式", question: "你更想要写实生活流、强情绪短剧、冷面喜剧、悬疑压迫还是其他风格？表演是单人口播、双人对手戏、多人群像还是无台词动作戏？" },
    { id: "character-voice", label: "人物声口与口癖", question: "主角和关键对手各自怎么说话，需不需要口癖或固定表达？我建议只保留能体现身份、关系或节奏的记忆点，避免机械重复。" },
    { id: "audience-payoff", label: "目标观众、情绪与核心看点", question: "观众看完最应该得到哪种满足，以及这条视频唯一最值得复述的核心看点是什么？我会用它筛掉无关桥段。" },
    { id: "story-engine", label: "人物欲望、阻碍与状态变化", question: "主角此刻必须得到什么，谁或什么直接阻止他，本条结束时人物、关系或局势必须发生哪种实质变化？" },
    { id: "opening-hook", label: "开头钩子", question: "第一眼更适合用正在发生的冲突、异常结果前置、身份反差还是一句强承诺开场？我会同时锁定第一画面、第一动作和观众立刻产生的问题。" },
    { id: "payoff-escalation", label: "中段升级与核心兑现", question: "中段先兑现一次小满足再升级代价，还是持续压迫到一次集中反击？我会据此安排看点次数、反转依据和节奏。" },
    { id: "ending-hook", label: "结尾兑现与追更钩子", question: "结尾更适合完成一次反击、揭开一层真相，还是改变关系后制造更具体的新问题？我会确保既有兑现又有下一条期待。" },
    { id: "production-boundary", label: "制作与尺度边界", question: "这条视频的场景数、人物数、动作/特效复杂度、预算和平台尺度有哪些硬限制？我会在不削弱核心看点的前提下做制作压缩。" },
  ], "基础脚本合同已经成立。下一步我会从可见冲突、角色声口、表演反差、提前小兑现、反转证据或站位权力变化中提出 1—3 个增强方案；你想选哪一个，还是按我的推荐？", "我会压缩复述平台形态、视频风格、表演方式、人物声口、核心看点、故事发动机、开头钩子、中段兑现、结尾钩子和制作边界。确认按这套方案生成，还是要调整其中一项？"),
  short_drama_script: schema("短剧剧本", [
    { id: "source-platform-format", label: "来源模式、平台与交付规格", question: "这是从零原创还是基于现有小说改编，主要发布平台、集数、单集时长、横竖屏和真人/漫剧/AI 制作形态怎么定？如果是改编，还需要明确必须保留、允许重组和禁止改动的范围。" },
    { id: "audience-genre-promise", label: "受众、题材与追剧承诺", question: "主要观众、核心题材和最持续的追剧满足分别是什么？我会把一句题材概念拆成首集、阶段高潮和终局都能兑现的观看承诺。" },
    { id: "protagonist-engine", label: "主角发动机", question: "主角的起点处境、迫切目标、内在缺口、不可退让的欲望和最怕失去的东西分别是什么？我会检查它们能否持续发动多集行动。" },
    { id: "conflict-escalation", label: "核心冲突、对手与升级机制", question: "谁或什么持续阻止主角，冲突怎样从事件、关系、资源和身份逐级加码，失败代价又怎样真正改变下一集局势？" },
    { id: "cast-relations", label: "人物关系与角色功能", question: "关键配角、对手和关系线各自承担什么独立目标与剧情功能，哪些关系必须持续变化？我会合并功能重复的人物，避免只有工具人推动情节。" },
    { id: "episode-engine", label: "单集结构与整季推进", question: "每集准备采用怎样的进入冲突、局部兑现、局势变化和下一集问题结构，整季又分几个阶段升级？我会避免单集重复同一套路或整季原地踏步。" },
    { id: "hooks-payoffs", label: "开场钩子、爽点兑现与集尾钩子", question: "首屏先抛出哪种异常或冲突，中段用什么可见行动兑现核心看点，集尾又留下哪个具体且可承接的新问题？" },
    { id: "style-performance-dialogue", label: "风格、表演与对白声口", question: "整体是写实、强情绪、喜剧、悬疑还是其他风格，表演强度、人物声口、台词长度和潜台词密度怎么控制？" },
    { id: "ending-payoff", label: "终局方向与主题兑现", question: "终局时外部矛盾、人物选择、核心关系和主题判断分别落到哪里，观众最终应获得怎样的情绪兑现？" },
    { id: "production-boundary", label: "制作、预算与尺度边界", question: "场景、人物、动作、特效、服化道、预算和平台尺度有哪些硬限制？我会让每次冲突升级都保持可拍、可演和可连续生产。" },
  ], "短剧基础合同已经闭环。下一步我会从首集强兑现、人物关系反转、可见爽点、集尾追更问题、表演反差或制作降本中提出 1—3 个增强方案，并说明它们对整季节奏的影响；你想选哪一个，还是按我的推荐？", "我会压缩复述来源模式、平台规格、受众题材、追剧承诺、主角发动机、冲突升级、人物关系、单集与整季结构、钩子兑现、表演对白、终局和制作边界。确认按这套短剧合同生成，还是要调整其中一项？"),
  novel: schema("长篇小说", [
    { id: "genre-platform-audience", label: "题材、平台、受众与篇幅", question: "这部长篇准备发布在哪个平台或以什么形态连载，主题材、目标读者、预计总篇幅、单章目标字数或范围与更新节奏怎么定？单章字数由你的项目需求决定；未指定时我会采用 2000–2800 字的默认范围，并让各章目标随章节功能自然波动。" },
    { id: "subgenre-track", label: "细分赛道与差异切口", question: "在主类型下更具体走哪条细分赛道，准备满足哪些成熟期待，又用什么差异切口避免只换设定不换故事？如果当前选择与平台读者冲突，我会指出原因并给出 1—3 条可执行替代路线。" },
    { id: "core-promise", label: "核心承诺与长期看点", question: "读者追完这本书最持续获得的核心满足是什么，前 3 章、首卷和终局分别要兑现哪一层？我会把一句概念拆成可重复升级但不会机械复刻的长期故事承诺。" },
    { id: "protagonist-engine", label: "主角发动机", question: "主角起点处境、外在目标、内在缺口、不可退让的欲望与最怕失去的东西分别是什么？若目标、行动和性格互相冲突，我会先指出不成立之处，再提供能真正发动长篇的调整方向。" },
    { id: "opposition-escalation", label: "阻力、代价与升级机制", question: "谁或什么持续阻止主角，阻力如何从事件、关系、资源、身份和价值选择逐层升级，失败代价又怎样改变局势？我会检查每次升级是否由前因触发，而不是靠角色降智或临时加难度。" },
    { id: "world-rules", label: "世界规则与能力边界", question: "故事必须依赖哪些世界规则、力量或职业机制、资源约束和社会后果？请同时确定不可突破的边界与破例代价，我会排除只为当前桥段服务、后文无法自洽的规则。" },
    { id: "ending-payoff", label: "终局方向与核心兑现", question: "终局时外部矛盾、人物选择、关系结果和主题判断分别要落到哪里，读者应获得哪种最终情绪？我会从终局反推中段必需的铺垫、转折和不可撤销变化。" },
    { id: "series-volume-structure", label: "全书与分卷结构", question: "全书预计分几卷或几个大阶段，每一阶段的目标、主要升级、高潮兑现、卷末状态变化及通往下一卷的新问题是什么？我会同时检查章、卷和全书三层起承转合，避免只有单章热闹而整体原地踏步。" },
    { id: "cast-subplots", label: "人物群像、关系与副线", question: "关键配角、对手和关系线各自有什么独立目标、变化轨迹与剧情功能，哪些副线会在哪一卷交汇或退出？我会删去重复功能人物，并防止副线长期占篇幅却不改变主线。" },
    { id: "information-foreshadowing", label: "信息释放、伏笔与回收", question: "核心谜面、秘密、误导、伏笔和承诺分别由谁知道、读者何时知道、在哪一阶段首次兑现或最终回收？我会安排信息台阶并检查反转证据，避免靠隐瞒必要信息或临时补设定制造悬念。" },
    { id: "voice-boundaries", label: "文风、叙事方式与禁区", question: "采用什么视角、时序、叙述距离、语言质感和场景密度，明确不要哪些套路、桥段、表达习惯与内容尺度？特殊叙事需要同时说明读者的认知锚点，避免写着写着自动退回普通线性叙事。" },
  ], "长篇基础合同已经闭环。下一步我会从开篇首个强兑现、卷级矛盾升级、人物关系反转、世界规则反噬、伏笔回收链或副线交汇中提出 1—3 个增强方案，并说明它们对全书节奏和后续推演的影响；你想选哪一个，还是按我的推荐？", "我会压缩复述平台与受众、细分赛道、核心承诺、主角发动机、阻力升级、世界规则、终局、全书与分卷结构、人物副线、信息伏笔及文风禁区。确认按这套长篇合同进入全集大纲与后续创作，还是要调整其中一项？"),
  short_fiction: schema("短篇小说", [
    { id: "classification-length", label: "分类、篇幅与读者预期", question: "这篇短篇的主类型、预计篇幅和读者预期怎么定？你更偏抓眼球的反常小故事、情绪型故事，还是有深度和余味的质量文？" },
    { id: "premise-setting", label: "故事前提与基础设定", question: "用一句话说，什么异常规则或处境逼人物进入这个故事？时间、地点和世界规则中哪些是绝对必要的，哪些应该删掉？" },
    { id: "character-engine", label: "人物欲望、阻碍、选择与代价", question: "主角最想得到什么，最怕失去什么，谁在阻止他，高潮时必须作出什么有代价的选择？" },
    { id: "narrative-form", label: "叙事结构与叙事方式", question: "这个故事更适合线性升级、结果前置、倒计时、双线交汇、循环变奏还是认知翻转？同时更适合第一人称还是第三人称？" },
    { id: "core-value", label: "核心看点、情绪与深度取向", question: "读者最该记住的是一个反常事件、一段关系、一次价值选择还是一个认知翻转？我会据此平衡抓人速度和主题深度。" },
    { id: "progression-reveal", label: "冲突升级、信息释放与高潮", question: "故事中段靠哪种变化持续推进：阻碍升级、关系反复、证据改写认知还是代价递增？我会同时确定反转依据和高潮前的关键选择。" },
    { id: "ending-aftertaste", label: "结尾功能与余味", question: "结尾更偏行动结果、关系改变、认知翻转、价值选择、命运闭环还是开放余味？这个选择会反向决定前文必须铺垫什么。" },
    { id: "voice-boundary", label: "文风、解释量与禁区", question: "你希望叙述更克制、浓烈、冷峻、幽默还是诗性？句式、感官密度、解释量、尺度和明确不要的套路分别怎么控制？" },
  ], "基础故事已经闭环。下一步我会从强化人物选择、补反转证据、删减无功能设定、设计贯穿意象或让高潮同时改变关系与认知中提出 1—3 个增强方案；你选哪一个，还是按我的推荐？", "我会压缩复述短篇分类、故事前提、人物发动机、叙事结构、核心看点、信息释放、结尾余味和文风边界。确认按这套方案生成，还是要调整其中一项？"),
  visual_prompt: schema("提示词", [
    { id: "output-format", label: "目标模型与输出格式", question: "目标是单镜头视频、分镜、漫剧、图片资产还是站位图？使用什么模型或平台、时长或数量、横竖屏比例和输出格式？" },
    { id: "style-texture", label: "风格与质感", question: "你想要的质感更接近纪实摄影、商业广告、胶片电影、动画/国漫还是其他媒介？我会继续锁定真实度、材质、颗粒、色彩和禁止风格。" },
    { id: "subject-composition", label: "主体、空间、构图与景别", question: "谁是视觉中心，人物和环境在前中后景如何站位，采用什么景别、机位、视角、焦段和景深？竖屏与横屏会采用不同的空间组织。" },
    { id: "lighting-color", label: "光感与色彩", question: "主光从哪里来、软硬和冷暖如何、环境光与轮廓光怎样分离主体？我会把“氛围感”转成可执行的光线结构。" },
    { id: "performance-action", label: "人物表演与动作", question: "人物从什么姿态开始，经过什么动作，在什么状态结束？视线、手部、重心、微表情和其他人的反应需要怎样表现？" },
    { id: "camera-motion", label: "运镜与节奏", question: "镜头是固定、推拉、摇移、跟拍、环绕还是组合？请选叙事目的，我会确定运动起点、路径、速度、焦点变化和终点。" },
    { id: "dialogue-audio-text", label: "台词、语气、音乐、声音与字幕", question: "这个成品需要台词和口型吗，语气如何；要不要背景音乐、环境声、音效和字幕？每项请明确需要、不要或不适用。" },
    { id: "continuity-negative", label: "连续性与禁止项", question: "哪些人物身份、脸、服装、道具、空间、光线和动作承接必须锁死？同时要禁止哪些漂移、变形、文字水印、镜头抖动或风格偏移？" },
  ], "基础视觉合同已经完整。下一步我会从光线变化、焦点转移、站位权力变化、动作预备与反应、前景层次、景别节奏或连续性锁中提出 1—3 个增强方案；你选哪一个，还是按我的推荐？", "我会按硬锁定、系统建议和可发挥项复述模型格式、画幅、风格质感、构图景别、光线、表演动作、运镜、台词声音字幕与连续性。确认按这套方案生成，还是要调整其中一项？"),
});

const text = (value, max = 1200) => String(value ?? "").trim().slice(0, max);
const list = (value, valid = null) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => text(item, 80))
  .filter((item) => item && (!valid || valid.has(item))))];
const DELEGATE_PATTERN = /你决定|你来定|按你的?推荐|按推荐|交给你|你看着办|都可以|都行|无所谓|随便|专业判断|系统决定/;
const CONFIRM_PATTERN = /^(?:可以|确认|确定|就这样|按这个|按这套|开始|生成|写吧|做吧|继续|没问题|同意|采用|执行)(?:了|吧|来|生成|写|执行|就行|即可)?[。！!]*$/;
const REVISE_PATTERN = /调整|修改|改一下|换成|不要|不对|等等|先别|补充|重新/;
const DEFER_PATTERN = /^(?:不知道|不清楚|没想好|还没想好|暂时没想法|先等等|先放着|以后再说|之后再说|先跳过|跳过|略过|暂时不回答|先不回答)[。！!？?]*$/;
const CLARIFY_PATTERN = /^(?:什么意思|没懂|(?:还是)?不明白|没看懂|你在问什么|这是什么|怎么理解|为什么要问|能解释一下吗|请解释一下)[。！!？?]*$/;
const CHOICE_REQUEST_PATTERN = /(?:给|提供|列|写|来).{0,6}(?:2|3|两|三|几个|几种).{0,8}(?:方案|方向|选择|候选)|(?:方案|方向|候选).{0,8}(?:比较|对比)|(?:没想法|没头绪|卡住了?|不知道怎么选)/u;
const DIRECT_REQUEST_PATTERN = /^(?:执行|生成)[。！!]*$|(?:直接写|继续写|马上写|直接生成|继续生成|直接执行|开始执行|按(?:这个|这套|上述|你的?专业判断).{0,8}(?:写|生成|执行|落盘)|你决定.{0,8}(?:写|生成|执行|落盘))/u;
const OPINION_PATTERN = /(?:因为|理由|我觉得|我认为|我希望|我更在意|最重要|更关键|不能牺牲|必须保留|不能接受|不符合|不同意|倾向|真正想|读者|人物|主角|剧情|结构|情绪|画面)/u;

export const creativeGuidanceAnswerDisposition = (value = "") => {
  const answer = text(value, 4000);
  if (!answer) return { kind: "empty", substantive: false, reason: "本轮没有可用于完成决策簇的回答" };
  if (DEFER_PATTERN.test(answer)) return { kind: "deferred", substantive: false, reason: "用户暂缓或跳过了当前决策" };
  if (CLARIFY_PATTERN.test(answer)) return { kind: "clarification", substantive: false, reason: "用户正在询问当前问题的含义" };
  if (CHOICE_REQUEST_PATTERN.test(answer)) return { kind: "choice_request", substantive: false, reason: "用户明确要求有限候选或表示当前没有思路" };
  return { kind: DELEGATE_PATTERN.test(answer) ? "delegated" : "answered", substantive: true, reason: "" };
};

export const creativeGuidanceDirectRequest = (value = "") => DIRECT_REQUEST_PATTERN.test(text(value, 4000));

export const creativeGuidanceCandidateFallbackAllowed = ({ prompt = "", reason = "" } = {}) => (
  DEFER_PATTERN.test(text(prompt, 4000))
  || CHOICE_REQUEST_PATTERN.test(text(prompt, 4000))
  || ["major_irreversible", "explicit_comparison", "explicit_multi_candidate"].includes(text(reason, 80))
);

const normalizeCandidateOptions = (value) => {
  const options = (Array.isArray(value) ? value : [])
    .map((item, index) => typeof item === "string"
      ? { id: String(index + 1), label: text(item, 240), preserved: "", changed: "", sacrificed: "", boundary: "", impact: "" }
      : {
        id: text(item?.id || item?.key || index + 1, 80),
        label: text(item?.label || item?.direction || item?.title, 240),
        preserved: text(item?.preserved || item?.keep, 500),
        changed: text(item?.changed || item?.change, 500),
        sacrificed: text(item?.sacrificed || item?.cost, 500),
        boundary: text(item?.boundary || item?.applicableWhen, 500),
        impact: text(item?.impact, 800),
      })
    .filter((item) => item.label && item.preserved && item.changed && item.sacrificed && item.boundary && item.impact)
    .slice(0, 3);
  return options.length >= 2 ? options : [];
};

const candidateForAnswer = (answer, options) => {
  const source = text(answer, 1000).replace(/[。！!？?]/gu, "").trim();
  const numbered = source.match(/^(?:我)?(?:选|选择|倾向|采用|要)?\s*(?:第)?\s*([123一二三])\s*(?:个|项|条|种|号|方案|方向)?(?:[，,：:\s]|$)/u)?.[1];
  const number = ({ 一: 1, 二: 2, 三: 3 })[numbered] || Number(numbered);
  if (number >= 1 && number <= options.length) return options[number - 1];
  return options.find((option) => source === option.id || source === option.label || source === `方案${option.id}`) ?? null;
};

const singleQuestion = (value = "") => {
  const source = text(value, 1200);
  const marks = [...source.matchAll(/[？?]/gu)];
  if (marks.length <= 1) return source;
  let seen = 0;
  return source.replace(/[？?]/gu, () => {
    seen += 1;
    return seen === marks.length ? "？" : "，";
  });
};

const guidanceQuestionContainsMultipleDecisionBlocks = (value = "") => {
  const source = text(value, 1200);
  if (!source) return false;
  const lines = source.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const markdownHeadings = lines.filter((line) => /^#{1,6}\s+\S/u.test(line));
  const standaloneBoldHeadings = lines.filter((line) => /^(?:\*\*|__)[^*_\n]{1,60}(?:\*\*|__)$/u.test(line));
  const numberedBlocks = lines.filter((line) => /^(?:#{1,6}\s*)?\d+[.、)）]\s*\S/u.test(line));
  const letteredOptions = lines.filter((line) => /^[A-HＡ-Ｈ][.、:：)）]\s*\S/u.test(line));
  const labelledDecisionBlocks = lines.filter((line) => /^(?:#{1,6}\s*)?(?:\d+[.、)）]\s*)?(?:故事类型|核心虐点|人物路线|女主路线|男主路线|结局|虐感强度|题材选择|平台选择|风格选择|结构选择|方案选择)(?:\s*[：:]\s*)?$/u.test(line));
  return markdownHeadings.length > 1
    || standaloneBoldHeadings.length > 1
    || numberedBlocks.length > 1
    || labelledDecisionBlocks.length > 1
    || (letteredOptions.length > 3 && /(?:回复|选择|选出|选一项).{0,12}(?:编号|字母|选项|即可)/u.test(source));
};

const usableGuidanceQuestion = (value = "") => {
  const source = text(value, 1200);
  return source && !guidanceQuestionContainsMultipleDecisionBlocks(source) ? source : "";
};

export const creativeGuidanceReflectionQuestion = (value = "") => {
  const proposed = text(value, 800);
  if (/(?:你觉得|你的看法|为什么|真正|不能牺牲|最重要|希望读者|哪里不一致).*[？?]$/u.test(proposed)) return singleQuestion(proposed);
  return "这几个方向里，哪一个最接近你的判断，为什么；又有哪一部分和你真正想写的东西不一致？";
};

const appendReflectionQuestion = (value, reflection) => {
  const response = text(value, 1200).replace(/[？?]+/gu, "；").replace(/；\s*$/u, "");
  const question = creativeGuidanceReflectionQuestion(reflection);
  if (!response) return question;
  if (response.endsWith(question.replace(/[？?]$/u, ""))) return `${response}？`;
  return `${response}\n\n${question}`;
};

const candidateDiscussionText = (state, lead = "") => {
  const candidates = (state.candidateOptions ?? []).map((option) => [
    `${option.id}. ${option.label}`,
    `保留：${option.preserved}`,
    `改变：${option.changed}`,
    `牺牲：${option.sacrificed}`,
    `适用边界：${option.boundary}`,
    `影响：${option.impact}`,
  ].join("\n"));
  return [
    text(lead, 1200),
    ...candidates,
    state.tradeoffs?.length ? `关键取舍：${state.tradeoffs.join("；")}` : "",
    state.recommendation ? `专业推荐：${state.recommendation}` : "",
  ].filter(Boolean).join("\n\n");
};

export const creativeGuidanceSchema = (deliverableType = "") => CREATIVE_GUIDANCE_SCHEMAS[deliverableType] ?? null;

const normalizeDecisions = (value, valid) => (Array.isArray(value) ? value : [])
  .map((item) => ({
    cluster: text(item?.cluster, 80),
    value: text(item?.value, 1200),
    source: ["user", "delegated", "inferred"].includes(item?.source) ? item.source : "user",
  }))
  .filter((item) => valid.has(item.cluster) && item.value)
  .slice(-24);

const mergeDecisions = (...groups) => {
  const merged = new Map();
  for (const item of groups.flat()) merged.set(item.cluster, item);
  return [...merged.values()];
};

const phaseFor = ({ missingClusters, enhancementDiscussed, finalConfirmation, direct }) => {
  if (direct) return "direct_requested";
  if (missingClusters.length) return "foundation";
  if (!enhancementDiscussed) return "enhancement";
  if (!finalConfirmation) return "confirmation";
  return "ready";
};

export const normalizeCreativeGuidanceState = ({
  value = null,
  previousState = null,
  deliverableType = "",
  prompt = "",
  direct = false,
} = {}) => {
  const contractSchema = creativeGuidanceSchema(deliverableType);
  if (!contractSchema) return null;
  const valid = new Set(contractSchema.clusters.map((item) => item.id));
  const previous = previousState?.deliverableType === deliverableType ? previousState : {};
  const proposed = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const currentPrompt = text(prompt, 4000);
  const directRequested = direct || creativeGuidanceDirectRequest(currentPrompt);
  const answerDisposition = creativeGuidanceAnswerDisposition(currentPrompt);
  const previousCandidates = normalizeCandidateOptions(previous.candidateOptions);
  const proposedCandidates = normalizeCandidateOptions(proposed.candidateOptions);
  const choiceFallbackReason = text(proposed.choiceFallbackReason || previous.choiceFallbackReason, 80);
  const candidatesAllowed = creativeGuidanceCandidateFallbackAllowed({ prompt: currentPrompt, reason: choiceFallbackReason })
    || previousCandidates.length > 0;
  const candidateOptions = proposedCandidates.length && candidatesAllowed ? proposedCandidates : previousCandidates;
  const selectedFromAnswer = candidateForAnswer(currentPrompt, previousCandidates.length ? previousCandidates : candidateOptions);
  const selectionOnly = Boolean(selectedFromAnswer && !OPINION_PATTERN.test(currentPrompt));
  const awaitingCandidateOpinion = false;
  const hasUserJudgment = OPINION_PATTERN.test(currentPrompt)
    || (currentPrompt.length >= 12 && !CONFIRM_PATTERN.test(currentPrompt) && answerDisposition.kind === "answered");
  const candidateOpinionMissing = false;
  const acceptsProposedProgress = !currentPrompt || answerDisposition.substantive || selectionOnly;
  const completed = new Set([
    ...list(previous.completedClusters, valid),
    ...(acceptsProposedProgress ? list(proposed.completedClusters, valid) : []),
  ]);
  const delegated = new Set([
    ...list(previous.delegatedClusters, valid),
    ...(acceptsProposedProgress ? list(proposed.delegatedClusters, valid) : []),
  ]);
  let decisions = mergeDecisions(
    normalizeDecisions(previous.decisions, valid),
    ...(acceptsProposedProgress ? [normalizeDecisions(proposed.decisions, valid)] : []),
  );

  const previousQuestion = text(previous.questionCluster, 80);
  let enhancementDiscussed = previous.enhancementDiscussed === true;
  let finalConfirmation = previous.finalConfirmation === true;
  let selectedEnhancement = text(proposed.selectedEnhancement || previous.selectedEnhancement, 1200);
  if (currentPrompt && valid.has(previousQuestion)) {
    if (answerDisposition.substantive || selectionOnly) {
      const delegatedAnswer = answerDisposition.kind === "delegated";
      if (delegatedAnswer) delegated.add(previousQuestion);
      else completed.add(previousQuestion);
      decisions = mergeDecisions(decisions, [{
        cluster: previousQuestion,
        value: currentPrompt,
        source: delegatedAnswer ? "delegated" : "user",
      }]);
    }
  } else if (currentPrompt && previousQuestion === SPECIAL_CLUSTER.enhancement) {
    if (answerDisposition.substantive || selectionOnly) {
      enhancementDiscussed = true;
      selectedEnhancement ||= currentPrompt;
    }
  } else if (currentPrompt && previousQuestion === SPECIAL_CLUSTER.confirmation) {
    if (CONFIRM_PATTERN.test(currentPrompt) && !REVISE_PATTERN.test(currentPrompt)) finalConfirmation = true;
    if (REVISE_PATTERN.test(currentPrompt)) finalConfirmation = false;
  }

  const covered = new Set([...completed, ...delegated]);
  const missingClusters = contractSchema.clusters.map((item) => item.id).filter((id) => !covered.has(id));
  const phase = phaseFor({ missingClusters, enhancementDiscussed, finalConfirmation, direct: directRequested });
  const proposedQuestionCluster = text(proposed.questionCluster, 80);
  const agentSelectedFoundationCluster = missingClusters.includes(proposedQuestionCluster)
    ? proposedQuestionCluster
    : "";
  const questionCluster = phase === "foundation"
    ? agentSelectedFoundationCluster || missingClusters[0]
    : phase === "enhancement"
      ? SPECIAL_CLUSTER.enhancement
      : phase === "confirmation"
        ? SPECIAL_CLUSTER.confirmation
        : "";
  const candidateCluster = text(proposed.candidateCluster || previous.candidateCluster || previousQuestion || questionCluster, 80);
  const activeCandidateOptions = candidateCluster === questionCluster && !answerDisposition.substantive && !selectionOnly
    ? candidateOptions
    : candidateCluster === questionCluster && selectionOnly
      ? candidateOptions
      : [];
  const selectedCandidate = selectedFromAnswer
    ? selectedFromAnswer.id
    : text(previous.selectedCandidate, 80);
  const userOpinion = selectedFromAnswer || (previous.selectedCandidate && hasUserJudgment)
    ? currentPrompt
    : text(previous.userOpinion, 2000);
  const pendingReflectionQuestion = creativeGuidanceReflectionQuestion(
    proposed.pendingReflectionQuestion || previous.pendingReflectionQuestion,
  );
  const recommendation = text(proposed.recommendation || previous.recommendation, 1600);
  const tradeoffs = list(proposed.tradeoffs || previous.tradeoffs).slice(0, 8);
  const questionAttempts = previous.questionAttempts && typeof previous.questionAttempts === "object"
    ? { ...previous.questionAttempts }
    : {};
  if (currentPrompt && previousQuestion) {
    questionAttempts[previousQuestion] = Math.min(2, Math.max(0, Number(questionAttempts[previousQuestion]) || 0) + 1);
  }
  const decisionStatus = answerDisposition.kind === "delegated"
    ? "delegated"
    : directRequested || finalConfirmation
      ? "confirmed"
      : activeCandidateOptions.length
        ? "tentative"
        : answerDisposition.substantive || selectionOnly
          ? "confirmed"
          : ["tentative", "confirmed", "delegated"].includes(previous.decisionStatus)
            ? previous.decisionStatus
            : "tentative";
  const interactionMode = directRequested
    ? "direct"
    : activeCandidateOptions.length
        ? "choice_fallback"
        : phase === "confirmation"
          ? "confirmation"
          : "discussion";

  return {
    schemaVersion: 2,
    deliverableType,
    deliverableLabel: contractSchema.label,
    phase,
    ready: ["ready", "direct_requested"].includes(phase),
    interactionMode,
    decisionStatus,
    completedClusters: [...completed],
    delegatedClusters: [...delegated],
    missingClusters,
    decisions,
    briefSummary: text(proposed.briefSummary || previous.briefSummary, 5000),
    enhancementIdeas: list(proposed.enhancementIdeas || previous.enhancementIdeas).slice(0, 5),
    selectedEnhancement,
    enhancementDiscussed,
    finalConfirmation: directRequested ? true : finalConfirmation,
    clarificationNeeded: Boolean(currentPrompt && !answerDisposition.substantive),
    answerDisposition: answerDisposition.kind,
    clarificationReason: answerDisposition.reason,
    questionCluster,
    questionMatchesPhase: !questionCluster || proposedQuestionCluster === questionCluster,
    candidateOptions: activeCandidateOptions,
    candidateCluster: activeCandidateOptions.length ? questionCluster : "",
    selectedCandidate,
    userOpinion,
    pendingReflectionQuestion,
    recommendation,
    tradeoffs,
    choiceFallbackReason,
    questionAttempts,
    questionRound: Math.min(2, Number(questionAttempts[questionCluster]) || 0),
    turnCount: Math.max(0, Number(previous.turnCount) || 0) + 1,
  };
};

export const creativeGuidanceQuestion = ({ state, proposedQuestion = "", force = false } = {}) => {
  const proposed = usableGuidanceQuestion(proposedQuestion);
  if (!state) return proposed;
  if (state.ready) return force
    ? singleQuestion(proposed || "请先确认主角当前最不能退让的目标，以及这次行动失败后会立刻失去什么。")
    : "";
  const contractSchema = creativeGuidanceSchema(state.deliverableType);
  if (!contractSchema) return proposed;
  const reflection = creativeGuidanceReflectionQuestion(state.pendingReflectionQuestion);
  if (state.selectedCandidate && state.decisionStatus === "tentative" && !state.userOpinion) return reflection;
  let question = state.questionMatchesPhase && proposed
    ? proposed
    : state.questionCluster === SPECIAL_CLUSTER.enhancement
      ? contractSchema.enhancementQuestion
      : state.questionCluster === SPECIAL_CLUSTER.confirmation
        ? contractSchema.confirmationQuestion
        : contractSchema.clusters.find((item) => item.id === state.questionCluster)?.question
          || "当前创作合同还有一个关键缺口。你真正不能牺牲的部分是什么？";
  if (state.questionRound >= 2 && state.clarificationNeeded && !state.candidateOptions?.length) {
    question = "这一点先保留为暂定，不重复原问题。你真正不能接受作品被写成什么样？";
  }
  return state.candidateOptions?.length
    ? appendReflectionQuestion(candidateDiscussionText(state, question), reflection)
    : singleQuestion(question);
};

export const creativeGuidanceInstruction = (deliverableType = "") => {
  const contractSchema = creativeGuidanceSchema(deliverableType);
  if (!contractSchema) return "";
  const clusters = contractSchema.clusters.map((item) => `- ${item.id}: ${item.label}`).join("\n");
  return `
# 专项创作合同状态协议
当前最终产物：${contractSchema.label}
必需决策簇：
${clusters}

${creativeGuidanceDepthPrompt({ direct: false })}

读取全部本轮引导消息和上轮创作合同状态，把用户新回答合并后返回 guidanceState。不要把只有主题、题材、一个风格词或单个素材点判为合同完整。一次回答可以覆盖多个明确决策簇，但没有证据的簇不得标记 completed。先像责任编辑一样复述作者真正想达到的效果，给出专业判断、影响和风险，再用一个开放式问题追问作者自己的判断；不得默认把引导做成选择题。question 只能表达当前 questionCluster，禁止在 question 中使用多个 Markdown 标题、多组编号或 A/B/C 列表拼装问卷。

每轮只推进一个最高价值的 questionCluster，不重复 completedClusters 或 delegatedClusters，同一问题最多追问两轮。用户回答“不知道”“没想好”“卡住”、明确要求比较方案、明确要求多候选稿，或面对会改变人物命运、核心真相、结局或全书结构的重大互斥分叉时，才允许 choice_fallback，并只给 2—3 个候选。每个候选必须写明保留、改变、牺牲、适用边界，以及对人物、剧情、读者体验和后续结构的影响；同时给出 recommendation 和理由。凡回复包含候选，末尾必须是询问作者看法、理由或真实倾向的开放式问题，不能只问“请选择 1、2、3”。

点击选项等同作者在对话框里输入该选项文字：保留问题和用户答案，选项面板自动隐藏；不得给点击动作附加特殊权限，也不得强制作者再解释理由。选项文字足以回答当前决策簇时可正常完成该簇；仍有真实歧义时由当前 Agent 只追问一个最高价值问题。只有文本本身明确要求生成或写入时才进入正式执行。用户明确说“你决定”或“按你的专业判断执行”时设为 delegated 并采用专业推荐；明确说“直接写、继续写、执行、生成、按这个落盘”时 interactionMode=direct、action=generate，不得强行给选择题或继续追问。对话选项、用户明确要求的多候选稿和创作核内部候选竞争必须严格区分。

基础簇全部完成后进入 __enhancement__，完成增强讨论后进入 __confirmation__，用压缩摘要确认最终合同。只有最终确认、明确委托或 direct 才能生成。笔记里创建小说时不得套用作品模式的分卷结构；确认是同一作品的多文档时，只可建立以作品名命名的分类文件夹。

guidanceState 格式：
{
  "completedClusters": ["已由用户明确回答的决策簇 ID"],
  "delegatedClusters": ["用户明确授权系统决定的决策簇 ID"],
  "decisions": [{"cluster":"决策簇 ID","value":"已确认内容或明确推荐","source":"user | delegated | inferred"}],
  "briefSummary": "持续更新的压缩创作合同；确认阶段必须覆盖全部决策簇",
  "enhancementIdeas": ["1—3 个具体增强建议及预期收益"],
  "selectedEnhancement": "用户选择、拒绝或授权采用的增强方案",
  "enhancementDiscussed": false,
  "finalConfirmation": false,
  "questionCluster": "本轮问题对应的决策簇 ID、__enhancement__ 或 __confirmation__",
  "interactionMode": "discussion | choice_fallback | confirmation | direct",
  "decisionStatus": "tentative | confirmed | delegated",
  "candidateOptions": [{"id":"1","label":"方向","preserved":"保留什么","changed":"改变什么","sacrificed":"牺牲什么","boundary":"适用边界","impact":"对人物、剧情、读者体验和后续结构的影响"}],
  "selectedCandidate": "作者选中的普通对话选项 ID；AI 不得代选",
  "userOpinion": "作者选择或输入的普通对话答案",
  "pendingReflectionQuestion": "候选回复末尾唯一的开放式意见问题",
  "recommendation": "专业推荐及理由",
  "tradeoffs": ["关键取舍"]
}`.trim();
};

export const CREATIVE_GUIDANCE_SPECIAL_CLUSTERS = SPECIAL_CLUSTER;
