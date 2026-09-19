const sequenceOf = (value) => Number(value?.sequence);

export const upsertAgentResultReference = (message, reference = {}) => {
  if (!message || !reference || !Number.isFinite(sequenceOf(reference))) return null;
  message.execution ??= {};
  const references = message.execution.agentResultReferences ??= [];
  const index = references.findIndex((entry) => sequenceOf(entry) === sequenceOf(reference));
  if (index < 0) {
    const inserted = { ...reference };
    references.push(inserted);
    return inserted;
  }
  Object.assign(references[index], reference);
  return references[index];
};

export const markAgentResultProjection = (message, {
  reference,
  verified,
  error = "",
} = {}) => {
  const liveReference = upsertAgentResultReference(message, reference);
  if (!liveReference) return null;
  liveReference.clientProjectionVerified = verified === true;
  if (verified === true) delete liveReference.clientProjectionError;
  else liveReference.clientProjectionError = String(error || "目录同步失败");
  return liveReference;
};
