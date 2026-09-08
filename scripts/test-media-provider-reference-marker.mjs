import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sanitizeMediaProviderPrompt, stripResolvedMediaReferenceMarkers } from "../src/media-prompt.js";

const raw = "普通 @ 用户\n@「图片3」人物身穿黑甲，站在城门前。\n@「失效引用」\n@「图片3」再次强调。";
const cleaned = stripResolvedMediaReferenceMarkers(raw, { referenceTokens: ["图片3"] });
assert.equal(
  cleaned,
  "普通 @ 用户\n人物身穿黑甲，站在城门前。\n@「失效引用」\n再次强调。",
  "只应移除已解析的内部引用标记，普通 @ 和失效引用必须保留",
);

assert.equal(
  sanitizeMediaProviderPrompt("@「图片3」人物身穿黑甲，站在城门前。", { referenceTokens: ["@「图片3」"] }),
  "人物身穿黑甲，站在城门前。",
  "媒体提示词清理不能删除文字卡片引用正文",
);

assert.equal(
  sanitizeMediaProviderPrompt("@「图片3」\n@「失效引用」", { referenceTokens: ["图片3"] }),
  "@「失效引用」",
  "只有内部标记时应在提交前留下明确的非空校验结果，失效引用不能静默删除",
);

assert.equal(
  sanitizeMediaProviderPrompt("请让角色通过 @ 关注点完成动作；普通邮箱 user@example.com 不应被改写"),
  "请让角色通过 @ 关注点完成动作；普通邮箱 user@example.com 不应被改写",
  "没有解析引用时，普通 @ 文本必须完全保持不变",
);

const [appSource, jobStoreSource, driverSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"),
]);
assert.match(appSource, /providerPromptReferenceTokens:\s*whiteboardGenerationProviderReferenceTokens\(generationContext\)/u, "白板图片和视频任务必须携带已解析引用标记清单");
assert.match(jobStoreSource, /sanitizeMediaProviderPrompt\(request\?\.prompt,\s*\{ referenceTokens: providerPromptReferenceTokens \}\)/u, "服务端创建任务前必须按解析结果清理提示词");
assert.match(driverSource, /const providerPrompt = \(job = \{\}\) => sanitizeMediaProviderPrompt/u, "媒体驱动必须在最终厂商边界再次清理提示词");
assert.match(driverSource, /JSON\.stringify\(targetFirstImageReferences\(references\)\.map\(\(item\) => item\.absolutePath\)/u, "即梦图片参考文件必须独立于提示词通道传递");
assert.match(driverSource, /JSON\.stringify\(targetFirstReferences\(references\)\.map\(\(item\) => \(\{[\s\S]{0,300}absolutePath: item\.absolutePath/u, "即梦视频参考文件必须独立于提示词通道传递");

console.log("媒体提示词内部引用标记双通道契约测试通过");
