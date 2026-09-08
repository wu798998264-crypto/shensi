const clean = (value = "") => String(value ?? "").replace(/\s+/gu, " ").trim();
const cleanDirective = (value = "") => String(value ?? "")
  .replace(/\r\n?/gu, "\n")
  .replace(/[ \t]+\n/gu, "\n")
  .trim();

const normalizedEvidenceSource = (value = {}, fallbackPath = "") => {
  const raw = typeof value === "string" ? { path: value } : (value ?? {});
  const quote = clean(raw.quote || raw.excerpt || raw.text);
  const startOffset = raw.startOffset !== null && raw.startOffset !== undefined && Number.isFinite(Number(raw.startOffset))
    ? Math.max(0, Number(raw.startOffset)) : null;
  const endOffset = raw.endOffset !== null && raw.endOffset !== undefined && Number.isFinite(Number(raw.endOffset))
    ? Math.max(startOffset ?? 0, Number(raw.endOffset)) : null;
  return {
    documentId: clean(raw.documentId || raw.id),
    title: clean(raw.title || raw.documentTitle),
    path: clean(raw.path || raw.sourcePath || fallbackPath),
    heading: clean(raw.heading || raw.section),
    quote,
    startOffset,
    endOffset,
    revision: clean(raw.revision || raw.versionHash || raw.documentRevision),
  };
};

export const pendingDecisionEvidenceSources = (value = {}) => {
  const fallbackPath = clean(value.sourcePath || value.documentPath || value.path || value.source);
  const supplied = Array.isArray(value.sources) ? value.sources
    : Array.isArray(value.evidenceSources) ? value.evidenceSources
      : Array.isArray(value.affectedDocuments) ? value.affectedDocuments : [];
  const normalized = supplied.map((item) => normalizedEvidenceSource(item, fallbackPath))
    .filter((item) => item.documentId || item.path || item.title || item.quote);
  if (normalized.length) return normalized.slice(0, 8);
  return fallbackPath ? [normalizedEvidenceSource({ path: fallbackPath }, fallbackPath)] : [];
};

const VAGUE_PENDING_PATTERN = /^(?:继续|进一步|适当|可以考虑|建议)?(?:完善|优化|加强|增强|补充|调整|保持|注意)(?:人物|剧情|冲突|节奏|逻辑|一致性|设定|表达|细节)?(?:即可|一下|方面)?[。.!！]?$/u;
const DECISION_SIGNAL_PATTERN = /(?:是否|哪一种|哪一条|哪条|何时|哪里|谁|为什么|如何|以哪|选择|确定|确认|冲突|互斥|代价|身份|真相|背叛|死亡|立场|伏笔|回收|规则|路线|结局|知情|秘密)/u;
const NON_DECISION_STATUS_PATTERN = /(?:暂无(?:明确)?(?:硬)?冲突|当前状态|更新至|已完成|已处理|无需确认|没有待确认|无待确认|未检测到冲突)/u;
const INTERNAL_MAINTENANCE_PATTERN = /(?:迁移|文件整理|目录整理|创建|新增|补建|维护).{0,12}(?:目录|索引|报告|记录表|节奏表|文档|文件)|(?:细纲|正文)\s*或\s*(?:细纲|正文)|是否需要为.{0,16}(?:新增|创建).{0,12}(?:表|目录|文档)/u;

export const pendingDecisionIsActionable = (value = "") => {
  const source = clean(value);
  if (!source || source.length < 8 || VAGUE_PENDING_PATTERN.test(source)) return false;
  if (NON_DECISION_STATUS_PATTERN.test(source) || INTERNAL_MAINTENANCE_PATTERN.test(source)) return false;
  return DECISION_SIGNAL_PATTERN.test(source) || /[？?]/u.test(source);
};

export const normalizePendingCreativeDecision = (value, {
  source = "正文创作",
  affectedScopes = [],
  recommendation = "",
  options = [],
  status = "pending",
} = {}) => {
  const raw = typeof value === "string" ? { question: value } : (value ?? {});
  const question = clean(raw.question || raw.text || raw.issue);
  if (!pendingDecisionIsActionable(question)) return null;
  const normalizedOptions = (Array.isArray(raw.options) ? raw.options : options)
    .map((item) => typeof item === "string" ? { label: clean(item), impact: "" } : ({ label: clean(item?.label || item?.option), impact: clean(item?.impact) }))
    .filter((item) => item.label)
    .slice(0, 5);
  const sources = pendingDecisionEvidenceSources(raw);
  const normalizedStatus = raw.status === "editing" ? "pending" : (raw.status || status);
  return {
    id: clean(raw.id) || `pending-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    question,
    source: clean(raw.source || source),
    sourcePath: clean(raw.sourcePath || raw.documentPath || raw.path || raw.source || source),
    context: clean(raw.context || raw.reason || raw.conflictExplanation),
    conflictExplanation: clean(raw.conflictExplanation || raw.context || raw.reason),
    conflictPoints: (Array.isArray(raw.conflictPoints) ? raw.conflictPoints : [])
      .map((item) => clean(item)).filter(Boolean).slice(0, 8),
    sources,
    options: normalizedOptions,
    recommendation: clean(raw.recommendation || recommendation),
    affectedScopes: [...new Set([...(raw.affectedScopes ?? []), ...affectedScopes].map(clean).filter(Boolean))],
    status: ["pending", "queued", "processing", "deferred", "confirmed", "discarded", "committed", "resolved"].includes(normalizedStatus) ? normalizedStatus : "pending",
    confirmedDecision: cleanDirective(raw.confirmedDecision),
    committedTargets: Array.isArray(raw.committedTargets) ? raw.committedTargets.map(clean).filter(Boolean) : [],
    sourceFingerprint: clean(raw.sourceFingerprint),
    issueFingerprint: clean(raw.issueFingerprint || raw.conflictFingerprint || raw.sourceFingerprint),
    detectedAt: clean(raw.detectedAt),
    resolvedAt: clean(raw.resolvedAt),
    resolutionEvidence: clean(raw.resolutionEvidence),
    decisionType: clean(raw.decisionType),
    opinion: cleanDirective(raw.opinion),
    draftOpinion: cleanDirective(raw.draftOpinion),
    processingAt: clean(raw.processingAt),
    reviewedAt: clean(raw.reviewedAt),
    lastError: clean(raw.lastError),
    order: Number.isFinite(Number(raw.order)) ? Number(raw.order) : 0,
  };
};

export const creativeGuidanceDepthPrompt = ({ direct = false } = {}) => direct
  ? "用户已要求直接生成或批量生成：立即执行，不追问，不设置候选稿、自检满意度或落盘门禁；把不阻断本轮交付但确实影响后续创作的具体未决问题记录为待确认事项。"
  : [
    "创作引导贯穿正文全过程，不在进入正文后终止。像责任编辑或主编一样，先复述作者真正想达到的效果，再说明编辑判断、影响与风险，最后只追问当前最高价值的一个问题。",
    "正文每推进一个场景或章节，都要检查并在必要时具体追问：视角人物此刻想得到什么、阻力来自谁或什么、失败会立刻失去什么、人物掌握与误判了哪些信息、为什么必须现在行动。",
    "继续检查场景起点与终点的状态变化、行动和反应的因果链、情绪转折的触发细节、对白表层信息与潜台词、读者知情边界、伏笔投放与回收、世界规则代价、主题取舍、章节钩子及前后连续性。",
    "追问要锚定具体人物、场景和事件。用户方向清楚时直接承接，不重复提供候选，不把明确要求改成问卷；同一个问题最多追问两轮，普通细节由系统专业补全。",
    "只有作者没想法、卡住、明确要求比较或多候选，或者人物命运、核心真相、结局、全书结构出现重大互斥分叉时，才给 2—3 个候选。每个候选说明保留、改变、牺牲、适用边界及对人物、剧情、读者体验和后续结构的影响，并给出专业推荐与理由。",
    "凡需要作者选择时，使用对话输入框上方的紧凑选项；点击选项等同作者输入该选项文字，没有额外权限，问题和答案保留、面板自动隐藏。选项文字若已足够清楚就直接承接；仍有真实歧义时只追问一个最高价值问题。只有普通文本本身明确要求生成或写入时才进入正式执行。",
    "能够从既有正文和已确认设定推断的内容不要重复询问；普通润色和确定性修复直接处理。",
    "会根本改变当前正文的互斥路线先请求作者确认；讨论中自然出现、只影响后续的灵感、设定和大纲可以继续完成当前正文，但必须记录为待确认事项。",
    "待确认事项只保存两项：上方的来源文档实际路径，以及下方由自然语言描述、作者能够明确回答的具体问题。不要保存方案、推荐、状态说明、检查报告或文件维护建议；禁止记录‘继续优化人物’‘加强冲突’‘注意一致性’等空泛建议。",
    "如果当前执行确实遇到只有用户才能决定的互斥含义或不可逆操作，不要自行设置隐藏门禁；返回一个明确的自然语言问题，由界面弹窗让用户确认。普通写作判断、可恢复修改和自检意见不得阻止生成或落盘。",
    "用户确认后，把结论局部写入实际需要的资料、设定、大纲、正文或记忆板块；未确认事项不得作为既定事实。",
    "笔记中创建小说不套用作品模式的分卷结构；同一作品需要多个笔记文档时，仅用作品名建立分类文件夹。",
  ].join("\n");
