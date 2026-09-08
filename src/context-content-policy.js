import { isLegacyNarrativePlaceholderText, isNarrativeUnitDocumentId } from "./narrative-placeholder.js";
import { sha256HexSync } from "./version-integrity.js";

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

const LEGACY_BODY_HASHES = Object.freeze({
  "outline-series": [
    "62a58ba2d72f27b47c216be8b48e03d66152a4c1cfde67567e5221f27ff8186c"
  ],
  "outline-volume-1": [
    "34fe51ebb0db2cdc803d2b30a61f69aa9bf6990db19b7e247e727afcc46e2720"
  ],
  "outline-chapter-6": [
    "9c7b25000adb54f846cf8035743351795c118935392f6ef76b57a50eb14c89f1"
  ],
  "canon-characters": [
    "ed5ef3e4ecb1d2504d76f660d2fbd6cc948dd5373d5ff8730509b76c7dedc712"
  ],
  "canon-factions": [
    "3480dddf8865ec33e09746a4f86d8f7436b31e29415ec9043e5db7eefcaa0aee"
  ],
  "canon-relations": [
    "5436eeb960ab28f89e66f1eff68254b5b14caaeca6cbb291874f47c53c8ac81f"
  ],
  "canon-locations": [
    "f515699114081a9ee1550506241a4ea229a017cd8348b19d6432a22122cf5e5d"
  ],
  "canon-items": [
    "4ffcd42b6ea6be6409145f8895deb6107159563c99ec8c3c7e6aaa1e711fa81d"
  ],
  "memory-foreshadowing": [
    "61bcb164c40b124a3a56246eedad547c6dcda3f59268643d8c7d4ab93a293a3c"
  ],
  "memory-first-appearance": [
    "7c8e8f1ef3b4d1327e2a193976299bcba0641b266cba13f663ab3dbb10b00577"
  ],
  "memory-release": [
    "6deebfe8ebf433c857ad20dcd1656a3a21eb5adaca3e4c58bdd55dd0d684d88f"
  ],
  "memory-reader": [
    "39fa65cdd66b8a0edb7bbb1af12ea6f91847fed50384403aa042f41414c4d97f"
  ],
  "memory-snapshot": [
    "8d323690df925aebfc954a56f67d767f622d9e703180141b847e3d9c701aae16"
  ],
  "script-episode-1": [
    "e346b0a6ec8e969b328bacb0575f7f1a9fc8af8f41ba47d8308c1e9d752c58c1"
  ],
  "prompt-video-1": [
    "1bbc64d2870cedd6632b744977737359d53026a8add74b96b8f40094b56e45f9"
  ],
  "prompt-visual-assets": [
    "181010888cf4c37d3afc850076d4da4df2396af64a31a83aeb237f90ad391c4f"
  ],
  "prompt-panorama-1": [
    "a5090adaf230cccc199640e0851bce972cb55d84c6bedbad1dcdeaf371c44485"
  ],
  "script-outline-series": [
    "e9bd7ad90974d3af8e7498f3e4a775dd857e3d9d34a1c8d5c984c50fadc13882"
  ],
  "script-outline-episode-1": [
    "c9b0ce14fbbc9eaf0817088d298e7eb7a2a424ae6c4c3e6a881e9e7c8365251d"
  ],
  "script-canon-characters": [
    "98432ff6f563e9a1f21a7e3b5e6c0f47703db3bf7a94fdf198c8c1f40c24da27"
  ],
  "script-canon-relations": [
    "447af3cd6c44217067b020dcd76ba16f03a467e1808f551bde2e3de688fa328f"
  ],
  "script-canon-world": [
    "749ac71f050e1878c349cda9991c477f79d724fd38629b8fd59d53183ff5201e"
  ],
  "script-canon-locations": [
    "522381c34fc196671581c5450a0c39a32619028259a5bdf925a1f4b46f13d23b"
  ],
  "script-canon-factions": [
    "25790796e5977a73249dfd1f5e280d8c111a8d7836ad6702f3b6c83eef97e25a"
  ],
  "script-canon-events": [
    "0250aeb7afd3b8315d6597eab81e309b9e0e03e651c11bd8f899728236bfe26f"
  ],
  "script-canon-items": [
    "c9535331b74747a1a9a4110e437ec6172f6f7016b36589b8eb07e4d15e1f4932"
  ],
  "script-canon-glossary": [
    "5b6f951d292de4844dc85b3239bbba246bc4ac13b2872c800aceb18e2c066a9c"
  ],
  "script-memory-foreshadowing": [
    "08235310fb4b1cd9260b994439c685e5845b0aa316f9979d5c201762939baa7e"
  ],
  "script-memory-first-appearance": [
    "fc6dbeb12c7aaeabf127a3ee34fb95589ae684841f57d9251f2d653b6eb1df66"
  ],
  "script-memory-release": [
    "4cadfc8376b11e2850d140e870ea6d4b827eea4f04cbce6a1899f491c8e8a2a4"
  ],
  "script-memory-audience": [
    "1ebe2cf04ebf3774e5119b06fc30884859f9e514d18bf2b8754a8c5cf61a492a"
  ],
  "script-memory-snapshot": [
    "f610e4085d5e6f3f97fabdb478e32351dd0d96aec75494248f0b62687c416a1b"
  ],
  "library-reference": [
    "d8d7adb9f26e638d1776a2cd2c355dedbaebeeda9bda3d35156738d454110c9d"
  ],
  "library-retired": [
    "c53cf3b066ccdd36505f83add4c28b12a038323d873d356b0676166f857deae5"
  ],
  "index-language-blacklist": [
    "6a1c547dd656570594837f9648aa5f2917cd485e2582d724c4f2a3bcb2c07921",
    "6a491fb75015f9245bee86492ac9928b2b8dacca2bbd9da369e46a8c1a5e9fa3",
    "62229007879e44d40ac1eaf06b281c3160c73d23ad96967a0ad6f8261f4e4214",
    "7c53b1669c25f86ebfce6a48797494b1afaaf5f8b08fca655d5566b578642b4d"
  ]
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
  const hashes = LEGACY_BODY_HASHES[String(documentId)] ?? [];
  return [text, withoutFirstContentLine(text)].map(normalizedSignature).filter(Boolean).some((value) => hashes.includes(sha256HexSync(value)));
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
