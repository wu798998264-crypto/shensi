import { sha256HexSync } from "./version-integrity.js";
import { contextualInsertionRequested } from "./document-edit-plan.js";
import { reviewDeliveryPolicy } from "./review-delivery-policy.js";
import { taskContractWriteAction, validateTaskContractForExecution } from "./task-contract.js";

const clean = (value = "") => String(value ?? "").replace(/\r\n?/g, "\n").trim();

const READ_ONLY_OR_NEGATED = /(?:只|仅)(?:需(?:要)?|想|要)?(?:分析|讨论|评价|评估|诊断|检查|回答|告诉|说明|解释|看看|看一下)|(?:^|[，。！？；;\n])\s*(?:(?:我)?(?:想|只想)|请(?:你)?|帮我|你)?\s*(?:(?:这|本|当前)(?:章|章节|文档|正文))?\s*(?:分析|讨论|评价|评估|诊断|检查|回答|告诉我|怎么看|如何|怎么|哪里|哪些|什么).{0,28}(?:修改|改写|续写|优化|调整|正文|章节)|(?:不要|不用|无需|不必|禁止|不得|别|先别|暂不|不能|不可)(?![^，。！？；;\n]{0,16}(?:宣称|声称|报告)).{0,16}(?:修改|改动|覆盖|替换|写入|落盘|保存|动).{0,12}(?:正文|原文|标题|文档|内容)?|(?:修改|改写|优化|调整).{0,20}(?:建议|意见|思路|方法)|(?:应该|需要|可以).{0,10}(?:怎么|如何|哪里|哪些).{0,10}(?:修改|改写|优化|调整)/u;
const CANDIDATE_REQUEST = /(?:先|暂时)?(?:写|生成|给|提供|出)(?:我)?(?:一|两|三|几|多)?(?:个|篇|版|份|种)?(?:候选|草稿|版本|方案|写法)|(?:多|两|三|几|[2-9])(?:个|篇|版|份|种)(?:候选|草稿|版本|方案|写法)|(?:写|生成).{0,12}(?:看看|看一看|试试|供选择|让我选)/u;
const NEGATED_CANDIDATE_REQUEST = /(?:不|不要|无需|暂不|先别)\s*(?:再)?(?:生成|写|提供|给).{0,20}(?:候选|草稿|版本|方案|写法)/u;
const GENERATE_WITHOUT_LANDING_REQUEST = /(?:^|[，。！？；;\s])(?:请)?(?:先|暂时)?(?:直接)?(?:生成|写|改写|重写|续写|创作).{0,28}(?:不|不要|无需|暂不|先别).{0,8}(?:落盘|写入|保存|覆盖)/u;
const NEGATED_GENERATION = /(?:不|不要|无需|不必|禁止|不得|先别|暂不).{0,6}(?:生成|写|改写|重写|续写|创作)/u;
const ADOPT_CANDIDATE = /^(?:就)?(?:按|采用|使用|选|确定用)(?:这个|这版|该版|当前候选|候选稿|它)?(?:执行|生成|落盘|写入|保存)?[。！!]*$|^(?:按这个|采用这版|使用这版|就这版).{0,8}(?:落盘|写入|保存|执行)[。！!]*$/u;
const APPEND_COMMAND = /^(?:请)?(?:直接)?(?:续写|继续写|接着写|追加|补写)(?:当前|本|这|该)?(?:章节|章|文档|正文|内容|一段|下一段)?|(?:在|向).{0,12}(?:末尾|结尾|后面).{0,8}(?:续写|追加|补写)/u;
const PATCH_COMMAND = /^(?:请)?(?:直接)?(?:改写|替换|修改|润色|精修|优化|调整)(?:当前)?(?:选区|选中内容|这段|这句|这一段|本段|第\s*[零〇一二两三四五六七八九十百千万\d]+\s*(?:段|场|章|节))|^(?:请)?(?:把|将).{1,40}(?:改成|替换为|修改为|删掉|删除)/u;
const REPLACE_COMMAND = /^(?:请)?(?:直接)?(?:全文|整章|当前章节|本章|这章|当前文档|正文)?(?:重写|改写|替换|覆盖|润色|精修|优化)(?:全文|整章|当前章节|本章|这章|当前文档|正文)?|^(?:请)?(?:把|将).{0,24}(?:全文|整章|当前章节|本章|这章|当前文档|正文).{0,16}(?:完整)?(?:重写|改写|替换|覆盖)/u;
const RENAME_COMMAND = /^(?:请)?(?:把|将)?(?:当前)?(?:章节|文档|标题|名字).{0,18}(?:改名为|重命名为|标题改为|改成|命名为|起名为)|^(?:请)?(?:给|为)(?:当前)?(?:章节|文档|正文)?(?:起一个标题|取一个标题|命名为|起名为)|^(?:请)?(?:改名|重命名)(?:当前)?(?:章节|文档)?/u;
const CREATE_COMMAND = /^(?:请)?(?:直接)?(?:生成|创作|撰写|写|制作|输出|产出|新建|创建)(?:第\s*[零一二两三四五六七八九十百千万\d]+\s*(?:章|集)|一篇|一章|一集|新(?:章节|文档)|正文|章节|剧本|脚本|大纲|设定|文章|稿件|文稿|小说|故事|公众号(?:文章|推文|长文)?|微信推文|短篇小说|短视频剧本|提示词)|(?:按|照|根据).{0,30}(?:直接)?(?:生成|写出|创作|落盘)/u;
const EXPLICIT_NEW_DOCUMENT_COMMAND = /(?:新建|创建|另建|新开|新增).{0,16}(?:文档|章节|篇章|文章|稿件|文稿|小说|故事|剧本|脚本|大纲|设定|公众号(?:文章|推文|长文)?|微信推文|短篇小说|短视频剧本|提示词)|(?:生成|创作|撰写|写|制作|输出|产出).{0,10}(?:一个|一篇|一章|一集|一份)?\s*新(?:文档|章节|篇章|文章|稿件|文稿|小说|故事|剧本|脚本|大纲|设定|公众号(?:文章|推文|长文)?|微信推文|短篇小说|短视频剧本|提示词)/u;
const FORMAL_DELIVERABLE_CREATE = /(?:生成|创作|撰写|写|制作|输出|产出|新建|创建).{0,14}(?:正式|完整|全套)?(?:正文|设定|大纲|章纲|卷纲|剧本|脚本|章节|文档|文章|稿件|文稿|小说|故事|短剧|漫剧|影视剧本|公众号(?:文章|推文|长文)?|微信推文|短篇小说|短视频剧本|提示词)/u;
const CONTEXTUAL_FORMAL_MUTATION = /(?:自检|检查|诊断|审稿|分析).{0,28}(?:后|并|然后|同时|再|直接)\s*(?:直接)?(?:修改|修复|重写|改写|润色|优化|替换|返修|调整)(?!建议|意见|方案|思路|方法)(?:.{0,16}(?:当前)?(?:正文|章节|文章|稿件|文稿|剧本|文档))?/u;
// Explicit report landing remains supported for single-unit checks. Batch and
// complete reports are also formal by scope through reviewDeliveryPolicy.
const EXPLICIT_REPORT_WRITE = /(?:小说自检|剧本自检|自检报告|改编报告|小说改剧本编译报告|编译报告).{0,18}(?:保存|写入|落盘|归档|提交)|(?:保存|写入|落盘|归档|提交).{0,18}(?:小说自检|剧本自检|自检报告|改编报告|小说改剧本编译报告|编译报告)/u;
const EXPLICIT_COMMIT = /(?:直接|立即|现在)(?:修改|修复|改写|重写|润色|优化|调整|替换|续写|生成|写|落盘|写入|保存)|(?:按这个|采用这版|使用这版|就这版)(?:执行|生成|落盘|写入|保存)|(?:修改|修复|改写|重写|润色|优化|调整|替换|续写|生成|写)(?:当前|本|这|第|选区|正文|章节|文档)|(?:落盘|写入|保存)(?:到|进|至)?(?:当前|本|这)?(?:文档|正文|章节)|(?:保存|写入|落盘|覆盖)[^，。！？；;\n]{1,40}(?:到|进|至)(?:当前|目标|指定|这个|该|本)?(?:文档|正文|章节|文章)/u;
const TITLE_PROTECTION = /(?:不|不要|无需|不必|禁止|不得|别).{0,8}(?:修改|改动|替换|覆盖|重命名|动).{0,6}(?:标题|文档名|章节名)|(?:标题|文档名|章节名).{0,8}(?:保持不变|不要动|不变)/u;
const BODY_PROTECTION = /(?:不|不要|无需|不必|禁止|不得|别).{0,8}(?:修改|改动|替换|覆盖|写入|动).{0,6}(?:正文|原文|内容)|(?:正文|原文|内容).{0,8}(?:保持不变|不要动|不变)/u;
const NEGATED_WRITE_CLAUSE = /(?:不|不要|不用|无需|不必|禁止|不得|别|先别|暂不|不能|不可).{0,8}(?:修改|修复|改动|改写|重写|润色|优化|调整|替换|续写|覆盖|写入|落盘|保存).{0,12}(?:正文|原文|内容|文档|章节|文章|稿件)?/gu;
const NO_WRITE_DOCUMENT_DIRECTIVE = /(?:^|[，。！？；;\n\s])(?:不|不要|不用|无需|不必|禁止|不得|别|先别|暂不|不能|不可).{0,12}(?:修改|修复|改动|改写|重写|润色|优化|调整|替换|续写|覆盖|写入|落盘|保存).{0,18}(?:正文|原文|内容|文档|章节|文章|稿件|设定|正史|世界观|大纲|章纲|卷纲|资料)?/u;
const MUTATION_QUESTION_PATTERN = /(?:能否|能不能|是否|可不可以|可以吗|会不会|如何|怎么|为什么|为何).{0,120}(?:插入|插写|补写|增补|补充|增加|添加|加入|追加|写入)|(?:插入|插写|补写|增补|补充|增加|添加|加入|追加).{0,80}(?:吗|呢|如何|怎么|为什么|为何|[?？])/u;
const WRITE_CAPABILITY_QUESTION = /(?:能否|能不能|是否|可不可以|可以吗|会不会|如何|怎么|为什么|为何).{0,120}(?:保存|写入|落盘|覆盖)|(?:保存|写入|落盘|覆盖).{0,80}(?:吗|呢|如何|怎么|为什么|为何|[?？])/u;

const uniqueStrings = (values = []) => [...new Set((Array.isArray(values) ? values : [values])
  .map(clean)
  .filter(Boolean))].sort((left, right) => left.localeCompare(right));

const normalizedRevisions = (value = {}, documentIds = []) => {
  if (Array.isArray(value)) {
    return Object.fromEntries(uniqueStrings(documentIds).map((id, index) => [id, clean(value[index])]));
  }
  if (!value || typeof value !== "object") return {};
  const source = Object.fromEntries(Object.entries(value).map(([id, revision]) => [clean(id), clean(revision)]).filter(([id]) => id));
  return Object.fromEntries(uniqueStrings(documentIds.length ? documentIds : Object.keys(source)).map((id) => [id, source[id] ?? ""]));
};

const stableHash = (value = "") => {
  return sha256HexSync(clean(value));
};

const explicitCandidateRequest = (source = "") => (
  (CANDIDATE_REQUEST.test(source) && !NEGATED_CANDIDATE_REQUEST.test(source))
  || (GENERATE_WITHOUT_LANDING_REQUEST.test(source) && !NEGATED_GENERATION.test(source))
);

const negativeClauseProtectsNonTargetContent = (clause = "") => (
  /(?:其他|其它|其余|剩余|别的|无关|非当前)(?:正文|原文|内容|文档|章节|文章|稿件)/u.test(clause)
  || /(?:说明|解释|分析|检查过程|检查结果|协议字段|Markdown|自检报告|候选稿|草稿|初稿).{0,20}(?:写入|写进|放入|混入)(?:正文|文档|章节|文章|稿件)/iu.test(clause)
);

const noWriteTargetMatches = ({ source = "", targetDocumentIds = [] } = {}) => {
  const text = clean(source);
  const ids = uniqueStrings(targetDocumentIds);
  if (!text || !ids.length) return false;
  const negativeClauses = [...text.matchAll(new RegExp(NEGATED_WRITE_CLAUSE.source, "gu"))]
    .map((match) => clean(match[0]))
    .filter((clause) => !negativeClauseProtectsNonTargetContent(clause))
    .join(" ");
  if (!negativeClauses) return false;
  const mentionsSetting = /(?:设定|正史|世界观|人物设定|角色设定|资料库)/u.test(negativeClauses);
  const mentionsOutline = /(?:大纲|章纲|卷纲|集纲|规划)/u.test(negativeClauses);
  const mentionsNarrative = /(?:正文|原文|内容|文档|章节|文章|稿件|落盘|写入|保存)/u.test(negativeClauses);
  if (mentionsSetting) return ids.every((id) => /^(?:canon-|script-canon-)/u.test(id));
  if (mentionsOutline) return ids.every((id) => /^(?:outline-|script-outline-)/u.test(id));
  if (mentionsNarrative) return ids.every((id) => /^(?:chapter-\d+|script-episode-\d+|public-account-|short-fiction-)/u.test(id));
  return true;
};

const explicitNoWriteGeneration = ({ source = "", action = "", targetDocumentIds = [], formalReviewWrite = false } = {}) => {
  const text = clean(source);
  if (!text || formalReviewWrite || action === "rename") return false;
  const affirmative = text.replace(NEGATED_WRITE_CLAUSE, " ").trim();
  const generationIntent = FORMAL_DELIVERABLE_CREATE.test(affirmative)
    || CREATE_COMMAND.test(affirmative)
    || EXPLICIT_NEW_DOCUMENT_COMMAND.test(affirmative);
  if (!generationIntent) return false;
  if (GENERATE_WITHOUT_LANDING_REQUEST.test(text) && !EXPLICIT_COMMIT.test(affirmative)) return true;
  // Protecting a title/document name is a field-level constraint on an
  // otherwise explicit body write.  Strip that clause before checking for a
  // no-write directive; otherwise “正文直接落盘，不要修改标题” is mistaken
  // for “生成但不要写入”, which downgrades a valid commit to candidate_only.
  const contentDirectiveSource = text.replace(TITLE_PROTECTION, " ").trim();
  return NO_WRITE_DOCUMENT_DIRECTIVE.test(contentDirectiveSource)
    && noWriteTargetMatches({ source: contentDirectiveSource, targetDocumentIds });
};

export const formalWriteInstructionHash = (instruction = "") => stableHash(instruction);
export const formalWriteCandidateHash = (candidate = "") => stableHash(candidate);

const writeAction = ({ instruction = "", hasSelection = false, targetExists = true } = {}) => {
  const source = clean(instruction);
  if (RENAME_COMMAND.test(source)) return "rename";
  if (contextualInsertionRequested(source)) return "patch";
  if (hasSelection) return "patch";
  if (APPEND_COMMAND.test(source)) return "append";
  if (REPLACE_COMMAND.test(source)) return "replace";
  if (PATCH_COMMAND.test(source)) return "patch";
  if (CONTEXTUAL_FORMAL_MUTATION.test(source)) return "replace";
  if (!targetExists || EXPLICIT_NEW_DOCUMENT_COMMAND.test(source)) return "create";
  return "generate";
};

const noAuthorization = ({ instruction = "", sourceMessageId = "", targetDocumentIds = [], expectedRevisions = {}, reason = "not_explicitly_authorized" } = {}) => ({
  state: "none",
  action: "analyze",
  sourceMessageId: clean(sourceMessageId),
  sourceInstructionHash: formalWriteInstructionHash(instruction),
  targetDocumentIds: uniqueStrings(targetDocumentIds),
  expectedRevisions: normalizedRevisions(expectedRevisions, targetDocumentIds),
  allowBodyMutation: false,
  allowTitleMutation: false,
  reason,
});

export const createFormalWriteAuthorization = ({
  instruction = "",
  sourceMessageId = "",
  targetDocumentIds = [],
  expectedRevisions = {},
  targetExists = true,
  targetTitle = "",
  hasSelection = false,
  contextualWriteAction = "",
  candidate = "",
  candidateAuthorization = null,
  taskContract = null,
  confirmWhenLandingUncertain = false,
  semanticWritePlan = null,
  guidanceOnly = false,
} = {}) => {
  const source = clean(instruction);
  const titleProtected = TITLE_PROTECTION.test(source);
  const bodyProtected = BODY_PROTECTION.test(source);
  const actionableSource = source
    .replace(TITLE_PROTECTION, " ")
    .replace(BODY_PROTECTION, " ")
    .trim();
  const affirmativeSource = actionableSource.replace(NEGATED_WRITE_CLAUSE, " ").trim();
  const contractDecision = validateTaskContractForExecution(taskContract);
  const authoritativeContract = contractDecision.recognized && contractDecision.authoritative;
  const contractDeliverables = authoritativeContract && Array.isArray(taskContract?.deliverables)
    ? taskContract.deliverables.filter((item) => item?.required !== false && clean(item?.targetDocumentId || item?.targetDocument))
    : [];
  const contractIds = contractDeliverables.map((item) => clean(item.targetDocumentId || item.targetDocument));
  const ids = uniqueStrings(contractIds.length ? contractIds : targetDocumentIds);
  const revisions = normalizedRevisions(expectedRevisions, ids);
  const contextualAction = ["append", "patch", "replace", "rename", "create"].includes(clean(contextualWriteAction))
    ? clean(contextualWriteAction)
    : "";
  const readOnlyIntent = READ_ONLY_OR_NEGATED.test(actionableSource);
  const explicitMutationDirective = Boolean(contextualAction)
    || CONTEXTUAL_FORMAL_MUTATION.test(affirmativeSource)
    || (EXPLICIT_COMMIT.test(affirmativeSource) && !readOnlyIntent);
  const positiveGenerationDirective = CREATE_COMMAND.test(affirmativeSource)
    || FORMAL_DELIVERABLE_CREATE.test(affirmativeSource)
    || EXPLICIT_NEW_DOCUMENT_COMMAND.test(affirmativeSource);
  // A report request may explicitly protect the source chapters while still
  // authorizing the separate report target. Resolve that target before the
  // generic read-only guard so “不要改动正文，但保存自检报告” is not reduced
  // to a conversation-only request.
  const reviewContextDomain = ids.includes("report-adaptation")
    ? "script-adaptation"
    : ids.includes("report-script") || ids.some((id) => id.startsWith("script-")) ? "script" : "novel";
  const formalReview = reviewDeliveryPolicy({ text: actionableSource, contextDomain: reviewContextDomain });
  const formalReviewWrite = formalReview.reportRequested === true
    && Boolean(formalReview.target?.documentId)
    && ids.includes(formalReview.target.documentId);
  const base = { instruction: source, sourceMessageId, targetDocumentIds: ids, expectedRevisions: revisions };
  if (!sourceMessageId) return noAuthorization({ ...base, reason: "missing_source_message" });
  // A creative-guidance turn may mention future production (for example,
  // “我想写一个故事”) while explicitly forbidding正文/落盘.  The current
  // bound document is context only in that lane; do not manufacture a
  // candidate authorization from the production verb.  Explicit candidate
  // requests remain eligible for candidate_only below.
  if (guidanceOnly && !formalReviewWrite && !explicitCandidateRequest(source)) {
    return noAuthorization({ ...base, reason: "creative_guidance_no_artifact" });
  }
  const semanticIntent = ["none", "candidate", "commit"].includes(clean(semanticWritePlan?.intent))
    ? clean(semanticWritePlan.intent)
    : "";
  if (semanticIntent) {
    if (semanticIntent === "none") return noAuthorization({ ...base, reason: "agent_semantic_no_write" });
    if (!ids.length) return noAuthorization({ ...base, reason: "agent_semantic_target_unresolved" });
    const semanticAction = ["append", "patch", "replace", "rename", "create"].includes(clean(semanticWritePlan?.operation))
      ? clean(semanticWritePlan.operation)
      : targetExists === false ? "create" : "replace";
    if (semanticIntent === "commit" && explicitNoWriteGeneration({
      source,
      action: semanticAction,
      targetDocumentIds: ids,
      formalReviewWrite,
    })) {
      return {
        state: "candidate_only",
        action: semanticAction,
        sourceMessageId: clean(sourceMessageId),
        sourceInstructionHash: formalWriteInstructionHash(source),
        targetDocumentIds: ids,
        expectedRevisions: revisions,
        allowBodyMutation: false,
        allowTitleMutation: false,
        reason: "explicit_no_write_overrides_agent_commit",
      };
    }
    const state = semanticIntent === "candidate" ? "candidate_only" : "commit";
    return {
      state,
      action: semanticAction,
      sourceMessageId: clean(sourceMessageId),
      sourceInstructionHash: formalWriteInstructionHash(source),
      targetDocumentIds: ids,
      expectedRevisions: revisions,
      allowBodyMutation: state === "commit" && semanticAction !== "rename",
      allowTitleMutation: state === "commit" && ["rename", "create"].includes(semanticAction),
      reason: `agent_semantic_${semanticIntent}`,
    };
  }
  if (!authoritativeContract && contextualInsertionRequested(actionableSource) && MUTATION_QUESTION_PATTERN.test(actionableSource)
    && !/(?:直接执行|立即执行|现在执行|确认写入|直接写入|立即写入|现在写入|直接落盘|立即落盘|现在落盘)/u.test(actionableSource)) {
    return noAuthorization({ ...base, reason: "contextual_insertion_question" });
  }
  if (!authoritativeContract && WRITE_CAPABILITY_QUESTION.test(actionableSource)
    && !/(?:直接执行|立即执行|现在执行|确认保存|确认写入|确认落盘|直接保存|直接写入|直接落盘)/u.test(actionableSource)) {
    return noAuthorization({ ...base, reason: "write_capability_question" });
  }

  if (ADOPT_CANDIDATE.test(source)) {
    const proof = validateFormalWriteAuthorization(candidateAuthorization, {
      requiredState: "candidate_only",
      candidate,
      targetDocumentIds: ids,
      expectedRevisions: revisions,
    });
    if (!proof.valid) return noAuthorization({ ...base, reason: `candidate_adoption_${proof.reason}` });
    const action = candidateAuthorization.action === "analyze" ? "replace" : candidateAuthorization.action;
    return {
      state: "commit",
      action,
      sourceMessageId: clean(sourceMessageId),
      sourceInstructionHash: formalWriteInstructionHash(source),
      candidateHash: formalWriteCandidateHash(candidate),
      targetDocumentIds: ids,
      expectedRevisions: revisions,
      allowBodyMutation: action !== "rename",
      allowTitleMutation: candidateAuthorization.allowTitleMutation === true
        || action === "rename"
        || action === "create"
        || Boolean(clean(targetTitle) && /未命名/u.test(clean(targetTitle))),
      reason: "explicit_candidate_adoption",
    };
  }

  const inferredAction = writeAction({ instruction: actionableSource, hasSelection, targetExists });
  if (explicitNoWriteGeneration({
    source,
    action: inferredAction,
    targetDocumentIds: ids,
    formalReviewWrite,
  })) {
    return {
      state: "candidate_only",
      action: inferredAction,
      sourceMessageId: clean(sourceMessageId),
      sourceInstructionHash: formalWriteInstructionHash(source),
      targetDocumentIds: ids,
      expectedRevisions: revisions,
      allowBodyMutation: false,
      allowTitleMutation: false,
      reason: "explicit_no_write_generation",
    };
  }

  if (authoritativeContract) {
    if (!contractDecision.valid) {
      return noAuthorization({ ...base, reason: `invalid_task_contract:${contractDecision.issues.join(",")}` });
    }
    if (contractDecision.persistence === "none") {
      return noAuthorization({ ...base, reason: "task_contract_conversation_only" });
    }
    const action = taskContractWriteAction(taskContract);
    if (contractDecision.persistence === "candidate_only") {
      return {
        state: "candidate_only",
        action,
        sourceMessageId: clean(sourceMessageId),
        sourceInstructionHash: formalWriteInstructionHash(source),
        targetDocumentIds: ids,
        expectedRevisions: revisions,
        allowBodyMutation: false,
        allowTitleMutation: false,
        reason: "task_contract_candidate_only",
        contractId: clean(taskContract?.contractId),
        contractRevision: Math.max(1, Number(taskContract?.revision) || 1),
      };
    }
    return {
      state: "commit",
      action,
      sourceMessageId: clean(sourceMessageId),
      sourceInstructionHash: formalWriteInstructionHash(source),
      targetDocumentIds: ids,
      expectedRevisions: revisions,
      allowBodyMutation: action !== "rename",
      allowTitleMutation: action === "rename" || action === "create"
        || contractDeliverables.some((item) => clean(item.title)),
      reason: "task_contract_formal_delivery",
      contractId: clean(taskContract?.contractId),
      contractRevision: Math.max(1, Number(taskContract?.revision) || 1),
    };
  }

  if (!contractDeliverables.length && readOnlyIntent
    && !formalReviewWrite
    && !explicitMutationDirective && !positiveGenerationDirective && !explicitCandidateRequest(source)) {
    return noAuthorization({ ...base, reason: "read_only_or_negated_intent" });
  }

  if (explicitCandidateRequest(source)) {
    return {
      state: "candidate_only",
      action: writeAction({ instruction: source, hasSelection, targetExists }),
      sourceMessageId: clean(sourceMessageId),
      sourceInstructionHash: formalWriteInstructionHash(source),
      targetDocumentIds: ids,
      expectedRevisions: revisions,
      allowBodyMutation: false,
      allowTitleMutation: false,
      reason: "candidate_requested_without_commit",
    };
  }

  if (contractDeliverables.length) {
    const action = contextualAction || writeAction({ instruction: actionableSource, hasSelection, targetExists });
    return {
      state: "commit",
      action,
      sourceMessageId: clean(sourceMessageId),
      sourceInstructionHash: formalWriteInstructionHash(source),
      targetDocumentIds: ids,
      expectedRevisions: revisions,
      allowBodyMutation: action !== "rename",
      allowTitleMutation: !titleProtected && (action === "rename" || action === "create" || contractDeliverables.some((item) => clean(item.title))),
      reason: "task_contract_formal_delivery",
      contractId: clean(taskContract?.contractId),
      contractRevision: Math.max(1, Number(taskContract?.revision) || 1),
    };
  }

  const explicitWriteIntent = Boolean(contextualAction)
    || contextualInsertionRequested(actionableSource)
    || EXPLICIT_COMMIT.test(affirmativeSource)
    || APPEND_COMMAND.test(actionableSource)
    || PATCH_COMMAND.test(actionableSource)
    || REPLACE_COMMAND.test(actionableSource)
    || RENAME_COMMAND.test(actionableSource)
    || CREATE_COMMAND.test(actionableSource)
    || CONTEXTUAL_FORMAL_MUTATION.test(affirmativeSource)
    || EXPLICIT_REPORT_WRITE.test(actionableSource)
    || formalReviewWrite
    || FORMAL_DELIVERABLE_CREATE.test(actionableSource);
  if (!explicitWriteIntent && (READ_ONLY_OR_NEGATED.test(actionableSource) || /^(?:给|提供|说说)?(?:我)?(?:建议|意见|方案)[。！!？?]*$/u.test(actionableSource))) {
    return noAuthorization({ ...base, reason: "read_only_or_negated_intent" });
  }
  const action = contextualAction || writeAction({ instruction: actionableSource, hasSelection, targetExists });
  if (!contextualAction && !contextualInsertionRequested(actionableSource) && !EXPLICIT_COMMIT.test(affirmativeSource) && !APPEND_COMMAND.test(actionableSource) && !PATCH_COMMAND.test(actionableSource)
    && !REPLACE_COMMAND.test(actionableSource) && !RENAME_COMMAND.test(actionableSource) && !CREATE_COMMAND.test(actionableSource)
    && !FORMAL_DELIVERABLE_CREATE.test(actionableSource) && !CONTEXTUAL_FORMAL_MUTATION.test(affirmativeSource)
    && !EXPLICIT_REPORT_WRITE.test(actionableSource) && !formalReviewWrite) {
    if (confirmWhenLandingUncertain) {
      return {
        state: "candidate_only",
        action,
        sourceMessageId: clean(sourceMessageId),
        sourceInstructionHash: formalWriteInstructionHash(source),
        targetDocumentIds: ids,
        expectedRevisions: revisions,
        allowBodyMutation: false,
        allowTitleMutation: false,
        reason: "landing_intent_uncertain",
      };
    }
    return noAuthorization({ ...base, reason: "ambiguous_or_discussion_intent" });
  }
  return {
    state: "commit",
    action,
    sourceMessageId: clean(sourceMessageId),
    sourceInstructionHash: formalWriteInstructionHash(source),
    targetDocumentIds: ids,
    expectedRevisions: revisions,
    allowBodyMutation: action !== "rename" && (!bodyProtected || formalReviewWrite),
    allowTitleMutation: !titleProtected && (action === "rename" || action === "create" || Boolean(clean(targetTitle) && /未命名/u.test(clean(targetTitle)))),
    reason: formalReviewWrite
      ? "formal_review_report_delivery"
      : contextualAction ? "contextual_explicit_formal_write_command" : "explicit_formal_write_command",
  };
};

export const bindFormalWriteCandidate = (authorization = null, {
  candidate = "",
  targetDocumentIds = null,
  expectedRevisions = null,
} = {}) => {
  if (!authorization || authorization.state === "none" || !clean(candidate)) return authorization;
  const ids = uniqueStrings(targetDocumentIds ?? authorization.targetDocumentIds);
  const revisions = normalizedRevisions(expectedRevisions ?? authorization.expectedRevisions, ids);
  const targetCheck = validateFormalWriteAuthorization(authorization, { targetDocumentIds: ids, expectedRevisions: revisions });
  if (!targetCheck.valid) return noAuthorization({
    instruction: "",
    sourceMessageId: authorization.sourceMessageId,
    targetDocumentIds: ids,
    expectedRevisions: revisions,
    reason: targetCheck.reason,
  });
  return { ...authorization, candidateHash: formalWriteCandidateHash(candidate), targetDocumentIds: ids, expectedRevisions: revisions };
};

export const rebaseFormalWriteAuthorization = (authorization = null, {
  expectedRevisions = {},
  reason = "latest_document_reloaded",
} = {}) => {
  if (!authorization || !["candidate_only", "commit"].includes(authorization.state)) return authorization;
  const ids = uniqueStrings(authorization.targetDocumentIds);
  const revisions = normalizedRevisions(expectedRevisions, ids);
  return {
    ...authorization,
    expectedRevisions: revisions,
    reason: clean(reason) || authorization.reason,
    ...(authorization.candidateHash ? { candidateHash: undefined } : {}),
  };
};

export const validateFormalWriteAuthorization = (authorization = null, {
  requiredState = "",
  sourceMessageId = "",
  instruction = "",
  candidate = "",
  targetDocumentIds = null,
  expectedRevisions = null,
  requireBodyMutation = false,
  requireTitleMutation = false,
} = {}) => {
  if (!authorization || typeof authorization !== "object") return { valid: false, reason: "missing_authorization" };
  if (!new Set(["none", "candidate_only", "commit"]).has(authorization.state)) return { valid: false, reason: "invalid_state" };
  if (authorization.state === "none") return { valid: false, reason: "authorization_denied" };
  if (requiredState && authorization.state !== requiredState) return { valid: false, reason: "state_mismatch" };
  if (!clean(authorization.sourceMessageId)) return { valid: false, reason: "missing_source_message" };
  if (sourceMessageId && clean(sourceMessageId) !== clean(authorization.sourceMessageId)) return { valid: false, reason: "source_message_mismatch" };
  if (instruction && formalWriteInstructionHash(instruction) !== authorization.sourceInstructionHash) return { valid: false, reason: "instruction_hash_mismatch" };
  const expectedIds = uniqueStrings(targetDocumentIds ?? authorization.targetDocumentIds);
  if (JSON.stringify(expectedIds) !== JSON.stringify(uniqueStrings(authorization.targetDocumentIds))) return { valid: false, reason: "target_mismatch" };
  const expectedRevisionMap = normalizedRevisions(expectedRevisions ?? authorization.expectedRevisions, expectedIds);
  if (JSON.stringify(expectedRevisionMap) !== JSON.stringify(normalizedRevisions(authorization.expectedRevisions, expectedIds))) return { valid: false, reason: "revision_mismatch" };
  if (candidate) {
    if (!authorization.candidateHash) return { valid: false, reason: "missing_candidate_hash" };
    if (formalWriteCandidateHash(candidate) !== authorization.candidateHash) return { valid: false, reason: "candidate_hash_mismatch" };
  }
  if (requireBodyMutation && authorization.allowBodyMutation !== true) return { valid: false, reason: "body_mutation_not_authorized" };
  if (requireTitleMutation && authorization.allowTitleMutation !== true) return { valid: false, reason: "title_mutation_not_authorized" };
  return { valid: true, reason: "authorized" };
};
