import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compactFullyReadContextContent } from "../src/context-compiler.js";
import {
  buildContextSourceManifest,
  contextManifestPrompt,
} from "../src/context-manifest.js";

const longDocument = `第一章\n${"正文证据。".repeat(9_000)}\n结尾事实。`;
const read = compactFullyReadContextContent(longDocument, 8_000, {
  query: "结尾事实",
  label: "当前绑定文档",
});

const manifest = buildContextSourceManifest({
  requestId: "request-v300-context",
  sources: [
    {
      kind: "document",
      id: "chapter-1",
      title: "第一章",
      content: longDocument,
      fullSourceRead: read.fullText,
      compressed: read.compressed,
      chunksRead: read.chunksRead,
      chunkReceipts: read.chunkReceipts,
      included: true,
      required: true,
      reason: "current_bound_document",
    },
    {
      kind: "skill",
      id: "writer-primary",
      title: "主笔",
      content: "完整主笔规则",
      fullSourceRead: true,
      included: true,
      required: true,
      reason: "enabled_selected_skill",
    },
  ],
});

assert.equal(manifest.requestId, "request-v300-context");
assert.equal(manifest.included.length, 2);
assert.equal(manifest.excluded.length, 0);
assert.equal(manifest.included[0].fullSourceRead, true);
assert.equal(manifest.included[0].compressed, true);
assert.equal(manifest.included[0].chunksRead, read.chunksRead);
assert.equal(manifest.included[0].contentLength, longDocument.length);
assert.match(manifest.included[0].contentHash, /^fnv1a-[0-9a-f]{8}$/u);
assert.equal(Object.hasOwn(manifest.included[0], "content"), false, "清单不得复制正文内容");
assert.match(contextManifestPrompt(manifest), /chapter-1/u);
assert.match(contextManifestPrompt(manifest), /全文已读·压缩/u);

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(serverSource, /buildContextSourceManifest\(\{[\s\S]{0,700}agentExecutionSources/u, "真实 Agent 执行必须记录统一来源清单");
assert.match(serverSource, /contextManifest:\s*agentContextSourceManifest/u, "全文来源回执必须携带清单");

console.log("Shensi v3.0 context manifest tests passed");
