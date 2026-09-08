const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const attachmentPreviewCanPan = ({ kind = "", scale = 1 } = {}) => (
  kind === "image" && finite(scale, 1) > 1
);

export const clampAttachmentPreviewPan = ({
  x = 0,
  y = 0,
  scale = 1,
  mediaWidth = 0,
  mediaHeight = 0,
  stageWidth = 0,
  stageHeight = 0,
} = {}) => {
  const safeScale = Math.max(0.5, finite(scale, 1));
  if (safeScale <= 1) return { x: 0, y: 0, maxX: 0, maxY: 0 };
  const maxX = Math.max(0, (Math.max(0, finite(mediaWidth)) * safeScale - Math.max(0, finite(stageWidth))) / 2);
  const maxY = Math.max(0, (Math.max(0, finite(mediaHeight)) * safeScale - Math.max(0, finite(stageHeight))) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, finite(x))),
    y: Math.min(maxY, Math.max(-maxY, finite(y))),
    maxX,
    maxY,
  };
};

export const attachmentPreviewTransform = ({ scale = 1, x = 0, y = 0 } = {}) => (
  `translate3d(${finite(x).toFixed(2)}px, ${finite(y).toFixed(2)}px, 0) scale(${Math.max(0.5, finite(scale, 1)).toFixed(4)})`
);
