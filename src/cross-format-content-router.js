import { explicitNewDocumentIntent } from "./automatic-landing-policy.js";

const clean = (value = "") => String(value ?? "").trim();

const CHINESE_NUMBER = "零一二三四五六七八九十百千万两";
const unitNumber = (value = "") => {
  const match = clean(value).match(new RegExp(`第\\s*([0-9${CHINESE_NUMBER}]+)\\s*(?:章|集)`, "u"));
  return match?.[1] ?? "";
};

export const contentTypeForDocument = (document = {}) => {
  const id = clean(document.id || document.documentId);
  const title = clean(document.title || document.name);
  const domain = clean(document.contextDomain);
  if (/^script-episode-/u.test(id) || /剧本|短剧|分镜剧本/u.test(title) || domain === "script") return "script";
  if (/^prompt-/u.test(id) || /提示词|seedance|视频提示/u.test(title)) return "prompt";
  if (/人物设定|角色设定/u.test(title)) return "character";
  if (/世界观|场景设定|地点设定/u.test(title)) return "world";
  if (/^chapter-/u.test(id) || /小说|第\s*[0-9一二三四五六七八九十百千万两]+\s*章/u.test(title) || domain === "novel") return "novel";
  return "document";
};

const targetTypeForInstruction = (instruction = "") => {
  const source = clean(instruction);
  if (!/(改编|改写|转换|转成|改成|生成|制作|根据|参考)/u.test(source)) return "";
  if (/分镜|视频提示词|Seedance|提示词/u.test(source)) return "prompt";
  if (/剧本|短剧/u.test(source)) return "script";
  if (/小说/u.test(source)) return "novel";
  if (/人物设定|角色设定/u.test(source)) return "character";
  if (/世界观|场景设定|地点设定/u.test(source)) return "world";
  return "";
};

const sourceTypeForInstruction = (instruction = "", targetType = "") => {
  const source = clean(instruction);
  if (/小说/u.test(source) && targetType !== "novel") return "novel";
  if (/剧本|短剧/u.test(source) && targetType !== "script") return "script";
  if (/提示词|Seedance/iu.test(source) && targetType !== "prompt") return "prompt";
  return "";
};

const isReferenceAssistedPatch = (instruction = "") => (
  /参考(?:一下)?原(?:小说|著|文)|更贴近原(?:小说|著|文)|对照原(?:小说|著|文)/u.test(clean(instruction))
  && /修改|改写|重写|优化|润色|压缩|调整|这一场|当前(?:场景|剧本)/u.test(clean(instruction))
);

export const isExplicitCrossFormatInstruction = (instruction = "") => {
  if (isReferenceAssistedPatch(instruction)) return true;
  const targetType = targetTypeForInstruction(instruction);
  if (!targetType) return false;
  return Boolean(
    sourceTypeForInstruction(instruction, targetType)
    || /将其|把它|这一章|这一集|当前(?:(?:源|原)?小说|剧本)|根据当前|参考原/u.test(clean(instruction)),
  );
};

const sourceReference = (instruction, documents, projectName = "") => {
  const quoted = clean(instruction).match(/[《“"]([^》”"]+)[》”"]/u)?.[1];
  const targetType = targetTypeForInstruction(instruction);
  const requestedSourceType = sourceTypeForInstruction(instruction, targetType);
  const number = unitNumber(instruction);
  const workName = clean(projectName || quoted);
  const candidates = documents.filter((document) => {
    if (requestedSourceType && contentTypeForDocument(document) !== requestedSourceType) return false;
    if (number && unitNumber(document.title || document.id) !== number) return false;
    return true;
  });
  if (quoted) {
    const exactTitle = candidates.find((document) => clean(document.title).includes(quoted));
    if (exactTitle) return exactTitle;
  }
  if (workName) {
    const workMatch = candidates.find((document) => [document.work, document.projectName, document.workspaceName]
      .some((value) => clean(value) === workName));
    if (workMatch) return workMatch;
  }
  return candidates.length === 1 ? candidates[0] : null;
};

const targetTitle = ({ type, source, number }) => {
  const sourceTitle = clean(source?.title).replace(/第\s*[0-9零一二三四五六七八九十百千万两]+\s*(?:章|集).*/u, "").trim();
  const prefix = sourceTitle ? `${sourceTitle} ` : "";
  if (type === "script") return `${prefix}第${number || "一"}集剧本`;
  if (type === "prompt") return `${prefix}第${number || "一"}${contentTypeForDocument(source) === "script" ? "集" : "章"}提示词`;
  if (type === "novel") return `${prefix}第${number || "一"}章小说`;
  if (type === "character") return `${prefix}人物设定`;
  return `${prefix}世界观设定`;
};

const moduleForType = (type) => type === "prompt" ? { moduleId: "manuscript", viewId: "prompts", kind: "document", contextDomain: "novel" }
  : type === "script" ? { moduleId: "manuscript", viewId: "script", kind: "document", contextDomain: "script" }
    : type === "novel" ? { moduleId: "manuscript", viewId: "novel", kind: "document", contextDomain: "novel" }
      : { moduleId: "outline", viewId: "novel", kind: "document", contextDomain: "novel" };

/**
 * Resolves an explicitly requested format conversion without treating the
 * visible/linked document as an automatic output destination. It is pure so
 * Chat and Agent can share the exact same routing decision.
 */
export const resolveCrossFormatContentRoute = ({ instruction = "", documents = [], associatedDocumentId = "", activeTargetDocumentId = "", chapterEpisodeMappings = [], projectName = "" } = {}) => {
  const list = (Array.isArray(documents) ? documents : []).map((document) => ({ ...document, id: clean(document.id || document.documentId) }));
  const associated = list.find((document) => document.id === clean(associatedDocumentId)) ?? null;
  const referenceAssistedPatch = isReferenceAssistedPatch(instruction) && associated;
  // “参考原小说修改当前剧本”中的小说是辅助来源，不是写入目标。
  // 目标必须保持为当前正在迭代的剧本文档，避免把修改结果反向覆盖到原小说。
  const targetType = referenceAssistedPatch
    ? contentTypeForDocument(associated)
    : targetTypeForInstruction(instruction);
  if (!targetType) return null;
  const explicit = sourceReference(instruction, list, projectName);
  const associatedUnit = unitNumber(associated?.title || associated?.id);
  const mappedReferenceSourceId = (Array.isArray(chapterEpisodeMappings) ? chapterEpisodeMappings : [])
    .find((mapping) => clean(mapping.targetDocumentId) === associated?.id && clean(mapping.sourceContentType || "novel") === "novel")
    ?.sourceDocumentId;
  const referenceSource = referenceAssistedPatch
    ? list.find((document) => document.id === clean(mappedReferenceSourceId))
      ?? list.find((document) => contentTypeForDocument(document) === "novel"
        && (!associatedUnit || unitNumber(document.title || document.id) === associatedUnit)
        && document.id !== associated.id)
    : null;
  const pronounSource = /(?:将其|把它|这一章|这一集|当前(?:(?:源|原)?小说|剧本)|根据这一章|根据当前剧本)/u.test(clean(instruction));
  // A pronoun explicitly points at the associated document. Project-level
  // inference must never override it merely because another document in the
  // same work happens to share the requested chapter/episode number.
  const source = referenceAssistedPatch
    ? referenceSource ?? explicit
    : pronounSource && associated ? associated : explicit;
  if (!source) return null;
  const sourceType = contentTypeForDocument(source);
  if (sourceType === targetType) return null;
  const number = unitNumber(instruction) || unitNumber(source.title) || unitNumber(source.id);
  const routedSource = clean(source.title).includes(clean(projectName)) || !clean(projectName)
    ? source
    : { ...source, title: `${clean(projectName)} ${clean(source.title)}` };
  const explicitCreate = explicitNewDocumentIntent(instruction);
  const preferredTitle = explicitCreate.title || targetTitle({ type: targetType, source: routedSource, number });
  const savedMapping = (Array.isArray(chapterEpisodeMappings) ? chapterEpisodeMappings : []).find((mapping) => (
    clean(mapping.sourceDocumentId) === source.id && clean(mapping.targetContentType) === targetType
  ));
  const mappedTargetIds = [savedMapping?.targetDocumentId, ...(savedMapping?.targetDocumentIds ?? [])].map(clean).filter(Boolean);
  const target = explicitCreate.create ? null : referenceAssistedPatch
    ? associated
    : list.find((document) => mappedTargetIds.includes(document.id))
    ?? list.find((document) => contentTypeForDocument(document) === targetType
    && clean(document.title) === preferredTitle)
    ?? list.find((document) => contentTypeForDocument(document) === targetType
    && (number ? unitNumber(document.title) === number : clean(document.title) === preferredTitle)
    && (targetType !== "prompt"
      || (contentTypeForDocument(source) === "script" ? /第\s*[0-9零一二三四五六七八九十百千万两]+\s*集/u : /第\s*[0-9零一二三四五六七八九十百千万两]+\s*章/u).test(clean(document.title)))) ?? null;
  const operationType = (referenceAssistedPatch || /优化|润色|修改|压缩|重写|改写/u.test(clean(instruction))) && target ? "patch" : "transform";
  return {
    sourceDocumentIds: [source.id],
    source: {
      documentId: source.id,
      contentType: sourceType,
      work: clean(projectName) || clean(instruction).match(/[《“"]([^》”"]+)[》”"]/u)?.[1] || clean(source.work || source.projectName),
      unit: number,
    },
    sourceDocumentId: source.id,
    sourceContentType: sourceType,
    sourceTitle: clean(source.title),
    targetContentType: targetType,
    targetDirectory: { moduleId: moduleForType(targetType).moduleId, viewId: moduleForType(targetType).viewId },
    targetDocumentId: target?.id ?? "",
    targetTitle: target?.title || preferredTitle,
    requestedTitle: target?.title || preferredTitle,
    target: target ? { documentId: target.id, moduleId: moduleForType(targetType).moduleId, contextDomain: moduleForType(targetType).contextDomain } : null,
    create: target ? null : { title: preferredTitle, ...moduleForType(targetType) },
    operationType,
    mappingSource: savedMapping ? "workspace_metadata" : "inferred",
    activeTargetDocumentId: clean(activeTargetDocumentId),
    referenceAssistedPatch: Boolean(referenceAssistedPatch),
  };
};
