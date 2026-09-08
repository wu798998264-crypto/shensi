import { displayOnlyIndexDocumentIds, indexPolicies } from "./index-policy.js";

const text = (value = "") => String(value ?? "").trim();
const unique = (values) => [...new Set(values.filter(Boolean))];

const indexWriteBindings = () => Object.fromEntries(Object.entries(indexPolicies()).map(([documentId, policy]) => [documentId, {
  scenarios: [...(policy.writeScenarios ?? [])],
  target: text(policy.writeTarget || documentId),
  authority: text(policy.writeAuthority || "none"),
}]));

export const NOVEL_MEMORY_DOCUMENT_IDS = Object.freeze([
  "memory-reader",
  "memory-foreshadowing",
  "memory-information-ledger",
  "memory-release",
  "memory-first-appearance",
  "memory-snapshot",
]);

export const SCRIPT_MEMORY_DOCUMENT_IDS = Object.freeze([
  "script-memory-audience",
  "script-memory-foreshadowing",
  "script-memory-information-ledger",
  "script-memory-release",
  "script-memory-first-appearance",
  "script-memory-snapshot",
]);

export const NOVEL_CANON_DOCUMENT_IDS = Object.freeze([
  "canon-characters",
  "canon-relations",
  "canon-world",
  "canon-locations",
  "canon-factions",
  "canon-events",
  "canon-items",
  "canon-glossary",
]);

export const PROJECT_MANAGEMENT_DOCUMENT_IDS = Object.freeze([
  "report-compile",
  "index-language-blacklist",
  "index-pending",
  "report-novel",
  "report-script",
  "report-adaptation",
  "index-update-log",
]);

export const sourceAuthorityForDocument = (documentId = "", moduleId = "") => {
  const id = text(documentId);
  const module = text(moduleId);
  if (/^(?:chapter-\d+|script-episode-\d+)$/.test(id) || module === "manuscript") return "realized";
  if (/^(?:outline-|script-outline-)/.test(id) || module === "outline") return "planned";
  if (/^(?:canon-|script-canon-)/.test(id) || module === "canon") return "canon";
  if (/^(?:memory-|script-memory-)/.test(id) || module === "memory") return "memory";
  if (module === "library") return "reference";
  return "derived";
};

export const compilePostCommitProjection = ({ documents = [], crossFormat = false } = {}) => {
  const committed = (Array.isArray(documents) ? documents : []).map((document) => ({
    documentId: text(document?.documentId || document?.id),
    moduleId: text(document?.moduleId || document?.target?.moduleId),
    contextDomain: text(document?.contextDomain || document?.target?.contextDomain),
  })).filter((document) => document.documentId);
  const authorities = committed.map((document) => sourceAuthorityForDocument(document.documentId, document.moduleId));
  const hasNovelRealized = committed.some((document, index) => authorities[index] === "realized" && !/^script-episode-/.test(document.documentId) && document.contextDomain !== "script");
  const hasScriptRealized = committed.some((document, index) => authorities[index] === "realized" && (/^script-episode-/.test(document.documentId) || document.contextDomain === "script"));
  const directDocumentIds = committed.map((document) => document.documentId);
  return {
    schemaVersion: 1,
    directDocumentIds,
    authorities: Object.fromEntries(committed.map((document, index) => [document.documentId, authorities[index]])),
    memory: {
      realizedDocumentIds: committed.filter((document, index) => authorities[index] === "realized").map((document) => document.documentId),
      eligibleDocumentIds: unique([
        ...(hasNovelRealized ? NOVEL_MEMORY_DOCUMENT_IDS : []),
        ...(hasScriptRealized ? SCRIPT_MEMORY_DOCUMENT_IDS : []),
      ]),
      plannedContentMustNotBecomeRealized: authorities.includes("planned"),
    },
    outline: {
      automaticDocumentIds: [],
      requiresExplicitAuthorization: true,
    },
    canon: {
      automaticDocumentIds: [],
      requiresExplicitAuthorization: true,
    },
    index: {
      displayOnlyDocumentIds: displayOnlyIndexDocumentIds(),
      readDuringCreativeWriting: ["index-language-blacklist", "index-pending"],
      syncAfterCommit: ["report-compile", "index-update-log", "index-pending"],
      writeBindings: indexWriteBindings(),
    },
    cockpit: {
      immediateDocumentIds: ["report-compile", "index-update-log", "index-pending"],
      formalReportDocumentIds: unique([
        ...(hasNovelRealized ? ["report-novel"] : []),
        ...(hasScriptRealized ? ["report-script"] : []),
        ...(crossFormat ? ["report-adaptation"] : []),
      ]),
      formalReportAuthorization: "explicit_self_check_only",
      creativeContractMutation: "explicit_author_instruction_only",
    },
  };
};
