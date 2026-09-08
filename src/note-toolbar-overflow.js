const finiteRect = (rect) => rect
  && Number.isFinite(Number(rect.left))
  && Number.isFinite(Number(rect.top))
  && Number.isFinite(Number(rect.right))
  && Number.isFinite(Number(rect.bottom));

export const noteToolbarControlKey = (control) => {
  if (control?.dataset?.noteControlKey) return control.dataset.noteControlKey;
  if (control?.dataset?.noteCommand) return `command:${control.dataset.noteCommand}`;
  if (control?.dataset?.noteAction) return `action:${control.dataset.noteAction}`;
  if (control?.dataset?.noteBlock) return `block:${control.dataset.noteBlock}`;
  return "";
};

export const rectFullyVisibleWithin = (controlRect, clipRects = [], tolerance = 0.75) => {
  if (!finiteRect(controlRect) || Number(controlRect.width) <= 0 || Number(controlRect.height) <= 0) return false;
  return clipRects.filter(finiteRect).every((clipRect) => (
    controlRect.left >= clipRect.left - tolerance
    && controlRect.top >= clipRect.top - tolerance
    && controlRect.right <= clipRect.right + tolerance
    && controlRect.bottom <= clipRect.bottom + tolerance
  ));
};

const clipsOverflow = (style, axis) => {
  const value = axis === "x" ? style?.overflowX : style?.overflowY;
  return ["auto", "clip", "hidden", "scroll"].includes(value);
};

export const noteToolbarControlFullyVisible = (control, primary, { getStyle = globalThis.getComputedStyle } = {}) => {
  if (!control || !primary || control.hidden || typeof control.getBoundingClientRect !== "function") return false;
  const style = typeof getStyle === "function" ? getStyle(control) : null;
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  const rect = control.getBoundingClientRect();
  const clientRects = typeof control.getClientRects === "function" ? control.getClientRects() : [rect];
  if (!clientRects?.length) return false;

  const clipRects = [primary.getBoundingClientRect()];
  for (let ancestor = control.parentElement; ancestor && ancestor !== primary; ancestor = ancestor.parentElement) {
    const ancestorStyle = typeof getStyle === "function" ? getStyle(ancestor) : null;
    if (clipsOverflow(ancestorStyle, "x") || clipsOverflow(ancestorStyle, "y")) {
      clipRects.push(ancestor.getBoundingClientRect());
    }
  }
  return rectFullyVisibleWithin(rect, clipRects);
};

export const noteToolbarDuplicateAssignment = ({ hasPrimary = false, primaryFullyVisible = false } = {}) => ({
  primaryHidden: Boolean(hasPrimary && !primaryFullyVisible),
  moreHidden: Boolean(hasPrimary && primaryFullyVisible),
});
