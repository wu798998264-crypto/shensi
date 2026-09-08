export const classifyFormalWriteFailure = ({ submissionStarted = false, diskCommitted = false, error = {} } = {}) => {
  const explicitlyRejected = ["WORKSPACE_STATE_CONFLICT", "DOCUMENT_REVISION_CONFLICT", "DOCUMENT_TRANSACTION_UNAUTHORIZED", "DOCUMENT_TRANSACTION_PREFLIGHT_FAILED"].includes(error?.code)
    && Number(error?.status) >= 400 && Number(error?.status) < 500;
  const status = diskCommitted ? "verification_pending"
    : !submissionStarted ? "preflight_failed" : explicitlyRejected ? "rejected" : "commit_unknown";
  const rollbackAllowed = ["preflight_failed", "rejected"].includes(status);
  return { status, rollbackAllowed, retryWriteAllowed: rollbackAllowed, requiresReadback: !rollbackAllowed };
};

export const formalWriteVerificationPending = (reply = {}) => [
  reply.landingStatus, reply.status,
  reply.engineExecution?.landingStatus, reply.engineExecution?.status,
  reply.execution?.landingStatus, reply.execution?.status,
].some((status) => ["verification_pending", "commit_unknown"].includes(status));

export const formalWritePendingReply = ({ outcome, error = {}, documentIds = [], receipt = null } = {}) => ({
  commitFailed: true,
  landingStatus: outcome?.status || "commit_unknown",
  landingReceipt: receipt,
  verificationPending: { documentIds: [...new Set(documentIds)], retryWriteAllowed: false },
  content: outcome?.status === "verification_pending"
    ? `内容已提交，但回读验收尚未完成：${error.message || "缺少验收凭证"}。已保留当前内容；不会回滚旧版本或重复提交，请先回读确认。`
    : `暂时不能确定磁盘是否已提交：${error.message || "未收到确认"}。当前内容仍然保留；请先回读确认，不要重复写入。`,
  engineExecution: {
    status: outcome?.status || "commit_unknown",
    landingStatus: outcome?.status || "commit_unknown",
    validationStatus: "pending", retryWriteAllowed: false,
    result: "等待磁盘回读确认，禁止重复提交",
    errorCode: error.code || "FORMAL_WRITE_READBACK_PENDING",
  },
});
