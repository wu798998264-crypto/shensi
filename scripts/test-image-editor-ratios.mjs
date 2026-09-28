import assert from "node:assert/strict";
import {
  IMAGE_EDITOR_CROP_ASPECT_RATIOS,
  fitImageCropToAspect,
  imageCropFromDrag,
  imageEditorAspectRatioValue,
} from "../src/image-card-editor.js";

assert.deepEqual(IMAGE_EDITOR_CROP_ASPECT_RATIOS.map((item) => item.value), [
  "free", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "9:21",
]);
assert.equal(imageEditorAspectRatioValue("16:9"), 16 / 9);
assert.equal(imageEditorAspectRatioValue("free"), null);

const landscape = imageCropFromDrag({ x: 80, y: 40 }, { x: 680, y: 440 }, 16 / 9, { width: 800, height: 500 });
assert.ok(Math.abs(landscape.width / landscape.height - 16 / 9) < 0.001, "拖拽裁剪框必须锁定 16:9");
assert.ok(landscape.x >= 0 && landscape.y >= 0 && landscape.x + landscape.width <= 800 && landscape.y + landscape.height <= 500);

const portrait = fitImageCropToAspect({ x: 0, y: 0, width: 800, height: 500 }, 9 / 16, { width: 800, height: 500 });
assert.ok(Math.abs(portrait.width / portrait.height - 9 / 16) < 0.001, "预设比例必须锁定 9:16");
assert.ok(portrait.x >= 0 && portrait.y >= 0 && portrait.x + portrait.width <= 800 && portrait.y + portrait.height <= 500);

console.log("image editor crop ratio helpers: ok");
