import assert from "node:assert/strict";
import { resolve } from "node:path";
import { compileTaskContract } from "../src/task-contract.js";
import { createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { reviewContextPlan } from "../src/review-context-plan.js";
import { compileServerVerifiedContext } from "../src/server/server-context-verifier.mjs";
import { runShensiOrchestration } from "../src/server/shensi-orchestrator.mjs";
import { chapterOutlineEndChapter } from "../src/chapter-outline-policy.js";
import { authorizeFormalMutation } from "../src/formal-mutation-permission.js";

const root = resolve(import.meta.dirname, "..");
const textFor = (id) => `这是${id}完整资料，结尾唯一证据必须保留。`;
const documents = {
  ...Object.fromEntries([1, 2, 3].map((n) => [`chapter-${n}`, { title: `第${n}章`, moduleId: "manuscript", text: textFor(`chapter-${n}`) }])),
  ...Object.fromEntries([1, 2, 3].map((n) => [`outline-chapter-${n + 2}`, { title: `第${n + 2}章章纲`, moduleId: "outline", text: `第${["一", "二", "三"][n - 1]}章章纲\n\n${textFor(`outline-${n}`)}` }])),
  "outline-chapter-1": { title: "空占位", moduleId: "outline", text: "" },
  "outline-chapter-2": { title: "空占位", moduleId: "outline", text: "" },
  "canon-custom": { title: "世界观", moduleId: "canon", text: textFor("canon") },
  "outline-custom": { title: "全书总纲", moduleId: "outline", text: textFor("series") },
};
const sourceIds = ["chapter-1", "chapter-2", "chapter-3"];
const plan = reviewContextPlan({ sourceDocumentIds: sourceIds, documents });
assert.deepEqual(plan.supportDocumentIds, ["outline-chapter-3", "outline-chapter-4", "outline-chapter-5", "canon-custom", "outline-custom"]);
assert.deepEqual(plan.issues, []);
assert.equal(chapterOutlineEndChapter({ id: "outline-chapter-5", title: "第5章章纲", content: documents["outline-chapter-5"].text }), 3);
const prompt = "核对前述三个章节；保护源文档，将审查结论交付。";
const contract = compileTaskContract({ taskType: "diagnosis", operation: "append", instruction: prompt,
  deliverables: [{ kind: "report", target: { documentId: "report-novel", moduleId: "reports", title: "前三章审查" } }],
  requiredContextDocumentIds: sourceIds, persistence: "commit", semanticSource: "model", sourceMessageId: "review-user", targetResolution: "exact" });
const authorization = createFormalWriteAuthorization({ instruction: prompt, sourceMessageId: "review-user", taskContract: contract });
assert.equal(authorizeFormalMutation({ instruction: "按确定的目标提交", taskContract: contract, targets: [{ documentId: "report-novel", moduleId: "reports" }] }).ok, true);
const verified = compileServerVerifiedContext({ documents, targetDocumentId: "report-novel", declaredRequiredIds: sourceIds, reviewSourceDocumentIds: sourceIds });
for (const id of plan.requiredDocumentIds) assert.ok(verified.manifest.included.some((item) => item.id === id && item.fullText && !item.compressed));
const report = "# 审查报告\n\n## 审查范围\n前三章与章纲、世界观。\n\n## 逐章证据\n三章结尾证据完整。\n\n## 结论与建议\n人物行动因果完整，保留原文，仅建议加强时间锚点。";
const stages = [];
const base = { shensiRoot: root, settings: {}, cwd: root, activeModule: "reports", contextDomain: "novel", targetDocumentId: "report-novel",
  messages: [{ role: "user", content: prompt }], creativeTask: { taskContract: contract, writeAuthorization: authorization },
  projectContext: verified.context, contextManifest: verified.manifest,
  runModel: async ({ shensiRuntime, system }) => {
    stages.push(shensiRuntime.stage);
    assert.equal(shensiRuntime.stage, "audit", "冻结合同后的独立报告不再二次规划");
    for (const id of plan.requiredDocumentIds) assert.ok(system.includes(documents[id].text));
    return { text: report };
  },
};
const result = await runShensiOrchestration(base);
assert.deepEqual(stages, ["audit"]);
assert.equal(result.execution.status, "ready_to_land");
assert.deepEqual(new Set(result.reviewArtifact.coverage.read), new Set(plan.requiredDocumentIds));
const { "chapter-3": removed, ...missingDocuments } = documents;
const missing = compileServerVerifiedContext({ documents: missingDocuments, targetDocumentId: "report-novel", declaredRequiredIds: sourceIds, reviewSourceDocumentIds: sourceIds });
assert.ok(missing.missingRequiredIds.includes("chapter-3"));
const blocked = await runShensiOrchestration({ ...base, projectContext: missing.context,
  runModel: async () => assert.fail("缺失必读章节时不调用模型") });
assert.equal(blocked.execution.status, "retry_required");
assert.equal(blocked.reviewArtifact, undefined);
assert.equal(blocked.memoryUpdate, null);
console.log("Review contract single-audit, semantic source binding, truthful coverage and missing-source closure passed");
