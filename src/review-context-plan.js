import { resolveChapterOutlineSource } from "./chapter-outline-policy.js";
import { documentContentState } from "./version-store.js";

// Host-side document relationships, not another interpretation of the sentence.
export const reviewContextPlan = ({ sourceDocumentIds = [], documents = {}, contentFor = (id) => documents[id]?.text || "" } = {}) => {
  const sourceIds = [...new Set(sourceDocumentIds.filter(Boolean))];
  const support = new Set();
  const issues = [];
  const chapterNumbers = sourceIds.map((id) => Number(id.match(/^chapter-(\d+)$/)?.[1] || 0)).filter(Boolean);
  if (chapterNumbers.length) {
    const readable = Object.entries(documents).map(([id, document]) => ({ id, ...document, content: contentFor(id) }))
      .filter((document) => document.contextStatus !== "deprecated" && documentContentState(document.content, document) === "substantive");
    const outlines = readable.filter((document) => document.moduleId === "outline");
    for (const chapterNumber of chapterNumbers) {
      const binding = resolveChapterOutlineSource({ chapterNumber, candidates: outlines });
      if (binding.documentId) support.add(binding.documentId);
      else issues.push({ kind: "chapter_outline", chapterNumber, ...binding });
    }
    for (const document of readable) {
      if (document.moduleId === "canon" || document.moduleId === "outline" && !/^outline-chapter-/u.test(document.id)) support.add(document.id);
    }
  }
  return { sourceDocumentIds: sourceIds, supportDocumentIds: [...support], requiredDocumentIds: [...new Set([...sourceIds, ...support])], issues };
};
