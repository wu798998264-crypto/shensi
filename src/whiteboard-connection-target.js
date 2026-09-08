const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const canvasNodeIdAtPoint = ({ nodes = [], point = null, excludedNodeIds = [], padding = 6 } = {}) => {
  if (!point) return "";
  const excluded = new Set(excludedNodeIds.map(String));
  const x = finite(point.x, Number.NaN);
  const y = finite(point.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return "";
  const margin = Math.max(0, finite(padding));
  return [...nodes].reverse().find((node) => {
    if (!node?.id || excluded.has(String(node.id)) || node.hidden === true) return false;
    const left = finite(node.x) - margin;
    const top = finite(node.y) - margin;
    const right = finite(node.x) + Math.max(1, finite(node.width, 260)) + margin;
    const bottom = finite(node.y) + Math.max(1, finite(node.height, 160)) + margin;
    return x >= left && x <= right && y >= top && y <= bottom;
  })?.id || "";
};

