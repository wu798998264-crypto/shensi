import { validateTaskContractForExecution } from "./task-contract.js";

const text = (value = "") => String(value ?? "").trim();

const WRITE_ACTION = /(?:写入|写进|写到|落盘|保存|存入|追加|覆盖|替换|新建|创建|生成|续写|改写|重写|补写|更新|修改)/u;

export const formalContentIntentDomain = (instruction = "", content = "") => {
  const source = `${text(instruction)}\n${text(content)}`;
  if (!WRITE_ACTION.test(text(instruction))) return "";
  if (/(?:自检报告|验收报告|编译报告|检查报告)/u.test(source)) return "reports";
  if (/(?:正文|章节|第[零〇一二两三四五六七八九十百\d]+章|小说成稿|剧本正文|第[零〇一二两三四五六七八九十百\d]+集)/u.test(source)) return "manuscript";
  if (/(?:人物|角色|物品|神器|地点|势力|术语|世界观|规则|设定)(?:档案|设定|表|集)?/u.test(source)) return "canon";
  if (/(?:全书|全集|整书|小说|分卷|卷|章节|剧情)?(?:大纲|卷纲|章纲|细纲|集纲|剧情规划)/u.test(source)) return "outline";
  if (/(?:资料库|参考资料|原始资料|备忘录)/u.test(source)) return "library";
  if (/(?:推演记录|创作过程记录|创作引导记录)/u.test(source)) return "guidance";
  return "";
};

export const targetSupportsFormalDomain = ({ target = null, domain = "" } = {}) => {
  const moduleId = text(target?.moduleId);
  const documentId = text(target?.documentId);
  if (!domain || !documentId) return true;
  if (domain === "guidance") return documentId === "index-creative-guidance";
  if (documentId === "index-creative-guidance") return false;
  return moduleId === domain;
};

const domainLabel = (domain = "") => ({
  manuscript: "正文",
  canon: "设定",
  outline: "大纲",
  reports: "报告",
  library: "资料",
  guidance: "推演记录",
}[domain] || "正式内容");

const deliverableDomain = (deliverable = {}) => {
  const moduleId = text(deliverable?.target?.moduleId).toLowerCase();
  if (["manuscript", "canon", "outline", "reports", "library"].includes(moduleId)) return moduleId;
  if (text(deliverable?.targetDocumentId || deliverable?.targetDocument) === "index-creative-guidance") return "guidance";
  return ({
    prose: "manuscript",
    setting: "canon",
    outline: "outline",
    report: "reports",
    review_report: "reports",
    reference: "library",
  })[text(deliverable?.kind).toLowerCase()] || "";
};

const authoritativeTaskContractDomain = ({ taskContract = null, target = null } = {}) => {
  const decision = validateTaskContractForExecution(taskContract);
  if (!decision.authoritative) return null;
  if (!decision.valid || decision.persistence === "none" || !decision.deliverables.length) return "";
  const targetDocumentId = text(target?.documentId);
  const matchingDeliverable = decision.deliverables.find((deliverable) => (
    text(deliverable?.targetDocumentId || deliverable?.targetDocument || deliverable?.target?.documentId) === targetDocumentId
  ));
  const domains = [...new Set((matchingDeliverable ? [matchingDeliverable] : decision.deliverables)
    .map(deliverableDomain)
    .filter(Boolean))];
  return domains.length === 1 ? domains[0] : "";
};

export const formalTargetCompatibility = ({ instruction = "", content = "", target = null, taskContract = null } = {}) => {
  const contractDomain = authoritativeTaskContractDomain({ taskContract, target });
  const domain = contractDomain === null ? formalContentIntentDomain(instruction, content) : contractDomain;
  if (!domain || targetSupportsFormalDomain({ target, domain })) return { compatible: true, domain };
  const targetTitle = text(target?.title || target?.documentId || "当前文档");
  const guidance = text(target?.documentId) === "index-creative-guidance";
  return {
    compatible: false,
    domain,
    recommendedModuleId: domain === "guidance" ? "index" : domain,
    reasonCode: guidance ? "creative_guidance_not_delivery_target" : "formal_content_target_domain_mismatch",
    message: guidance
      ? `“${targetTitle}”只用于保存已确认的推演记录，不承载${domainLabel(domain)}。请选择对应的${domainLabel(domain)}文档后再写入。`
      : `识别到本轮要写入的是${domainLabel(domain)}，但“${targetTitle}”不属于对应板块。请选择正确的${domainLabel(domain)}文档后再写入。`,
  };
};
