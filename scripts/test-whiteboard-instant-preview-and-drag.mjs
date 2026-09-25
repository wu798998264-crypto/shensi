import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

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
  /const x = drag\.nodeX \+ deltaX \/ drag\.zoom;[\s\S]{0,120}const y = drag\.nodeY \+ deltaY \/ drag\.zoom;/u,
  "卡片拖拽预览必须逐像素跟随鼠标，不得逐帧吸附网格",
);
assert.match(
  appSource,
  /Commit grid snapping once[\s\S]{0,600}snapCanvasValue\(drag\.pending\.x[\s\S]{0,240}snapCanvasValue\(drag\.pending\.y/u,
  "网格吸附必须只在松手提交时发生",
);

console.log("白板即时预览与无追赶拖拽契约测试通过");
