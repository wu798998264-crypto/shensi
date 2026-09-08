const POSTWRITE_CHECK_STAGES = new Set(["evaluation", "combined-check", "memory-check", "theory-support"]);

export const supplementRequestsLatestDocument = (value = "") => (
  /(?:按|读取|采用|使用|基于|以).{0,8}(?:最新|刚刚修改|当前最新版)(?:的)?(?:文档|正文|内容|版本)|(?:文档|正文|内容).{0,8}(?:已经|刚刚|刚才).{0,8}(?:修改|更新).{0,8}(?:请)?(?:重新读取|按最新)/u.test(String(value || "").trim())
);

export const supplementDisposition = (stage = "") => POSTWRITE_CHECK_STAGES.has(stage)
  ? "defer_candidate_revision"
  : "adjust_completed_stage";

export const supplementAdjustmentPrompt = ({ stage = "", result = "", supplements = [] } = {}) => [
  `这是${stage || "当前"}阶段刚刚完成的结果：`,
  String(result).trim(),
  "",
  "作者在模型运行期间追加了以下要求：",
  ...supplements.map((item) => `- ${String(item?.content ?? item).trim()}`).filter((item) => item !== "- "),
  "",
  "不要取消或从头重做原任务。只修改受补充要求影响的部分，保留其余已完成内容和原定输出格式；返回吸收补充要求后的完整阶段结果。",
].join("\n");
