import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const whiteboardSource = await readFile(new URL("../src/whiteboard.js", import.meta.url), "utf8");

assert.match(
  appSource,
  /data-attachment-preview-src="\$\{escapeHtml\(visibleImageUrl\)\}"/u,
  "图片卡片必须把已缓存预览源交给双击预览",
);
assert.match(
  appSource,
  /const previewSource = !video[\s\S]{0,500}const initialSource = previewSource \|\| source/u,
  "图片预览必须先显示已解码缩略图，再后台升级原图",
);
assert.match(
  appSource,
  /if \(!video && initialSource !== source\)[\s\S]{0,700}upgrade\.src = source/u,
  "图片预览必须在弹窗显示后后台加载原图",
);
assert.match(
  appSource,
  /const rawX = drag\.nodeX \+ deltaX \/ drag\.zoom;[\s\S]{0,260}const x = snapCanvasValue\(rawX, drag\.canvasSettings\);[\s\S]{0,120}const y = snapCanvasValue\(rawY, drag\.canvasSettings\);/u,
  "开启自动吸附时，卡片拖拽预览必须实时吸附到网格",
);
assert.match(
  whiteboardSource,
  /if \(settings\.snapToGrid === false\) return finite\(value, 0\);[\s\S]{0,120}return Math\.round\(finite\(value, 0\) \/ size\) \* size;/u,
  "关闭自动吸附时，拖拽预览必须保持原始像素位置",
);

console.log("白板即时预览与可切换网格吸附拖拽契约测试通过");
