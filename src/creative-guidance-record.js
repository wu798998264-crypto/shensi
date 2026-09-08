import { creativeGuidanceSchema } from "./creative-guidance-contract.js";

export const CREATIVE_GUIDANCE_DOCUMENT_ID = "index-creative-guidance";

export const CREATIVE_GUIDANCE_EMPTY_PROMPT = [
  "在这里完成正式写作前的梳理灵感、探索方向，将模糊想法逐步发展为人物、设定、冲突与故事结构的工作。",
  "神思不提倡全自动一键代写，希望创作过程始终保留创作者的主观审美、创意方向与最终判断。",
  "你可以把一句话故事、人物构想或几个关键词输入右侧对话框，与神思共同完善作品。已有设定和大纲也可以直接粘贴到左侧对应的正式文档，供后续创作真实读取。",
  "你还可以把已有内容以文本或附件发送到右侧对话框。神思会保存原始资料，并在你确认后整理到对应的正式文档。",
  "方向明确时，也可以跳过引导，直接打开设定、大纲或正文开始创作。",
  "单篇短文、短篇小说、散文、随笔、评论或文案，请点击左侧目录顶部的「作品」，切换至「笔记」模式。",
].join("\n\n");

export const creativeGuidanceLandingTarget = ({ requestMode = "", target = null } = {}) => (
  String(requestMode || "") === "creative_guidance"
    ? { ...(target && typeof target === "object" ? target : {}), documentId: CREATIVE_GUIDANCE_DOCUMENT_ID, moduleId: "index", landingMode: "append_report" }
    : target
);

const clean = (value = "") => String(value ?? "")
  .replace(/\r\n?/gu, "\n")
  .replace(/[ \t]+/gu, " ")
  .trim();

const unique = (values = []) => [...new Set((Array.isArray(values) ? values : [values])
  .map(clean)
  .filter(Boolean))];

const structuredDecisionRecord = (guidanceState = null) => {
  if (!guidanceState || typeof guidanceState !== "object" || Array.isArray(guidanceState)) return null;
  const contractSchema = creativeGuidanceSchema(guidanceState.deliverableType);
  if (!contractSchema) return null;
  const labels = new Map(contractSchema.clusters.map((item) => [item.id, item.label]));
  const confirmed = new Set([
    ...(Array.isArray(guidanceState.completedClusters) ? guidanceState.completedClusters : []),
    ...(Array.isArray(guidanceState.delegatedClusters) ? guidanceState.delegatedClusters : []),
  ]);
  const decisions = (Array.isArray(guidanceState.decisions) ? guidanceState.decisions : [])
    .filter((item) => confirmed.has(item?.cluster)
      && ["user", "delegated"].includes(item?.source)
      && clean(item?.value))
    .map((item) => `- ${labels.get(item.cluster) || item.cluster}${item.source === "delegated" ? "（作者委托神思决定）" : ""}：${clean(item.value)}`);
  const selectedEnhancement = guidanceState.enhancementDiscussed === true
    ? clean(guidanceState.selectedEnhancement)
    : "";
  if (!decisions.length && !selectedEnhancement) return [];
  return [
    "## 推演记录",
    decisions.length ? `### 已确认的作者决策\n${decisions.join("\n")}` : "",
    selectedEnhancement ? `### 已采用的增强方向\n- ${selectedEnhancement}` : "",
  ].filter(Boolean).join("\n\n");
};

export const creativeGuidanceInferenceRecord = ({ userClues = [], acceptedChanges = [], guidanceState = null } = {}) => {
  const structured = structuredDecisionRecord(guidanceState);
  if (typeof structured === "string") return structured;
  const clues = unique(userClues).filter((clue) => !/^(?:按这个|采用这版|落盘|写入|保存|继续|执行)[。！!]*$/u.test(clue));
  // Only changes supported by the author's key instructions belong in this
  // concise creation log. Raw assistant advice/questions are deliberately not
  // accepted here; they remain in conversation history until the author adopts
  // them and they are passed as acceptedChanges.
  const conclusions = unique(acceptedChanges);
  if (!clues.length && !conclusions.length) return "";
  return [
    "## 推演记录",
    clues.length ? `### 用户线索\n${clues.map((clue) => `- ${clue}`).join("\n")}` : "",
    conclusions.length ? `### 已确认的内容变化\n${conclusions.map((conclusion) => `- ${conclusion}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
};

export const creativeGuidanceRecordInstruction = () => [
  "当前绑定文档是作品前置准备的“创作引导”。先通过一次一个高价值问题与作者讨论，不把提问写入正式文档。",
  "这是可跳过的创作准备缓冲区，不是正文门禁。作者可以在这里整理资料、确定必要设定、规划篇幅和大纲，也可以随时直接进入正文。",
  "直接打开正文时，讨论、准备、生成和落盘能力必须与从创作引导开始完全一致；不得因为没有经过创作引导而阻塞、降级或改写任务路由。",
  "简单、现实题材或作者已有成熟方案时，可以只做必要准备，甚至完全跳过本入口。",
  "创作引导文档自身只接收“推演记录”：保留作者关键指令造成的内容变化，绝不记录你自行提出但作者尚未采用的建议或问题。",
  "普通讨论没有写入资格；只有作者明确要求落盘时，才输出可验证的正式推演记录候选。",
].join("\n");

export const creativeGuidanceDocumentPatch = (documentState = {}) => ({
  ...documentState,
  title: "创作引导",
  html: typeof documentState.html === "string" ? documentState.html : "",
  updatedAt: documentState.updatedAt || "",
  moduleId: "index",
  systemSlotId: CREATIVE_GUIDANCE_DOCUMENT_ID,
  creativeGuidanceWorkspace: true,
  emptyPlaceholder: CREATIVE_GUIDANCE_EMPTY_PROMPT,
});
