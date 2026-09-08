const text = (value = "") => String(value ?? "").trim();

export const isFormalWriteRollbackRequest = (instruction = "") => {
  const source = text(instruction);
  if (!source || /(?:如何|怎么|能否|可以吗|什么意思|功能|规则)/u.test(source)) return false;
  return /(?:退回|撤销|还原|恢复到)(?:刚才|上次|最近|前一次)?/u.test(source)
    && /(?:正式内容|落盘|写入|覆盖|追加|文档内容|修改)/u.test(source);
};

export const normalizeFormalWriteRollbackCheckpoints = (checkpoints = [], { limit = 24 } = {}) => {
  const seen = new Set();
  return (Array.isArray(checkpoints) ? checkpoints : [])
    .filter((item) => item?.id && item?.documentId && item?.afterRevision)
    .sort((left, right) => Number(right.committedAt || 0) - Number(left.committedAt || 0))
    .filter((item) => {
      const key = `${item.documentId}:${item.afterRevision}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(1, Number(limit) || 24));
};

export const latestFormalWriteRollbackCheckpoint = ({ checkpoints = [], documentId = "", currentRevision = "" } = {}) => {
  const targetId = text(documentId);
  const records = normalizeFormalWriteRollbackCheckpoints(checkpoints);
  const checkpoint = records.find((item) => item.documentId === targetId) || null;
  if (!checkpoint) return { available: false, reason: "checkpoint_missing" };
  if (text(checkpoint.afterRevision) !== text(currentRevision)) {
    return { available: false, reason: "document_changed_after_write", checkpoint };
  }
  if (checkpoint.created === true) return { available: false, reason: "created_document_requires_delete", checkpoint };
  return { available: true, checkpoint };
};

export const registerFormalWriteRollbackCheckpoints = ({ current = [], additions = [] } = {}) => {
  const targetIds = new Set((Array.isArray(additions) ? additions : []).map((item) => item?.documentId).filter(Boolean));
  return normalizeFormalWriteRollbackCheckpoints([
    ...(Array.isArray(additions) ? additions : []),
    ...(Array.isArray(current) ? current : []).filter((item) => !targetIds.has(item?.documentId)),
  ]);
};

