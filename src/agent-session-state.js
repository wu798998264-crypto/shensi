const clean = (value = "") => String(value ?? "").trim();
const pathKey = (value = "") => clean(value).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

const digest = (value = "") => {
  let hash = 0x811c9dc5;
  for (const character of clean(value)) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const agentSessionKey = ({ conversationId = "", branchId = "", provider = "codex", cwd = "" } = {}) => (
  [clean(conversationId), clean(branchId) || "main", clean(provider) || "codex", pathKey(cwd)].join("::")
);

export const normalizeAgentSessionRecord = (record = {}) => ({
  threadId: clean(record.threadId),
  conversationId: clean(record.conversationId),
  branchId: clean(record.branchId) || "main",
  provider: clean(record.provider) || "codex",
  model: clean(record.model),
  cwd: clean(record.cwd),
  toolVersion: clean(record.toolVersion) || "unavailable",
  status: ["active", "compacted", "corrupted"].includes(record.status) ? record.status : "active",
  providerSummary: clean(record.providerSummary).slice(0, 2_000),
  updatedAt: clean(record.updatedAt),
});

export const agentSessionCompatibility = (record = {}, expected = {}) => {
  const current = normalizeAgentSessionRecord(record);
  const reasons = [];
  if (!current.threadId) reasons.push("missing_thread");
  if (current.provider !== (clean(expected.provider) || "codex")) reasons.push("provider_changed");
  if (pathKey(current.cwd) !== pathKey(expected.cwd)) reasons.push("cwd_changed");
  if (current.model !== clean(expected.model)) reasons.push("model_changed");
  if (current.toolVersion !== (clean(expected.toolVersion) || "unavailable")) reasons.push("tool_protocol_changed");
  if (current.status === "corrupted") reasons.push("session_corrupted");
  return { compatible: reasons.length === 0, reasons, record: current };
};

export const decideAgentSessionAction = ({ record = null, expected = {}, sourceRecord = null, capabilities = {} } = {}) => {
  if (record) {
    const compatibility = agentSessionCompatibility(record, expected);
    if (compatibility.compatible && capabilities.resume !== false) return { action: "resume", recovery: "", reasons: [], record: compatibility.record };
    return { action: "start", recovery: "capsule_recovery", reasons: compatibility.reasons.length ? compatibility.reasons : ["resume_unsupported"], record: compatibility.record };
  }
  if (sourceRecord?.threadId && capabilities.fork === true) return { action: "fork", recovery: "", reasons: ["branch_created"], record: normalizeAgentSessionRecord(sourceRecord) };
  if (sourceRecord?.threadId) return { action: "start", recovery: "capsule_recovery", reasons: ["fork_unsupported"], record: normalizeAgentSessionRecord(sourceRecord) };
  return { action: "start", recovery: "", reasons: ["new_session"], record: null };
};

export const safeAgentSessionMirror = ({ record = {}, recovery = "", recoveryReason = "", resumed = false, forked = false } = {}) => {
  const normalized = normalizeAgentSessionRecord(record);
  return {
    provider: normalized.provider,
    model: normalized.model,
    branchId: normalized.branchId,
    safeThreadId: normalized.threadId ? `thread-${digest(normalized.threadId)}` : "",
    cwdFingerprint: normalized.cwd ? digest(pathKey(normalized.cwd)) : "",
    status: normalized.status,
    compacted: normalized.status === "compacted",
    resumed: resumed === true,
    forked: forked === true,
    recovery: clean(recovery),
    recoveryReason: clean(recoveryReason),
    providerSummary: normalized.providerSummary,
    updatedAt: normalized.updatedAt,
  };
};
