import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mediaGenerationErrorText } from "../src/domains/media/media-error-presentation.js";
import { taskCardActualReadEvidence } from "../src/domains/document/task-card-evidence.js";

const [app, server, mediaPresentation, mediaApi, documentEvidence, documentApi] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/domains/media/media-error-presentation.js", import.meta.url), "utf8"),
  readFile(new URL("../src/domains/media/media-generation-api.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/domains/document/task-card-evidence.js", import.meta.url), "utf8"),
  readFile(new URL("../src/domains/document/conversation-agent-api.mjs", import.meta.url), "utf8"),
]);

assert.match(app, /\.\/domains\/media\/media-error-presentation\.js/u,
  "应用组合层必须从独立媒体域加载错误呈现");
assert.match(app, /\.\/domains\/document\/task-card-evidence\.js/u,
  "应用组合层必须从独立文档域加载读取证据");
assert.match(server, /createMediaGenerationApi/u, "服务端组合层必须从独立媒体域加载生成任务 API");
assert.match(server, /createConversationAgentApi/u, "服务端组合层必须从独立文档域加载对话 Agent API");
assert.doesNotMatch(server, /pathname === "\/api\/generation\/jobs\/media"/u,
  "服务端组合层不得继续内联媒体生成任务路由");
assert.doesNotMatch(server, /pathname === "\/api\/conversation-agent\/start"/u,
  "服务端组合层不得继续内联文档对话任务路由");
assert.doesNotMatch(documentEvidence, /whiteboard|dreamina|libtv|media-/iu,
  "文档任务卡域不得依赖白板或媒体生成实现");
assert.doesNotMatch(mediaPresentation, /conversation|task-card|landing-document/iu,
  "媒体错误域不得依赖对话任务卡或文档落盘实现");
assert.doesNotMatch(mediaApi, /conversation-agent|document_saved|document transaction/iu,
  "媒体生成 API 不得依赖文档对话或落盘实现");
assert.doesNotMatch(documentApi, /dreamina|libtv|generation-job-store|media-generation-worker/iu,
  "文档对话 API 不得依赖即梦、LibTV 或媒体任务状态机");

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
