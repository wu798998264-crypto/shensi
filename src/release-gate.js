const normalizedBooleanEntries = (value = {}) => Object.entries(value ?? {})
  .map(([id, passed]) => ({ id: String(id || "").trim(), passed: passed === true }))
  .filter(({ id }) => Boolean(id));

const normalizedExternalEntries = (value = {}) => Object.entries(value ?? {})
  .map(([id, status]) => ({ id: String(id || "").trim(), status: String(status || "pending").trim() || "pending" }))
  .filter(({ id }) => Boolean(id));

// A release gate must distinguish proof that can be collected locally from
// services that need a real user account, paid task, or restricted website.
// Pending external proof is deliberately not converted into a local failure,
// but it does keep `publishReady` false so the UI/release process cannot claim
// a commercial launch was verified when it was not.
export const evaluateV300ReleaseGate = ({ localChecks = {}, uiEvidence = false, externalChecks = {} } = {}) => {
  const local = normalizedBooleanEntries(localChecks);
  const failedLocal = local.filter(({ passed }) => !passed).map(({ id }) => id);
  if (uiEvidence !== true) failedLocal.push("uiEvidence");
  const external = normalizedExternalEntries(externalChecks);
  const failedExternal = external.filter(({ status }) => status === "failed");
  const pendingExternal = external.filter(({ status }) => !["verified", "failed"].includes(status));
  return Object.freeze({
    localReady: failedLocal.length === 0,
    publishReady: failedLocal.length === 0 && failedExternal.length === 0 && pendingExternal.length === 0,
    failedLocal: Object.freeze([...new Set(failedLocal)]),
    failedExternal: Object.freeze(failedExternal),
    pendingExternal: Object.freeze(pendingExternal),
    verifiedExternal: Object.freeze(external.filter(({ status }) => status === "verified")),
  });
};
