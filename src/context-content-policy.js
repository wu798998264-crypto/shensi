import { isLegacyNarrativePlaceholderText, isNarrativeUnitDocumentId } from "./narrative-placeholder.js";

const normalizeLines = (value) => String(value ?? "")
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const normalizedSignature = (value) => String(value ?? "")
  .replace(/^\s*#{1,6}\s*/gmu, "")
  .replace(/[\s\p{P}\p{S}]+/gu, "")
  .toLowerCase();

const withoutFirstContentLine = (value) => {
  const lines = normalizeLines(value).split("\n");
  const first = lines.findIndex((line) => line.trim());
  if (first >= 0) lines.splice(first, 1);
  return lines.join("\n").trim();
};

const LEGACY_EXACT_BODIES = Object.freeze({
  "outline-series": ["全书以一次被人为制造的误判为起点，逐层揭开人物关系、利益交换与旧案真相。"],
  "outline-volume-1": ["第一卷完成主角入局、第一次误判和核心对手的首次正面交锋。"],
  "outline-chapter-6": ["本章用03:17的时间戳制造逻辑断点，让主角第一次意识到证据链被人主动修改。"],
  "canon-characters": ["陆沉：克制、敏锐，在信息不足时习惯先压下情绪；简宁：掌握旧案关键材料。"],
  "canon-factions": ["城建集团、旧案调查组与匿名数据修正者构成当前三方力量。"],
  "canon-relations": ["陆沉与简宁互相需要，但双方仍各自保留一部分关键信息。"],
  "canon-locations": ["老地方：废弃高架桥下的通宵餐馆；会议室：03:17线索的冲突地点。"],
  "canon-items": ["牛皮纸文件袋、折叠地图和被修改的打印数据是当前关键物品。"],
  "memory-foreshadowing": ["F-006：03:17时间戳。状态：已埋设；预计在第十二章完成第一次解释。"],
  "memory-first-appearance": ["03:17在第六章首次进入读者视野，目前只知道它与陆沉的不在场记录冲突。"],
  "memory-release": ["第六章释放：记录冲突。暂缓释放：谁修改了记录，以及简宁掌握材料的真实来源。"],
  "memory-reader": ["读者知道数据链被人为掐断，但尚不知道陆沉是否真的离开过会议室。"],
  "memory-snapshot": ["陆沉：警觉上升；简宁：等待见面；03:17：未解释；地图：已重新启用。"],
  "script-episode-1": ["按单集剧本格式承接剧本大纲、剧本设定和当前状态；当前等待确认本集主戏剧问题。"],
  "prompt-video-1": ["按镜头拆分可执行的视频提示词，并追溯到对应分集剧本。"],
  "prompt-visual-assets": ["维护剧本所需角色、场景、道具和复用资产的视觉生成提示词。"],
  "prompt-panorama-1": ["固定多人场景的空间关系、站位、朝向、动线和关键动作区域。"],
  "script-outline-series": ["原创项目在此建立类型契约、核心矛盾、阶段爆点和终局；改编项目在原作基础上重构为剧本总控。"],
  "script-outline-episode-1": ["记录本集主戏剧问题、情绪变化、信息释放、关系推进和结尾画面钩子。"],
  "script-canon-characters": ["只记录相对小说正史发生的人物删减、功能合并、表演方向和出场顺序变化。"],
  "script-canon-relations": ["只记录剧本化导致的关系位置、关系弧线和人物合并变化。"],
  "script-canon-world": ["只记录为画面呈现、制作执行或观众理解而改动的世界信息与规则，不复制小说正史。"],
  "script-canon-locations": ["只记录场景调度、地点压缩、合并、替换与新增。"],
  "script-canon-factions": ["只记录组织的保留、合并、替换及其戏剧功能变化。"],
  "script-canon-events": ["只记录原作事件的删并重排、跨集位置与时间顺序变化。"],
  "script-canon-items": ["只记录承担证据、反转、身份标记或视觉记忆点的关键道具变化。"],
  "script-canon-glossary": ["只记录剧本新增或为观众理解而改写的术语。"],
  "script-memory-foreshadowing": ["记录原创或改编剧本中已经成立的可呈现伏笔及其跨集回收位置。"],
  "script-memory-first-appearance": ["记录关键信息在剧本中的首次出现、局部揭示和正式揭示集数。"],
  "script-memory-release": ["按集维护观众获得的信息、角色知情差和延后解释事项。"],
  "script-memory-audience": ["记录观众在当前集结束时已经确认、怀疑和仍未知的信息。"],
  "script-memory-snapshot": ["记录人物、关系、道具、伤口、地点和未兑现集尾承诺的当前状态。"],
  "library-reference": ["用于保存研究资料、用户导入文本和不会直接进入正史的参考信息。"],
  "library-retired": ["已经废弃但需要保留来源的设定进入隔离区。"],
  "index-language-blacklist": [
    "项目禁用词 当前没有项目级禁用词。 特别注意事项 记录只针对本项目生效的创作边界、必须承接事项和特殊要求。",
    "当前没有项目级禁用词。记录只针对本项目生效的创作边界、必须承接事项和特殊要求。",
    "项目禁用词 当前没有项目级禁用词。 特别注意事项 当前没有项目级特别注意事项。",
    "Project banned terms No project-specific banned terms. Special project constraints No project-specific special constraints.",
  ],
});

const GENERIC_EMPTY_BODIES = Object.freeze([
  "在右侧对话中确定创作意图后开始填写。",
  "本章正文尚未展开，可在右侧对话中继续确定章节意图。",
  "当前尚未执行剧本自检。",
  "本报告将根据当前项目的大纲、分卷、正文、设定和连续性资料实时更新。",
  "尚未收录正式术语。",
  "当前尚无结构化更新记录。",
  "创作合同",
  "项目禁用词",
  "Project Rules",
  "Project banned terms",
  "Define this document's purpose in the chat panel before filling it in.",
  "Define this chapter's intent in the chat panel before drafting.",
]);

const bodyMatches = (value, candidates = []) => {
  const variants = [value, withoutFirstContentLine(value)].map(normalizedSignature).filter(Boolean);
  return candidates.some((candidate) => variants.includes(normalizedSignature(candidate)));
};

export const isContextPlaceholderContent = (documentId = "", value = "") => {
  const text = normalizeLines(value);
  if (!text) return true;
  if (isNarrativeUnitDocumentId(documentId) && isLegacyNarrativePlaceholderText(text)) return true;
  if (bodyMatches(text, GENERIC_EMPTY_BODIES)) return true;
  return bodyMatches(text, LEGACY_EXACT_BODIES[String(documentId)] ?? []);
};

export { isNarrativeUnitDocumentId };

const sectionLabel = (line) => String(line ?? "")
  .trim()
  .replace(/^#{1,6}\s*/u, "")
  .replace(/[：:]$/u, "")
  .trim();

const BODY_SECTION_LABELS = new Set(["正文", "正式正文", "剧本正文"]);
const INTERNAL_SECTION_LABELS = new Set([
  "单集写作卡", "本集写作卡", "本章写作卡", "写作卡", "动态创作胶囊", "本轮内部生成合同",
  "本集结尾说明", "本章结尾说明", "本集说明", "本章说明", "结尾说明",
  "自检报告", "程序语言扫描", "评分表", "返修约束", "返修协议", "记忆增量", "问题协议",
]);

const isInternalMetadataLine = (line) => /^(?:[-*]\s*)?(?:来源|剧本域状态|小说域状态|正文域状态|输出状态|生成状态|正史状态)\s*[：:]/u.test(String(line ?? "").trim());

export const stripInternalNarrativeScaffolding = (value = "", { documentId = "" } = {}) => {
  const text = normalizeLines(value);
  if (!text || (documentId && !isNarrativeUnitDocumentId(documentId))) return text;
  const lines = text.split("\n");
  const bodyIndex = lines.findIndex((line) => BODY_SECTION_LABELS.has(sectionLabel(line)));
  const source = bodyIndex >= 0 ? lines.slice(bodyIndex + 1) : lines;
  const kept = [];
  let skippingInternalSection = false;
  for (const line of source) {
    const label = sectionLabel(line);
    if (BODY_SECTION_LABELS.has(label)) {
      skippingInternalSection = false;
      continue;
    }
    if (INTERNAL_SECTION_LABELS.has(label)) {
      skippingInternalSection = true;
      continue;
    }
    if (isInternalMetadataLine(line)) continue;
    if (skippingInternalSection) continue;
    kept.push(line);
  }
  return normalizeLines(kept.join("\n"));
};

const continuityValue = (value) => String(value ?? "")
  .replace(/^\s*[-*]\s*/u, "")
  .replace(/\s+/gu, " ")
  .trim();

export const isContinuityManagementValue = (value) => {
  const text = continuityValue(value);
  if (!text) return true;
  return /^(?:来源|剧本域状态|小说域状态|正文域状态|输出状态|生成状态|正史状态|改编方式|可拍正文预计时长|尾钩重构方案|本集(?:核心事件|主戏剧问题|情绪功能|必须保留|禁止合并|暂不释放|场景数量|人物)(?:的[^：:\n]{0,40})?|本章(?:核心事件|主戏剧问题|情绪功能|必须保留|禁止合并|暂不释放)(?:的[^：:\n]{0,40})?|人物口语声口锚点|单集写作卡|本集写作卡|本章写作卡|写作卡|本集结尾说明|本章结尾说明|集尾以|章尾以|自检报告|程序语言扫描|评分表|返修约束|返修协议|记忆增量|问题协议)\s*(?:[：:]|$)/u.test(text);
};

const trustedContinuityValue = (value) => isContinuityManagementValue(value) ? "" : continuityValue(value);

export const trustedContinuityDeltaText = (delta = {}, { labelFor = (id) => id } = {}) => {
  if (!delta || typeof delta !== "object") return "";
  const plan = delta.nextReadPlan && typeof delta.nextReadPlan === "object" ? delta.nextReadPlan : null;
  const labels = (ids = []) => ids.map((id) => String(id ?? "").trim()).filter(Boolean).map(labelFor).filter(Boolean).join("、");
  const summary = trustedContinuityValue(delta.summary);
  const carryover = (Array.isArray(delta.nextCarryover) ? delta.nextCarryover : []).map(trustedContinuityValue).filter(Boolean);
  const rules = (Array.isArray(plan?.rules) ? plan.rules : []).map(trustedContinuityValue).filter(Boolean);
  const instructions = (Array.isArray(plan?.instructions) ? plan.instructions : []).map(trustedContinuityValue).filter(Boolean);
  return [
    summary ? `本单元已发生结果：${summary}` : "",
    ...carryover.map((item) => `后续事实承接：${item}`),
    plan?.targetDocumentId ? `下一单元读取目标：${labelFor(plan.targetDocumentId) || plan.targetDocumentId}` : "",
    plan?.requiredDocumentIds?.length ? `下一单元必读文档：${labels(plan.requiredDocumentIds)}` : "",
    plan?.conditionalDocumentIds?.length ? `下一单元按需文档：${labels(plan.conditionalDocumentIds)}` : "",
    rules.length ? `下一单元执行规则：${rules.join("、")}` : "",
    ...instructions.map((item) => `下一单元执行细则：${item}`),
    plan?.strongStoryMode ? `强剧情模式：开启${plan.strongStoryReasons?.length ? `（${plan.strongStoryReasons.map(continuityValue).filter(Boolean).join("；")}）` : ""}` : "",
    plan?.strongStoryMode ? "强剧情自检：必须执行并通过后才能进入下一单元" : "",
  ].filter(Boolean).join("\n");
};

export const projectContextDocumentText = ({ documentId = "", text = "", continuityDelta = null, labelFor } = {}) => {
  const narrativeBody = isNarrativeUnitDocumentId(documentId)
    ? stripInternalNarrativeScaffolding(text, { documentId })
    : normalizeLines(text);
  const body = isContextPlaceholderContent(documentId, narrativeBody) ? "" : narrativeBody;
  const delta = trustedContinuityDeltaText(continuityDelta, { labelFor });
  return [body, delta].filter(Boolean).join("\n\n");
};
