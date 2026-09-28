import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { depthExplorerEventProgress } from "../src/depth-explorer-progress.js";

assert.deepEqual(depthExplorerEventProgress([{ event: "progress", value: 37, message: "推理中" }, { event: "log", message: "still running" }]), { currentPercent: 37, message: "推理中" });
assert.equal(depthExplorerEventProgress([{ event: "progress", progress: 61 }]).currentPercent, 61);
assert.equal(depthExplorerEventProgress([{ event: "progress", value: 30 }, { event: "progress", value: "bad" }, { event: "provider", value: "cpu" }]).currentPercent, 30);
assert.equal(depthExplorerEventProgress([{ event: "progress", value: 105 }]).currentPercent, 100);
assert.equal(depthExplorerEventProgress([{ event: "log", value: 0 }]), null);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const extract = (name) => {
  const start = app.indexOf(`const ${name} = `);
  assert.ok(start >= 0, name);
  const end = app.indexOf("\n};", start);
  assert.ok(end > start, name);
  return app.slice(start, end + 3);
};
const runtime = { busy: false, checking: false, error: "", total: 1, completed: 0, currentPercent: 0, percent: 0 };
const node = { id: "depth", operation: { type: "depth-explorer", settings: {} } };
const context = vm.createContext({
  state: { activeDocument: "board", readOnly: false },
  whiteboardDepthExplorerRuntimeState: () => runtime,
  whiteboardDepthExplorerPreflight: null,
  whiteboardDepthExplorerConnectedInputs: () => [{ id: "image", kind: "image", file: "source.png" }],
  whiteboardDepthExplorerInputs: () => [{ id: "image", kind: "image", file: "source.png" }],
  whiteboardDepthExplorerSettings: () => ({ quality: "balanced", provider: "auto" }),
  escapeHtml: (v) => String(v), icon: () => "icon", node,
});
vm.runInContext(`${extract("whiteboardDepthExplorerRuntimeSignature")}\n${extract("whiteboardDepthExplorerNodeMarkup")}\n${extract("whiteboardCardRenderSignature")}`, context);
const signature = () => vm.runInContext('whiteboardCardRenderSignature({ stableNode: "unchanged", depthExplorerRuntimeSignature: whiteboardDepthExplorerRuntimeSignature("depth"), depthExplorerInputSignature: "image" })', context);
const markup = () => vm.runInContext('whiteboardDepthExplorerNodeMarkup(node, {id:"board"})', context);
const loadingSignature = signature();
assert.match(markup(), /程序正在加载/u);
assert.match(markup(), /whiteboard-depth-generate[\s\S]{0,180}disabled/u);
context.whiteboardDepthExplorerPreflight = { available: true, cpuThreads: 8 };
assert.notEqual(signature(), loadingSignature, "ready state invalidates final DOM key");
assert.match(markup(), /data-whiteboard-depth-action="generate">生成深度结果/u);
const readySignature = signature();
Object.assign(runtime, { busy: true, message: "正在推理", currentPercent: 37, percent: 37 });
assert.notEqual(signature(), readySignature);
assert.match(markup(), /disabled[\s\S]{0,40}>处理中/u);
assert.match(markup(), /当前任务 37%/u);
assert.match(markup(), /已完成 0/u);
const busySignature = signature();
Object.assign(runtime, { busy: false, completed: 1, currentPercent: 100, percent: 100, message: "已完成" });
assert.notEqual(signature(), busySignature);
assert.match(markup(), /data-whiteboard-depth-action="generate">生成深度结果/u);
assert.match(markup(), /已完成 1/u);
const recordSignature = app.match(/signature: whiteboardCardRenderSignature\(\{ stableNode:[^\n]+/u)?.[0] || "";
assert.match(recordSignature, /depthExplorerRuntimeSignature, depthExplorerInputSignature/u, "both runtime and upstream changes must invalidate applyCardRecord");
assert.match(app, /Math\.max\(750, activeDepthRuns \* 600\)/u, "depth polling stays below the 180/min endpoint rate limit");
assert.match(app, /runtime\.busy = Boolean\(runtime\.progressInterrupted\)/u, "lost status response must not enable duplicate CPU submissions");

const images = Array.from({ length: 8 }, (_, index) => ({
  id: index, isConnected: true, loading: "lazy", dataset: index % 2 ? {} : { whiteboardDeferredSrc: `image-${index}.png` },
  visible: index < 6,
  getBoundingClientRect() { return this.visible ? { left: 100, right: 200, top: 100, bottom: 200 } : { left: 9_000, right: 9_100, top: 9_000, bottom: 9_100 }; },
  setAttribute(key, value) { this[key] = value; },
  matches() { return this.loading === "lazy"; },
}));
const scheduled = [];
const surface = { dataset: { renderIdentity: "board" }, querySelectorAll: () => images.filter((item) => item.dataset.whiteboardDeferredSrc || item.loading === "lazy") };
surface.querySelector = () => surface.querySelectorAll()[0];
const hydration = vm.createContext({
  ui: {}, elements: { whiteboardSurface: surface, whiteboardEditor: { getBoundingClientRect: () => ({ left: 0, right: 1000, top: 0, bottom: 800, width: 1000, height: 800 }) } },
  activeWhiteboardDocument: () => ({ id: "board" }),
  WHITEBOARD_MEDIA_HYDRATION_MARGIN_PX: 360, WHITEBOARD_DEFERRED_IMAGE_BATCH: 4,
  cancelUiBackgroundTask: () => {},
  scheduleUiBackgroundTask: (run) => { scheduled.push(run); return scheduled.length; },
});
vm.runInContext(extract("scheduleWhiteboardMediaHydration"), hydration);
const hydrate = () => {
  vm.runInContext("scheduleWhiteboardMediaHydration()", hydration);
  let count = 0;
  while (scheduled.length) { assert.ok(++count < 10, "offscreen images must not create an endless hydration loop"); scheduled.shift()(); }
};
hydrate();
for (const image of images.slice(0, 6)) assert.equal(image.loading, "eager", "transformed visible rect overrides native lazy classification");
assert.equal(images[6].loading, "lazy", "far-offscreen cards stay deferred");
assert.equal(images[6].src, undefined);
images[6].visible = true;
images[7].visible = true;
hydrate();
assert.equal(images[6].src, "image-6.png", "panning into view hydrates the original media");
assert.equal(images[6].loading, "eager");
assert.equal(images[7].loading, "eager");
console.log("Depth DOM state transitions, actual event schema, progress budget and transformed visible-media hydration passed");
