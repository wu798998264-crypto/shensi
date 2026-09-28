// The standalone runtime emits { event: 'progress', value: percent }.
// Log/provider events do not reset the most recent numerical progress.
export const depthExplorerEventProgress = (events = []) => {
  const progress = [...events].reverse().find((event) => event?.event === 'progress'
    && Number.isFinite(Number(event.value ?? event.progress)));
  if (!progress) return null;
  return {
    currentPercent: Math.max(0, Math.min(100, Number(progress.value ?? progress.progress))),
    message: String(progress.message || '正在处理'),
  };
};
