import assert from "node:assert/strict";

import { buildIntentEnvelope, normalizeIntentEnvelope } from "../src/intent-envelope.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { contextDocumentReadDecision } from "../src/context-read-policy.js";
import { readFile } from "node:fs/promises";

const selfCheckRoute = buildAdaptiveTaskRoute({
  text: "请自检1-10章正文",
  sourceMessageId: "self-check-1-10",
  targetDocumentId: "chapter-1",
  targetDocumentIds: Array.from({ length: 10 }, (_, index) => `chapter-${index + 1}`),
  targetModuleId: "manuscript",
});
assert.equal(selfCheckRoute.intentEnvelope.taskType, "diagnosis");
assert.equal(selfCheckRoute.writeAuthorization.state, "commit");
assert.equal(selfCheckRoute.intentEnvelope.writeMode, "formal_auto");
assert.equal(selfCheckRoute.intentEnvelope.targetResolution, "exact");
assert.deepEqual(selfCheckRoute.intentEnvelope.targetDocumentIds, ["report-novel"]);
assert.deepEqual(selfCheckRoute.intentEnvelope.deliverables.map((item) => item.targetDocumentId), ["report-novel"]);
assert.equal(selfCheckRoute.candidatePreviewRequired, false);

const reportRead = contextDocumentReadDecision({
  documentId: "report-novel",
  moduleId: "reports",
  title: "小说自检",
  instruction: "请自检1-10章正文",
  targetDomain: "novel",
});
assert.equal(reportRead.allowed, false);
assert.equal(reportRead.required, false);
assert.equal(reportRead.contextRole, "excluded");

const explicitReportRead = contextDocumentReadDecision({
  documentId: "report-novel",
  moduleId: "reports",
  title: "小说自检",
  instruction: "读取上次小说自检报告并根据报告修改1-10章正文",
  targetDomain: "novel",
});
assert.equal(explicitReportRead.allowed, true);
assert.equal(explicitReportRead.required, true);
assert.equal(explicitReportRead.contextRole, "required");

const reviewAndRepairRoute = buildAdaptiveTaskRoute({
  text: "读取上次小说自检报告并根据报告修改1-10章正文",
  sourceMessageId: "review-repair-1-10",
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  targetModuleId: "manuscript",
});
assert.equal(reviewAndRepairRoute.intentEnvelope.taskType, "modification");
assert.deepEqual(reviewAndRepairRoute.intentEnvelope.deliverables.map((item) => item.targetDocumentId), ["chapter-1"]);
assert.equal(reviewAndRepairRoute.intentEnvelope.deliverables[0].kind, "prose");
assert.deepEqual(reviewAndRepairRoute.intentEnvelope.requiredContextDocumentIds, ["report-novel"]);
assert.deepEqual(reviewAndRepairRoute.intentEnvelope.acceptanceCriteria, ["all_required_deliverables_verified"]);

const batchReviewAndRepairRoute = buildAdaptiveTaskRoute({
  text: "请自检第1章至第5章并修改正文",
  sourceMessageId: "batch-review-repair-1-5",
  targetDocumentId: "chapter-1",
  targetDocumentIds: Array.from({ length: 5 }, (_, index) => `chapter-${index + 1}`),
  targetModuleId: "manuscript",
});
assert.equal(batchReviewAndRepairRoute.writeAuthorization.state, "commit");
assert.deepEqual(batchReviewAndRepairRoute.intentEnvelope.deliverables.map((item) => item.targetDocumentId), [
  "chapter-1", "chapter-2", "chapter-3", "chapter-4", "chapter-5", "report-novel",
]);
assert.equal(batchReviewAndRepairRoute.intentEnvelope.writeMode, "formal_auto");

const scriptReviewAndRepairRoute = buildAdaptiveTaskRoute({
  text: "根据剧本自检报告修复第一集剧本",
  sourceMessageId: "script-review-repair-1",
  targetDocumentId: "script-episode-1",
  targetDocumentIds: ["script-episode-1"],
  targetModuleId: "manuscript",
  contextDomain: "script",
});
assert.deepEqual(scriptReviewAndRepairRoute.intentEnvelope.requiredContextDocumentIds, ["report-script"]);

const adaptationReviewAndRepairRoute = buildAdaptiveTaskRoute({
  text: "读取小说改剧本编译报告并修改第一集剧本",
  sourceMessageId: "adaptation-review-repair-1",
  targetDocumentId: "script-episode-1",
  targetDocumentIds: ["script-episode-1"],
  targetModuleId: "manuscript",
  contextDomain: "script-adaptation",
});
assert.deepEqual(adaptationReviewAndRepairRoute.intentEnvelope.requiredContextDocumentIds, ["report-adaptation"]);

const writingRoute = buildAdaptiveTaskRoute({
  text: "请写第三章正文",
  sourceMessageId: "write-chapter-3",
  targetDocumentId: "chapter-3",
  targetDocumentIds: ["chapter-3"],
  targetModuleId: "manuscript",
  targetExists: true,
});
assert.equal(writingRoute.writeAuthorization.state, "commit");
assert.equal(writingRoute.intentEnvelope.taskType, "writing");
assert.equal(writingRoute.intentEnvelope.writeMode, "formal_auto");
assert.equal(writingRoute.intentEnvelope.targetResolution, "exact");
assert.deepEqual(writingRoute.intentEnvelope.targetDocumentIds, ["chapter-3"]);
assert.equal(writingRoute.intentEnvelope.deliverables[0].kind, "prose");

const testingRoute = buildAdaptiveTaskRoute({
  text: "测试当前软件的正文落盘能力",
  sourceMessageId: "test-write-path",
  targetDocumentId: "chapter-1",
  targetDocumentIds: ["chapter-1"],
  targetModuleId: "manuscript",
});
assert.equal(testingRoute.intentEnvelope.taskType, "testing");
assert.equal(testingRoute.intentEnvelope.writeMode, "conversation_only");

const planningRoute = buildAdaptiveTaskRoute({
  text: "规划下一卷大纲",
  sourceMessageId: "plan-next-volume",
  targetDocumentId: "outline-series",
  targetDocumentIds: ["outline-series"],
  targetModuleId: "outline",
});
assert.equal(planningRoute.intentEnvelope.taskType, "planning");
assert.equal(planningRoute.intentEnvelope.writeMode, "conversation_only");
assert.equal(planningRoute.intentEnvelope.deliverables.length, 0);

const exportRoute = buildAdaptiveTaskRoute({
  text: "导出当前项目为 Markdown 文件",
  sourceMessageId: "export-project",
  targetDocumentId: "project",
  targetDocumentIds: ["project"],
  targetModuleId: "workspace",
});
assert.equal(exportRoute.intentEnvelope.taskType, "export");

const reportSaveRoute = buildAdaptiveTaskRoute({
  text: "请自检1-10章正文并将报告保存到小说自检",
  sourceMessageId: "save-review-report",
  targetDocumentId: "report-novel",
  targetDocumentIds: ["report-novel"],
  targetModuleId: "reports",
  targetExists: true,
});
assert.equal(reportSaveRoute.intentEnvelope.taskType, "diagnosis");
assert.equal(reportSaveRoute.intentEnvelope.writeMode, "formal_auto");
assert.deepEqual(reportSaveRoute.intentEnvelope.deliverables.map((item) => item.targetDocumentId), ["report-novel"]);

const normalized = normalizeIntentEnvelope({
  taskType: "invalid",
  writeMode: "invalid",
  targetDocumentIds: ["chapter-1", "chapter-1"],
  confidence: 4,
});
assert.equal(normalized.taskType, "discussion");
assert.equal(normalized.writeMode, "conversation_only");
assert.deepEqual(normalized.targetDocumentIds, ["chapter-1"]);
assert.equal(normalized.confidence, 1);

const directEnvelope = buildIntentEnvelope({
  instruction: "只分析当前正文，不保存",
  sourceMessageId: "chat-only",
  route: { mode: "general", reason: "对话分析", confidence: 0.88, shensiLed: false },
  taskPolicy: { commitDisposition: "no_artifact" },
  writeAuthorization: { state: "none", reason: "read_only_or_negated_intent" },
});
assert.equal(directEnvelope.taskType, "discussion");
assert.equal(directEnvelope.writeMode, "conversation_only");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(appSource, /const intentEnvelope = execution\.taskRoute\?\.intentEnvelope/u);
assert.match(appSource, /正式交付自动写入/u);
assert.match(appSource, /仅对话，不写入/u);
assert.match(appSource, /必读：\$\{intentRequiredContextText\}/u);
assert.match(appSource, /requiredContextDocumentIds: taskRoute\.intentEnvelope\?\.requiredContextDocumentIds/u);
assert.match(serverSource, /contextDomain: String\(body\.contextDomain/u);
assert.match(serverSource, /taskRoute\.intentEnvelope\?\.requiredContextDocumentIds/u);

console.log("intent envelope and self-check context contracts passed");
