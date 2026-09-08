const valueText = (value = "", max = 4000) => String(value ?? "").trim().slice(0, max);
const list = (value, max = 8) => (Array.isArray(value) ? value : [])
  .map((item) => valueText(item, 240))
  .filter(Boolean)
  .slice(0, max);

const SKILL_CAPABILITY_IDS = new Set([
  "creative_guidance", "novel_guidance", "short_drama_guidance", "prompt_guidance",
  "story_planner", "setting_planner", "novel_prose_writer", "original_script_writer",
  "adaptation_writer", "visual_prompt_writer", "theory_advisor", "effect_reviewer",
  "genre_reviewer", "repair_writer", "format_extension", "custom_writer",
  "auxiliary_advisor", "style_reference", "knowledge_reference", "memory_advisor",
  "experience_advisor", "experience_observer", "article_illustration_planner",
  "novel_cover_designer", "public_account_guidance", "short_fiction_guidance",
  "short_video_guidance", "public_account_writer", "short_fiction_writer",
  "short_video_script_writer", "prompt_writer",
]);

const normalizedSkillCapabilities = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map((item) => valueText(item, 80))
  .filter((item) => SKILL_CAPABILITY_IDS.has(item)))].slice(0, 16);

export const UNIFIED_AGENT_ENTRY_VERSION = 2;
export const UNIFIED_AGENT_LANES = Object.freeze(["direct_reply", "guided_dialogue", "task_execution"]);
export const UNIFIED_AGENT_TASK_KINDS = Object.freeze([
  "conversation",
  "creative_guidance",
  "content_creation",
  "content_revision",
  "quality_review",
  "workspace_operation",
  "research",
  "task_execution",
]);
export const UNIFIED_AGENT_WORKFLOWS = Object.freeze(["library_archive"]);
export const UNIFIED_AGENT_OPERATION_KINDS = Object.freeze(["skill_install", "self_repair"]);

const balancedJsonObject = (source = "") => {
  const text = String(source || "");
  const start = text.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return "";
};

const normalizedQuestion = (value = "") => {
  const source = valueText(value, 1000);
  const matches = [...source.matchAll(/[？?]/gu)];
  if (matches.length <= 1) return source;
  let count = 0;
  return source.replace(/[？?]/gu, () => {
    count += 1;
    return count === matches.length ? "？" : "，";
  });
};

const normalizedGuidance = (value = {}) => ({
  deliverableType: ["novel", "short_fiction", "short_drama_script", "short_video_script", "public_account", "visual_prompt"].includes(valueText(value.deliverableType, 80))
    ? valueText(value.deliverableType, 80)
    : "novel",
  question: normalizedQuestion(value.question),
  questionCluster: valueText(value.questionCluster, 80),
  completedClusters: list(value.completedClusters, 24),
  delegatedClusters: list(value.delegatedClusters, 24),
  decisions: (Array.isArray(value.decisions) ? value.decisions : []).map((item) => ({
    cluster: valueText(item?.cluster, 80),
    value: valueText(item?.value, 1200),
    source: ["user", "delegated", "inferred"].includes(item?.source) ? item.source : "user",
  })).filter((item) => item.cluster && item.value).slice(-24),
  briefSummary: valueText(value.briefSummary, 5000),
  interactionMode: ["discussion", "choice_fallback", "confirmation", "direct"].includes(value.interactionMode)
    ? value.interactionMode
    : "discussion",
  candidateOptions: (Array.isArray(value.candidateOptions) ? value.candidateOptions : []).map((item, index) => ({
    id: valueText(item?.id || String(index + 1), 40),
    label: valueText(item?.label, 240),
    preserved: valueText(item?.preserved, 600),
    changed: valueText(item?.changed, 600),
    sacrificed: valueText(item?.sacrificed, 600),
    boundary: valueText(item?.boundary, 600),
    impact: valueText(item?.impact, 1000),
  })).filter((item) => item.label).slice(0, 3),
  recommendation: valueText(value.recommendation, 1600),
  tradeoffs: list(value.tradeoffs, 8),
});

const normalizedOpenDecision = (value = null) => {
  if (typeof value === "string") {
    const question = normalizedQuestion(value);
    return question ? {
      id: "",
      question,
      whyNeeded: "",
      options: [],
      allowFreeText: true,
    } : null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const question = normalizedQuestion(value.question);
  if (!question) return null;
  const options = (Array.isArray(value.options) ? value.options : []).map((item, index) => ({
    id: valueText(item?.id || String(index + 1), 80),
    label: valueText(item?.label, 240),
    effect: valueText(item?.effect, 800),
    entityRefs: list(item?.entityRefs, 12),
    scopeDelta: valueText(item?.scopeDelta, 800),
  })).filter((item) => item.id && item.label).slice(0, 4);
  return {
    id: valueText(value.id, 120),
    question,
    whyNeeded: valueText(value.whyNeeded, 800),
    options,
    allowFreeText: value.allowFreeText !== false,
  };
};

const normalizedOperation = (value = null, lane = "") => {
  if (lane !== "task_execution" || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const kind = valueText(value.kind, 80);
  if (!UNIFIED_AGENT_OPERATION_KINDS.includes(kind)) return null;
  return {
    kind,
    reason: valueText(value.reason, 800),
  };
};

export const normalizeUnifiedAgentDecision = (value = null) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const lane = UNIFIED_AGENT_LANES.includes(value.lane) ? value.lane : "";
  if (!lane) return null;
  const declaredTaskKind = UNIFIED_AGENT_TASK_KINDS.includes(valueText(value.taskKind, 80))
    ? valueText(value.taskKind, 80)
    : "";
  const taskKind = declaredTaskKind || (lane === "direct_reply"
    ? "conversation"
    : lane === "guided_dialogue" ? "creative_guidance" : "task_execution");
  const qualityReview = lane === "task_execution" && taskKind === "quality_review";
  const relation = qualityReview
    ? "inspect_task"
    : ["new_task", "supplement", "resume", "inspect_task"].includes(value.relation)
    ? value.relation
    : "new_task";
  const objective = valueText(value.objective, 2400);
  const reply = valueText(value.reply, lane === "guided_dialogue" ? 1600 : 16000);
  const requestMode = qualityReview
    ? "creative"
    : lane === "direct_reply"
    ? "general"
    : lane === "guided_dialogue"
      ? "creative_guidance"
      : ["creative", "quick_revision", "workspace_operation", "visual_prompt", "general"].includes(value.requestMode)
        ? value.requestMode
        : "creative";
  const deliverableType = qualityReview
    ? "report"
    : ["novel", "short_fiction", "short_drama_script", "short_video_script", "public_account", "visual_prompt", "document", "report"].includes(valueText(value.deliverableType, 80))
    ? valueText(value.deliverableType, 80)
    : "";
  if (lane === "direct_reply" && !reply) return null;
  const guidance = lane === "guided_dialogue" ? normalizedGuidance(value.guidance) : null;
  if (lane === "guided_dialogue" && !(guidance?.question || reply)) return null;
  const writeIntent = lane === "task_execution" && ["none", "candidate", "commit"].includes(value.writePlan?.intent)
    ? value.writePlan.intent
    : "none";
  const writeTargetKind = lane === "task_execution" && ["current", "existing", "new", "unspecified"].includes(value.writePlan?.targetKind)
    ? value.writePlan.targetKind
    : "unspecified";
  const writeOperation = lane === "task_execution" && ["append", "replace", "patch", "create", "none"].includes(value.writePlan?.operation)
    ? value.writePlan.operation
    : "none";
  const workflow = lane === "task_execution" && UNIFIED_AGENT_WORKFLOWS.includes(valueText(value.workflow, 80))
    ? valueText(value.workflow, 80)
    : "";
  const operation = normalizedOperation(value.operation, lane);
  const skillCapabilities = lane !== "direct_reply" ? normalizedSkillCapabilities(value.skillCapabilities) : [];
  if (qualityReview && !skillCapabilities.includes("effect_reviewer")) skillCapabilities.push("effect_reviewer");
  return {
    schemaVersion: UNIFIED_AGENT_ENTRY_VERSION,
    lane,
    taskKind,
    relation,
    objective: objective || (lane === "direct_reply" ? "回答当前问题" : lane === "guided_dialogue" ? "逐步明确创作方向" : "执行当前任务"),
    requestMode,
    deliverableType,
    workflow,
    operation,
    reply,
    confidence: Math.max(0, Math.min(1, Number(value.confidence) || 0)),
    guidanceCompleted: value.guidanceCompleted === true,
    skillQueries: lane !== "direct_reply" ? list(value.skillQueries, 8) : [],
    skillCapabilities,
    readPlan: lane !== "direct_reply" ? (Array.isArray(value.readPlan) ? value.readPlan : []).map((item) => ({
      reference: valueText(item?.reference, 240),
      required: item?.required === true,
      purpose: valueText(item?.purpose, 600),
    })).filter((item) => item.reference).slice(0, 16) : [],
    writePlan: {
      intent: writeIntent,
      targetKind: writeTargetKind,
      targetRef: valueText(value.writePlan?.targetRef, 240),
      operation: writeOperation,
    },
    openDecision: normalizedOpenDecision(value.openDecision),
    guidance,
  };
};

export const parseUnifiedAgentDecision = (source = "") => {
  const json = balancedJsonObject(String(source || "").replace(/^```(?:json)?\s*|\s*```$/giu, ""));
  if (!json) return null;
  try {
    return normalizeUnifiedAgentDecision(JSON.parse(json));
  } catch {
    return null;
  }
};

export const unifiedAgentEntrySystemPrompt = () => `
你是神思统一文字入口。你只做一次语义判断，并在允许时同时完成本轮回复。

只输出一个 JSON 对象，不输出 Markdown、代码围栏或 JSON 之外的文字。

lane 只能是：
- direct_reply：普通闲聊、知识问答、解释或不需要读取工作区和调用工具的讨论。reply 必须直接完成回答。
- guided_dialogue：需要调用创作引导能力逐步探索创作目标的 Agent 任务，不能按普通对话直接返回，也不应一次输出完整方案或正文。填写 deliverableType、所需 skillQueries 和必要 readPlan；reply 只作为路由摘要，最终问题由创作引导 Skill 生成。
- task_execution：需要读取资料、选择 Skill、调用工具、创建或修改内容、写入文档、检查真实状态，或者需要恢复既有任务。

taskKind 用来表达任务本身是什么。对正文、剧本或文章做质检、自检、审稿、质量检查，或续接上一轮同类检查时，必须填写 quality_review；这类任务必须使用 task_execution，requestMode=creative，deliverableType=report，并在 skillCapabilities 中选择 effect_reviewer。不能因为目标可能不存在、句子很短或沿用上文，就把它降为 direct_reply。

workflow 只在确有专用事务流程时填写：
- library_archive：用户的完整意图是读取当前作品或笔记本内的资料库来源，把其中有证据的内容拆分、分类并归档到设定或大纲。普通资料问答、引用资料续写正文、只整理一份当前文档、仅查看资料库，均不得选择此 workflow。

operation 只在确有高影响操作意图时填写：
- kind=skill_install：用户明确要求把本轮提供的 Skill/技能内容导入并绑定到神思能力面板；只讨论、分析或使用已有 Skill 时不得填写。
- kind=self_repair：用户明确要求检查并修改神思软件、源码、界面或运行器；修复作品正文、设定、大纲或普通文档时不得填写。
这两类操作只返回待确认提案，不得在统一入口直接执行。

不得用关键词表机械判断。结合最近对话、用户明确引用、当前引导状态和任务状态理解真实意图。
用户表达想开始一项创作，但题材承诺、核心冲突、人物目标、受众或形式等关键创作合同仍需共同推演时，应判断为 guided_dialogue；不能把它当作 direct_reply 输出教程、方案清单、完整设定或大段建议。即使用户只给出一句模糊方向，也要基于语义判断是否应进入创作引导。
guided_dialogue 每轮只推进一个当前最有价值的决策。reply 和 guidance.question 只能简短承接并提出一个问题，不得输出问卷、多组问题、完整方案或正文。已有 guidanceState 时应继续同一引导；只有合同已充分形成且作者明确同意进入产出，才能把 guidanceCompleted 设为 true。
direct_reply 不得请求加载 Skill、文档目录、写入规则或工具。guided_dialogue 可以按需请求创作引导 Skill 和最小必要资料，但不得写入文档。task_execution 只提出语义计划，不声称已经获得权限或完成操作。
选择 library_archive 时，由宿主读取可信资料库快照、比较现有设定和大纲并动态生成确认项；你不得预先编造固定选项，也不得把“读取资料”当成修改资料库的授权。此 workflow 的 writePlan 应描述候选归档意图，正式写入必须等待宿主确认。
只有在持续创作引导已形成足够合同、且用户明确同意进入产出时，guidanceCompleted 才能为 true。
用户说“当前文档”时 targetRef 写 submitted_document；引用资料不等于允许修改。新任务不得继承旧任务的临时写入授权。
没有真实必要时不要生成 openDecision；需要用户拍板时只问一个问题，选项必须来自本次真实场景，并允许自然语言回答。

JSON 格式：
{
  "lane":"direct_reply | guided_dialogue | task_execution",
  "taskKind":"conversation | creative_guidance | content_creation | content_revision | quality_review | workspace_operation | research | task_execution",
  "relation":"new_task | supplement | resume | inspect_task",
  "objective":"本轮目标",
  "requestMode":"general | creative_guidance | creative | quick_revision | workspace_operation | visual_prompt",
  "deliverableType":"novel | short_fiction | short_drama_script | short_video_script | public_account | visual_prompt | document | report | 空字符串",
  "workflow":"library_archive | 空字符串",
  "operation":{"kind":"skill_install | self_repair","reason":"为何必须进入高影响操作确认"},
  "reply":"direct_reply 的完整回答，或 guided_dialogue 的简短理解、判断和唯一问题",
  "confidence":0.0,
  "guidanceCompleted":false,
"skillQueries":["用于解释能力意图的自然语言描述；不需要则为空"],
"skillCapabilities":["从神思能力目录中选择本轮真正需要的能力 ID；只填写必要能力，不得凭关键词猜测"],
  "readPlan":[{"reference":"资源描述","required":true,"purpose":"用途"}],
  "writePlan":{"intent":"none | candidate | commit","targetKind":"current | existing | new | unspecified","targetRef":"资源引用","operation":"append | replace | patch | create | none"},
  "openDecision":{"id":"稳定决定ID","question":"仍需用户决定的唯一事项","whyNeeded":"为何不能安全自行决定","options":[{"id":"选项ID","label":"显示文字","effect":"选择后的实际影响","entityRefs":["真实资源ID"],"scopeDelta":"新增或缩小的授权范围"}],"allowFreeText":true},
  "guidance":{"deliverableType":"novel","question":"唯一问题","questionCluster":"由你动态选择的决策簇","completedClusters":[],"delegatedClusters":[],"decisions":[],"briefSummary":"当前创作合同摘要","interactionMode":"discussion","candidateOptions":[],"recommendation":"","tradeoffs":[]}
}`.trim();

export const unifiedAgentEntryUserPrompt = ({ messages = [], explicitReferences = [], explicitSkills = [], guidanceState = null, taskState = null, submittedDocument = null } = {}) => {
  const recentMessages = (Array.isArray(messages) ? messages : []).slice(-8).map((message) => ({
    role: message?.role === "assistant" ? "assistant" : "user",
    content: valueText(message?.content, 4000),
  })).filter((message) => message.content);
  return JSON.stringify({
    recentMessages,
    explicitReferences: list(explicitReferences, 16),
    explicitSkills: list(explicitSkills, 12),
    guidanceState: guidanceState && typeof guidanceState === "object" ? guidanceState : null,
    taskState: taskState && typeof taskState === "object" ? taskState : null,
    submittedDocument: submittedDocument && typeof submittedDocument === "object" ? submittedDocument : null,
  });
};
