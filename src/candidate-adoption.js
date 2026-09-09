import { contentRevision } from "./workspace-operations.js";

export const normalizeCandidateLandingValue = (value = "") => String(value ?? "")
  .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/giu, " ")
  .replace(/<[^>]+>/gu, " ")
  .replace(/&nbsp;|&#160;/giu, " ")
  .replace(/\s+/gu, "")
  .trim();

export const candidateLandingProofsForVersion = (version = {}, message = null) => {
  const versionProofs = Array.isArray(version?.landedDocuments) ? version.landedDocuments : [];
  const messageProofs = Array.isArray(message?.landedDocuments) ? message.landedDocuments : [];
  const proofs = versionProofs.length ? versionProofs : messageProofs;
  return proofs
    .filter((proof) => proof && String(proof.documentId || "").trim())
    .map((proof) => ({
      documentId: String(proof.documentId).trim(),
      title: String(proof.title || "").trim(),
      content: String(proof.content || ""),
    }));
};

export const candidateLandingProofFingerprint = (proofs = []) => contentRevision(JSON.stringify(
  [...(Array.isArray(proofs) ? proofs : [])]
    .map((proof) => ({
      documentId: String(proof?.documentId || "").trim(),
      title: normalizeCandidateLandingValue(proof?.title || ""),
      content: normalizeCandidateLandingValue(proof?.content || ""),
    }))
    .filter((proof) => proof.documentId)
    .sort((left, right) => left.documentId.localeCompare(right.documentId)),
));

export const candidateVersionMatchesCurrentLanding = ({
  version = {},
  message = null,
  documents = {},
  documentContent = (documentState) => documentState?.html ?? documentState?.markdown ?? documentState?.text ?? "",
} = {}) => {
  const proofs = candidateLandingProofsForVersion(version, message);
  if (!proofs.length || new Set(proofs.map((proof) => proof.documentId)).size !== proofs.length) return false;
  return proofs.every((proof) => {
    const documentState = documents?.[proof.documentId];
    if (!documentState) return false;
    const expectedContent = normalizeCandidateLandingValue(proof.content);
    if (!expectedContent) return false;
    const contentMatches = normalizeCandidateLandingValue(documentContent(documentState))
      === expectedContent;
    const titleMatches = !proof.title
      || normalizeCandidateLandingValue(documentState.title || "") === normalizeCandidateLandingValue(proof.title);
    return contentMatches && titleMatches;
  });
};

export const candidateVersionIsAdopted = ({ group = {}, version = {}, message = null, documents = {}, documentContent } = {}) => {
  if (!candidateVersionMatchesCurrentLanding({ version, message, documents, documentContent })) return false;
  const adoptedVersionId = String(group?.adoptedVersionId || "");
  if (adoptedVersionId) return adoptedVersionId === String(version?.id || "");
  // Compatibility for candidate groups saved before adoptedVersionId existed.
  return message?.landingStatus === "complete";
};

export const recordCandidateAdoption = ({ group, version, landedDocuments = [], adoptedAt = Date.now() } = {}) => {
  if (!group || !version) return { group, version };
  const proofs = candidateLandingProofsForVersion({ landedDocuments }, null);
  const fingerprint = candidateLandingProofFingerprint(proofs);
  version.landedDocuments = structuredClone(proofs);
  version.adoptedContentFingerprint = fingerprint;
  version.lastAdoptedAt = adoptedAt;
  group.adoptedVersionId = String(version.id || "");
  group.adoptedCandidateId = String(version.candidateId || "");
  group.adoptedContentFingerprint = fingerprint;
  group.adoptedAt = adoptedAt;
  return { group, version, fingerprint };
};
