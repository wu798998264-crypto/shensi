import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { candidateBatchCoversRequestedTargets, mergeAgentExecutionTaskRoute } from "../src/agent-task-route-merge.js";
import { codexAgentCandidatePreview } from "../src/codex-agent-candidate-preview.js";
import { explicitlyDefersCandidateLanding, isGenerationAndLandingRequest, isLandingRequest } from "../src/chapter-target.js";
import { compileCreativeMutationPlan } from "../src/creative-mutation-plan.js";
import { extractFormalArtifacts } from "../src/formal-artifact-extractor.js";
import { authorizeFormalMutation } from "../src/formal-mutation-permission.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { resolveTaskContractRetryContext } from "../src/task-contract-retry.js";
import { evaluateTaskContract } from "../src/task-contract.js";

const combinedInstruction = [
  "现在正式创作并落盘：完整小说设定、完整全书大纲，以及第1章至第10章的正式正文。",
  "题材为玄幻、御兽、废柴流、退婚流。",
  "第1章至第10章每章不少于1500个中文字符。",
  "不要把设定、大纲、执行说明或检查报告写进正文。",
  "验收：12份文档全部存在、非空、位置、标题和顺序正确。",
].join("\n");

const plan = compileCreativeMutationPlan({
  instruction: combinedInstruction,
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});

assert.deepEqual(plan.primaryTargets.map((item) => item.documentId), [
  "canon-world",
  "outline-series",
  ...Array.from({ length: 10 }, (_, index) => `chapter-${index + 1}`),
]);
assert.equal(plan.taskContract.taskType, "writing", "验收和检查词不能把正式写作污染成测试或诊断任务");
assert.equal(plan.taskContract.deliverables.length, 12);
assert.ok(plan.taskContract.exclusions.some((item) => item.includes("不要把设定")));
assert.ok(plan.taskContract.acceptanceCriteria.some((item) => item.includes("12份文档")));

const confirmedGuidancePlan = compileCreativeMutationPlan({
  instruction: "最终决定：铜心每次启动都会让叶昭失去一段关于父亲的记忆；她用修钟时记录齿轮误差的旧习惯，把重要记忆刻进铜片。现在把已经确认的内容作为正式内容自动写入当前作品的资料、设定和全书大纲，并记录必要伏笔与信息台阶。只在有实际内容时创建文档，不创建空占位，不写正文；完成后给出与真实文档同名的可点击链接。",
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.deepEqual(confirmedGuidancePlan.primaryTargets.map((item) => item.documentId), [
  "library-reference",
  "canon-world",
  "outline-series",
  "memory-foreshadowing",
  "memory-release",
], "已确认内容是写入对象，不得被误分到验收条件并丢失多文档目标");
assert.ok(confirmedGuidancePlan.taskContract.acceptanceCriteria.every((item) => !item.includes("已经确认的内容")));
assert.equal(confirmedGuidancePlan.taskContract.persistence, "commit");
assert.equal(confirmedGuidancePlan.taskContract.targetResolution, "exact");

const authorDecisionPlan = compileCreativeMutationPlan({
  instruction: "叶昭暂不公开完整图纸，只把能证明气税造假的半页交给工匠行会；这样会让她救下贫民区，却令沈砚怀疑她在争夺铸造权。沈砚表面追捕她，暗中给她留下通往龙骨列车的通行章。\n请把这项决定记入当前作品相关设定、大纲和记忆，然后继续按既定二十章结构推进；此时不写正文。",
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.deepEqual(authorDecisionPlan.primaryTargets.map((item) => item.documentId), [
  "canon-world",
  "outline-series",
  "memory-foreshadowing",
  "memory-release",
], "“相关设定、大纲和记忆”必须展开为完整的四目标正式合同");
assert.deepEqual(authorDecisionPlan.taskContract.deliverables.map((item) => item.kind), [
  "setting", "outline", "memory", "memory",
]);
assert.equal(authorDecisionPlan.taskContract.operation, "batch");
assert.equal(authorDecisionPlan.taskContract.persistence, "commit");
assert.equal(authorDecisionPlan.taskContract.targetResolution, "exact");

const separatedRangePlan = compileCreativeMutationPlan({
  instruction: "必须重新输出完整的12个结构化交付物：1份完整设定写入canon-world，1份完整全书大纲写入outline-series，第1章至第10章分别写入chapter-1至chapter-10。十章都必须是完整可读的小说正文，去除标题和空白后每章至少1800个中文字符。请直接生成、整体落盘。",
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.deepEqual(separatedRangePlan.primaryTargets.map((item) => item.documentId), [
  "canon-world", "outline-series", ...Array.from({ length: 10 }, (_, index) => `chapter-${index + 1}`),
], "章节范围与正文关键词之间存在目标位置说明时仍必须识别全部交付物");
assert.ok(separatedRangePlan.primaryTargets.filter((item) => /^chapter-/.test(item.documentId)).every((item) => item.minCharacters === 1800));

const readOnlyCanonPlan = compileCreativeMutationPlan({
  instruction: "现在正式创作并落盘第1章至第10章正式正文。必须读取并遵循已经落盘的世界观与基础规则和全集大纲。每章至少1800个中文字符。不得修改现有设定、大纲，不得用自检报告代替正文。整体落盘并逐章回读验收。",
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.deepEqual(readOnlyCanonPlan.primaryTargets.map((item) => item.documentId), Array.from({ length: 10 }, (_, index) => `chapter-${index + 1}`), "只读正典和验收动作不得污染正式交付物清单");
const detailedLengthPlan = compileCreativeMutationPlan({
  instruction: "现在正式创作第1章至第10章正式正文。每章必须是完整小说正文，去除标题和空白后至少1800个中文字符。",
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.ok(detailedLengthPlan.primaryTargets.every((item) => item.minCharacters === 1800), "长度说明与最低字符数之间有正文限定语时仍必须写入验收合同");

const explicitContractInstruction = [
  "现在正式创作并落盘一个完整小说项目《御兽退婚：废柴的万兽神庭》。",
  "题材：玄幻、御兽、废柴流、退婚流。",
  "交付物：",
  "1. 完整小说设定，写入“设定”模块的独立文档，标题《御兽退婚：废柴的万兽神庭·完整设定》。必须包含世界格局、人物、事件时间线、势力与伏笔。",
  "2. 完整全书大纲，写入“大纲”模块的独立文档，标题《御兽退婚：废柴的万兽神庭·全书大纲》。必须包含六卷规划、关键伏笔回收，以及第1章至第10章逐章章纲。",
  "3. 第1章至第10章正式正文，分别写入“正文”模块的10个独立文档，每章不少于1500个中文字符。",
  "禁止：",
  "- 不要把设定、大纲、执行说明、检查过程、自检报告或完成回执写进正文。",
  "- 不要创建额外交付物。",
  "- 不要只在对话里展示内容而不落盘。",
  "验收：",
  "12份文档必须全部创建且非空，类型、目标模块、标题和章节顺序正确。",
].join("\n");
const explicitContractPlan = compileCreativeMutationPlan({
  instruction: explicitContractInstruction,
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.deepEqual(explicitContractPlan.primaryTargets.map((item) => item.documentId), [
  "canon-world",
  "outline-series",
  ...Array.from({ length: 10 }, (_, index) => `chapter-${index + 1}`),
], "显式交付物清单必须覆盖内容字段推导，人物、时间线、伏笔、自检和逐章章纲不能扩张为额外文档");
assert.deepEqual(explicitContractPlan.primaryTargets.slice(0, 2).map((item) => item.title), [
  "御兽退婚：废柴的万兽神庭·完整设定",
  "御兽退婚：废柴的万兽神庭·全书大纲",
]);
assert.equal(explicitContractPlan.taskContract.deliverables.length, 12);
assert.equal(explicitlyDefersCandidateLanding(explicitContractInstruction), false, "要求禁止只在对话展示是在强制落盘，不能反向延期事务");
assert.ok(explicitContractPlan.taskContract.deliverables.filter((item) => item.kind === "prose").every((item) => item.minCharacters === 1500));
assert.ok(explicitContractPlan.taskContract.exclusions.some((item) => item.includes("自检报告或完成回执")), "禁止段落中的逗号列表必须保持为排除项");
assert.equal(explicitContractPlan.primaryTargets.some((item) => ["canon-events", "canon-characters", "memory-foreshadowing", "outline-chapter-1", "report-novel"].includes(item.documentId)), false);

const shortDocuments = Object.fromEntries(explicitContractPlan.taskContract.deliverables.map((item) => [item.targetDocumentId, {
  id: item.targetDocumentId,
  documentId: item.targetDocumentId,
  moduleId: item.target.moduleId,
  title: item.kind === "prose" ? `${item.title} 正式标题` : item.title,
  text: item.targetDocumentId === "chapter-1" ? "过短正文" : "正文内容".repeat(item.kind === "prose" ? 600 : 20),
}]));
const shortEvaluation = evaluateTaskContract({
  contract: explicitContractPlan.taskContract,
  documents: shortDocuments,
  receipts: explicitContractPlan.taskContract.deliverables.map((item) => ({ targetDocumentId: item.targetDocumentId, verified: true })),
});
assert.equal(shortEvaluation.complete, false);
assert.ok(shortEvaluation.missing.some((item) => item.targetDocument === "chapter-1" && item.reason.includes("content_too_short")), "不足最小字符数的正文不得通过完成验收");

const outlineOnly = compileCreativeMutationPlan({
  instruction: "正式生成并写入完整全书大纲，规划第1章至第10章的剧情走向；不要生成正式正文。",
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.deepEqual(outlineOnly.primaryTargets.map((item) => item.documentId), ["outline-series"], "大纲中的章节范围不能制造正文交付物");

const settingOnly = compileCreativeMutationPlan({
  instruction: "创建并正式写入作品设定文档；不要写正文或大纲。",
  formalWriteIntent: true,
  productionIntent: true,
  inventory: [],
});
assert.deepEqual(settingOnly.primaryTargets.map((item) => item.documentId), ["canon-world"]);

const route = buildAdaptiveTaskRoute({
  text: combinedInstruction,
  authorizationInstruction: combinedInstruction,
  sourceMessageId: "user-formal-delivery",
  target: { ...plan.primaryTargets[0], exists: false },
  targetDocumentIds: plan.primaryTargets.map((item) => item.documentId),
  expectedRevisions: Object.fromEntries(plan.primaryTargets.map((item) => [item.documentId, ""])),
  targetExists: false,
  taskContract: plan.taskContract,
}, { executionSurface: "agent" });

assert.equal(route.writeAuthorization.state, "commit", "排除内容不能否定 TaskContract 的正式写入授权");
assert.equal(route.writeAuthorization.reason, "task_contract_formal_delivery");
assert.equal(route.formalArtifactExpected, true);
assert.equal(route.taskContract.deliverables.length, 12);
const mergedRuntimeRoute = mergeAgentExecutionTaskRoute({
  preparedRoute: route,
  runtimeRoute: {
    commitOwner: route.commitOwner,
    commitDisposition: route.commitDisposition,
    landingPolicy: route.landingPolicy,
    completionAuthority: route.completionAuthority,
  },
});
assert.equal(mergedRuntimeRoute.taskContract.deliverables.length, 12, "Agent 启动后的简化路由不能覆盖客户端 TaskContract");
assert.equal(mergedRuntimeRoute.formalArtifactExpected, true, "Agent 完成阶段必须保留正式交付物预期");
assert.equal(mergedRuntimeRoute.writeAuthorization.state, "commit", "Agent 完成阶段必须保留正式事务授权");

const artifacts = plan.taskContract.deliverables.map((deliverable, index) => ({
  deliverableId: deliverable.id,
  targetDocumentId: deliverable.targetDocumentId,
  contentType: deliverable.kind,
  title: deliverable.kind === "prose" ? `${deliverable.title} 标题${index + 1}` : deliverable.title,
  content: deliverable.kind === "prose"
    ? `这是${deliverable.title}的正式正文，包含连续动作、人物选择、环境变化与冲突推进。`.repeat(80)
    : `${deliverable.title}的正式内容。`.repeat(20),
}));
const response = JSON.stringify({ artifacts });
const preview = codexAgentCandidatePreview({
  text: response,
  route,
  target: { ...plan.primaryTargets[0], creativeMutationPlan: plan },
  instruction: combinedInstruction,
});
assert.ok(preview);
assert.equal(preview.target.kind, "document-batch");
assert.equal(preview.target.incompleteBatch, false);
assert.equal(preview.target.creativeMutationPlan.primaryTargets.length, 12, "正式落盘防火墙必须保留原始目标计划");
assert.equal(preview.candidateDocuments.length, 12);
assert.deepEqual(preview.candidateDocuments.map((item) => item.target.documentId), plan.primaryTargets.map((item) => item.documentId));
assert.deepEqual(preview.candidateDocuments.map((item) => item.target.moduleId), [
  "canon", "outline", ...Array.from({ length: 10 }, () => "manuscript"),
]);
assert.equal(candidateBatchCoversRequestedTargets({
  candidateDocuments: preview.candidateDocuments,
  requestedTargets: plan.primaryTargets,
}), true, "已由 TaskContract 验证并完整映射的批量候选必须绕过第二次语义拆包");
assert.equal(candidateBatchCoversRequestedTargets({
  candidateDocuments: preview.candidateDocuments.slice(0, 11),
  requestedTargets: plan.primaryTargets,
}), false, "缺少交付物的批量候选不能绕过语义拆包与完整性检查");
assert.equal(authorizeFormalMutation({
  instruction: combinedInstruction,
  plan: preview.target.creativeMutationPlan,
  targets: preview.candidateDocuments.map((item) => ({ documentId: item.target.documentId, moduleId: item.target.moduleId })),
}).ok, true, "设定、大纲和正文必须共同通过正式事务防火墙");

const shortArtifacts = artifacts.map((artifact) => artifact.targetDocumentId === "chapter-4"
  ? { ...artifact, content: "这是一段不足验收长度的正式正文。".repeat(20) }
  : artifact);
const shortPreview = codexAgentCandidatePreview({
  text: JSON.stringify({ artifacts: shortArtifacts }),
  route,
  target: { ...plan.primaryTargets[0], creativeMutationPlan: plan },
  instruction: combinedInstruction,
});
assert.equal(shortPreview.target.incompleteBatch, true, "正文字符不足必须在任何磁盘写入前阻止整批落盘");
assert.deepEqual(shortPreview.target.invalidDeliverables.map((item) => item.targetDocumentId), ["chapter-4"]);

const incompletePreview = codexAgentCandidatePreview({
  text: JSON.stringify({ artifacts: artifacts.slice(0, 11) }),
  route,
  target: { ...plan.primaryTargets[0], creativeMutationPlan: plan },
  instruction: combinedInstruction,
});
assert.ok(incompletePreview);
assert.equal(incompletePreview.target.incompleteBatch, true, "缺少一个交付物时不得进入自动落盘完成态");

const marked = extractFormalArtifacts({
  response: [
    "<!-- target: canon-world | type: setting -->",
    "# 世界观与基础规则",
    "御兽世界设定。",
    "<!-- target: outline-series | type: outline -->",
    "# 全集大纲",
    "第1章：退婚。\n第2章：觉醒。",
  ].join("\n"),
  instruction: "正式写入设定和大纲",
});
assert.equal(marked.structuredResponse, true);
assert.deepEqual(marked.artifacts.map((item) => item.targetDocumentId), ["canon-world", "outline-series"]);
assert.deepEqual(marked.artifacts.map((item) => item.contentType), ["setting", "outline"]);

const retryContext = resolveTaskContractRetryContext({
  instruction: "我按当前合同原样重试",
  messages: [
    { role: "user", content: "普通问题" },
    {
      role: "user",
      content: combinedInstruction,
      requestMode: "codex_agent",
      taskRoute: { executionSurface: "agent", taskContract: plan.taskContract },
      references: ["canon-old"],
    },
    { role: "assistant", content: "落盘失败", execution: { status: "failed" } },
  ],
});
assert.equal(retryContext.prompt, combinedInstruction);
assert.equal(retryContext.executionSurface, "agent", "合同重试必须保留原执行界面，不能退回无模型的本地分支");
assert.equal(retryContext.taskContract.contractId, plan.taskContract.contractId);
assert.equal(resolveTaskContractRetryContext({ instruction: "分析一下原因", messages: [] }), null);

for (const landingInstruction of ["落盘", "落盘落盘", "将上一次完整候选原样落盘"]) {
  assert.equal(isLandingRequest(landingInstruction), true, `“${landingInstruction}”必须识别为落盘指令`);
  assert.equal(isGenerationAndLandingRequest(landingInstruction), false, `“${landingInstruction}”不得触发重新生成`);
}

const appSource = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
const queuedDispatchSource = appSource.slice(
  appSource.indexOf("const queuedLandingOnly = isLandingRequest(nextQueuedItem.content)"),
  appSource.indexOf("const enqueueMessage ="),
);
assert.ok(
  queuedDispatchSource.indexOf("const queuedLandingOnly =")
    < queuedDispatchSource.indexOf("runtimeSupplement === true && !queuedLandingOnly"),
  "排队恢复不得把纯落盘包装成补充生成任务",
);
assert.match(queuedDispatchSource, /const queuedUsesAgent = !queuedLandingOnly/u,
  "队列应先识别纯落盘，再决定是否需要完整 Agent 执行");
assert.match(queuedDispatchSource, /else \{\s+void sendMessage\(dispatchContent/u,
  "统一 Agent 模式下的排队项必须回到同一发送入口，不能被旧模式分支截走");
const composerDispatch = appSource.slice(appSource.indexOf("const dispatchComposerContent ="), appSource.indexOf("const switchToAgentFromGuidance ="));
assert.ok(composerDispatch.indexOf("const landingOnly =") < composerDispatch.indexOf("resolveTaskContractRetryContext"), "纯落盘必须先于失败合同重试判定");
assert.doesNotMatch(composerDispatch.slice(composerDispatch.indexOf("if (landingOnly)"), composerDispatch.indexOf("resolveTaskContractRetryContext")), /runBoundedExternalWorkspaceRefresh/u, "已有候选的纯落盘不得等待外部工作区刷新");
assert.match(appSource, /if \(!landingOnlyRequested\) void protectConversationDispatchBeforeModel\(\)/u, "生成任务应后台启动保存，纯落盘不应重复触发生成前保护");
assert.match(appSource, /const requestAdaptiveEvidence = !landingOnlyRequested/u, "纯落盘不得再编译动态取证范围");
assert.match(appSource, /let requestProjectContext = landingOnlyRequested\s+\? ""/u, "纯落盘不得再编译模型项目上下文");
assert.doesNotMatch(appSource, /const landingLanguageViolations/u, "用户授权的批量落盘不得重复执行未参与决策的跨章语言扫描");
assert.match(appSource, /const activeCandidateReady = Boolean\([\s\S]{0,260}const recovered = activeCandidateReady\s+\? null\s+: latestRecoverableCandidate/u, "当前候选、目标与授权齐全时不得重复扫描整段历史对话");
assert.match(appSource, /if \(!parsedCandidateBatch && explicitNewDocumentRequest\.create && smartLandingHint\.action === "create_and_land"\)/u,
  "TaskContract 已拆分的多文档候选不得被‘创建文档’字样重定向到单个临时文档");
const formalLandingMemoryStage = appSource.slice(
  appSource.indexOf("const memoryPendingDocumentIds = markMaterialUpdatePending"),
  appSource.indexOf("aiWritingMetricChanges.forEach", appSource.indexOf("const memoryPendingDocumentIds = markMaterialUpdatePending")),
);
assert.doesNotMatch(formalLandingMemoryStage, /await requestVerifiedMemoryProjection/u, "派生记忆投影不得阻塞正式交付物的原子落盘");
assert.match(formalLandingMemoryStage, /markMaterialUpdatePending/u, "正文落盘前必须把资料状态标记为待更新");
assert.match(formalLandingMemoryStage, /materialUpdatePromptFor/u, "正文落盘后必须生成独立的更新资料项目");
assert.doesNotMatch(formalLandingMemoryStage, /scheduleManualNarrativeMemorySync/u, "正文落盘后不得绕过用户选择自动更新资料");

console.log("Shensi TaskContract formal delivery closure passed");
