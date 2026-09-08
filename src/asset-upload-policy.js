const MB = 1024 * 1024;

// Upload itself streams through fetch. Limiting only the number of concurrent
// files prevents large video/audio selections from monopolising local disk and
// renderer memory, while small image/text batches remain pleasantly quick.
export const standaloneAssetUploadWorkerCount = (entries = []) => {
  const sizes = (Array.isArray(entries) ? entries : []).map((entry) => Math.max(0, Number(entry?.file?.size ?? entry?.size) || 0));
  if (!sizes.length) return 1;
  const largest = Math.max(0, ...sizes);
  if (largest >= 256 * MB) return 1;
  if (largest >= 32 * MB) return 2;
  return 3;
};
