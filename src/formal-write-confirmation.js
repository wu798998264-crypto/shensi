import { reviewDeliveryPolicy } from "./review-delivery-policy.js";

const sourceText = (value = "") => String(value ?? "").trim();

const EXPLICIT_WRITE_PATTERN = /保存|写入|覆盖|落盘|应用(?:到|至)|提交(?:到|至)|同步到|替换原文|更新(?:到|至)?(?:文档|正文|设定|大纲)|记入(?:文档|正文|设定|大纲)/u;
const EXPLICIT_NO_WRITE_PATTERN = /(?:不要|无需|暂不|先别|禁止|仅|只)(?:立即|现在|自动)?(?:保存|写入|覆盖|落盘|应用|提交|同步)|(?:只|仅)(?:在)?(?:对话|聊天)(?:里|中)?(?:回答|展示|输出)/u;
const NON_FORMAL_PATTERN = /规划|测试|诊断|分析|草稿|预览|对话说明|说明|解释|讨论|评估|审稿|自检|检查|验收|复核|报告/u;
const FORMAL_DELIVERABLE_PATTERN = /正式(?:正文|设定|大纲|章纲|卷纲|剧本|稿件)|(?:正文|设定|大纲|章纲|卷纲|剧本|章节|文档|文章).{0,12}(?:交付|成稿|全文)|(?:写|创作|生成|续写|改写|重写|润色|修改|修复|优化|替换|调整|返修).{0,20}(?:正文|设定|大纲|章纲|卷纲|剧本|章节|文章|稿件)/u;

export const hasExplicitFormalWriteIntent = (instruction = "", command = "") => {
  const prompt = `${sourceText(instruction)}\n${sourceText(command)}`.trim();
  return Boolean(prompt) && EXPLICIT_WRITE_PATTERN.test(prompt) && !EXPLICIT_NO_WRITE_PATTERN.test(prompt);
};

export const isNonFormalTaskByDefault = (instruction = "", { target = null, contentType = "" } = {}) => {
  const prompt = sourceText(instruction);
  if (!prompt || EXPLICIT_NO_WRITE_PATTERN.test(prompt)) return true;
  if (hasExplicitFormalWriteIntent(prompt)) return false;
  const targetModule = sourceText(target?.moduleId || target?.module || "").toLocaleLowerCase();
  const targetDocumentId = sourceText(target?.documentId || target?.targetDocumentId || "").toLocaleLowerCase();
  const resolvedContentType = sourceText(contentType || target?.contentType || target?.contextDomain).toLocaleLowerCase();
  const reviewContextDomain = targetDocumentId === "report-adaptation"
    ? "script-adaptation"
    : targetDocumentId === "report-script" ? "script" : "novel";
  const reviewDelivery = reviewDeliveryPolicy({ text: prompt, contextDomain: reviewContextDomain });
  if (reviewDelivery.reportRequested === true && reviewDelivery.target?.documentId === targetDocumentId) return false;
  if ((targetModule === "reports" || targetDocumentId.startsWith("report-") || resolvedContentType.includes("review_report"))
    && /自检|检查|诊断|审稿|验收|复核|分析/u.test(prompt)) return true;
  return NON_FORMAL_PATTERN.test(prompt) && !FORMAL_DELIVERABLE_PATTERN.test(prompt);
};

export const shouldSuppressAutomaticFormalLanding = ({ instruction = "", target = null, contentType = "" } = {}) => (
  isNonFormalTaskByDefault(instruction, { target, contentType })
);

export const formalLandingResolutionReason = ({
  targetAmbiguous = false,
  targetDocumentId = "",
  targetDocumentIds = [],
  writeAuthorization = null,
  targetExists = false,
  targetHasContent = false,
} = {}) => {
  const resolvedTargetIds = [...new Set([
    targetDocumentId,
    ...(Array.isArray(targetDocumentIds) ? targetDocumentIds : []),
  ].map(sourceText).filter(Boolean))];
  if (targetAmbiguous || !resolvedTargetIds.length) return "target";
  if (writeAuthorization?.state === "candidate_only"
    && writeAuthorization?.reason === "landing_intent_uncertain") return "write_confirmation";
  if (writeAuthorization?.state !== "commit") return "";
  // A TaskContract-backed batch already owns its complete target set and each
  // child target carries its own create/replace operation. Do not collapse the
  // batch into the single-document target/operation confirmation flow.
  if (resolvedTargetIds.length > 1) return "";
  const action = sourceText(writeAuthorization.action).toLocaleLowerCase();
  if ((!action || action === "generate") && targetExists && targetHasContent) return "operation";
  return "";
};
