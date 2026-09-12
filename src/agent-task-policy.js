import { compileCanonTaskPolicy } from "./canon-task-policy.js";
import { validateTaskContractForExecution } from "./task-contract.js";

const sourceText = (value = "") => String(value ?? "").trim();

const MULTIPLE_CANDIDATE_PATTERN = /(?:多个|多篇|多版|几版|若干|两(?:个|篇|版|份)|三(?:个|篇|版|份)|四(?:个|篇|版|份)|五(?:个|篇|版|份)|[2-9]\s*(?:个|篇|版|份))\s*(?:不同)?(?:候选(?:稿)?|版本|方案|写法|正文)|(?:候选(?:稿)?|版本|方案|写法|正文)\s*(?:对比|比较|多选|备选|各写|分别写)|(?:写|生成|给|提供|输出|创作)[^，。；！？\n]{0,8}(?<!第)(?:两|三|四|五|[2-9])\s*版/u;
const EXPLICIT_DEFER_PATTERN = /(?:不要|不必|不用|先别|暂时(?:不要|不必|不用|先别)?|暂不|仅|只)(?:立即|现在|直接|自动)?(?:写入|落盘|保存|同步|提交|修改文档|覆盖)|(?:不要|先别|暂时不要|暂不)(?:写进|存进|同步到|提交到)(?:文档|正文|设定|大纲)?|(?:保留|作为)(?:候选|草稿)(?:即可|就行)?/u;
const MEDIA_ROUTE_MODES = new Set(["image", "video", "audio", "media"]);

const withoutNegatedCandidateRequests = (instruction = "") => sourceText(instruction).replace(
  /(?:不|不要|无需|不必|禁止|别|不可|不再)\s*(?:再|重新)?\s*(?:生成|提供|输出|创作|写|保留|展示)?\s*(?:多个|多篇|多版|几版|若干|两(?:个|篇|版|份)|三(?:个|篇|版|份)|四(?:个|篇|版|份)|五(?:个|篇|版|份)|[2-9]\s*(?:个|篇|版|份))\s*(?:不同)?\s*(?:候选(?:稿)?|版本|方案|写法|正文)/gu,
  " ",
);

const withoutOtherTargetProtection = (instruction = "") => sourceText(instruction).replace(
  /(?:不|不要|无需|不必|禁止|别|不可|不得)\s*(?:再)?\s*(?:覆盖|替换|修改|写入|改动)\s*(?:任何)?\s*(?:其他|其它|其余|非目标)(?:的)?(?:章节|文档|文件|正文|内容)/gu,
  " ",
);

export const requestsMultipleCandidates = (instruction = "") => (
  MULTIPLE_CANDIDATE_PATTERN.test(withoutNegatedCandidateRequests(instruction))
);

export const explicitlyDefersManagedCommit = (instruction = "") => (
  EXPLICIT_DEFER_PATTERN.test(withoutOtherTargetProtection(instruction))
);

const taskAction = ({ route, writeAuthorization = null, taskContract = null }) => {
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
  if (route?.reviewDelivery?.landingEligible === true
    && route?.reviewDelivery?.target?.documentId) return "generate";
  // A guidance turn may discuss a future novel/script and therefore contain
  // words such as “创作” or “写作”, but its current deliverable is a question
  // or decision prompt, not a formal asset. A later explicit production turn
  // is routed as `creative` and regains normal transaction authority.
  if (mode === "creative_guidance") return "analyze";
  // Questions about what was read, which Skill ran, or whether automatic
  // landing is possible are explanations, even when they mention production
  // verbs such as “续写/写入/覆盖”. They must never become document writes.
  if (writeAuthorization?.state === "commit") {
    return ["patch", "replace", "rename"].includes(writeAuthorization.action) ? "modify" : "generate";
  }
  if (writeAuthorization?.state === "candidate_only") {
    return ["patch", "replace", "rename"].includes(writeAuthorization.action) ? "modify" : "generate";
  }
  if (writeAuthorization?.state === "none") {
    return route.diagnosisIntent ? "analyze" : "discuss";
  }
  if (mode === "quick_revision" || route?.revisionIntent === true) return "modify";
  if (route.diagnosisIntent) return "analyze";
  if (["creative", "visual_prompt"].includes(mode)) return "generate";
  return "discuss";
};

const commitOwnerFor = ({ action, target }) => {
  if (!["generate", "modify", "operate", "media"].includes(action)) return "none";
  if (action === "operate" || target?.managed === false || target?.workspaceFile === true) return "workspace_agent";
  if (action === "media" && !target?.documentId) return "none";
  return "shensi_transaction";
};

const commitDispositionFor = ({ action, canonMode, target, candidateCount, writeAuthorization = null, taskContract = null }) => {
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
  if (writeAuthorization?.state !== "commit") return "no_artifact";
  if (Number(candidateCount) > 1) return "defer_multiple";
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
  semanticAuthority = route?.semanticAuthority === true,
  semanticExecutionPlan = null,
} = {}) => {
  const normalizedText = "";
  const action = taskAction({ text: normalizedText, route, writeAuthorization, taskContract });
  const canonPolicy = compileCanonTaskPolicy({ text: normalizedText, action, route });
  const canonMode = semanticAuthority && ["advisory", "strict", "rewrite_canon", "alternate"].includes(semanticExecutionPlan?.canonMode)
    ? semanticExecutionPlan.canonMode
    : canonPolicy.canonMode;
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
  const reviewTier = semanticAuthority && ["none", "basic", "full"].includes(semanticExecutionPlan?.reviewTier)
    ? semanticExecutionPlan.reviewTier
    : canonPolicy.reviewTier;

  return {
    action,
    reasoningOwner: "agent",
    commitOwner,
    canonMode,
    commitDisposition,
    reviewTier,
  };
};
