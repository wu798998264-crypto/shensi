import { validateTaskContractForExecution } from "./task-contract.js";

const clone = (value) => value == null ? value : structuredClone(value);
const populatedObject = (value) => value && typeof value === "object" && Object.keys(value).length > 0;

const AUTHORITATIVE_ROUTE_FIELDS = Object.freeze([
  "mode",
  "recommendedMode",
  "action",
  "target",
  "targetDocumentId",
  "targetRevision",
  "commitDisposition",
  "commitOwner",
  "landingPolicy",
  "completionAuthority",
  "executionOwner",
  "shensiLed",
  "revisionIntent",
  "diagnosisIntent",
  "productionIntent",
  "deliverableType",
  "deliverableLabel",
  "landingConfirmationRequired",
  "reviewDelivery",
  "taskPolicy",
  "intentEnvelope",
  "hardBlocked",
  "taskContractValidation",
]);

export const mergeAgentExecutionTaskRoute = ({ preparedRoute = null, runtimeRoute = null } = {}) => {
  const prepared = preparedRoute && typeof preparedRoute === "object" ? preparedRoute : {};
  const runtime = runtimeRoute && typeof runtimeRoute === "object" ? runtimeRoute : {};
  const taskContract = prepared.taskContract?.protocol
    ? prepared.taskContract
    : runtime.taskContract?.protocol ? runtime.taskContract : null;
  const contractDecision = validateTaskContractForExecution(taskContract);
  const preparedContractIsAuthoritative = prepared.taskContract?.protocol && contractDecision.authoritative;
  const writeAuthorization = preparedContractIsAuthoritative
    ? populatedObject(prepared.writeAuthorization) ? prepared.writeAuthorization : null
    : populatedObject(runtime.writeAuthorization)
      ? runtime.writeAuthorization
      : populatedObject(prepared.writeAuthorization) ? prepared.writeAuthorization : null;
  const merged = {
    ...prepared,
    ...runtime,
    taskContract: clone(taskContract),
    writeAuthorization: clone(writeAuthorization),
    formalArtifactExpected: prepared.formalArtifactExpected === true || runtime.formalArtifactExpected === true,
    candidatePreviewRequired: prepared.candidatePreviewRequired === true || runtime.candidatePreviewRequired === true,
  };
  if (!preparedContractIsAuthoritative) return merged;
  for (const field of AUTHORITATIVE_ROUTE_FIELDS) {
    if (Object.hasOwn(prepared, field)) merged[field] = clone(prepared[field]);
  }
  merged.formalArtifactExpected = prepared.formalArtifactExpected === true;
  merged.candidatePreviewRequired = prepared.candidatePreviewRequired === true;
  merged.runtimeRerouteAllowed = false;
  return merged;
};

export const candidateBatchCoversRequestedTargets = ({ candidateDocuments = [], requestedTargets = [] } = {}) => {
  const requestedIds = requestedTargets.map((target) => String(target?.documentId || target?.targetDocumentId || "")).filter(Boolean);
  const candidateIds = candidateDocuments.map((document) => String(document?.target?.documentId || "")).filter(Boolean);
  if (requestedIds.length < 2 || candidateIds.length !== requestedIds.length) return false;
  const requestedSet = new Set(requestedIds);
  const candidateSet = new Set(candidateIds);
  return requestedSet.size === requestedIds.length
    && candidateSet.size === candidateIds.length
    && requestedIds.every((documentId) => candidateSet.has(documentId));
};
