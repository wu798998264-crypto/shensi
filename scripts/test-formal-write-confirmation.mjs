import assert from "node:assert/strict";
import {
  hasExplicitFormalWriteIntent,
  formalLandingResolutionReason,
  isNonFormalTaskByDefault,
} from "../src/formal-write-confirmation.js";
import { compileAgentTaskPolicy } from "../src/agent-task-policy.js";
import { formalArtifactLandingPolicy } from "../src/formal-artifact-extractor.js";
import { createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { readFile } from "node:fs/promises";

assert.equal(hasExplicitFormalWriteIntent("请生成第三章正文"), false);
assert.equal(hasExplicitFormalWriteIntent("请生成第三章正文并保存"), true);
assert.equal(formalLandingResolutionReason({ targetAmbiguous: true }), "target");
assert.equal(formalLandingResolutionReason({
  targetDocumentIds: ["library-reference", "canon-world", "outline-series"],
  writeAuthorization: { state: "commit", action: "replace" },
}), "", "TaskContract 批量目标已经明确时不得再弹出单文档目标选择");
assert.equal(formalLandingResolutionReason({
  targetDocumentId: "chapter-3",
  writeAuthorization: { state: "commit", action: "generate" },
  targetExists: true,
  targetHasContent: true,
}), "operation");
assert.equal(formalLandingResolutionReason({
  targetDocumentId: "chapter-3",
  writeAuthorization: { state: "commit", action: "append" },
  targetExists: true,
  targetHasContent: true,
}), "");
assert.equal(formalLandingResolutionReason({
  targetDocumentId: "chapter-3",
  writeAuthorization: { state: "candidate_only", reason: "landing_intent_uncertain" },
  targetExists: true,
  targetHasContent: false,
}), "write_confirmation");
assert.equal(isNonFormalTaskByDefault("请分析第三章并给出诊断"), true);
assert.equal(isNonFormalTaskByDefault("请生成正式大纲"), false);
assert.equal(isNonFormalTaskByDefault("请生成一篇公众号文章"), false, "公众号文章属于正式创作交付物");
assert.equal(isNonFormalTaskByDefault("请自检第1章至第5章", {
  target: { documentId: "report-novel", moduleId: "reports" },
  contentType: "batch_report",
}), false, "多章节自检报告本身是正式内容");

const reviewPolicy = compileAgentTaskPolicy({
  text: "请自检第三章",
  route: { mode: "creative" },
  target: { documentId: "report-novel" },
  writeAuthorization: { state: "commit", action: "replace", targetDocumentIds: ["report-novel"] },
});
assert.equal(reviewPolicy.commitDisposition, "auto_commit", "明确 commit 授权不能再被非正式内容分类二次否决");

const formalReviewPolicy = compileAgentTaskPolicy({
  text: "请自检第1章至第5章",
  route: {
    mode: "creative",
    formalArtifactExpected: true,
    reviewDelivery: {
      active: true,
      reportRequested: true,
      landingEligible: true,
      kind: "batch_report",
      target: { documentId: "report-novel", moduleId: "reports" },
    },
  },
  target: { documentId: "report-novel", moduleId: "reports" },
  writeAuthorization: { state: "commit", action: "generate", targetDocumentIds: ["report-novel"] },
});
assert.equal(formalReviewPolicy.commitDisposition, "auto_commit");

const explicitWritePolicy = compileAgentTaskPolicy({
  text: "请自检第三章并将报告写入当前文档",
  route: { mode: "creative" },
  target: { documentId: "report-novel" },
  writeAuthorization: { state: "commit", action: "replace", targetDocumentIds: ["report-novel"] },
});
assert.equal(explicitWritePolicy.commitDisposition, "auto_commit");

const noWritePolicy = formalArtifactLandingPolicy({
  instruction: "请分析第三章并给出诊断",
  writeAuthorization: createFormalWriteAuthorization({
    instruction: "请分析第三章并给出诊断并写入报告",
    sourceMessageId: "message-1",
    targetDocumentIds: ["report-novel"],
    expectedRevisions: { "report-novel": "revision-1" },
    targetExists: true,
    candidate: "诊断结果",
  }),
  candidate: "诊断结果",
});
assert.equal(noWritePolicy.shouldLand, false);

const publicAccountAuthorization = createFormalWriteAuthorization({
  instruction: "请生成一篇公众号文章",
  sourceMessageId: "message-public-account",
  targetDocumentIds: ["public-account-article"],
  expectedRevisions: { "public-account-article": "revision-empty" },
  targetExists: true,
});
assert.equal(publicAccountAuthorization.state, "commit");
assert.equal(publicAccountAuthorization.action, "generate", "已有空白公众号文档应直接写入，不能误判为新建");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(appSource, /formalWriteConfirmationDialog/u);
assert.doesNotMatch(appSource, /等待用户确认正式写入/u);
assert.doesNotMatch(appSource, /继续落盘/u);
assert.match(appSource, /kind === "landing_resolution"/u);
assert.match(appSource, /kind === "landing_recovery"/u);
assert.match(appSource, /kind === "formal_target_correction"/u);
assert.match(appSource, /kind === "formal_write_rollback"/u);
assert.match(appSource, /kind === "full_text_import"/u);
assert.match(appSource, /kind === "workspace_binding"/u);
assert.match(appSource, /当前任务没有绑定有效工作区，请选择要使用的作品或笔记本/u);
assert.match(appSource, /是否将本轮生成结果写入/u);
assert.match(appSource, /系统无法确定这次结果是否需要落盘/u);
assert.match(appSource, /仅保留在对话区/u);
assert.match(appSource, /选择后直接写入现有正式内容，不会重新调用模型/u);
assert.match(appSource, /creativeGuidanceWriteConfirmationRequired/u, "创作引导正式推演记录必须进入二次确认门禁");
assert.match(appSource, /确认写入推演记录/u);
assert.match(appSource, /只追加已确认或明确委托的作者决策/u);
assert.match(appSource, /const operation = pending\.fixedOperation \|\| value/u, "创作引导确认不得被切换为覆盖操作");
const fullTextConfirmationSource = appSource.slice(
  appSource.indexOf("const confirmFullTextImportPreview"),
  appSource.indexOf("const appendFullTextImportMessage"),
);
assert.doesNotMatch(fullTextConfirmationSource, /showModal\s*\(/u, "对话触发的全文导入确认不得显示在页面中央");

console.log("formal write confirmation contracts passed");
