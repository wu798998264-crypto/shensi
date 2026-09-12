import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mediaGenerationErrorText } from "../src/domains/media/media-error-presentation.js";
import { taskCardActualReadEvidence } from "../src/domains/document/task-card-evidence.js";

const [app, mediaPresentation, documentEvidence] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/domains/media/media-error-presentation.js", import.meta.url), "utf8"),
  readFile(new URL("../src/domains/document/task-card-evidence.js", import.meta.url), "utf8"),
]);

assert.match(app, /\.\/domains\/media\/media-error-presentation\.js/u,
  "应用组合层必须从独立媒体域加载错误呈现");
assert.match(app, /\.\/domains\/document\/task-card-evidence\.js/u,
  "应用组合层必须从独立文档域加载读取证据");
assert.doesNotMatch(documentEvidence, /whiteboard|dreamina|libtv|media-/iu,
  "文档任务卡域不得依赖白板或媒体生成实现");
assert.doesNotMatch(mediaPresentation, /conversation|task-card|landing-document/iu,
  "媒体错误域不得依赖对话任务卡或文档落盘实现");

const reads = taskCardActualReadEvidence([
  { kind: "document", id: "outline", title: "故事大纲", characters: 1200, fullText: true },
  { kind: "document", id: "outline", title: "故事大纲", characters: 300, readKind: "search_excerpt" },
  { kind: "document", id: "empty", title: "空文档", characters: 0 },
  { kind: "document", id: "route", title: "神思任务路由", characters: 900, userVisible: false },
  { kind: "skill", id: "story", title: "故事创作", characters: 500 },
]);
assert.deepEqual(reads.map((item) => item.title), ["故事大纲", "故事创作"],
  "任务卡只显示真实读取并按资源去重");
assert.equal(reads[0].detail, "全文", "重复读取必须保留最强的全文证据");

assert.match(mediaGenerationErrorText({
  status: "failed",
  request: { settings: { provider: "libtv", remarkName: "LibTV 主配置" } },
  providerErrorCode: "LIBTV_REQUEST_FAILED",
  error: "upstream timeout",
}), /LibTV 配置“LibTV 主配置”.*LIBTV_REQUEST_FAILED.*upstream timeout/u,
"媒体错误呈现必须保留配置、错误码和厂商原始原因");

console.log("Runtime domain presentation isolation checks passed");
