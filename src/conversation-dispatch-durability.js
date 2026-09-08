const durabilityError = (message, { code, cause, checkpointError = null } = {}) => {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.checkpointError = checkpointError;
  return error;
};

const normalizedFailure = (error, fallback) => (
  error instanceof Error ? error : new Error(String(error || fallback))
);

// A rapid recovery checkpoint is the preferred protection and the canonical
// workspace is its fallback. This coordinator is deliberately non-gating: the
// caller starts it in the background while the generation attempt/job journal
// owns the model task lifecycle.
export const ensureConversationDispatchDurability = async ({
  ensureRecoveryCheckpoint,
  hasRecoveryOnlyDraft,
  saveCanonicalWorkspace,
} = {}) => {
  if (typeof ensureRecoveryCheckpoint !== "function"
    || typeof hasRecoveryOnlyDraft !== "function"
    || typeof saveCanonicalWorkspace !== "function") {
    throw durabilityError("对话持久化保护参数不完整", { code: "CONVERSATION_DURABILITY_INVALID" });
  }

  let checkpointError = null;
  try {
    const protectedByCheckpoint = await ensureRecoveryCheckpoint();
    if (protectedByCheckpoint !== false) {
      return {
        protectedBy: "recovery_checkpoint",
        degraded: false,
        recoverableAfterRestart: true,
        warning: "",
      };
    }
    checkpointError = new Error("恢复检查点写入失败");
  } catch (error) {
    checkpointError = normalizedFailure(error, "恢复检查点写入失败");
  }

  // Dispatch protection runs in the background. A recovery-only whiteboard
  // draft cannot be represented by the canonical workspace save, but it must
  // no longer prevent an otherwise valid model task from starting. Report the
  // reduced recovery guarantee and keep the normal autosave retry alive.
  let recoveryOnlyDraft = false;
  try {
    recoveryOnlyDraft = hasRecoveryOnlyDraft() === true;
  } catch {
    recoveryOnlyDraft = true;
  }

  let saveError = null;
  try {
    const saved = await saveCanonicalWorkspace();
    if (saved !== true) throw new Error("规范工作区保存未完成");
  } catch (error) {
    saveError = normalizedFailure(error, "规范工作区保存失败");
  }

  if (saveError) {
    return {
      protectedBy: "memory_only",
      degraded: true,
      recoverableAfterRestart: false,
      recoveryOnlyDraft,
      checkpointError,
      saveError,
      warning: "模型任务已继续；本轮对话与未保存草稿暂时无法断电恢复，请勿在自动保存恢复前关闭软件。",
    };
  }

  return {
    protectedBy: "canonical_workspace",
    degraded: true,
    recoverableAfterRestart: !recoveryOnlyDraft,
    recoveryOnlyDraft,
    checkpointError,
    warning: recoveryOnlyDraft
      ? "模型任务已继续；白板中尚未保存的提示词或参考暂时无法断电恢复，后台会继续重试保存。"
      : "",
  };
};
