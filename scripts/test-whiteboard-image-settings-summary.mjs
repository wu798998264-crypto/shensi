import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const appSource = await readFile(resolve("src/app.js"), "utf8");

assert.match(
  appSource,
  /const hasVisibleResolutionChoice = Boolean\([\s\S]{0,360}elements\.whiteboardImageResolutionField\?\.hidden[\s\S]{0,240}const resolution = hasVisibleResolutionChoice/u,
  "图片摘要必须只读取可见的独立分辨率选择，不得把隐藏的 1K 兼容回退值显示出来",
);
assert.match(
  appSource,
  /const resolution = hasVisibleResolutionChoice\s*\?\s*selectedOptionLabel\(form\.elements\.resolution, ""\)\s*:\s*"";/u,
  "没有独立分辨率选项时，图片摘要必须省略分辨率字段",
);
assert.match(
  appSource,
  /const hasBackgroundCapability = Boolean\(imageCapabilities\?\.backgrounds\?\.length\);[\s\S]{0,260}const background = hasBackgroundCapability && !elements\.whiteboardImageBackgroundField\?\.hidden/u,
  "图片摘要必须以当前模型的真实背景能力为准，不能显示隐藏表单的自动回退值",
);
assert.match(
  appSource,
  /const background = hasBackgroundCapability && !elements\.whiteboardImageBackgroundField\?\.hidden[\s\S]{0,180}: "";/u,
  "即梦和 GPT Image 2.0 等无背景能力的模型必须完全省略背景摘要",
);

console.log("白板图片设置摘要测试通过：隐藏的分辨率与背景回退值不会泄露到即梦/GPT 2.0 摘要");
