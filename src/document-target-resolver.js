import { requestedChapterTarget } from "./chapter-target.js";

const clean = (value = "") => String(value ?? "").trim();
const normalizedTarget = (target = null) => target?.documentId ? {
  ...target,
  documentId: clean(target.documentId),
  moduleId: clean(target.moduleId),
  contextDomain: clean(target.contextDomain),
  title: clean(target.title),
} : null;

const intendedDomain = (instruction = "") => {
  const text = clean(instruction);
  if (/(?:大纲|卷纲|章纲|剧情规划)/u.test(text)) return "outline";
  if (/(?:设定|世界观|人物档案|角色档案)/u.test(text)) return "setting";
  if (/(?:正文|章节|第[零〇一二两三四五六七八九十百\d]+章)/u.test(text)) return "novel";
  return "";
};

const targetMatchesDomain = (target, domain) => {
  if (!target || !domain) return true;
  if (domain === "novel") return target.moduleId === "manuscript" || /^chapter-\d+$/u.test(target.documentId);
  if (domain === "setting") return ["canon", "settings"].includes(target.moduleId) || target.contextDomain === "setting" || /^(?:canon-|script-canon-|setting)/u.test(target.documentId);
  if (domain === "outline") return target.moduleId === "outline" || target.contextDomain === "outline" || /^(?:outline-|script-outline-)/u.test(target.documentId);
  return true;
};

const resolved = (target, reason, inventoryIds) => ({
  status: "resolved",
  target: {
    ...target,
    operation: inventoryIds.has(target.documentId) ? "patch" : "create",
  },
  reason,
});

export const resolveDocumentTarget = ({
  instruction = "",
  selectionTarget = null,
  boundTarget = null,
  semanticTargets = [],
  activeTarget = null,
  inventory = [],
} = {}) => {
  const text = clean(instruction);
  const items = (Array.isArray(inventory) ? inventory : []).map(normalizedTarget).filter(Boolean);
  const inventoryIds = new Set(items.map((item) => item.documentId));
  const domain = intendedDomain(text);
  const explicitChapter = requestedChapterTarget(text);
  if (explicitChapter?.documentId && (!domain || domain === "novel")) {
    return resolved({
      documentId: explicitChapter.documentId,
      chapterNumber: explicitChapter.chapterNumber,
      title: `第${explicitChapter.chapterNumber}章 未命名`,
      moduleId: "manuscript",
      contextDomain: "novel",
    }, "explicit_instruction_target", inventoryIds);
  }
  const selection = normalizedTarget(selectionTarget);
  if (selection && /选区|这段|这句|所选/u.test(text)) return resolved(selection, "explicit_selection_target", inventoryIds);
  const bound = normalizedTarget(boundTarget);
  if (bound && /当前(?:文档|章节|正文)|本文档|本章/u.test(text)) return resolved(bound, "explicit_bound_target", inventoryIds);
  const semantic = (Array.isArray(semanticTargets) ? semanticTargets : []).map(normalizedTarget).filter(Boolean);
  const semanticMatch = semantic.find((target) => targetMatchesDomain(target, domain));
  if (semanticMatch) return resolved(semanticMatch, "semantic_target", inventoryIds);
  // A single semantic target is an explicit routing decision. Incidental
  // source words such as “根据当前设定写后续正文” must not let the legacy
  // keyword domain filter replace that decision with the bound read source.
  // Multiple conflicting semantic targets still fall through to the normal
  // domain/choice safeguards instead of being guessed here.
  if (semantic.length === 1) return resolved(semantic[0], "semantic_target_domain_override", inventoryIds);
  if (bound && targetMatchesDomain(bound, domain)) return resolved(bound, "bound_document_target", inventoryIds);
  const active = normalizedTarget(activeTarget);
  if (active && targetMatchesDomain(active, domain)) return resolved(active, "active_document_target", inventoryIds);
  if (!domain) {
    if (semantic[0]) return resolved(semantic[0], "semantic_fallback_target", inventoryIds);
    if (bound) return resolved(bound, "bound_fallback_target", inventoryIds);
    if (active) return resolved(active, "active_fallback_target", inventoryIds);
  }
  return { status: "needs_choice", target: null, reason: domain ? `target_not_resolved:${domain}` : "target_not_resolved" };
};
