const normalized = (value) => String(value || "").trim().toLowerCase();

export const mediaResultLifecycleStage = (job = {}) => {
  if (job.userStoppedAt || job.resultSuppressed || job.userStopped) return "user_stopped";
  if (normalized(job.status) === "cancelled" || normalized(job.providerStatus) === "cancelled") return "cancelled";
  if (job.appliedAt && (job.target?.targetType !== "whiteboard-node" || job.cardReadbackVerified === true)) {
    return "card_complete";
  }
  if (normalized(job.status) === "complete" && (job.landingReceipt?.sha256 || job.result?.attachment?.sha256)) {
    return "asset_saved_card_pending";
  }
  if (["completed", "complete", "succeeded", "success"].includes(normalized(job.providerStatus))) {
    return "provider_complete_retrieving";
  }
  if (normalized(job.status) === "failed" || normalized(job.providerStatus) === "failed") return "provider_failed";
  if (["queued", "waiting"].includes(normalized(job.providerStatus)) || normalized(job.status) === "queued") return "provider_queued";
  return "provider_running";
};
