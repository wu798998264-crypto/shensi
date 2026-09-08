export const PANE_LAYOUT_DEFAULTS = Object.freeze({
  leftPaneWidth: 270,
  rightPaneWidth: 420,
});

export const PANE_LAYOUT_LIMITS = Object.freeze({
  leftMin: 220,
  leftMax: 420,
  rightMin: 320,
  rightMax: 620,
  editorMin: 450,
  resizerWidth: 6,
});

const numberValue = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

export const constrainPaneWidths = ({
  leftPaneWidth,
  rightPaneWidth,
  workspaceWidth,
  limits = PANE_LAYOUT_LIMITS,
} = {}) => {
  const width = Math.max(0, numberValue(workspaceWidth, 1440));
  let left = clamp(numberValue(leftPaneWidth, PANE_LAYOUT_DEFAULTS.leftPaneWidth), limits.leftMin, limits.leftMax);
  let right = clamp(numberValue(rightPaneWidth, PANE_LAYOUT_DEFAULTS.rightPaneWidth), limits.rightMin, limits.rightMax);
  const availableForSides = Math.max(limits.leftMin + limits.rightMin, width - limits.editorMin - limits.resizerWidth * 2);
  let overflow = left + right - availableForSides;
  if (overflow > 0) {
    const rightReduction = Math.min(overflow, right - limits.rightMin);
    right -= rightReduction;
    overflow -= rightReduction;
  }
  if (overflow > 0) left = Math.max(limits.leftMin, left - overflow);
  return {
    leftPaneWidth: Math.round(left),
    rightPaneWidth: Math.round(right),
  };
};

export const resizePaneWidths = ({
  side,
  startLeft,
  startRight,
  deltaX,
  workspaceWidth,
  limits = PANE_LAYOUT_LIMITS,
} = {}) => {
  const width = Math.max(0, numberValue(workspaceWidth, 1440));
  const left = numberValue(startLeft, PANE_LAYOUT_DEFAULTS.leftPaneWidth);
  const right = numberValue(startRight, PANE_LAYOUT_DEFAULTS.rightPaneWidth);
  if (side === "left") {
    return {
      leftPaneWidth: Math.round(clamp(left + numberValue(deltaX, 0), limits.leftMin, Math.min(limits.leftMax, width - limits.editorMin - limits.resizerWidth * 2 - right))),
      rightPaneWidth: Math.round(right),
    };
  }
  if (side === "right") {
    return {
      leftPaneWidth: Math.round(left),
      rightPaneWidth: Math.round(clamp(right - numberValue(deltaX, 0), limits.rightMin, Math.min(limits.rightMax, width - limits.editorMin - limits.resizerWidth * 2 - left))),
    };
  }
  return constrainPaneWidths({ leftPaneWidth: left, rightPaneWidth: right, workspaceWidth: width, limits });
};
