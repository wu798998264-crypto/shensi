import { compileCanonTaskPolicy } from "./canon-task-policy.js";
import { reviewIncludesContentMutation } from "./review-delivery-policy.js";
import { shouldSuppressAutomaticFormalLanding } from "./formal-write-confirmation.js";
import { validateTaskContractForExecution } from "./task-contract.js";

const sourceText = (value = "") => String(value ?? "").trim();

const MULTIPLE_CANDIDATE_PATTERN = /(?:多个|多篇|多版|几版|若干|两(?:个|篇|版|份)|三(?:个|篇|版|份)|四(?:个|篇|版|份)|五(?:个|篇|版|份)|[2-9]\s*(?:个|篇|版|份))\s*(?:不同)?(?:候选(?:稿)?|版本|方案|写法|正文)|(?:候选(?:稿)?|版本|方案|写法|正文)\s*(?:对比|比较|多选|备选|各写|分别写)|(?:写|生成|给|提供|输出|创作)[^，。；！？\n]{0,8}(?<!第)(?:两|三|四|五|[2-9])\s*版/u;
const EXPLICIT_DEFER_PATTERN = /(?:不要|不必|不用|先别|暂时(?:不要|不必|不用|先别)?|暂不|仅|只)(?:立即|现在|直接|自动)?(?:写入|落盘|保存|同步|提交|修改文档|覆盖)|(?:不要|先别|暂时不要|暂不)(?:写进|存进|同步到|提交到)(?:文档|正文|设定|大纲)?|(?:保留|作为)(?:候选|草稿)(?:即可|就行)?/u;
const ANALYZE_PATTERN = /分析|评价|评估|诊断|检查|为什么|怎么样|好不好|问题|原因|比较|对比|解释/u;
const MODIFY_PATTERN = /修改|改写|重写|替换|润色|精修|优化|调整|修订|删掉|删除|补写|扩写|缩写|写入正典|替换旧/u;
const CONTEXTUAL_PATCH_PATTERN = /(?:这里|这段|这句|这一段|本段|这一场|这场|当前段落|当前场景|当前章节|本章).{0,18}(?:太慢|太快|拖沓|啰嗦|不自然|不顺|不够|有点|需要|节奏|语气|名字|称呼|错了|问题)|(?:节奏|对白|措辞|名字|称呼|语气|衔接|逻辑).{0,14}(?:太慢|太快|拖沓|啰嗦|不自然|不顺|不够|有点|需要|改|换|调整|压缩|加强)/u;
const READ_ONLY_CREATIVE_DISCUSSION_PATTERN = /(?:帮我|请)?(?:看看|看一下|分析|评价|评估|讨论|解释|梳理).{0,20}(?:设定|人物|剧情|大纲|文档|章节|正文|剧本)|(?:这个|当前|本章|这章|这段).{0,14}(?:设定|人物|剧情|结构).{0,10}(?:怎么样|如何|合理吗|有没有问题)/u;
const READ_ONLY_CAPABILITY_QUERY_PATTERN = /(?:(?:本次|这次|此次|当前|刚才)[^，。！？；;\n]{0,18}(?:实际)?(?:读取|参考|使用|调用|写入|落盘|覆盖)(?:了|过|的是|到)?\s*(?:什么|哪些|哪里|哪(?:个|些)?))|(?:(?:能否|是否|可不可以|会不会|有没有|为什么|为何|怎么|如何|什么原因)[^，。！？；;\n]{0,36}(?:读取|参考|调用|使用|写入|落盘|覆盖|修改文档|自动保存))|(?:(?:读取|参考|调用|使用|写入|落盘|覆盖|自动保存)[^，。！？；;\n]{0,28}(?:吗|呢|[?？]|为什么|怎么|如何|哪里|哪些|什么))/iu;
const GENERATE_PATTERN = /写|创作|生成|制作|输出|续写|拟定|整理(?:成|为)|设计/u;
const MEDIA_ROUTE_MODES = new Set(["image", "video", "audio", "media"]);

const withoutNegatedCandidateRequests = (instruction = "") => sourceText(instruction).replace(
  /(?:不|不要|无需|不必|禁止|别|不可|不再)\s*(?:再|重新)?\s*(?:生成|提供|输出|创作|写|保留|展示)?\s*(?:多个|多篇|多版|几版|若干|两(?:个|篇|版|份)|三(?:个|篇|版|份)|四(?:个|篇|版|份)|五(?:个|篇|版|份)|[2-9]\s*(?:个|篇|版|份))\s*(?:不同)?\s*(?:候选(?:稿)?|版本|方案|写法|正文)/gu,
  " ",
);

const withoutOtherTargetProtection = (instruction = "") => sourceText(instruction).replace(
  /(?:不|不要|无需|不必|禁止|别|不可|不得)\s*(?:再)?\s*(?:覆盖|替换|修改|写入|改动)\s*(?:任何)?\s*(?:其他|其它|其余|非目标)(?:的)?(?:章节|文档|文件|正文|内容)/gu,
  " ",
);

const withoutQuotedTitles = (instruction = "") => sourceText(instruction).replace(/《[^》\n]{1,160}》/gu, "《标题》");

export const requestsMultipleCandidates = (instruction = "") => (
  MULTIPLE_CANDIDATE_PATTERN.test(withoutNegatedCandidateRequests(instruction))
);

export const explicitlyDefersManagedCommit = (instruction = "") => (
  EXPLICIT_DEFER_PATTERN.test(withoutOtherTargetProtection(instruction))
);

const taskAction = ({ text, route, writeAuthorization = null, taskContract = null }) => {
  const mode = String(route?.mode ?? "");
  if (mode === "operation" || mode === "workspace_operation") return "operate";
  if (MEDIA_ROUTE_MODES.has(mode)) return "media";
  const contractDecision = validateTaskContractForExecution(taskContract);
  if (contractDecision.authoritative) {
    if (!contractDecision.valid) return "discuss";
    if (["commit", "candidate_only"].includes(writeAuthorization?.state)) {
      return taskContract?.taskType === "modification"
        || ["patch", "replace", "rename"].includes(writeAuthorization.action)
        ? "modify"
        : "generate";
    }
    if (["diagnosis", "testing"].includes(taskContract?.taskType)) return "analyze";
    if (["writing", "planning"].includes(taskContract?.taskType)) return "generate";
    if (taskContract?.taskType === "modification") return "modify";
    return "discuss";
  }
  // An explicit self-check is also an instruction to create/update its formal
  // report. Meta questions are excluded earlier by reviewDeliveryPolicy, so
  // this does not turn a mention of “自检” into a write.
  if (route?.reviewDelivery?.landingEligible === true
    && route?.reviewDelivery?.target?.documentId
    && !reviewIncludesContentMutation(text)) return "generate";
  // A guidance turn may discuss a future novel/script and therefore contain
  // words such as “创作” or “写作”, but its current deliverable is a question
  // or decision prompt, not a formal asset. A later explicit production turn
  // is routed as `creative` and regains normal transaction authority.
  if (mode === "creative_guidance") return "analyze";
  // Questions about what was read, which Skill ran, or whether automatic
  // landing is possible are explanations, even when they mention production
  // verbs such as “续写/写入/覆盖”. They must never become document writes.
  if (READ_ONLY_CAPABILITY_QUERY_PATTERN.test(withoutQuotedTitles(text))) return "analyze";
  if (writeAuthorization?.state === "commit") {
    return ["patch", "replace", "rename"].includes(writeAuthorization.action) ? "modify" : "generate";
  }
  if (writeAuthorization?.state === "candidate_only") {
    return ["patch", "replace", "rename"].includes(writeAuthorization.action) ? "modify" : "generate";
  }
  if (writeAuthorization?.state === "none") {
    return writeAuthorization.reason === "read_only_or_negated_intent"
      || READ_ONLY_CREATIVE_DISCUSSION_PATTERN.test(text)
      || ANALYZE_PATTERN.test(text)
      ? "analyze"
      : "discuss";
  }
  if (mode === "quick_revision" || route?.revisionIntent === true || MODIFY_PATTERN.test(text) || CONTEXTUAL_PATCH_PATTERN.test(text)) return "modify";
  if (READ_ONLY_CREATIVE_DISCUSSION_PATTERN.test(text) && !MODIFY_PATTERN.test(text) && !GENERATE_PATTERN.test(text)) return "analyze";
  if (ANALYZE_PATTERN.test(text) && !GENERATE_PATTERN.test(text)) return "analyze";
  if (["creative", "visual_prompt"].includes(mode) || GENERATE_PATTERN.test(text)) return "generate";
  return "discuss";
};

const commitOwnerFor = ({ action, target }) => {
  if (!["generate", "modify", "operate", "media"].includes(action)) return "none";
  if (action === "operate" || target?.managed === false || target?.workspaceFile === true) return "workspace_agent";
  if (action === "media" && !target?.documentId) return "none";
  return "shensi_transaction";
};

const commitDispositionFor = ({ text, action, canonMode, target, candidateCount, writeAuthorization = null, route = null, taskContract = null }) => {
  if (!["generate", "modify"].includes(action)) return "no_artifact";
  if (writeAuthorization?.state === "none") return "no_artifact";
  const contractDecision = validateTaskContractForExecution(taskContract);
  if (contractDecision.authoritative) {
    if (!contractDecision.valid || contractDecision.persistence === "none") return "no_artifact";
    if (contractDecision.persistence === "candidate_only") return "candidate_only";
    if (target?.ambiguous === true || contractDecision.targetResolution !== "exact") return "defer_ambiguous";
    return "auto_commit";
  }
  if (writeAuthorization?.state === "candidate_only") return "candidate_only";
  if (canonMode === "alternate") return "defer_explicit";
  if (explicitlyDefersManagedCommit(text)) return "defer_explicit";
  if (writeAuthorization?.state !== "commit" && route?.formalArtifactExpected !== true && shouldSuppressAutomaticFormalLanding({
    instruction: text,
    target: route?.reviewDelivery?.target || target,
    contentType: route?.reviewDelivery?.kind || "",
  })) return "no_artifact";
  if (Number(candidateCount) > 1 || requestsMultipleCandidates(text)) return "defer_multiple";
  if (target?.ambiguous === true) return "defer_ambiguous";
  return "auto_commit";
};

export const compileAgentTaskPolicy = ({
  text = "",
  route = {},
  target = null,
  candidateCount = 1,
  writeAuthorization = route?.writeAuthorization ?? null,
  taskContract = route?.taskContract ?? null,
} = {}) => {
  const normalizedText = sourceText(text);
  const action = taskAction({ text: normalizedText, route, writeAuthorization, taskContract });
  const canonPolicy = compileCanonTaskPolicy({ text: normalizedText, action, route });
  const canonMode = canonPolicy.canonMode;
  const commitOwner = commitOwnerFor({ action, target });
  const commitDisposition = commitDispositionFor({
    text: normalizedText,
    action,
    canonMode,
    target,
    candidateCount,
    writeAuthorization,
    route,
    taskContract,
  });
  const reviewTier = canonPolicy.reviewTier;

  return {
    action,
    reasoningOwner: "agent",
    commitOwner,
    canonMode,
    commitDisposition,
    reviewTier,
  };
};
