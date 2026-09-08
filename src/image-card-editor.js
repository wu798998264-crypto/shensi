import { addCanvasEdge, addCanvasImageNode, appendCanvasAsset, normalizeCanvas, snapCanvasValue } from "./whiteboard.js";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number(value) || 0));

const cloneValue = (value) => {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

export const IMAGE_CARD_EDITOR_TOOLS = Object.freeze([
  { id: "select", label: "选择与移动" },
  { id: "crop", label: "裁剪" },
  { id: "rectangle", label: "画框" },
  { id: "line", label: "直线" },
  { id: "pen", label: "画笔" },
  { id: "arrow", label: "箭头" },
  { id: "text", label: "文字" },
  { id: "mosaic", label: "马赛克" },
]);

export const imageEditorRasterSize = ({ width, height, maximumDimension = 8192, maximumPixels = 32_000_000 } = {}) => {
  const sourceWidth = Math.max(1, Math.round(Number(width) || 1));
  const sourceHeight = Math.max(1, Math.round(Number(height) || 1));
  const dimensionScale = Math.min(1, maximumDimension / Math.max(sourceWidth, sourceHeight));
  const pixelScale = Math.min(1, Math.sqrt(maximumPixels / Math.max(1, sourceWidth * sourceHeight)));
  const scale = Math.min(dimensionScale, pixelScale);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    scale,
  };
};

export const normalizeImageCrop = (crop, { width, height, minimumSize = 2 } = {}) => {
  const canvasWidth = Math.max(1, Number(width) || 1);
  const canvasHeight = Math.max(1, Number(height) || 1);
  if (!crop) return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  const startX = clamp(Math.min(Number(crop.x) || 0, (Number(crop.x) || 0) + (Number(crop.width) || 0)), 0, canvasWidth);
  const startY = clamp(Math.min(Number(crop.y) || 0, (Number(crop.y) || 0) + (Number(crop.height) || 0)), 0, canvasHeight);
  const endX = clamp(Math.max(Number(crop.x) || 0, (Number(crop.x) || 0) + (Number(crop.width) || 0)), 0, canvasWidth);
  const endY = clamp(Math.max(Number(crop.y) || 0, (Number(crop.y) || 0) + (Number(crop.height) || 0)), 0, canvasHeight);
  if (endX - startX < minimumSize || endY - startY < minimumSize) {
    return { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
  }
  return { x: startX, y: startY, width: endX - startX, height: endY - startY };
};

export const imageCropHandles = (crop) => {
  if (!crop) return [];
  const left = Number(crop.x) || 0;
  const top = Number(crop.y) || 0;
  const right = left + (Number(crop.width) || 0);
  const bottom = top + (Number(crop.height) || 0);
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return [
    { id: "nw", x: left, y: top },
    { id: "n", x: centerX, y: top },
    { id: "ne", x: right, y: top },
    { id: "e", x: right, y: centerY },
    { id: "se", x: right, y: bottom },
    { id: "s", x: centerX, y: bottom },
    { id: "sw", x: left, y: bottom },
    { id: "w", x: left, y: centerY },
  ];
};

export const hitImageCrop = (crop, point, { tolerance = 6 } = {}) => {
  if (!crop || !point) return null;
  const radius = Math.max(1, Number(tolerance) || 6);
  const handle = imageCropHandles(crop).find((item) => Math.hypot(point.x - item.x, point.y - item.y) <= radius);
  if (handle) return { mode: "resize", handle: handle.id };
  const right = crop.x + crop.width;
  const bottom = crop.y + crop.height;
  const withinHorizontalEdge = point.x >= crop.x - radius && point.x <= right + radius;
  const withinVerticalEdge = point.y >= crop.y - radius && point.y <= bottom + radius;
  if (withinHorizontalEdge && Math.abs(point.y - crop.y) <= radius) return { mode: "resize", handle: "n" };
  if (withinHorizontalEdge && Math.abs(point.y - bottom) <= radius) return { mode: "resize", handle: "s" };
  if (withinVerticalEdge && Math.abs(point.x - crop.x) <= radius) return { mode: "resize", handle: "w" };
  if (withinVerticalEdge && Math.abs(point.x - right) <= radius) return { mode: "resize", handle: "e" };
  return point.x >= crop.x && point.x <= right && point.y >= crop.y && point.y <= bottom
    ? { mode: "move", handle: "" }
    : null;
};

export const moveImageCrop = (crop, dx, dy, { width, height } = {}) => {
  const normalized = normalizeImageCrop(crop, { width, height });
  const canvasWidth = Math.max(1, Number(width) || 1);
  const canvasHeight = Math.max(1, Number(height) || 1);
  return {
    ...normalized,
    x: clamp(normalized.x + (Number(dx) || 0), 0, Math.max(0, canvasWidth - normalized.width)),
    y: clamp(normalized.y + (Number(dy) || 0), 0, Math.max(0, canvasHeight - normalized.height)),
  };
};

export const resizeImageCrop = (crop, handle, point, { width, height } = {}) => {
  const normalized = normalizeImageCrop(crop, { width, height });
  let left = normalized.x;
  let top = normalized.y;
  let right = normalized.x + normalized.width;
  let bottom = normalized.y + normalized.height;
  const x = clamp(point?.x, 0, Math.max(1, Number(width) || 1));
  const y = clamp(point?.y, 0, Math.max(1, Number(height) || 1));
  if (String(handle).includes("w")) left = x;
  if (String(handle).includes("e")) right = x;
  if (String(handle).includes("n")) top = y;
  if (String(handle).includes("s")) bottom = y;
  return normalizeImageCrop({ x: left, y: top, width: right - left, height: bottom - top }, { width, height });
};

export const imageEditorPointer = (event, canvas) => {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clamp((event.clientX - rect.left) * canvas.width / Math.max(rect.width, 1), 0, canvas.width),
    y: clamp((event.clientY - rect.top) * canvas.height / Math.max(rect.height, 1), 0, canvas.height),
  };
};

export const appendImageEditorStrokePoints = (points = [], samples = [], { minimumDistance = 0.35 } = {}) => {
  const next = Array.isArray(points) ? points.map((point) => ({ x: Number(point.x) || 0, y: Number(point.y) || 0 })) : [];
  const threshold = Math.max(0.05, Number(minimumDistance) || 0.35);
  for (const sample of samples) {
    const point = { x: Number(sample?.x) || 0, y: Number(sample?.y) || 0 };
    const previous = next[next.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= threshold) next.push(point);
  }
  return next;
};

const appendImageEditorStrokeSamplesInPlace = (points, samples, minimumDistance = 0.35) => {
  const next = Array.isArray(points) ? points : [];
  const threshold = Math.max(0.05, Number(minimumDistance) || 0.35);
  for (const sample of samples) {
    const point = { x: Number(sample?.x) || 0, y: Number(sample?.y) || 0 };
    const previous = next[next.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= threshold) next.push(point);
  }
  return next;
};

export const imageEditorBrushCursorDiameter = ({ tool, size, displayScale = 1 } = {}) => {
  const normalizedSize = Math.max(1, Number(size) || 1);
  const canvasDiameter = tool === "mosaic" ? normalizedSize * 2 : normalizedSize;
  return clamp(canvasDiameter * Math.max(0.01, Number(displayScale) || 1), 4, 240);
};

export const createEditedImageDownstream = (canvas, {
  sourceNodeId,
  editedNodeId,
  assetId,
  attachment,
  width,
  height,
  createdAt = new Date().toISOString(),
} = {}) => {
  const normalized = normalizeCanvas(canvas);
  const sourceNode = normalized.nodes.find((node) => node.id === sourceNodeId && node.kind === "image");
  if (!sourceNode || !editedNodeId || !assetId || !attachment?.relativePath) return { canvas: normalized, nodeId: "" };
  const aspectRatio = clamp(Number(width) / Math.max(1, Number(height)), 0.1, 10);
  const nodeWidth = Math.max(180, Number(sourceNode.width) || 320);
  let nextCanvas = addCanvasImageNode(normalized, {
    id: editedNodeId,
    file: attachment.relativePath,
    name: attachment.name,
    mimeType: attachment.mimeType || "image/png",
    aspectRatio,
    width: nodeWidth,
    x: snapCanvasValue(sourceNode.x + sourceNode.width + 120, normalized),
    y: snapCanvasValue(sourceNode.y, normalized),
  });
  nextCanvas = addCanvasEdge(nextCanvas, { fromNode: sourceNodeId, toNode: editedNodeId });
  nextCanvas = appendCanvasAsset(nextCanvas, {
    id: assetId,
    kind: "image",
    origin: "generated",
    source: "whiteboard",
    prompt: "图片编辑",
    attachment: { ...attachment, width, height },
    aspectRatio,
    sourceNodeId: editedNodeId,
    nodeName: attachment.name || "编辑图片",
    createdAt,
  });
  return { canvas: nextCanvas, nodeId: editedNodeId, aspectRatio };
};

const iconMarkup = (tool) => {
  const paths = {
    select: '<path d="M5 3l12 9-6 1.5 3.5 6-2.8 1.6-3.4-6.2L5 20z"/>',
    crop: '<path d="M7 3v14a2 2 0 0 0 2 2h12M3 7h14a2 2 0 0 1 2 2v12"/>',
    rectangle: '<rect x="4" y="5" width="16" height="14" rx="1"/>',
    line: '<path d="M4 19L20 5"/>',
    pen: '<path d="M4 20c4-1 5-4 7-7l7-8 2 2-8 8c-3 2-6 3-8 5z"/><path d="M14 8l2 2"/>',
    arrow: '<path d="M4 18L19 5M12 5h7v7"/>',
    text: '<path d="M5 5h14M12 5v14M8 19h8"/>',
    mosaic: '<path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z"/>',
  };
  const fill = ["select", "mosaic"].includes(tool) ? ' fill="currentColor" stroke="none"' : ' fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"${fill}>${paths[tool] || ""}</svg>`;
};

const editorMarkup = () => `<dialog class="image-card-editor-dialog" aria-labelledby="imageCardEditorTitle">
  <form method="dialog" class="image-card-editor-shell">
    <header class="image-card-editor-header">
      <div><h2 id="imageCardEditorTitle">编辑图片</h2><small data-image-editor-name></small></div>
      <div class="image-card-editor-history" role="group" aria-label="编辑历史">
        <button type="button" data-image-editor-undo title="撤销" aria-label="撤销">↶</button>
        <button type="button" data-image-editor-redo title="重做" aria-label="重做">↷</button>
        <button type="button" data-image-editor-close title="关闭" aria-label="关闭">×</button>
      </div>
    </header>
    <main class="image-card-editor-stage" data-image-editor-stage>
      <div class="image-card-editor-canvas-shell"><canvas data-image-editor-canvas aria-label="图片编辑画布"></canvas><canvas data-image-editor-live-canvas aria-hidden="true"></canvas><div class="image-card-editor-brush-cursor" data-image-editor-brush-cursor aria-hidden="true" hidden></div><textarea data-image-editor-text-box maxlength="500" aria-label="在图片上输入文字" hidden></textarea></div>
      <p data-image-editor-loading>正在读取图片…</p>
    </main>
    <section class="image-card-editor-options" aria-label="工具参数">
      <label data-image-editor-color-field><span>颜色</span><input data-image-editor-color type="color" value="#ff3b30" /></label>
      <label data-image-editor-size-field><span data-image-editor-size-label>粗细</span><input data-image-editor-size type="range" min="2" max="32" step="1" value="6" /><output data-image-editor-size-output>6</output></label>
      <span class="image-card-editor-tip" data-image-editor-tip>拖拽已有标注可移动；拖拽控制点可调整大小。</span>
    </section>
    <footer class="image-card-editor-footer">
      <div class="image-card-editor-tools" role="toolbar" aria-label="图片编辑工具">
        ${IMAGE_CARD_EDITOR_TOOLS.map(({ id, label }) => `<button type="button" data-image-editor-tool="${id}" title="${label}" aria-label="${label}" aria-pressed="${id === "select"}">${iconMarkup(id)}</button>`).join("")}
      </div>
      <div class="image-card-editor-actions"><button type="button" class="secondary-button" data-image-editor-cancel>取消</button><button type="button" class="primary-button" data-image-editor-save>保存为新图片</button></div>
    </footer>
  </form>
</dialog>`;

const lineDistance = (point, start, end) => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(point.x - start.x, point.y - start.y);
  const ratio = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (start.x + ratio * dx), point.y - (start.y + ratio * dy));
};

const rectFromPoints = (start, end) => ({
  x: Math.min(start.x, end.x),
  y: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
});

const operationBounds = (operation, context) => {
  if (operation.type === "rectangle") return { x: operation.x, y: operation.y, width: operation.width, height: operation.height };
  if (["line", "arrow"].includes(operation.type)) return rectFromPoints(operation.start, operation.end);
  if (["pen", "mosaic"].includes(operation.type)) {
    const xs = operation.points.map((point) => point.x);
    const ys = operation.points.map((point) => point.y);
    return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  }
  if (operation.type === "text") {
    context.save();
    context.font = `${operation.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    const width = Math.max(operation.fontSize, context.measureText(operation.text).width);
    context.restore();
    return {
      x: operation.x,
      y: operation.y,
      width: Math.max(operation.fontSize * 2, Number(operation.width) || width),
      height: Math.max(operation.fontSize * 1.35, Number(operation.height) || operation.fontSize * 1.35),
    };
  }
  return { x: 0, y: 0, width: 0, height: 0 };
};

const operationHandles = (operation, context) => {
  const bounds = operationBounds(operation, context);
  if (["rectangle", "text"].includes(operation.type)) return [
    { id: "nw", x: bounds.x, y: bounds.y },
    { id: "ne", x: bounds.x + bounds.width, y: bounds.y },
    { id: "sw", x: bounds.x, y: bounds.y + bounds.height },
    { id: "se", x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
  if (["line", "arrow"].includes(operation.type)) return [
    { id: "start", ...operation.start },
    { id: "end", ...operation.end },
  ];
  return [];
};

const hitOperation = (operations, point, context, tolerance) => {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    const handle = operationHandles(operation, context).find((item) => Math.hypot(point.x - item.x, point.y - item.y) <= tolerance * 1.35);
    if (handle) return { index, mode: "handle", handle: handle.id };
    if (["line", "arrow"].includes(operation.type) && lineDistance(point, operation.start, operation.end) <= tolerance) return { index, mode: "move" };
    if (["pen", "mosaic"].includes(operation.type) && operation.points.some((item, pointIndex) => pointIndex > 0 && lineDistance(point, operation.points[pointIndex - 1], item) <= Math.max(tolerance, operation.size / 2))) return { index, mode: "move" };
    const bounds = operationBounds(operation, context);
    if (point.x >= bounds.x - tolerance && point.x <= bounds.x + bounds.width + tolerance && point.y >= bounds.y - tolerance && point.y <= bounds.y + bounds.height + tolerance) return { index, mode: "move" };
  }
  return null;
};

const hitTextOperation = (operations, point, context, tolerance) => {
  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    if (operation.type !== "text") continue;
    const handle = operationHandles(operation, context).find((item) => Math.hypot(point.x - item.x, point.y - item.y) <= tolerance * 1.35);
    if (handle) return { index, mode: "handle", handle: handle.id };
    const bounds = operationBounds(operation, context);
    if (point.x >= bounds.x - tolerance && point.x <= bounds.x + bounds.width + tolerance && point.y >= bounds.y - tolerance && point.y <= bounds.y + bounds.height + tolerance) return { index, mode: "move" };
  }
  return null;
};

const translateOperation = (operation, dx, dy) => {
  if (["line", "arrow"].includes(operation.type)) return { ...operation, start: { x: operation.start.x + dx, y: operation.start.y + dy }, end: { x: operation.end.x + dx, y: operation.end.y + dy } };
  if (["pen", "mosaic"].includes(operation.type)) return { ...operation, points: operation.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
  return { ...operation, x: operation.x + dx, y: operation.y + dy };
};

const resizeOperation = (operation, handle, point, startOperation, dragStart) => {
  if (["line", "arrow"].includes(operation.type)) return { ...operation, [handle]: { ...point } };
  if (["rectangle", "text"].includes(operation.type)) {
    const left = handle.includes("w") ? point.x : startOperation.x;
    const right = handle.includes("e") ? point.x : startOperation.x + startOperation.width;
    const top = handle.includes("n") ? point.y : startOperation.y;
    const bottom = handle.includes("s") ? point.y : startOperation.y + startOperation.height;
    const resized = rectFromPoints({ x: left, y: top }, { x: right, y: bottom });
    if (operation.type === "text") {
      resized.width = Math.max(startOperation.fontSize * 2, resized.width);
      resized.height = Math.max(startOperation.fontSize * 1.35, resized.height);
    }
    return { ...operation, ...resized };
  }
  return operation;
};

const drawArrow = (context, operation) => {
  const { start, end } = operation;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const head = Math.max(12, Number(operation.arrowSize) || operation.size * 4);
  context.beginPath();
  context.moveTo(start.x, start.y);
  context.lineTo(end.x, end.y);
  context.moveTo(end.x, end.y);
  context.lineTo(end.x - head * Math.cos(angle - Math.PI / 6), end.y - head * Math.sin(angle - Math.PI / 6));
  context.moveTo(end.x, end.y);
  context.lineTo(end.x - head * Math.cos(angle + Math.PI / 6), end.y - head * Math.sin(angle + Math.PI / 6));
  context.stroke();
};

const drawMosaic = (context, operation) => {
  if (!operation.points.length) return;
  const block = Math.max(4, Math.round(operation.size));
  const source = document.createElement("canvas");
  source.width = context.canvas.width;
  source.height = context.canvas.height;
  source.getContext("2d").drawImage(context.canvas, 0, 0);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.ceil(source.width / block));
  small.height = Math.max(1, Math.ceil(source.height / block));
  const smallContext = small.getContext("2d");
  smallContext.imageSmoothingEnabled = false;
  smallContext.drawImage(source, 0, 0, small.width, small.height);
  const overlay = document.createElement("canvas");
  overlay.width = source.width;
  overlay.height = source.height;
  const overlayContext = overlay.getContext("2d");
  overlayContext.imageSmoothingEnabled = false;
  overlayContext.drawImage(small, 0, 0, small.width, small.height, 0, 0, overlay.width, overlay.height);
  overlayContext.globalCompositeOperation = "destination-in";
  overlayContext.strokeStyle = "#fff";
  overlayContext.fillStyle = "#fff";
  overlayContext.lineWidth = block * 1.75;
  overlayContext.lineCap = "round";
  overlayContext.lineJoin = "round";
  overlayContext.beginPath();
  overlayContext.moveTo(operation.points[0].x, operation.points[0].y);
  operation.points.slice(1).forEach((point) => overlayContext.lineTo(point.x, point.y));
  overlayContext.stroke();
  if (operation.points.length === 1) {
    overlayContext.beginPath();
    overlayContext.arc(operation.points[0].x, operation.points[0].y, block, 0, Math.PI * 2);
    overlayContext.fill();
  }
  context.drawImage(overlay, 0, 0);
};

const wrappedTextLines = (context, text, maximumWidth) => {
  const lines = [];
  for (const paragraph of String(text || "").split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const character of [...paragraph]) {
      const candidate = `${line}${character}`;
      if (line && context.measureText(candidate).width > maximumWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
};

const drawSmoothStroke = (context, points) => {
  if (!points?.length) return;
  if (points.length === 1) {
    context.beginPath();
    context.arc(points[0].x, points[0].y, context.lineWidth / 2, 0, Math.PI * 2);
    context.fill();
    return;
  }
  context.beginPath();
  context.moveTo(points[0].x, points[0].y);
  if (points.length === 2) context.lineTo(points[1].x, points[1].y);
  else {
    for (let index = 1; index < points.length - 1; index += 1) {
      const current = points[index];
      const next = points[index + 1];
      context.quadraticCurveTo(current.x, current.y, (current.x + next.x) / 2, (current.y + next.y) / 2);
    }
    context.lineTo(points[points.length - 1].x, points[points.length - 1].y);
  }
  context.stroke();
};

const drawOperation = (context, operation) => {
  if (operation.type === "mosaic") {
    drawMosaic(context, operation);
    return;
  }
  context.save();
  context.strokeStyle = operation.color || "#ff3b30";
  context.fillStyle = operation.color || "#ff3b30";
  context.lineWidth = Math.max(1, Number(operation.size) || 4);
  context.lineCap = "round";
  context.lineJoin = "round";
  if (operation.type === "rectangle") context.strokeRect(operation.x, operation.y, operation.width, operation.height);
  else if (operation.type === "line") {
    context.beginPath();
    context.moveTo(operation.start.x, operation.start.y);
    context.lineTo(operation.end.x, operation.end.y);
    context.stroke();
  } else if (operation.type === "arrow") drawArrow(context, operation);
  else if (operation.type === "pen") {
    drawSmoothStroke(context, operation.points);
  } else if (operation.type === "text") {
    context.font = `${operation.fontSize}px "Microsoft YaHei", "PingFang SC", sans-serif`;
    context.textBaseline = "top";
    const bounds = operationBounds(operation, context);
    const lineHeight = operation.fontSize * 1.25;
    context.beginPath();
    context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.clip();
    wrappedTextLines(context, operation.text, bounds.width).forEach((line, index) => {
      if ((index + 1) * lineHeight > bounds.height + lineHeight * 0.2) return;
      context.fillText(line, bounds.x, bounds.y + index * lineHeight);
    });
  }
  context.restore();
};

const canvasBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片导出失败")), "image/png", 1));

export const createImageCardEditor = ({ mount = document.body } = {}) => {
  const host = document.createElement("div");
  host.innerHTML = editorMarkup();
  const dialog = host.firstElementChild;
  mount.append(dialog);
  const canvas = dialog.querySelector("[data-image-editor-canvas]");
  const liveCanvas = dialog.querySelector("[data-image-editor-live-canvas]");
  const canvasShell = dialog.querySelector(".image-card-editor-canvas-shell");
  const stage = dialog.querySelector("[data-image-editor-stage]");
  // Chromium/Electron can return a permanently black desynchronized canvas
  // after a dialog is promoted to a GPU layer. Keep the editor on the stable
  // 2D path; pointer drawing is already batched with requestAnimationFrame.
  const context = canvas.getContext("2d", { willReadFrequently: true, alpha: true });
  const liveContext = liveCanvas.getContext("2d", { alpha: true });
  const brushCursor = dialog.querySelector("[data-image-editor-brush-cursor]");
  const loading = dialog.querySelector("[data-image-editor-loading]");
  const nameOutput = dialog.querySelector("[data-image-editor-name]");
  const colorInput = dialog.querySelector("[data-image-editor-color]");
  const sizeInput = dialog.querySelector("[data-image-editor-size]");
  const sizeOutput = dialog.querySelector("[data-image-editor-size-output]");
  const sizeLabel = dialog.querySelector("[data-image-editor-size-label]");
  const sizeField = dialog.querySelector("[data-image-editor-size-field]");
  const colorField = dialog.querySelector("[data-image-editor-color-field]");
  const textBox = dialog.querySelector("[data-image-editor-text-box]");
  const tip = dialog.querySelector("[data-image-editor-tip]");
  const undoButton = dialog.querySelector("[data-image-editor-undo]");
  const redoButton = dialog.querySelector("[data-image-editor-redo]");
  const saveButton = dialog.querySelector("[data-image-editor-save]");
  let image = null;
  let imageUrl = "";
  let tool = "select";
  let operations = [];
  let crop = null;
  let selectedIndex = -1;
  let draft = null;
  let pointerDrag = null;
  let history = [];
  let historyIndex = -1;
  let saveHandler = null;
  let textEditing = null;
  let selectedTextStyleDirty = false;
  let renderFrame = 0;
  let liveStrokeFrame = 0;
  let liveStrokePointIndex = 0;
  let liveMosaicPattern = null;
  let brushCursorClientPoint = null;
  const sizeMemory = { drawing: 6, text: 32, mosaic: 20 };
  const sizeBucket = (value) => value === "text" ? "text" : value === "mosaic" ? "mosaic" : ["rectangle", "line", "pen", "arrow"].includes(value) ? "drawing" : "";

  const syncCanvasPresentationSize = () => {
    if (!canvas.width || !canvas.height || !canvasShell.clientWidth || !canvasShell.clientHeight) return;
    const scale = Math.min(
      canvasShell.clientWidth / canvas.width,
      canvasShell.clientHeight / canvas.height,
      1,
    );
    const width = Math.max(1, Math.floor(canvas.width * scale));
    const height = Math.max(1, Math.floor(canvas.height * scale));
    for (const target of [canvas, liveCanvas]) {
      target.style.width = `${width}px`;
      target.style.height = `${height}px`;
    }
    updateBrushCursor();
    positionTextBox();
  };
  const stageResizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => syncCanvasPresentationSize()) : null;
  stageResizeObserver?.observe(stage);

  const snapshot = () => ({ operations: cloneValue(operations), crop: crop ? { ...crop } : null });
  const restore = (value) => {
    operations = cloneValue(value?.operations || []);
    crop = value?.crop ? { ...value.crop } : null;
    selectedIndex = -1;
    render();
  };
  const syncHistoryButtons = () => {
    undoButton.disabled = historyIndex <= 0;
    redoButton.disabled = historyIndex < 0 || historyIndex >= history.length - 1;
  };
  const commit = () => {
    history = history.slice(0, historyIndex + 1);
    history.push(snapshot());
    historyIndex = history.length - 1;
    syncHistoryButtons();
  };

  const clearLiveCanvas = () => {
    if (liveStrokeFrame) cancelAnimationFrame(liveStrokeFrame);
    liveStrokeFrame = 0;
    liveStrokePointIndex = 0;
    liveMosaicPattern = null;
    liveContext.clearRect(0, 0, liveCanvas.width, liveCanvas.height);
  };

  const prepareLiveMosaicPattern = (operation) => {
    const block = Math.max(4, Math.round(Number(operation?.size) || 20));
    const small = document.createElement("canvas");
    small.width = Math.max(1, Math.ceil(canvas.width / block));
    small.height = Math.max(1, Math.ceil(canvas.height / block));
    const smallContext = small.getContext("2d");
    smallContext.imageSmoothingEnabled = false;
    smallContext.drawImage(canvas, 0, 0, small.width, small.height);
    const pixelated = document.createElement("canvas");
    pixelated.width = canvas.width;
    pixelated.height = canvas.height;
    const pixelatedContext = pixelated.getContext("2d");
    pixelatedContext.imageSmoothingEnabled = false;
    pixelatedContext.drawImage(small, 0, 0, small.width, small.height, 0, 0, pixelated.width, pixelated.height);
    liveMosaicPattern = liveContext.createPattern(pixelated, "no-repeat");
  };

  const drawLiveStrokeSegments = () => {
    liveStrokeFrame = 0;
    if (!draft || !["pen", "mosaic"].includes(draft.type) || !draft.points?.length) return;
    const startIndex = Math.max(0, liveStrokePointIndex - 2);
    const points = draft.points.slice(startIndex);
    if (!points.length) return;
    liveContext.save();
    liveContext.lineCap = "round";
    liveContext.lineJoin = "round";
    liveContext.lineWidth = draft.type === "mosaic" ? Math.max(8, Number(draft.size) * 1.75) : Math.max(1, Number(draft.size) || 4);
    liveContext.strokeStyle = draft.type === "mosaic" ? liveMosaicPattern || "transparent" : draft.color || "#ff3b30";
    liveContext.fillStyle = liveContext.strokeStyle;
    drawSmoothStroke(liveContext, points);
    liveContext.restore();
    liveStrokePointIndex = draft.points.length;
  };

  const requestLiveStrokeRender = () => {
    if (liveStrokeFrame) return;
    liveStrokeFrame = requestAnimationFrame(drawLiveStrokeSegments);
  };

  const drawSelection = () => {
    const operation = operations[selectedIndex];
    if (!operation) return;
    const bounds = operationBounds(operation, context);
    context.save();
    context.strokeStyle = "#ffffff";
    context.lineWidth = Math.max(1, canvas.width / Math.max(canvas.clientWidth, 1));
    context.setLineDash([6, 4]);
    context.strokeRect(bounds.x - 3, bounds.y - 3, bounds.width + 6, bounds.height + 6);
    context.setLineDash([]);
    operationHandles(operation, context).forEach((handle) => {
      context.beginPath();
      context.arc(handle.x, handle.y, Math.max(5, canvas.width / Math.max(canvas.clientWidth, 1) * 5), 0, Math.PI * 2);
      context.fillStyle = "#fff";
      context.fill();
      context.strokeStyle = "#111";
      context.stroke();
    });
    context.restore();
  };

  const drawCropGuide = () => {
    if (!crop) return;
    const normalized = normalizeImageCrop(crop, canvas);
    context.save();
    context.fillStyle = "rgb(0 0 0 / 0.52)";
    context.beginPath();
    context.rect(0, 0, canvas.width, canvas.height);
    context.rect(normalized.x, normalized.y, normalized.width, normalized.height);
    context.fill("evenodd");
    context.strokeStyle = "#fff";
    context.lineWidth = Math.max(1, canvas.width / Math.max(canvas.clientWidth, 1));
    context.setLineDash([8, 5]);
    context.strokeRect(normalized.x, normalized.y, normalized.width, normalized.height);
    context.setLineDash([]);
    const radius = Math.max(5, canvas.width / Math.max(canvas.clientWidth, 1) * 5);
    imageCropHandles(normalized).forEach((handle) => {
      context.beginPath();
      context.arc(handle.x, handle.y, radius, 0, Math.PI * 2);
      context.fillStyle = "#fff";
      context.fill();
      context.strokeStyle = "#111";
      context.lineWidth = Math.max(1, radius / 4);
      context.stroke();
    });
    context.restore();
  };

  const render = ({ guides = true, target = canvas } = {}) => {
    if (!image || !target.width || !target.height) return;
    const targetContext = target.getContext("2d", { willReadFrequently: true });
    targetContext.clearRect(0, 0, target.width, target.height);
    targetContext.imageSmoothingEnabled = true;
    targetContext.imageSmoothingQuality = "high";
    targetContext.drawImage(image, 0, 0, target.width, target.height);
    operations.forEach((operation, index) => {
      if (target === canvas && textEditing?.index === index && !textBox.hidden) return;
      drawOperation(targetContext, operation);
    });
    if (draft && draft.type !== "text-region") drawOperation(targetContext, draft);
    if (guides && target === canvas) {
      if (tool === "crop") drawCropGuide();
      if (selectedIndex >= 0 && (tool === "select" || (tool === "text" && operations[selectedIndex]?.type === "text"))) drawSelection();
      if (draft?.type === "text-region") {
        targetContext.save();
        targetContext.strokeStyle = colorInput.value;
        targetContext.lineWidth = Math.max(1, canvas.width / Math.max(canvas.clientWidth, 1));
        targetContext.setLineDash([8, 5]);
        targetContext.strokeRect(draft.x, draft.y, draft.width, draft.height);
        targetContext.restore();
      }
    }
  };

  const requestRender = () => {
    if (renderFrame) return;
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0;
      render();
    });
  };

  const renderNow = () => {
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    render();
  };

  const updateBrushCursor = (event = null) => {
    if (event) brushCursorClientPoint = { x: event.clientX, y: event.clientY };
    const isBrush = ["pen", "mosaic"].includes(tool);
    canvas.dataset.imageEditorBrush = String(isBrush);
    if (!isBrush || !brushCursorClientPoint || canvas.hidden || !canvas.width) {
      brushCursor.hidden = true;
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const { x, y } = brushCursorClientPoint;
    if (x < canvasRect.left || x > canvasRect.right || y < canvasRect.top || y > canvasRect.bottom) {
      brushCursor.hidden = true;
      return;
    }
    const shellRect = canvasShell.getBoundingClientRect();
    const diameter = imageEditorBrushCursorDiameter({
      tool,
      size: sizeInput.value,
      displayScale: canvasRect.width / Math.max(canvas.width, 1),
    });
    brushCursor.dataset.tool = tool;
    brushCursor.style.setProperty("--image-editor-brush-diameter", `${diameter}px`);
    brushCursor.style.left = `${x - shellRect.left}px`;
    brushCursor.style.top = `${y - shellRect.top}px`;
    brushCursor.hidden = false;
  };

  const hideBrushCursor = () => {
    brushCursorClientPoint = null;
    brushCursor.hidden = true;
  };

  const positionTextBox = () => {
    if (!textEditing || textBox.hidden || !canvas.width || !canvas.height) return;
    const canvasRect = canvas.getBoundingClientRect();
    const shellRect = canvasShell.getBoundingClientRect();
    const scaleX = canvasRect.width / canvas.width;
    const scaleY = canvasRect.height / canvas.height;
    const bounds = textEditing.bounds;
    textBox.style.left = `${canvasRect.left - shellRect.left + bounds.x * scaleX}px`;
    textBox.style.top = `${canvasRect.top - shellRect.top + bounds.y * scaleY}px`;
    textBox.style.width = `${Math.max(48, bounds.width * scaleX)}px`;
    textBox.style.height = `${Math.max(32, bounds.height * scaleY)}px`;
    textBox.style.fontSize = `${Math.max(12, textEditing.fontSize * Math.min(scaleX, scaleY))}px`;
    textBox.style.color = textEditing.color;
  };

  const commitSelectedTextStyleChange = () => {
    if (!selectedTextStyleDirty) return;
    selectedTextStyleDirty = false;
    commit();
  };

  const syncSelectedTextControls = (index = selectedIndex) => {
    const operation = operations[index];
    if (operation?.type !== "text") return;
    sizeMemory.text = clamp(operation.fontSize, 12, 180);
    sizeInput.value = String(sizeMemory.text);
    sizeOutput.value = sizeInput.value;
    colorInput.value = operation.color || colorInput.value;
  };

  const finishTextEditing = ({ accept = true } = {}) => {
    if (!textEditing) return false;
    const editing = textEditing;
    const value = textBox.value.trim();
    textEditing = null;
    textBox.hidden = true;
    textBox.value = "";
    if (!accept) {
      render();
      return false;
    }
    if (editing.index >= 0) {
      if (value) {
        operations[editing.index] = {
          ...operations[editing.index],
          ...editing.bounds,
          text: value,
          fontSize: editing.fontSize,
          color: editing.color,
        };
        selectedIndex = editing.index;
      } else {
        operations.splice(editing.index, 1);
        selectedIndex = -1;
      }
      commit();
    } else if (value) {
      operations.push({
        type: "text",
        ...editing.bounds,
        text: value,
        fontSize: editing.fontSize,
        color: editing.color,
      });
      selectedIndex = operations.length - 1;
      commit();
    }
    selectedTextStyleDirty = false;
    render();
    return Boolean(value);
  };

  const startTextEditing = (bounds, index = -1) => {
    commitSelectedTextStyleChange();
    finishTextEditing();
    const existing = index >= 0 ? operations[index] : null;
    const x = clamp(bounds.x, 0, Math.max(0, canvas.width - 48));
    const y = clamp(bounds.y, 0, Math.max(0, canvas.height - 32));
    const normalized = {
      x,
      y,
      width: Math.max(48, Math.min(bounds.width, canvas.width - x)),
      height: Math.max(32, Math.min(bounds.height, canvas.height - y)),
    };
    textEditing = {
      index,
      bounds: normalized,
      fontSize: clamp(existing?.fontSize || sizeInput.value || 32, 12, 180),
      color: existing?.color || colorInput.value,
    };
    sizeMemory.text = textEditing.fontSize;
    sizeInput.value = String(textEditing.fontSize);
    sizeOutput.value = sizeInput.value;
    colorInput.value = textEditing.color;
    textBox.value = existing?.text || "";
    textBox.hidden = false;
    positionTextBox();
    render();
    requestAnimationFrame(() => {
      positionTextBox();
      textBox.focus({ preventScroll: true });
      textBox.select();
    });
  };

  const setTool = (nextTool) => {
    commitSelectedTextStyleChange();
    const previousSizeBucket = sizeBucket(tool);
    if (previousSizeBucket) sizeMemory[previousSizeBucket] = Number(sizeInput.value) || sizeMemory[previousSizeBucket];
    tool = IMAGE_CARD_EDITOR_TOOLS.some((item) => item.id === nextTool) ? nextTool : "select";
    selectedIndex = -1;
    draft = null;
    clearLiveCanvas();
    dialog.querySelectorAll("[data-image-editor-tool]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.imageEditorTool === tool)));
    colorField.hidden = ["select", "crop", "mosaic"].includes(tool);
    sizeField.hidden = ["select", "crop"].includes(tool);
    sizeLabel.textContent = tool === "text" ? "字号" : tool === "mosaic" ? "大小" : "粗细";
    sizeInput.min = tool === "text" ? "12" : tool === "mosaic" ? "8" : "2";
    sizeInput.max = tool === "text" ? "180" : tool === "mosaic" ? "80" : "32";
    const nextSizeBucket = sizeBucket(tool);
    if (nextSizeBucket) sizeInput.value = String(sizeMemory[nextSizeBucket]);
    sizeOutput.value = sizeInput.value;
    tip.textContent = tool === "select"
      ? "拖拽标注可移动；拖拽控制点可调整位置和大小。"
      : tool === "crop"
        ? "拖出裁剪范围；拖拽框内可移动，拖拽边缘或角点可调整大小。"
        : tool === "text"
          ? "单击已有文字可选择；在空白处拖出区域才会创建新文字，双击已有文字可修改内容。"
          : "在图片上拖拽绘制；完成后可用选择工具移动或调整。";
    updateBrushCursor();
    render();
  };

  const loadHtmlImage = (source) => new Promise((resolve, reject) => {
    const next = new Image();
    next.decoding = "async";
    next.onload = () => {
      if (!next.naturalWidth || !next.naturalHeight) {
        reject(new Error("图片数据无效或为空"));
        return;
      }
      resolve(next);
    };
    next.onerror = () => reject(new Error("图片读取失败"));
    next.src = source;
  });

  const loadImage = async (source) => {
    try {
      const response = await fetch(source, { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("图片数据为空");
      // Chromium on Windows can decode some large PNG/WebP blobs into an
      // ImageBitmap that reports the right dimensions but draws as solid
      // black on a 2D canvas. A blob-backed HTMLImageElement uses Chromium's
      // stable image decode path and remains compatible with authenticated
      // attachment responses.
      const objectUrl = URL.createObjectURL(blob);
      try {
        const loaded = await loadHtmlImage(objectUrl);
        loaded.dataset.blobUrl = objectUrl;
        return loaded;
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
    } catch {
      return loadHtmlImage(source);
    }
  };

  const close = () => {
    commitSelectedTextStyleChange();
    if (renderFrame) cancelAnimationFrame(renderFrame);
    renderFrame = 0;
    clearLiveCanvas();
    if (image?.dataset?.blobUrl) {
      URL.revokeObjectURL(image.dataset.blobUrl);
      delete image.dataset.blobUrl;
    }
    image?.close?.();
    image = null;
    pointerDrag = null;
    draft = null;
    textEditing = null;
    textBox.hidden = true;
    textBox.value = "";
    selectedTextStyleDirty = false;
    hideBrushCursor();
    saveHandler = null;
    if (dialog.open) dialog.close();
  };

  const open = async ({ src, name = "图片", onSave } = {}) => {
    if (!src) throw new Error("当前图片没有可编辑的文件");
    operations = [];
    crop = null;
    selectedIndex = -1;
    draft = null;
    textEditing = null;
    selectedTextStyleDirty = false;
    hideBrushCursor();
    textBox.hidden = true;
    textBox.value = "";
    history = [];
    historyIndex = -1;
    saveHandler = typeof onSave === "function" ? onSave : null;
    nameOutput.textContent = name;
    loading.textContent = "正在读取图片…";
    loading.hidden = false;
    canvas.hidden = true;
    saveButton.disabled = true;
    setTool("select");
    if (!dialog.open) dialog.showModal();
    try {
      imageUrl = src;
      image = await loadImage(src);
      const raster = imageEditorRasterSize({ width: image.naturalWidth || image.width, height: image.naturalHeight || image.height });
      canvas.width = raster.width;
      canvas.height = raster.height;
      canvas.style.aspectRatio = `${raster.width} / ${raster.height}`;
      liveCanvas.width = raster.width;
      liveCanvas.height = raster.height;
      liveCanvas.style.aspectRatio = `${raster.width} / ${raster.height}`;
      clearLiveCanvas();
      loading.hidden = true;
      canvas.hidden = false;
      syncCanvasPresentationSize();
      requestAnimationFrame(syncCanvasPresentationSize);
      saveButton.disabled = false;
      commit();
      render();
    } catch (error) {
      loading.textContent = error.message || "图片读取失败";
      throw error;
    }
  };

  const exportResult = async () => {
    const rendered = document.createElement("canvas");
    rendered.width = canvas.width;
    rendered.height = canvas.height;
    render({ guides: false, target: rendered });
    const targetCrop = normalizeImageCrop(crop, rendered);
    const output = document.createElement("canvas");
    output.width = Math.max(1, Math.round(targetCrop.width));
    output.height = Math.max(1, Math.round(targetCrop.height));
    output.getContext("2d").drawImage(rendered, targetCrop.x, targetCrop.y, targetCrop.width, targetCrop.height, 0, 0, output.width, output.height);
    return { blob: await canvasBlob(output), width: output.width, height: output.height, sourceUrl: imageUrl };
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !image) return;
    event.preventDefault();
    commitSelectedTextStyleChange();
    updateBrushCursor(event);
    canvas.setPointerCapture?.(event.pointerId);
    const point = imageEditorPointer(event, canvas);
    const tolerance = Math.max(6, canvas.width / Math.max(canvas.clientWidth, 1) * 7);
    if (tool === "select") {
      const hit = hitOperation(operations, point, context, tolerance);
      selectedIndex = hit?.index ?? -1;
      pointerDrag = hit ? { pointerId: event.pointerId, start: point, last: point, mode: "transform", hit, startOperation: cloneValue(operations[hit.index]), changed: false } : null;
      render();
      return;
    }
    if (tool === "text") {
      finishTextEditing();
      const hit = hitTextOperation(operations, point, context, tolerance);
      if (hit) {
        selectedIndex = hit.index;
        syncSelectedTextControls(hit.index);
        pointerDrag = { pointerId: event.pointerId, start: point, last: point, mode: "transform", hit, startOperation: cloneValue(operations[hit.index]), changed: false };
        render();
        return;
      }
      selectedIndex = -1;
      draft = { type: "text-region", x: point.x, y: point.y, width: 0, height: 0 };
      pointerDrag = { pointerId: event.pointerId, start: point, last: point, mode: "text-create", changed: false };
      render();
      return;
    }
    if (tool === "crop") {
      const normalizedCrop = crop ? normalizeImageCrop(crop, canvas) : null;
      const hit = normalizedCrop ? hitImageCrop(normalizedCrop, point, { tolerance }) : null;
      if (hit?.mode === "move") {
        pointerDrag = { pointerId: event.pointerId, start: point, last: point, mode: "crop-move", startCrop: normalizedCrop, changed: false };
      } else if (hit?.mode === "resize") {
        pointerDrag = { pointerId: event.pointerId, start: point, last: point, mode: "crop-resize", handle: hit.handle, startCrop: normalizedCrop, changed: false };
      } else {
        const previousCrop = normalizedCrop ? { ...normalizedCrop } : null;
        crop = { x: point.x, y: point.y, width: 0, height: 0 };
        pointerDrag = { pointerId: event.pointerId, start: point, last: point, mode: "crop-create", previousCrop, changed: false };
      }
      render();
      return;
    }
    const common = { color: colorInput.value, size: clamp(sizeInput.value, 2, tool === "mosaic" ? 80 : 32) };
    if (["rectangle"].includes(tool)) draft = { type: tool, x: point.x, y: point.y, width: 0, height: 0, ...common };
    else if (["line", "arrow"].includes(tool)) draft = { type: tool, start: point, end: point, arrowSize: Math.max(12, common.size * 4), ...common };
    else draft = { type: tool, points: [point], ...common };
    pointerDrag = { pointerId: event.pointerId, start: point, last: point, mode: "draw" };
    if (["pen", "mosaic"].includes(tool)) {
      clearLiveCanvas();
      if (tool === "mosaic") prepareLiveMosaicPattern(draft);
      requestLiveStrokeRender();
      return;
    }
    render();
  });

  const continuePointerGesture = (event) => {
    updateBrushCursor(event);
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const coalescedEvents = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];
    const sampleEvents = coalescedEvents.length ? coalescedEvents : [event];
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(canvasRect.width, 1);
    const scaleY = canvas.height / Math.max(canvasRect.height, 1);
    const samplePoints = sampleEvents.map((sample) => ({
      x: clamp((sample.clientX - canvasRect.left) * scaleX, 0, canvas.width),
      y: clamp((sample.clientY - canvasRect.top) * scaleY, 0, canvas.height),
    }));
    const point = samplePoints[samplePoints.length - 1];
    if (pointerDrag.mode === "transform" && pointerDrag.hit) {
      const { index, mode, handle } = pointerDrag.hit;
      if (mode === "handle") operations[index] = resizeOperation(operations[index], handle, point, pointerDrag.startOperation, pointerDrag.start);
      else {
        const dx = point.x - pointerDrag.last.x;
        const dy = point.y - pointerDrag.last.y;
        operations[index] = translateOperation(operations[index], dx, dy);
      }
      pointerDrag.changed ||= Math.hypot(point.x - pointerDrag.last.x, point.y - pointerDrag.last.y) > 0.05;
      pointerDrag.last = point;
    } else if (pointerDrag.mode === "crop-create") {
      crop = { x: pointerDrag.start.x, y: pointerDrag.start.y, width: point.x - pointerDrag.start.x, height: point.y - pointerDrag.start.y };
      pointerDrag.changed = true;
    } else if (pointerDrag.mode === "crop-move") {
      crop = moveImageCrop(pointerDrag.startCrop, point.x - pointerDrag.start.x, point.y - pointerDrag.start.y, canvas);
      pointerDrag.changed = true;
    } else if (pointerDrag.mode === "crop-resize") {
      crop = resizeImageCrop(pointerDrag.startCrop, pointerDrag.handle, point, canvas);
      pointerDrag.changed = true;
    }
    else if (pointerDrag.mode === "text-create") {
      draft = { type: "text-region", ...rectFromPoints(pointerDrag.start, point) };
      pointerDrag.changed = true;
    }
    else if (draft?.type === "rectangle") Object.assign(draft, rectFromPoints(pointerDrag.start, point));
    else if (["line", "arrow"].includes(draft?.type)) draft.end = point;
    else if (["pen", "mosaic"].includes(draft?.type)) {
      appendImageEditorStrokeSamplesInPlace(draft.points, samplePoints, Math.max(0.25, Number(draft.size) * 0.08));
    }
    pointerDrag.last = point;
    if (["pen", "mosaic"].includes(draft?.type)) requestLiveStrokeRender();
    else requestRender();
  };
  // Chromium exposes pointerrawupdate at the device sampling rate. Keeping the
  // regular pointermove listener as well preserves compatibility, while the
  // distance filter above removes duplicate samples emitted by both streams.
  canvas.addEventListener("pointermove", continuePointerGesture);
  if ("onpointerrawupdate" in window) canvas.addEventListener("pointerrawupdate", continuePointerGesture);

  const finishPointer = (event) => {
    if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
    if (event.type === "pointercancel") {
      if (pointerDrag.mode === "transform" && pointerDrag.changed && pointerDrag.hit) operations[pointerDrag.hit.index] = pointerDrag.startOperation;
      if (["crop-move", "crop-resize"].includes(pointerDrag.mode)) crop = pointerDrag.startCrop;
      if (pointerDrag.mode === "crop-create") crop = pointerDrag.previousCrop;
      draft = null;
      pointerDrag = null;
      clearLiveCanvas();
      renderNow();
      return;
    }
    if (pointerDrag.mode === "transform" && pointerDrag.changed) commit();
    else if (["crop-create", "crop-move", "crop-resize"].includes(pointerDrag.mode)) {
      crop = normalizeImageCrop(crop, canvas);
      commit();
    } else if (pointerDrag.mode === "text-create") {
      const scale = canvas.width / Math.max(canvas.clientWidth, 1);
      const minimumTextRegion = Math.max(4, scale * 6);
      const bounds = draft && draft.width >= minimumTextRegion && draft.height >= minimumTextRegion ? draft : null;
      draft = null;
      pointerDrag = null;
      renderNow();
      if (bounds) startTextEditing(bounds);
      return;
    } else if (draft) {
      const bounds = operationBounds(draft, context);
      if (Math.max(bounds.width, bounds.height) >= 2 || ["pen", "mosaic"].includes(draft.type)) {
        operations.push(draft);
        selectedIndex = operations.length - 1;
        commit();
      }
    }
    draft = null;
    pointerDrag = null;
    clearLiveCanvas();
    renderNow();
  };
  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);
  canvas.addEventListener("pointerenter", updateBrushCursor);
  canvas.addEventListener("pointerleave", () => {
    if (!pointerDrag) hideBrushCursor();
  });
  canvas.addEventListener("dblclick", (event) => {
    if (!image) return;
    const point = imageEditorPointer(event, canvas);
    const tolerance = Math.max(6, canvas.width / Math.max(canvas.clientWidth, 1) * 7);
    const hit = hitTextOperation(operations, point, context, tolerance);
    if (hit == null) return;
    event.preventDefault();
    setTool("text");
    startTextEditing(operationBounds(operations[hit.index], context), hit.index);
  });

  dialog.addEventListener("click", async (event) => {
    const toolButton = event.target.closest("[data-image-editor-tool]");
    if (toolButton) {
      setTool(toolButton.dataset.imageEditorTool);
      return;
    }
    if (event.target.closest("[data-image-editor-undo]")) {
      commitSelectedTextStyleChange();
      if (historyIndex > 0) restore(history[--historyIndex]);
      syncHistoryButtons();
      return;
    }
    if (event.target.closest("[data-image-editor-redo]")) {
      if (historyIndex < history.length - 1) restore(history[++historyIndex]);
      syncHistoryButtons();
      return;
    }
    if (event.target.closest("[data-image-editor-close], [data-image-editor-cancel]")) {
      close();
      return;
    }
    if (event.target.closest("[data-image-editor-save]")) {
      saveButton.disabled = true;
      saveButton.textContent = "正在保存…";
      try {
        finishTextEditing();
        commitSelectedTextStyleChange();
        const result = await exportResult();
        if (saveHandler) await saveHandler(result);
        close();
      } catch (error) {
        dialog.dispatchEvent(new CustomEvent("image-editor-error", { detail: error }));
      } finally {
        saveButton.disabled = false;
        saveButton.textContent = "保存为新图片";
      }
    }
  });

  sizeInput.addEventListener("input", () => {
    sizeOutput.value = sizeInput.value;
    const bucket = sizeBucket(tool);
    if (bucket) sizeMemory[bucket] = Number(sizeInput.value) || sizeMemory[bucket];
    if (textEditing) {
      textEditing.fontSize = clamp(sizeInput.value, 12, 180);
      positionTextBox();
    } else if (tool === "text" && operations[selectedIndex]?.type === "text") {
      const fontSize = clamp(sizeInput.value, 12, 180);
      const current = operations[selectedIndex];
      const scaleRatio = fontSize / Math.max(1, Number(current.fontSize) || fontSize);
      const availableWidth = Math.max(1, canvas.width - current.x);
      const availableHeight = Math.max(1, canvas.height - current.y);
      operations[selectedIndex] = {
        ...current,
        fontSize,
        width: Math.min(availableWidth, Math.max(fontSize * 2, (Number(current.width) || fontSize * 2) * scaleRatio)),
        height: Math.min(availableHeight, Math.max(fontSize * 1.35, (Number(current.height) || fontSize * 1.35) * scaleRatio)),
      };
      selectedTextStyleDirty = true;
      requestRender();
    }
    updateBrushCursor();
  });
  sizeInput.addEventListener("change", commitSelectedTextStyleChange);
  colorInput.addEventListener("input", () => {
    if (textEditing) {
      textEditing.color = colorInput.value;
      textBox.style.color = colorInput.value;
    } else if (tool === "text" && operations[selectedIndex]?.type === "text") {
      operations[selectedIndex] = { ...operations[selectedIndex], color: colorInput.value };
      selectedTextStyleDirty = true;
      requestRender();
    }
  });
  colorInput.addEventListener("change", commitSelectedTextStyleChange);
  textBox.addEventListener("blur", () => finishTextEditing());
  textBox.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finishTextEditing({ accept: false });
      canvas.focus?.({ preventScroll: true });
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      finishTextEditing();
      canvas.focus?.({ preventScroll: true });
    }
  });
  window.addEventListener("resize", positionTextBox);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key.toLowerCase() !== "z") return;
    event.preventDefault();
    if (event.shiftKey && historyIndex < history.length - 1) restore(history[++historyIndex]);
    else if (!event.shiftKey && historyIndex > 0) restore(history[--historyIndex]);
    syncHistoryButtons();
  });

  return { dialog, open, close, exportResult, getState: () => snapshot() };
};
