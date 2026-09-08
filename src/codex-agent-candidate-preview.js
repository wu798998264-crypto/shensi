import { splitCandidateChapters } from "./candidate-chapters.js";
import { finalizeCandidateBasis } from "./candidate-provenance.js";
import { cleanFormalDocumentContent } from "./obsidian-markdown.js";
import { extractFormalArtifacts, formalArtifactCommitEligibility, formalArtifactContentAssessment } from "./formal-artifact-extractor.js";
import { bindFormalWriteCandidate, validateFormalWriteAuthorization } from "./formal-write-authorization.js?v=5.5.2-guidance-write-authorization";
import { taskContractContentCharacterCount } from "./task-contract.js?v=3.0.10-character-preflight-2";

export const codexAgentCompletionNeedsLandingProof = ({ route = null, runStatus = "", previewed = false } = {}) => (
  String(runStatus || "").toLocaleLowerCase() === "completed"
  && previewed !== true
  && (route?.formalArtifactExpected === true
    || route?.candidatePreviewRequired === true
    || route?.writeAuthorization?.state === "commit"
    || route?.taskPolicy?.writeAuthorization?.state === "commit")
  && route?.commitOwner === "shensi_transaction"
  && route?.commitDisposition === "auto_commit"
);

const previewSource = (value = "") => String(value)
  .replace(/^\s*【候选稿】\s*/u, "")
  .trim();

const normalizedArtifactKind = (value = "") => {
  const kind = String(value || "").trim().toLowerCase();
  if (["setting", "canon", "world", "character"].includes(kind)) return "setting";
  if (["outline", "plan", "planning"].includes(kind)) return "outline";
  if (["prose", "novel", "chapter", "manuscript", "text"].includes(kind)) return "prose";
  return kind;
};

const taskContractForPreview = (route = null, target = null) => (
  route?.taskContract?.protocol ? route.taskContract
    : target?.taskContract?.protocol ? target.taskContract
      : target?.creativeMutationPlan?.taskContract?.protocol ? target.creativeMutationPlan.taskContract
        : null
);

export const codexAgentCandidatePreview = ({
  text = "",
  route = null,
  target = null,
  candidateBasisSeed = null,
  instruction = "",
  runStatus = "completed",
} = {}) => {
  const explicitWrite = route?.writeAuthorization?.state === "commit"
    || route?.taskPolicy?.writeAuthorization?.state === "commit";
  if (!explicitWrite && route?.formalArtifactExpected !== true && route?.candidatePreviewRequired !== true) return null;
  if (!formalArtifactCommitEligibility({ route, runStatus }).eligible) return null;
  const source = cleanFormalDocumentContent(previewSource(text));
  const assessment = formalArtifactContentAssessment({ content: source, instruction });
  const formalSource = assessment.valid ? assessment.content : source;
  if (!formalSource) return null;
  const writeAuthorization = bindFormalWriteCandidate(route.writeAuthorization, {
    candidate: formalSource,
    targetDocumentIds: route.writeAuthorization?.targetDocumentIds,
    expectedRevisions: route.writeAuthorization?.expectedRevisions,
  });
  if (!validateFormalWriteAuthorization(writeAuthorization, {
    requiredState: route.writeAuthorization?.state === "candidate_only" ? "candidate_only" : "commit",
    candidate: formalSource,
    targetDocumentIds: route.writeAuthorization?.targetDocumentIds,
    expectedRevisions: route.writeAuthorization?.expectedRevisions,
  }).valid) return null;
  if (!assessment.valid) {
    const documentIds = [...new Set([
      ...(route.writeAuthorization?.targetDocumentIds ?? []),
      target?.documentId,
    ].map(String).filter(Boolean))];
    const generationBasis = finalizeCandidateBasis({ seed: candidateBasisSeed, targetDocumentIds: documentIds });
    const unresolvedTarget = {
      ...(target || {}),
      generationBasis,
      landingBlocked: true,
      landingBlockReason: assessment.reason || "candidate_content_requires_confirmation",
      requiresContentConfirmation: true,
    };
    return {
      candidate: formalSource,
      writeAuthorization,
      candidateDocuments: target?.documentId ? [{ content: formalSource, target: unresolvedTarget }] : [],
      target: unresolvedTarget,
    };
  }
  const taskContract = taskContractForPreview(route, target);
  const requiredDeliverables = Array.isArray(taskContract?.deliverables)
    ? taskContract.deliverables.filter((item) => item?.required !== false && item?.targetDocumentId)
    : [];
  const byDeliverableId = new Map(requiredDeliverables.map((item) => [String(item.id), item]));
  const byDocumentId = new Map(requiredDeliverables.map((item) => [String(item.targetDocumentId), item]));
  const extracted = extractFormalArtifacts({ response: formalSource, instruction, target });
  let documents = [];
  let expectedCount = requiredDeliverables.length || Math.max(0, Number(target?.batchRequest?.count) || 0);

  if (requiredDeliverables.length && extracted.structuredResponse) {
    const seen = new Set();
    for (const artifact of extracted.artifacts) {
      const deliverable = byDeliverableId.get(String(artifact.deliverableId || ""))
        || byDocumentId.get(String(artifact.targetDocumentId || ""));
      if (!deliverable || seen.has(deliverable.id)) return null;
      const artifactKind = normalizedArtifactKind(artifact.contentType);
      if (artifactKind && artifactKind !== "document" && artifactKind !== normalizedArtifactKind(deliverable.kind)) return null;
      seen.add(deliverable.id);
      documents.push({
        content: cleanFormalDocumentContent(artifact.content),
        memoryUpdate: artifact.memoryUpdate ?? null,
        target: {
          ...(deliverable.target || {}),
          documentId: deliverable.targetDocumentId,
          moduleId: deliverable.target?.moduleId || "",
          title: artifact.title || deliverable.title,
          deliverableId: deliverable.id,
          deliverableKind: deliverable.kind,
          explicitArtifact: true,
        },
      });
    }
  } else if (requiredDeliverables.length === 1) {
    const deliverable = requiredDeliverables[0];
    const artifact = extracted.artifacts[0];
    documents = [{
      content: cleanFormalDocumentContent(artifact?.content || formalSource),
      memoryUpdate: artifact?.memoryUpdate ?? null,
      target: {
        ...(deliverable.target || {}),
        documentId: deliverable.targetDocumentId,
        moduleId: deliverable.target?.moduleId || "",
        title: artifact?.title || deliverable.title,
        deliverableId: deliverable.id,
        deliverableKind: deliverable.kind,
        explicitArtifact: true,
      },
    }];
  } else {
    const batchDocumentIds = Array.isArray(target?.batchRequest?.documentIds) ? target.batchRequest.documentIds : [];
    const batchStartChapter = Math.max(1, Number(target?.batchRequest?.startChapter) || 1);
    const parsed = splitCandidateChapters(formalSource, target).map((document) => {
      const chapterNumber = Number(document.target?.chapterNumber) || 0;
      const requestedDocumentId = chapterNumber ? batchDocumentIds[chapterNumber - batchStartChapter] : "";
      return requestedDocumentId ? { ...document, target: { ...document.target, documentId: requestedDocumentId } } : document;
    });
    documents = expectedCount > 1 ? parsed.filter((document) => document.target?.inferredFromOutput) : parsed;
  }
  documents = documents.filter((document) => document.content && document.target?.documentId);
  const documentIds = [...new Set([
    ...documents.map((document) => document.target?.documentId),
    target?.documentId,
  ].filter(Boolean))];
  const generationBasis = finalizeCandidateBasis({ seed: candidateBasisSeed, targetDocumentIds: documentIds });

  if (expectedCount > 1 || documents.length > 1) {
    const batchDocuments = documents.map((document) => ({
      ...document,
      target: { ...document.target, generationBasis },
    }));
    const batchByDocumentId = new Map(batchDocuments.map((document) => [String(document.target?.documentId || ""), document]));
    const invalidDeliverables = requiredDeliverables.flatMap((deliverable) => {
      const document = batchByDocumentId.get(String(deliverable.targetDocumentId || ""));
      if (!document) return [];
      const actualCharacters = taskContractContentCharacterCount({ text: document.content });
      return deliverable.minCharacters > 0 && actualCharacters < deliverable.minCharacters
        ? [{ deliverableId: deliverable.id, targetDocumentId: deliverable.targetDocumentId, reason: `content_too_short:${actualCharacters}/${deliverable.minCharacters}` }]
        : [];
    });
    return {
      candidate: formalSource,
      writeAuthorization,
      candidateDocuments: batchDocuments,
      target: {
        kind: requiredDeliverables.some((item) => item.kind !== "prose") ? "document-batch" : "chapter-batch",
        explicitChapter: requiredDeliverables.length ? requiredDeliverables.every((item) => item.kind === "prose") : true,
        chapterDocuments: batchDocuments,
        expectedChapterCount: expectedCount || batchDocuments.length,
        incompleteBatch: (expectedCount > 1 && batchDocuments.length < expectedCount) || invalidDeliverables.length > 0,
        invalidDeliverables,
        ...(taskContract ? { taskContract } : {}),
        ...(target?.creativeMutationPlan ? { creativeMutationPlan: target.creativeMutationPlan } : {}),
        generationBasis,
      },
    };
  }

  const document = documents[0] || { content: formalSource, target };
  const resolvedTarget = {
    ...(document.target || target),
    ...(taskContract ? { taskContract } : {}),
    ...(target?.creativeMutationPlan ? { creativeMutationPlan: target.creativeMutationPlan } : {}),
    generationBasis,
  };
  const content = cleanFormalDocumentContent(document.content || formalSource);
  return {
    candidate: formalSource,
    writeAuthorization,
    candidateDocuments: [{ ...document, content, target: resolvedTarget }],
    target: resolvedTarget,
  };
};
