export const NUTSTORE_PHASE_LABELS = Object.freeze({
  idle: "空闲", scanning: "扫描中", comparing: "比较中", upload: "上传中", download: "下载中",
  delete_remote: "提交删除", delete_local: "应用远程删除", conflict: "存在冲突", completed: "同步完成",
  paused: "已暂停", retry_wait: "等待重试", waiting_credentials: "等待凭据", failed: "同步失败",
  disconnected: "已断开", baidu_local_folder: "百度网盘本地文件夹模式",
});

export const nutstorePhaseLabel = (phase = "") => NUTSTORE_PHASE_LABELS[phase] || phase || "未连接";

export const formatSyncBytes = (bytes) => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
};

export const nutstorePreviewSummary = (summary = {}) => `首次同步预览：上传 ${Number(summary.upload || 0)}，下载 ${Number(summary.download || 0)}，删除 ${Number(summary.delete || 0)}，冲突 ${Number(summary.conflict || 0)}，跳过 ${Number(summary.skip || 0)}；预计传输 ${formatSyncBytes(summary.bytes || 0)}。`;

export const nutstoreStatusView = (status = {}) => ({
  connected: status.enabled === true && status.activeMode === "nutstore_direct",
  desktopSupported: status.desktopRuntime === true,
  canAutoSync: status.capabilityLevel === "safe_auto",
  phaseLabel: nutstorePhaseLabel(status.phase),
  hasConflicts: Number(status.conflictCount || 0) > 0,
});

