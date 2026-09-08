import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSmartLandingPath, explicitNewDocumentIntent } from "../src/automatic-landing-policy.js";
import { latestRecoverableCandidate } from "../src/candidate-chapters.js";
import { explicitlyDefersCandidateLanding } from "../src/chapter-target.js";
import { bindFormalWriteCandidate } from "../src/formal-write-authorization.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appSource = await readFile(join(root, "src", "app.js"), "utf8");
const indexSource = await readFile(join(root, "index.html"), "utf8");

const namedCreation = explicitNewDocumentIntent("落盘到一个新文档里，命名为第一章2");
assert.deepEqual(namedCreation, { create: true, title: "第一章2", reason: "explicit_new_document" });

const smartCreation = analyzeSmartLandingPath({
  instruction: "落盘到一个新文档里，命名为第一章2",
  result: { candidate: "这是本轮刚刚生成的新版正文。" },
  boundDocumentId: "chapter-1",
  documents: { "chapter-1": { title: "旧关联正文", content: "已有正文".repeat(300) } },
});
assert.equal(smartCreation.action, "create_and_land");
assert.equal(smartCreation.suggestedTitle, "第一章2");

assert.equal(explicitlyDefersCandidateLanding("生成新版但不落盘"), true);
assert.equal(explicitlyDefersCandidateLanding("第1章至第10章正式正文，分别写入正文文档"), false, "‘分别写入’中的‘别’不是禁止写入");
assert.equal(
  explicitlyDefersCandidateLanding("正式正文必须直接新建文档第六集剧本验收，不得覆盖当前文档"),
  false,
  "protecting the source document must not defer landing into an explicit new target",
);
assert.equal(
  explicitlyDefersCandidateLanding("新建文档第六集剧本验收，但不要落盘"),
  true,
  "an explicit no-landing instruction must still defer the target",
);
assert.equal(
  explicitlyDefersCandidateLanding("不要只在对话里展示内容而不落盘。全部写入并回读验证成功后才可报告完成。"),
  false,
  "a prohibition against chat-only output requires landing and must not be inverted into a deferral",
);
const route = buildAdaptiveTaskRoute({
  text: "生成新版但不落盘",
  sourceMessageId: "candidate-request",
  targetDocumentId: "chapter-1",
  targetModuleId: "manuscript",
  contextDomain: "novel",
  workspaceKind: "project",
}, { executionSurface: "agent" });
assert.equal(route.candidatePreviewRequired, true);
const implicitFormalRoute = buildAdaptiveTaskRoute({
  text: "这一章需要更紧凑一些，女主进门后马上发现尸体。",
  sourceMessageId: "implicit-creative-request",
  targetDocumentId: "chapter-1",
  targetModuleId: "manuscript",
  contextDomain: "novel",
  continuesCreativeThread: true,
  workspaceKind: "project",
}, { executionSurface: "chat" });
assert.equal(implicitFormalRoute.mode, "creative");
assert.equal(implicitFormalRoute.candidatePreviewRequired, false, "ordinary creative instructions must not open a candidate window unless the user explicitly requests candidates");

const recoverableCandidate = "# 纸人报丧\n\n这是本轮最新生成的新版正文。";
const recoveryRoute = buildAdaptiveTaskRoute({
  text: "生成新版但不落盘",
  sourceMessageId: "rewrite-request",
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
  targetModuleId: "manuscript",
  contextDomain: "novel",
  workspaceKind: "project",
}, { executionSurface: "agent" });
recoveryRoute.writeAuthorization = bindFormalWriteCandidate(recoveryRoute.writeAuthorization, {
  candidate: recoverableCandidate,
  targetDocumentIds: ["chapter-1"],
  expectedRevisions: { "chapter-1": "revision-1" },
});

const messages = [
  { id: "review-request", role: "user", content: "自检本章小说有无问题。" },
  {
    id: "old-review", role: "assistant", candidate: "小说自检结论：这是较旧的诊断结果。",
    target: { documentId: "chapter-1", moduleId: "manuscript", contextDomain: "novel" },
    execution: { sourceMessageId: "review-request", endedAt: 100, status: "hard_blocked" },
  },
  { id: "rewrite-request", role: "user", content: "生成新版但不落盘" },
  {
    id: "latest-agent-output", role: "assistant",
    candidate: recoverableCandidate,
    target: { documentId: "chapter-1", moduleId: "manuscript", contextDomain: "novel" },
    execution: {
      strength: "agent", status: "complete", sourceMessageId: "rewrite-request", endedAt: 200,
      taskRoute: recoveryRoute,
    },
  },
];
const recovered = latestRecoverableCandidate({ messages, fallbackTarget: messages[1].target });
assert.match(recovered.candidate, /这是本轮最新生成的新版正文/u);
assert.doesNotMatch(recovered.candidate, /较旧的诊断结果/u);
assert.equal(recovered.sourceMessageId, "rewrite-request");
assert.equal(recovered.candidateMessageId, "latest-agent-output");
assert.equal(recovered.deliverableType, "prose");

const reviewOnly = latestRecoverableCandidate({ messages: messages.slice(0, 2), fallbackTarget: messages[1].target });
assert.equal(reviewOnly, null, "缺少来源授权合同的旧诊断消息不得恢复成正式候选");

assert.match(appSource, /const deleteAllowed = documentDeleteAllowed\(/u);
assert.match(appSource, /data-menu-action="delete"[^\n]+protectedDocument \|\| !deleteAllowed/u);
assert.match(appSource, /recovered\.deliverableType === "review_report"[\s\S]{0,180}currentCandidateTarget/u);
assert.match(appSource, /let explicitChapterTarget = inlineEdit \? null : explicitChapterBatch/u);
assert.match(appSource, /canonicalNovelChapterRequestTarget\(\{/u);
assert.match(appSource, /forceCreateNewDocument/u);
assert.match(indexSource, /app\.js\?v=\d+\.\d+\.\d+-[a-z0-9-]+/u);

console.log("Shensi terminal delete and landing routing regressions passed");
