import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { compileTaskContract, validateTaskContractForExecution } from "../src/task-contract.js";
import { resolveSkillRuntime, skillIdsForStage } from "../src/skill-routing.js";
import { detectShensiRunProfile, isNonDeliverableCandidate, isDeliverableOrchestrationResult, runShensiOrchestration } from "../src/server/shensi-orchestrator.mjs";
import { compileServerVerifiedContext } from "../src/server/server-context-verifier.mjs";
import { compileCreativeMutationPlan } from "../src/creative-mutation-plan.js";
import { explicitlyDefersCandidateLanding } from "../src/chapter-target.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const prompt = "检查前三章的问题，不要改动正文，但保存《前三章自检报告》。";
const reportTarget = { documentId: "report-novel", moduleId: "reports", title: "前三章自检报告" };
const mutation = compileCreativeMutationPlan({ instruction: prompt, formalWriteIntent: true, productionIntent: true, inventory: [reportTarget] });
assert.equal(mutation.taskContract.persistence, "commit", "源正文保护不得把报告合同降级成候选");
assert.equal(explicitlyDefersCandidateLanding("检查前三章，不要改动正文，也不要保存报告。", { outputKind: "report" }), true);
assert.equal(explicitlyDefersCandidateLanding("检查前三章，只给我候选报告，等我确认后再保存。", { outputKind: "report" }), true);
for (const kind of ["artifact", "document", ""]) {
  for (const target of [reportTarget, "report-novel"]) {
    const contract = compileTaskContract({
      taskType: "diagnosis", operation: "create", instruction: prompt,
      deliverables: [{ kind, target }], persistence: "commit",
      semanticSource: "model", sourceMessageId: "review-request", targetResolution: "exact",
    });
    assert.equal(contract.deliverables[0].kind, "report", "报告绑定必须消除传输层泛化类型");
    assert.equal(validateTaskContractForExecution(contract).valid, true);
  }
}
const authorization = createFormalWriteAuthorization({
  instruction: prompt, sourceMessageId: "review-request",
  targetDocumentIds: [reportTarget.documentId], expectedRevisions: { "report-novel": "report-v1" },
  semanticWritePlan: { intent: "commit", operation: "replace" },
});
assert.equal(authorization.state, "commit");
assert.equal(authorization.allowBodyMutation, true, "保护源正文不能禁止独立报告写入");
assert.deepEqual(authorization.targetDocumentIds, ["report-novel"]);
assert.equal(createFormalWriteAuthorization({
  instruction: "只分析前三章，不保存报告，也不要改动正文。",
  sourceMessageId: "readonly-request", targetDocumentIds: ["report-novel"],
}).state, "none");

const protocol = "<tool_call><arg_key>documentIds</arg_key><arg_value>chapter-1</arg_value></tool_call>";
const unfinished = "我需要先读取前三章和章纲，再进行检查并保存报告。";
const report = [
  "# 前三章自检报告", "", "## 审查范围与资料完整性",
  "已审查第一章、第二章、第三章及对应章纲、世界观。",
  "## 必须修正", "第三章离场动机与第二章承诺冲突，应补足选择原因。",
  "## 明确保留", "第一章的具体代价和第二章的线索回收应保持。",
  "## 下一步", "下一步修改第三章离场动机，保留既有事实。",
  "## 总体验收", "报告已完整；正文需局部修订，本轮没有修改正文。",
].join("\n");
const pollutedReport = `${protocol}\n\n模型内部说明：我不能直接写文件。\n\n${report}`;
assert.equal(isNonDeliverableCandidate(protocol), true);
assert.equal(isNonDeliverableCandidate(unfinished), true);
assert.equal(isNonDeliverableCandidate(report), false, "真实报告内的后续建议不是未执行计划");
assert.equal(isNonDeliverableCandidate("<argkey>content</argkey><argvalue>planning</argvalue>"), true);
for (const status of ["retry_required", "failed", "hard_blocked", "needs_user_input", "complete"]) {
  assert.equal(isDeliverableOrchestrationResult({ text: report, execution: { status } }), false, "执行未授权交付时不能把说明登记成候选");
}
assert.equal(isDeliverableOrchestrationResult({ text: report, execution: { status: "ready_to_land" } }), true);
assert.equal(isDeliverableOrchestrationResult({ text: protocol, execution: { status: "ready_to_land" } }), false);

const documents = [
  ["chapter-1", "第一章：沈见川承受三相灼伤，仍承诺保护同伴。"],
  ["chapter-2", "第二章：沈见川将铜牌交给同伴，约定不单独离开。"],
  ["chapter-3", "第三章：沈见川独自离场，没有解释约定改变。"],
  ["outline-chapter-1", "第一章章纲：代价必须可见。"],
  ["outline-chapter-2", "第二章章纲：铜牌作为约定信物。"],
  ["outline-chapter-3", "第三章章纲：行动选择必须承接约定。"],
  ["canon-world", "世界观：三相切换必须付出等量代价。"],
];
const context = documents.map(([id, content]) => `# ${id}\n${content}`).join("\n\n");
const currentDocuments = Object.fromEntries(documents.map(([id, content]) => [id, {
  title: id, moduleId: id.startsWith("chapter-") ? "manuscript" : id.startsWith("outline-") ? "outline" : "canon",
  html: `<p>${content.repeat(140)}</p><p>末尾证据-${id}</p>`, revision: `${id}-current`,
}]));
const suppliedContext = documents.map(([id]) => `<!-- shensi-context-source ${JSON.stringify({ id, required: true })} -->\n旧客户端摘要`).join("\n");
currentDocuments["report-novel"] = { title: "小说自检", moduleId: "reports", html: `<p>${protocol.replaceAll("<", "&lt;")}</p>` };
const verified = compileServerVerifiedContext({ suppliedContext, documents: currentDocuments, prompt, targetDocumentId: "report-novel" });
assert.equal(verified.status, "ready");
assert.ok(!verified.includedIds.includes("report-novel"), "报告输出目标不可自行成为审查输入");
for (const [id] of documents) {
  assert.ok(verified.context.includes(`末尾证据-${id}`), "必读资料的末尾不能被摘录截断");
  assert.equal(verified.manifest.included.find((item) => item.id === id)?.fullText, true);
}
assert.ok(!verified.context.includes("旧客户端摘要"), "必须从当前文档重读而非信任传入正文");
const { "chapter-3": removed, ...missingDocuments } = currentDocuments;
const missing = compileServerVerifiedContext({ suppliedContext, documents: missingDocuments, prompt, targetDocumentId: "report-novel" });
assert.equal(missing.status, "recoverable");
assert.ok(missing.missingRequiredIds.includes("chapter-3"));

// Read only the relevant source blocks for the browser/server integration guards.
const readBlock = async (path, start, end) => {
  const stream = createReadStream(resolve(root, path), { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const block = [];
  try {
    for await (const line of lines) {
      if (!block.length && !line.includes(start)) continue;
      if (block.length && line.includes(end)) return block.join("\n");
      block.push(line);
      assert.ok(block.length <= 250, "源码断言仅读取局部块");
    }
    assert.fail(`Source block not found: ${path}`);
  } finally {
    lines.close();
    stream.destroy();
  }
};
const snapshotStages = await readBlock("server.mjs", "const snapshotReuseStages = new Set([", "]);");
assert.ok(!snapshotStages.includes('"audit"') && !snapshotStages.includes('"audit-final"'), "独立自检不得用无正文的摘要冒充读取");
const contextBuilder = await readBlock("src/app.js", "const defaultContextRequirements = creativeContextRequiredIds({", "  const allowedIds = Array.from(relevantIds)");
const requiredBlock = contextBuilder.slice(contextBuilder.lastIndexOf("  const requiredIds = new Set(["));
assert.ok(requiredBlock.includes("...requiredReviewScopeIds"));
assert.ok(requiredBlock.includes("...reviewSupportIds"));
const completion = await readBlock("server.mjs", "const candidatePermitted =", "      const resultPayload =");
assert.ok(completion.includes("isDeliverableOrchestrationResult(result)"));
assert.ok(completion.includes("const generationFailed = hasRequiredDeliverables && !hasFormalCandidate"));
const sessionFinalization = await readBlock("server.mjs", 'status: generationFailed ? "failed" : requiresCommit || candidateOnly', "      resultPayload.generationAttempt =");
assert.ok(sessionFinalization.includes('status: generationFailed ? "failed" : requiresCommit ? "awaiting_landing_receipt"'));
const reviewer = {
  id: "builtin:effect-review", name: "小说自检", content: "逐章核对证据、因果及角色动机，明确未读取的资料。",
  capabilities: ["effect_reviewer"], workspaceModes: ["project"], testStatus: "passed", fullText: true,
};
const runtime = resolveSkillRuntime({
  skills: [reviewer], activeModule: "reports", prompt, contextDomain: "novel", targetDocumentId: "report-novel",
});
assert.ok(skillIdsForStage(runtime, "audit").includes(reviewer.id));

const runReview = async ({ instruction = prompt, planning = protocol, audit = report } = {}) => {
  const stages = [];
  const attempts = [];
  const result = await runShensiOrchestration({
    shensiRoot: root, settings: {}, cwd: root, messages: [{ role: "user", content: instruction }],
    projectContext: context, postwriteProjectContext: context,
    activeModule: "reports", contextDomain: "novel", targetDocumentId: "report-novel",
    userSkillRuntime: runtime, creativeTask: { writeAuthorization: authorization },
    semanticLane: "task_execution", semanticTaskKind: "quality_review",
    semanticWriteIntent: "commit", semanticWriteOperation: "replace",
    semanticDeliverableType: "report",
    semanticExecutionPlan: { reviewTier: "full", candidateCount: 1 },
    onAttempt: async (attempt) => attempts.push(attempt),
    runModel: async ({ shensiRuntime, system, messages }) => {
      const stage = shensiRuntime.stage;
      stages.push(stage);
      if (stage === "planning") {
        if (planning instanceof Error) throw planning;
        return { text: planning };
      }
    assert.ok(stage === "audit", "独立诊断只能进入审查链");
      for (const [, content] of documents) assert.ok(system.includes(content), "审查模型必须拿到冻结的完整原文");
      assert.ok(messages.some((message) => message.content.includes(reviewer.content)), "自检 Skill 必须实际送入审查阶段");
      if (stage === "audit" && audit === pollutedReport && stages.filter((item) => item === "audit").length > 1) return { text: report };
      return { text: audit };
    },
  });
  return { result, stages, attempts };
};

for (const instruction of [prompt, "直接检查前三章并保存自检报告，不要改动正文。", "自检前三章并直接执行，保存报告。"]) {
  assert.equal(detectShensiRunProfile({
    prompt: instruction, activeModule: "reports", targetDocumentId: "report-novel",
    semanticLane: "task_execution", semanticTaskKind: "quality_review",
    semanticWriteIntent: "commit", semanticDeliverableType: "report",
    semanticExecutionPlan: { reviewTier: "full", candidateCount: 1 },
  }).diagnostic, true);
  for (const planning of [protocol, unfinished, JSON.stringify({ action: "generate" }), JSON.stringify({ action: "respond" })]) {
    const { result, stages } = await runReview({ instruction, planning });
    assert.deepEqual(stages, ["planning", "audit"]);
    assert.equal(result.execution.status, "ready_to_land");
    assert.equal(result.reviewArtifact?.verdict, "passed");
    assert.equal(result.execution.choiceOptions, undefined, "明确保存报告不应再要求选择");
    assert.equal(result.memoryUpdate, null);
    assert.ok(result.text.includes(report));
  }
}
{
  const { result, stages } = await runReview({ planning: JSON.stringify({ action: "respond" }), audit: pollutedReport });
  assert.deepEqual(stages, ["planning", "audit", "audit"]);
  assert.equal(result.execution.status, "ready_to_land");
  assert.ok(!result.text.includes("<tool_call>"));
  assert.ok(!result.text.includes("不能直接写文件"));
}
for (const audit of ["", protocol, unfinished, `【正式内容】\n${protocol}`]) {
  const { result, attempts } = await runReview({ planning: JSON.stringify({ action: "respond" }), audit });
  assert.equal(result.execution.status, "retry_required");
  assert.equal(result.reviewArtifact, undefined, "非成果不能取得正式验收凭证");
  assert.ok(attempts.every((attempt) => attempt.landingEligible !== true));
  assert.equal(result.execution.choiceOptions, undefined, "模型格式失败不制造用户目标选择题");
  assert.ok(!result.text.includes("<tool_call>"));
}
for (const code of ["MODEL_REASONING_WITHOUT_TEXT", "MODEL_EMPTY_TEXT"]) {
  const { result, stages } = await runReview({ planning: Object.assign(new Error(code), { code }) });
  assert.deepEqual(stages, ["planning", "audit"]);
  assert.equal(result.execution.status, "ready_to_land");
}
await assert.rejects(runReview({ planning: Object.assign(new Error("offline"), { code: "ECONNRESET" }) }), /offline/u);

console.log("Review report normalization, authorization, audit execution and invalid-output guards passed");
