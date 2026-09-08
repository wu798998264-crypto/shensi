import { chapterNumberValue } from "./chapter-target.js";
import { canonicalEpisodeTitle, parseEpisodeHeading } from "./episode-document.js";
import { cleanFormalDocumentContent } from "./obsidian-markdown.js";
import { generatedDocumentTitleFromContent, genericLandingDocumentTitle } from "./document-landing-title.js?v=2.19.7-continuation-title";
import { validateFormalWriteAuthorization } from "./formal-write-authorization.js";

const CHAPTER_HEADING = /^(?:#{1,6}\s*)?第\s*(\d+|[零〇一二两三四五六七八九十百千]+)\s*章(?:[\t 　:：·—|｜-]+(.+))?$/;

const normalizedTitle = (value = "") => String(value).trim().replace(/^[-—:：·\s　]+/, "").slice(0, 100);
const chapterHeadingText = (line = "") => String(line)
  .trim()
  .replace(/<\/?(?:div|p|h[1-6]|strong|b)\b[^>]*>/gi, "")
  .trim();

const uniqueTargetIds = (values = []) => [...new Set((Array.isArray(values) ? values : [values])
  .map((value) => String(value || "").trim())
  .filter(Boolean))];

// A verified single-document contract owns the landing destination. Headings
// emitted by a model describe content; they must not silently turn that one
// authorized document into a chapter batch.
export const candidateDocumentTargetPolicy = ({
  fallbackTarget = null,
  writeAuthorization = null,
  taskContract = null,
  batchCount = 0,
} = {}) => {
  const deliverables = Array.isArray(taskContract?.deliverables)
    ? taskContract.deliverables.filter((item) => item?.required !== false && String(item?.targetDocumentId || item?.targetDocument || "").trim())
    : [];
  const authorizedIds = uniqueTargetIds(writeAuthorization?.targetDocumentIds);
  const deliverableIds = uniqueTargetIds(deliverables.map((item) => item.targetDocumentId || item.targetDocument));
  const explicitBatch = Number(batchCount) > 1
    || authorizedIds.length > 1
    || deliverableIds.length > 1
    || ((!authorizedIds.length && !deliverableIds.length)
      && ["chapter-batch", "document-batch"].includes(String(fallbackTarget?.kind || "")));
  if (explicitBatch) return { mode: "split", target: fallbackTarget, targetDocumentIds: authorizedIds.length ? authorizedIds : deliverableIds };

  const documentId = authorizedIds.length === 1
    ? authorizedIds[0]
    : deliverableIds.length === 1 ? deliverableIds[0] : "";
  if (!documentId) return { mode: "infer", target: fallbackTarget, targetDocumentIds: [] };
  const deliverable = deliverables.find((item) => String(item.targetDocumentId || item.targetDocument) === documentId);
  return {
    mode: "single",
    targetDocumentIds: [documentId],
    target: {
      ...(fallbackTarget || {}),
      ...(deliverable?.target && typeof deliverable.target === "object" ? deliverable.target : {}),
      documentId,
    },
  };
};

export const splitCandidateChapters = (text = "", fallbackTarget = null) => {
  const normalized = String(text).replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const lines = normalized.split("\n");
  const headings = [];
  lines.forEach((line, index) => {
    const match = chapterHeadingText(line).match(CHAPTER_HEADING);
    if (match) {
      const chapterNumber = chapterNumberValue(match[1]);
      if (chapterNumber) headings.push({ index, kind: "chapter", number: chapterNumber, title: normalizedTitle(match[2]) });
      return;
    }
    const episode = parseEpisodeHeading(line);
    if (episode) headings.push({ index, kind: "episode", number: episode.number, title: episode.title });
  });
  if (!headings.length) {
    const resolvedTarget = fallbackTarget ? { ...fallbackTarget } : null;
    if (resolvedTarget?.documentId && /^chapter-\d+$/u.test(resolvedTarget.documentId)
      && genericLandingDocumentTitle(resolvedTarget.chapterTitle || resolvedTarget.title || "未命名")) {
      resolvedTarget.chapterTitle = generatedDocumentTitleFromContent(normalized, { fallback: "本章正文" });
    }
    if (resolvedTarget?.documentId && /^script-episode-\d+$/u.test(resolvedTarget.documentId)
      && genericLandingDocumentTitle(resolvedTarget.episodeTitle || resolvedTarget.title || "未命名")) {
      resolvedTarget.episodeTitle = generatedDocumentTitleFromContent(normalized, { fallback: "本集正文" });
    }
    return [{ content: normalized, target: resolvedTarget }];
  }
  return headings.map((heading, index) => {
    const nextIndex = headings[index + 1]?.index ?? lines.length;
    const content = lines.slice(heading.index + 1, nextIndex).join("\n").trim();
    if (heading.kind === "episode") {
      const documentId = `script-episode-${heading.number}`;
      const episodeTitle = heading.title || generatedDocumentTitleFromContent(content, { fallback: "本集正文" });
      return {
        content,
        heading: canonicalEpisodeTitle({ documentId, episodeNumber: heading.number, episodeTitle }),
        target: {
          documentId,
          moduleId: "manuscript",
          viewId: "script",
          contextDomain: "script",
          title: canonicalEpisodeTitle({ documentId, episodeNumber: heading.number, episodeTitle }),
          episodeNumber: heading.number,
          episodeTitle,
          explicitArtifact: true,
          inferredFromOutput: true,
        },
      };
    }
    const chapterTitle = heading.title || generatedDocumentTitleFromContent(content, { fallback: "本章正文" });
    return {
      content,
      heading: `第${heading.number}章　${chapterTitle}`,
      target: {
        chapterNumber: heading.number,
        documentId: `chapter-${heading.number}`,
        chapterTitle,
        explicitChapter: true,
        inferredFromOutput: true,
      },
    };
  }).filter(({ content }) => content);
};

export const duplicateChapterTargets = (documents = []) => {
  const seen = new Set();
  const duplicates = new Set();
  for (const document of documents) {
    const id = document.target?.documentId;
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
};

const deliverableTypeFor = ({ sourceInstruction = "", target = null, content = "" } = {}) => {
  const instruction = String(sourceInstruction || "");
  if (/(?:自检|诊断|审稿|审查|检查|验收|评估|质量(?:复检|审计))/u.test(instruction)) return "review_report";
  if (/提示词|prompt/iu.test(instruction) || target?.viewId === "prompts") return "prompt";
  if (/剧本|短剧|漫剧/u.test(instruction) || target?.contextDomain === "script") return "script";
  if (target?.moduleId === "reports" || /(?:自检|诊断|审查)(?:结论|报告)/u.test(String(content || "").slice(0, 240))) return "review_report";
  return "prose";
};

const targetForDeliverableType = ({ target = null, deliverableType = "prose", sourceInstruction = "" } = {}) => {
  if (deliverableType !== "review_report") return target;
  const source = String(sourceInstruction || "");
  const adaptation = /小说.{0,20}(?:改编|改成|改写成|转换成|转成).{0,10}(?:短剧|剧本|漫剧)|改编剧本|改编报告|小说改剧本/u.test(source)
    || target?.documentId === "report-adaptation"
    || target?.contextDomain === "script-adaptation";
  const script = adaptation || /剧本|短剧|漫剧/u.test(source) || target?.contextDomain === "script";
  const documentId = adaptation ? "report-adaptation" : script ? "report-script" : "report-novel";
  return {
    ...(target || {}),
    kind: "artifact",
    documentId,
    moduleId: "reports",
    viewId: "default",
    contextDomain: script ? "script" : "novel",
    title: documentId === "report-adaptation" ? "小说改剧本编译报告" : script ? "剧本自检" : "小说自检",
    explicitArtifact: true,
    reportKind: "self_check",
  };
};

const CANDIDATE_TARGET_PROVENANCE_KEYS = [
  "generationBasis",
  "generationAttemptRequestId",
  "landingBlocked",
  "landingBlockReason",
  "notebookDestination",
  "standaloneNotebookDeliverable",
  "memoryUpdates",
  "artifactPlan",
  "experienceCandidate",
  "experienceObservation",
  "trustedActionResults",
];

export const candidateWriteAuthorizationForRecovery = (message = null, attempt = null) => (
  message?.writeAuthorization
  ?? message?.execution?.taskRoute?.writeAuthorization
  ?? attempt?.resultData?.payload?.creativeTask?.writeAuthorization
  ?? attempt?.resultData?.payload?.execution?.writeAuthorization
  ?? null
);

// Parsed chapter/document targets describe where content belongs, while the
// message target owns the immutable generation/landing contract. Never let a
// parser-created child target discard that contract before the safety check.
export const inheritCandidateTargetProvenance = (target = null, authorityTarget = null) => {
  const resolved = { ...(target || authorityTarget || {}) };
  for (const key of CANDIDATE_TARGET_PROVENANCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(authorityTarget ?? {}, key)) resolved[key] = authorityTarget[key];
  }
  return resolved;
};

export const candidateBatchTarget = ({ documents = [], authorityTarget = null, kind = "document-batch" } = {}) => ({
  ...inheritCandidateTargetProvenance({}, authorityTarget),
  kind,
  explicitChapter: true,
  chapterDocuments: documents.map((document) => ({
    ...document,
    target: inheritCandidateTargetProvenance(document.target, authorityTarget),
  })),
  expectedChapterCount: documents.length,
  incompleteBatch: false,
});

const candidateMessageOrder = (message, index) => {
  const updatedAt = Date.parse(String(message?.generationAttempt?.updatedAt || message?.generationAttempt?.heartbeatAt || ""));
  if (Number.isFinite(updatedAt)) return updatedAt;
  const endedAt = Number(message?.execution?.endedAt);
  if (Number.isFinite(endedAt) && endedAt > 0) return endedAt;
  const idTimestamp = Number(String(message?.id || "").match(/(?:^|[-_])(\d{12,})(?:[-_]|$)/)?.[1]);
  if (Number.isFinite(idTimestamp) && idTimestamp > 0) return idTimestamp;
  return index;
};

const recoverableDocuments = (message, fallbackTarget, sourceInstruction = "") => {
  const taskRoute = message?.execution?.taskRoute;
  const authorization = taskRoute?.writeAuthorization ?? message?.writeAuthorization ?? null;
  const sourceMessageId = String(message?.execution?.sourceMessageId || "").trim();
  const candidate = String(message?.candidate || "").trim();
  if (!sourceMessageId || !candidate || !authorization) return [];
  const authorizationCheck = validateFormalWriteAuthorization(authorization, {
    requiredState: authorization.state === "candidate_only" ? "candidate_only" : "commit",
    sourceMessageId,
    instruction: sourceInstruction,
    candidate,
    targetDocumentIds: authorization.targetDocumentIds,
    expectedRevisions: authorization.expectedRevisions,
  });
  if (!authorizationCheck.valid) return [];
  const messageTargetId = String(message?.target?.documentId || "").trim();
  if (["report-novel", "report-script", "report-adaptation"].includes(messageTargetId)
    && (["failed", "retry_required", "hard_blocked", "cancelled", "commit_unknown", "verification_pending"].includes(message?.execution?.status)
      || message?.generationAttempt?.recoveryEvidence
      || /<\/?(?:tool_call|arg_?key|arg_?value)\b/iu.test(candidate))) return [];
  if (messageTargetId && !authorization.targetDocumentIds?.includes(messageTargetId)) return [];
  if (Array.isArray(message?.candidateDocuments) && message.candidateDocuments.length) {
    const initialTarget = message?.target || fallbackTarget;
    const candidateText = message.candidateDocuments.map((document) => document?.content || "").join("\n\n");
    const deliverableType = deliverableTypeFor({ sourceInstruction, target: initialTarget, content: candidateText });
    const authorityTarget = targetForDeliverableType({ target: initialTarget, deliverableType, sourceInstruction });
    return message.candidateDocuments
      .filter((document) => document?.content && document?.target?.documentId)
      .map((document) => ({
        ...document,
        target: inheritCandidateTargetProvenance(
          targetForDeliverableType({ target: document.target, deliverableType, sourceInstruction }),
          authorityTarget,
        ),
        deliverableType,
      }));
  }
  const text = cleanFormalDocumentContent(candidate);
  if (!text) return [];
  const initialTarget = message?.target || fallbackTarget;
  const deliverableType = deliverableTypeFor({ sourceInstruction, target: initialTarget, content: text });
  const authorityTarget = targetForDeliverableType({ target: initialTarget, deliverableType, sourceInstruction });
  const parsed = splitCandidateChapters(text.replace(/^【候选稿】\s*/, ""), authorityTarget)
    .map((document) => ({
      ...document,
      target: inheritCandidateTargetProvenance(document.target, authorityTarget),
      deliverableType,
    }));
  return parsed;
};

export const latestRecoverableCandidate = ({ messages = [], fallbackTarget = null, instruction = "" } = {}) => {
  const orderedMessages = messages
    .map((message, index) => ({ message, index, order: candidateMessageOrder(message, index) }))
    .sort((left, right) => right.order - left.order || right.index - left.index);
  const explicitlyRequestsReport = /(?:自检|诊断|审稿|审查|检查|验收|评估|质量)(?:结论|报告)?|编译报告/u.test(String(instruction || ""));
  for (const { message, index } of orderedMessages) {
    if (message?.role !== "assistant" || message?.pending) continue;
    const sourceMessageId = String(message?.execution?.sourceMessageId || "");
    const sourceMessage = sourceMessageId
      ? messages.find((entry) => entry?.id === sourceMessageId && entry?.role === "user")
      : null;
    if (!sourceMessage) continue;
    const sourceInstruction = String(sourceMessage.content || "");
    const documents = recoverableDocuments(message, fallbackTarget, sourceInstruction);
    if (!documents.length) continue;
    const authorization = message?.execution?.taskRoute?.writeAuthorization ?? message?.writeAuthorization ?? null;
    const resolvedCandidate = documents.length === 1 ? {
        candidate: documents[0].content,
        target: documents[0].target || message.target || fallbackTarget,
        candidateDocuments: documents,
        deliverableType: documents[0].deliverableType || "prose",
        sourceInstruction,
        sourceMessageId,
        candidateMessageId: message.id,
        authorization,
      } : {
      candidate: documents.map((document) => document.content).join("\n\n"),
      target: candidateBatchTarget({ documents, authorityTarget: message.target || fallbackTarget, kind: "chapter-batch" }),
      candidateDocuments: documents,
      deliverableType: documents[0]?.deliverableType || "prose",
      sourceInstruction,
      sourceMessageId,
      candidateMessageId: message.id,
      authorization,
    };
    if (explicitlyRequestsReport && resolvedCandidate.deliverableType === "review_report") return resolvedCandidate;
    if (!explicitlyRequestsReport && resolvedCandidate.deliverableType !== "review_report") return resolvedCandidate;
  }
  return null;
};
