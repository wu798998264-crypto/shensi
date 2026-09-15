import { hasFormalAssetWriteIntent } from "./artifact-ontology.js";
import { requestedChapterBatch, requestedChapterTarget } from "./chapter-target.js";
import { formalDocumentContentPolicy } from "./formal-content-policy.js";
import { reviewDeliveryPolicy } from "./review-delivery-policy.js";
import { validateTaskContractForExecution } from "./task-contract.js";

const text = (value = "") => String(value ?? "").trim();
const unique = (values) => [...new Set(values.filter(Boolean))];

export const AUTOMATIC_RUNTIME_DOCUMENT_IDS = Object.freeze([
  "memory-reader",
  "memory-foreshadowing",
  "memory-release",
  "memory-first-appearance",
  "memory-snapshot",
  "script-memory-audience",
  "script-memory-foreshadowing",
  "script-memory-release",
  "script-memory-first-appearance",
  "script-memory-snapshot",
  "report-compile",
  "index-update-log",
  "index-pending",
]);

const formalFactModule = (moduleId = "") => ["canon", "outline"].includes(text(moduleId));
const selfCheckReport = (documentId = "") => ["report-novel", "report-script", "report-adaptation"].includes(text(documentId));

export const authorizeFormalMutation = ({ instruction = "", plan = null, targets = [], taskContract = null } = {}) => {
  const source = text(instruction);
  const plannedIds = new Set((plan?.primaryTargets ?? []).map((target) => text(target?.documentId)).filter(Boolean));
  const normalizedTargets = (Array.isArray(targets) ? targets : []).map((target) => ({
    documentId: text(target?.documentId || target?.id),
    moduleId: text(target?.moduleId),
  })).filter((target) => target.documentId);
  const reviewContextDomain = normalizedTargets.some((target) => target.documentId === "report-adaptation")
    || /小说改(?:编|成)剧本|改编剧本|改编报告|小说改剧本编译报告|适配剧本/u.test(source)
    ? "script-adaptation"
    : normalizedTargets.some((target) => target.documentId.startsWith("script-")) ? "script" : "novel";
  const review = reviewDeliveryPolicy({ text: source, contextDomain: reviewContextDomain });
  const contractDecision = validateTaskContractForExecution(taskContract);
  const contractAuthorizesTarget = (target) => {
    if (!contractDecision.authoritative || !contractDecision.valid || contractDecision.persistence !== "commit") return false;
    return contractDecision.deliverables.some((deliverable) => {
      const deliverableId = text(deliverable?.targetDocumentId || deliverable?.targetDocument || deliverable?.target?.documentId);
      const deliverableModule = text(deliverable?.target?.moduleId || deliverable?.moduleId).toLowerCase();
      return deliverableId === target.documentId
        && deliverableModule === text(target.moduleId).toLowerCase();
    });
  };
  const requestedManuscriptIds = new Set();
  const chapterBatch = requestedChapterBatch(source, { baseChapterNumber: 0 });
  if (chapterBatch) {
    for (let chapter = chapterBatch.startChapter; chapter <= chapterBatch.endChapter; chapter += 1) {
      requestedManuscriptIds.add(`chapter-${chapter}`);
    }
  }
  const singleChapter = requestedChapterTarget(source);
  if (singleChapter?.documentId) requestedManuscriptIds.add(singleChapter.documentId);
  const rejected = [];

  for (const target of normalizedTargets) {
    const contentPolicy = formalDocumentContentPolicy({ documentId: target.documentId, moduleId: target.moduleId });
    if (!contentPolicy.formal) {
      rejected.push({ ...target, reason: "目标不属于当前作品的正式内容文档" });
      continue;
    }
    if (["memory_projection", "runtime_projection", "read_only"].includes(contentPolicy.mode)) {
      rejected.push({ ...target, reason: "该文档由专用写入规则维护，不能接收普通对话正文" });
      continue;
    }
    if (selfCheckReport(target.documentId) && (contractDecision.authoritative
      ? contractAuthorizesTarget(target) && taskContract?.taskType === "diagnosis"
      : review.active && review.reportRequested === true && review.target?.documentId === target.documentId)) continue;
    if (contentPolicy.mode === "review_report") {
      rejected.push({ ...target, reason: "自检报告只能由对应的完整自检任务写入" });
      continue;
    }
    if (contentPolicy.mode === "creative_contract") {
      if (/(?:创作合同|项目禁用词|禁用表达|特别注意事项).{0,24}(?:写入|更新|修改|补充|增加|新增|覆盖|替换|追加)|(?:写入|更新|修改|补充|增加|新增|覆盖|替换|追加).{0,24}(?:创作合同|项目禁用词|禁用表达|特别注意事项)/u.test(source)) continue;
      rejected.push({ ...target, reason: "创作合同只能由明确的作者规则修改指令更新" });
      continue;
    }
    if (formalFactModule(target.moduleId) && contractAuthorizesTarget(target)) continue;
    if (plannedIds.has(target.documentId)
      && (!formalFactModule(target.moduleId) || !contractDecision.authoritative || contractAuthorizesTarget(target))) continue;
    if (target.moduleId === "manuscript" && requestedManuscriptIds.has(target.documentId)) continue;
    if (formalFactModule(target.moduleId) && !contractAuthorizesTarget(target)) {
      rejected.push({ ...target, reason: "设定和大纲必须由用户明确指定目标并下达写入指令" });
      continue;
    }
    rejected.push({ ...target, reason: "目标不在本轮明确授权的写入清单中" });
  }

  if (normalizedTargets.some((target) => formalFactModule(target.moduleId) && !contractAuthorizesTarget(target)) && !hasFormalAssetWriteIntent(source)) {
    normalizedTargets.filter((target) => formalFactModule(target.moduleId) && !contractAuthorizesTarget(target)).forEach((target) => {
      if (!rejected.some((item) => item.documentId === target.documentId)) {
        rejected.push({ ...target, reason: "对话只提及了设定或大纲，没有形成明确写入授权" });
      }
    });
  }

  // An explicitly requested self-check report has one index-bound destination.
  // Do not silently downgrade it to a正文 target when the caller omitted the
  // corresponding report document from the transaction.
  if (!contractDecision.authoritative && review.reportRequested === true && review.target?.documentId
    && !normalizedTargets.some((target) => target.documentId === review.target.documentId)) {
    rejected.push({
      documentId: review.target.documentId,
      moduleId: "reports",
      reason: "自检报告只能写入索引绑定的对应报告文档",
    });
  }

  return {
    ok: rejected.length === 0 && normalizedTargets.length > 0,
    authorizedDocumentIds: unique(normalizedTargets.filter((target) => !rejected.some((item) => item.documentId === target.documentId)).map((target) => target.documentId)),
    rejected,
  };
};
