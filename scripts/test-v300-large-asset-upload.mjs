import assert from "node:assert/strict";
import { standaloneAssetUploadWorkerCount } from "../src/asset-upload-policy.js";
import { readFile } from "node:fs/promises";

assert.equal(standaloneAssetUploadWorkerCount([]), 1);
assert.equal(standaloneAssetUploadWorkerCount([{ size: 2 * 1024 * 1024 }]), 3);
assert.equal(standaloneAssetUploadWorkerCount([{ size: 80 * 1024 * 1024 }]), 2,
  "普通大媒体应限制并发，保留界面响应");
assert.equal(standaloneAssetUploadWorkerCount([{ size: 300 * 1024 * 1024 }]), 1,
  "超大媒体必须串行上传，避免同一工作区磁盘与内存争抢");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /standaloneAssetUploadWorkerCount\(accepted\)/u, "上传任务必须按体积选择并发度");
assert.match(app, /await yieldAssetUploadToUi\(\)/u, "每个上传项之间必须主动让出渲染帧");
assert.match(app, /loading="lazy" decoding="async"/u, "资产缩略图必须延迟解码");
assert.match(app, /preload="metadata"/u, "视频资产列表不得预加载完整媒体");

console.log("v3.0 大资产上传响应性测试通过");
