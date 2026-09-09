import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compileServerVerifiedContext, serverDocumentText } from "../src/server/server-context-verifier.mjs";
import { contextAvailabilityDecision } from "../src/context-availability-policy.js";

const documents = {
  "chapter-8": {
    title: "第8章 渠底暗门",
    html: "",
    markdown: "这是真实存在且可以读取的第八章全文。\n\n第二段也必须被完整读取。",
    moduleId: "manuscript",
  },
};
assert.match(serverDocumentText(documents["chapter-8"]), /第二段也必须被完整读取/u, "空 html 不能遮蔽真实 markdown 正文");
const compiled = compileServerVerifiedContext({
  documents,
  prompt: "续写当前章节",
  targetDocumentId: "chapter-8",
  declaredRequiredIds: ["chapter-8"],
  fullDocumentIds: ["chapter-8"],
});
assert.equal(compiled.status, "ready");
assert.deepEqual(compiled.missingRequiredIds, []);
assert.match(compiled.context, /这是真实存在且可以读取的第八章全文/u);
assert.match(compiled.context, /第二段也必须被完整读取/u);

const blankOutputDocuments = {
  "public-account-article": {
    title: "公众号文章",
    html: "",
    markdown: "",
    moduleId: "manuscript",
  },
};
const blankOutputContext = compileServerVerifiedContext({
  documents: blankOutputDocuments,
  prompt: "生成一篇公众号文章",
  targetDocumentId: "public-account-article",
  declaredRequiredIds: ["public-account-article"],
  fullDocumentIds: ["public-account-article"],
});
assert.equal(blankOutputContext.status, "ready", "空白输出目标不能被当作缺失的必读资料");
assert.deepEqual(blankOutputContext.missingRequiredIds, []);

const explicitlyReferencedBlankOutput = compileServerVerifiedContext({
  documents: blankOutputDocuments,
  prompt: "参考 @公众号文章 后生成新稿",
  targetDocumentId: "public-account-article",
  explicitReferenceDocumentIds: ["public-account-article"],
  declaredRequiredIds: ["public-account-article"],
  fullDocumentIds: ["public-account-article"],
});
assert.equal(explicitlyReferencedBlankOutput.status, "recoverable", "用户明确引用的空文档仍应暂停自动执行，但必须允许用户确认从零开始");
assert.deepEqual(explicitlyReferencedBlankOutput.missingRequiredIds, ["public-account-article"]);

const largeDocuments = Object.fromEntries(Array.from({ length: 800 }, (_, index) => [
  `document-${index + 1}`,
  { title: `资料 ${index + 1}`, markdown: `资料正文 ${index + 1}：${"线索".repeat(80)}`, moduleId: "library" },
]));
largeDocuments["chapter-target"] = {
  title: "当前目标章",
  markdown: `目标开头\n${"必须完整读取的目标正文。".repeat(12_000)}\n目标结尾标记`,
  moduleId: "manuscript",
};
const largeStartedAt = performance.now();
const largeCompiled = compileServerVerifiedContext({
  documents: largeDocuments,
  prompt: "读取当前目标章全文并继续写作",
  targetDocumentId: "chapter-target",
  declaredRequiredIds: ["chapter-target"],
  fullDocumentIds: ["chapter-target"],
});
assert.equal(largeCompiled.status, "ready", "大项目中当前目标全文必须保持可读");
assert.match(largeCompiled.context, /目标开头/u);
assert.match(largeCompiled.context, /目标结尾标记/u, "不能只读目录或只取目标文档开头");
assert.ok(performance.now() - largeStartedAt < 5_000, "800 份资料的大项目上下文编译不应阻塞 5 秒以上");

assert.deepEqual(contextAvailabilityDecision({
  missingRequiredIds: ["source-1"],
  documents: {},
  explicitReferenceIds: ["source-1"],
}), {
  status: "ask_fresh_start",
  missingIds: ["source-1"],
  readableIds: [],
});
assert.deepEqual(contextAvailabilityDecision({
  missingRequiredIds: ["chapter-8"],
  documents,
  explicitReferenceIds: ["chapter-8"],
}), {
  status: "retry_read",
  missingIds: [],
  readableIds: ["chapter-8"],
});

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /kind:\s*"fresh_start"/u);
assert.match(appSource, /label:\s*"从零开始"/u);
assert.match(appSource, /label:\s*"先补充资料"/u);
assert.match(appSource, /只依据现有资料继续/u, "服务端资料选择必须能解除本轮缺失资料等待");
assert.match(appSource, /explicitReferenceDocumentIds:\s*recoverableContextGateRetry\s*\?\s*\[\]\s*:/u, "确认继续后不得再次提交同一失效引用形成循环");
assert.doesNotMatch(appSource, /hardContextBlocked|contextAvailability\.status/u, "普通 Agent 对话不得由已删除的客户端资料门禁提前阻断");
assert.match(appSource, /conversationAgentRequest\("\/api\/conversation-agent\/start"/u, "资料重读必须交给统一 Agent 入口");

console.log("Shensi v2.84 required context reload tests passed");
