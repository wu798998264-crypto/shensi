import { indexWriteTargetForScenario } from "./index-policy.js";
import { requestedChapterBatch, requestedChapterTarget } from "./chapter-target.js";

const REVIEW_INTENT_PATTERN = /自检|自检报告|编译报告|改编报告|审稿|审查|检查|检测|诊断|验收|评估|质量复检|质量审计/u;
const REVIEW_INTENT_NEGATION_PATTERN = /(?:不要|无需|不用|不必|禁止|跳过|取消|先不|暂不)[^。！？；，,\n]{0,12}(?:自检|审稿|审查|检查|检测|诊断|验收|评估)|(?:不是|不得|不能|不可)(?:只|再|继续|输出|生成|写|写成|作为|当作)?[^。！？；，,\n]{0,12}(?:自检|审稿|审查|检查|检测|诊断|验收|评估)/u;
const REVIEW_TARGET_PATTERN = /小说|正文|章节|本章|当前章节|全书|全稿|本卷|整卷|剧本|短剧|漫剧|单集|多集|全集|整季|作品|稿件|文稿|第\s*[零〇一二两三四五六七八九十百千万\d]+\s*(?:章|集)/u;
const BATCH_REVIEW_SCOPE_PATTERN = /批量|多(?:章|集|章节|剧集)|多个(?:章节|剧集)|若干(?:章节|剧集)|全部章节|所有章节|全(?:书|稿|文|卷|剧|集)|(?:全|全部|整个|整部)作品|整(?:书|稿|部|卷|剧|季)|本卷|整季|前\s*[零〇一二两三四五六七八九十百千万两\d]+\s*(?:章|集)|(?:第\s*)?[零〇一二两三四五六七八九十百千万两\d]+\s*(?:章|集)?\s*(?:至|到|[-—–~～]|和|与|及|、)\s*(?:第\s*)?[零〇一二两三四五六七八九十百千万两\d]+\s*(?:章|集)/u;
const REPORT_LANDING_PATTERN = /落盘|写入|存入|保存(?:到|至|进|为)?|归档|提交(?:到|至)?/u;
const REPORT_LANDING_NEGATION_PATTERN = /(?:不要|无需|不用|不必|禁止|暂不|先不|(?:^|[，、。！？；;\s])不)[^。！？；，,\n]{0,12}(?:落盘|写入|存入|保存|归档|提交|候选稿|报告)/u;
const FULL_REVIEW_REPORT_PATTERN = /(?:完整|全面|正式|全量|系统(?:性)?).{0,12}(?:自检|审稿|审查|检查|检测|诊断|验收|评估).{0,8}报告|(?:自检|审稿|审查|检查|检测|诊断|验收|评估).{0,12}(?:完整|全面|正式|全量|系统(?:性)?).{0,8}报告/u;
const NAMED_REVIEW_REPORT_PATTERN = /(?:小说|剧本|正文|短剧|漫剧)?自检报告|小说改剧本编译报告|改编报告/gu;
const LOCAL_REVIEW_SCOPE_PATTERN = /选区|选中文字|这句|本句|这句话|这段|本段|这一段|段落|局部|小范围|小检测|简单检查|快速检查|当前片段|某一处/u;
const SINGLE_REVIEW_SCOPE_PATTERN = /单(?:章|集)|本(?:章|集)|当前(?:章|章节|集)|这(?:章|一章|集|一集)|第\s*[零〇一二两三四五六七八九十百千万两\d]+\s*(?:章|集)/u;
const SCRIPT_PATTERN = /剧本|短剧|漫剧|单集|多集|全集|整季/u;
const ADAPTATION_PATTERN = /小说.{0,20}(?:改编|改成|改写成|转换成|转成).{0,10}(?:短剧|剧本|漫剧)|改编剧本|改编报告|小说改剧本/u;
const REVIEW_META_INQUIRY_PATTERN = /(?:自检|审稿|审查|验收).{0,16}(?:是什么|有哪些功能|怎么用|如何使用|什么时候|何时|流程|区别|会不会自动)|(?:为什么|怎么|如何).{0,16}(?:触发|进入|使用).{0,8}(?:自检|审稿|审查|验收)/u;
const REVIEW_CONTENT_MUTATION_PATTERN = /(?:修改|修复|重写|改写|润色|返修|调整|优化|替换|续写|扩写|压缩|微增|增补|补写).{0,18}(?:正文|章节|本章|稿件|文稿|剧本|单集)|(?:正文|章节|本章|稿件|文稿|剧本|单集).{0,18}(?:修改|修复|重写|改写|润色|返修|调整|优化|替换|续写|扩写|压缩|微增|增补|补写)|(?:并|然后|同时|检查后|自检后).{0,4}(?:直接)?(?:修改|修复|重写|改写|润色|返修|调整|优化|替换|续写|扩写|压缩|微增|增补|补写)(?!建议|意见|方案)/u;
const REVIEW_CONTENT_PRODUCTION_PATTERN = /(?:创作|撰写|编写|写出|写成|生成|完成|产出).{0,24}(?:正式)?(?:小说)?(?:正文|章节|本章|稿件|文稿|剧本|单集)|(?:正式)?(?:小说)?(?:正文|章节|本章|稿件|文稿|剧本|单集).{0,24}(?:创作|撰写|编写|写出|写成|生成|完成|产出)/u;
const EXPLICIT_REVIEW_REPORT_REQUEST_PATTERN = /(?:生成|创建|新建|输出|撰写|编写|写入|保存|落盘|归档|提交).{0,18}(?:小说|剧本|正文|改编)?(?:自检|审稿|审查|诊断|验收|评估)(?:报告|文档)|(?:小说|剧本|正文|改编)?(?:自检|审稿|审查|诊断|验收|评估)(?:报告|文档).{0,18}(?:生成|创建|新建|输出|撰写|编写|写入|保存|落盘|归档|提交)/u;

export const reviewIncludesContentMutation = (value = "") => {
  const source = String(value || "");
  return REVIEW_CONTENT_MUTATION_PATTERN.test(source) || REVIEW_CONTENT_PRODUCTION_PATTERN.test(source);
};

// A review's source scope is independent from its optional report artifact.
// Keeping this contract here prevents callers from using report-novel as the
// input document merely because it is the formal landing target.
export const reviewScopeFromInstruction = ({ text = "", baseChapterNumber = 0, plannedEndChapter = 0 } = {}) => {
  const source = String(text || "").trim();
  if (!source) return null;
  const batch = requestedChapterBatch(source, { baseChapterNumber, plannedEndChapter });
  if (batch?.count > 1) {
    return {
      kind: "chapters",
      startChapter: batch.startChapter,
      endChapter: batch.endChapter,
      documentIds: Array.from({ length: batch.count }, (_, index) => `chapter-${batch.startChapter + index}`),
    };
  }
  const single = requestedChapterTarget(source);
  if (single?.documentId) {
    return {
      kind: "chapters",
      startChapter: single.chapterNumber,
      endChapter: single.chapterNumber,
      documentIds: [single.documentId],
    };
  }
  if (/(?:全部|所有|全|整)(?:章节|章|书|稿|文|卷)|全书|全稿|本卷/u.test(source)) {
    return { kind: "all_chapters", documentIds: [] };
  }
  return { kind: "bound_document", documentIds: [] };
};

export const reviewReportTarget = ({ contextDomain = "novel" } = {}) => {
  const script = ["script", "script-adaptation"].includes(String(contextDomain)) || contextDomain === "short_drama";
  const targetBinding = indexWriteTargetForScenario("explicit_self_check_report", {
    contextDomain: contextDomain === "short_drama" ? "script" : contextDomain,
  });
  const documentId = targetBinding?.documentId || (script ? "report-script" : "report-novel");
  return script
    ? {
      kind: "artifact",
      documentId,
      moduleId: "reports",
      title: documentId === "report-adaptation" ? "小说改剧本编译报告" : "剧本自检",
      contextDomain: "script",
      explicitArtifact: true,
      landingMode: "append_report",
      reportKind: "batch_self_check",
    }
    : {
      kind: "artifact",
      documentId,
      moduleId: "reports",
      title: "小说自检",
      contextDomain: "novel",
      explicitArtifact: true,
      landingMode: "append_report",
      reportKind: "batch_self_check",
    };
};

export const reviewDeliveryPolicy = ({ text = "", contextDomain = "novel" } = {}) => {
  const source = String(text || "").trim();
  const sourceWithoutNamedReportReferences = source.replace(NAMED_REVIEW_REPORT_PATTERN, "报告文档");
  const explicitlyRequestsFullReport = FULL_REVIEW_REPORT_PATTERN.test(source);
  const review = (REVIEW_INTENT_PATTERN.test(sourceWithoutNamedReportReferences) || explicitlyRequestsFullReport)
    && !REVIEW_INTENT_NEGATION_PATTERN.test(source)
    && !REVIEW_META_INQUIRY_PATTERN.test(source)
    && (REVIEW_TARGET_PATTERN.test(source) || LOCAL_REVIEW_SCOPE_PATTERN.test(source) || SINGLE_REVIEW_SCOPE_PATTERN.test(source) || /自检|审稿|质量(?:复检|审计|报告)/u.test(source));
  if (!review) return {
    active: false,
    kind: "not_review",
    batch: false,
    reportRequested: false,
    candidatePreviewRequired: null,
    landingEligible: false,
    target: null,
  };
  const parsedChapterBatch = requestedChapterBatch(source, { baseChapterNumber: 0, plannedEndChapter: 0 });
  const batch = Number(parsedChapterBatch?.count || 0) > 1 || BATCH_REVIEW_SCOPE_PATTERN.test(source);
  const explicitlyNoLanding = REPORT_LANDING_NEGATION_PATTERN.test(source);
  const explicitlyRequestsLanding = REPORT_LANDING_PATTERN.test(source);
  const contentProductionOrMutation = reviewIncludesContentMutation(source);
  const explicitlyRequestsReportArtifact = explicitlyRequestsFullReport || EXPLICIT_REVIEW_REPORT_REQUEST_PATTERN.test(source);
  const localDiagnostic = LOCAL_REVIEW_SCOPE_PATTERN.test(source) && !batch;
  const singleUnitReview = !batch && SINGLE_REVIEW_SCOPE_PATTERN.test(source);
  // Scope determines the default artifact boundary. Local and single-unit
  // checks stay conversational; batch/whole-work and explicitly complete
  // reports are formal deliverables unless the author explicitly opts out.
  const reportRequested = !explicitlyNoLanding
    && (explicitlyRequestsReportArtifact || batch || (!contentProductionOrMutation && explicitlyRequestsLanding));
  const resolvedDomain = contextDomain === "script-adaptation"
    || ADAPTATION_PATTERN.test(source)
    ? "script-adaptation"
    : SCRIPT_PATTERN.test(source) ? "script" : contextDomain;
  return {
    active: true,
    kind: reportRequested
      ? batch ? "batch_report" : "formal_review_report"
      : localDiagnostic ? "local_diagnostic"
        : singleUnitReview ? "single_unit_diagnostic" : "review_diagnostic",
    batch,
    reportRequested,
    candidatePreviewRequired: false,
    landingEligible: reportRequested,
    target: reportRequested ? reviewReportTarget({ contextDomain: resolvedDomain }) : null,
    reason: explicitlyNoLanding
      ? "用户明确要求自检结果只保留在对话中，不写入正式报告"
      : contentProductionOrMutation && !explicitlyRequestsReportArtifact
        ? "自检属于本轮正式内容生成或修改的写后门禁，只交付最终内容，不额外创建自检报告"
      : reportRequested
        ? batch
          ? "多章节、整卷或整部作品自检属于正式报告，写入对应自检文档"
          : "完整自检报告属于正式内容，写入对应自检文档"
        : singleUnitReview
          ? "单章或单集检测属于普通诊断，只在对话中返回"
          : "局部或小范围检测属于普通诊断，只在对话中返回",
  };
};

export const explicitReviewReportReference = (value = "") => (
  // “编译报告” is the Author Cockpit collection, not a catch-all document.
  // Only an explicitly named novel/script self-check report may resolve to a
  // writable review artifact; the adaptation report is routed separately.
  /(?:小说|剧本|正文|短剧|漫剧)自检报告|(?:打开|查看|进入|切换到|定位|显示).{0,10}(?:小说自检|剧本自检|自检报告)|(?:小说自检|剧本自检|自检报告).{0,10}(?:文档|页面)/u.test(String(value || ""))
);
