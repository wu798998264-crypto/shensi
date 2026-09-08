import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(worker, /job = await update\(job\.id, \{[\s\S]{0,900}capabilityProbe:[\s\S]{0,900}const selectedModel/u, "提交前必须先保存实时媒体模型目录");
assert.match(worker, /providerErrorCode: "MODEL_NOT_AVAILABLE",[\s\S]{0,140}submissionOutcomeKnown: true/u, "模型不可见必须标记为未提交的确定性失败");
assert.match(app, /error\.availableModels = Array\.isArray\(job\.capabilityProbe\?\.models\)/u, "UI 必须接收失败任务的实时模型目录");
assert.match(app, /failure\.state === "model_unconfirmed"[\s\S]{0,500}visibilityChecked: true, models: error\.availableModels/u, "所选模型失效后必须保留连接并刷新真实可选模型");

console.log("media model eligibility refresh regression passed");
