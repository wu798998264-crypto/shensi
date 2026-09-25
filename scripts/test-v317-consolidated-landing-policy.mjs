import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { compileAgentTaskPolicy } from "../src/agent-task-policy.js";
import { codexAgentCandidatePreview } from "../src/codex-agent-candidate-preview.js";
import { compileCreativeMutationPlan } from "../src/creative-mutation-plan.js";
import { extractFormalArtifacts, formalArtifactCommitEligibility, formalArtifactLandingPolicy } from "../src/formal-artifact-extractor.js";
import { bindFormalWriteCandidate, createFormalWriteAuthorization } from "../src/formal-write-authorization.js";
import { isNonFormalTaskByDefault } from "../src/formal-write-confirmation.js";
import { notebookDestinationForDeliverable } from "../src/notebook-deliverable.js";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";
import { documentContentState } from "../src/version-store.js";

assert.equal(documentContentState(""), "empty");
assert.equal(documentContentState("<p>等待AI写入</p>"), "meaningless");
assert.equal(documentContentState("乱码"), "meaningless");
assert.equal(documentContentState("xxxxxxxxxx"), "meaningless");
assert.equal(documentContentState("序"), "substantive", "合法短文本不能被当成乱码");
assert.equal(documentContentState("这是已有文章中必须读取的有效信息。"), "substantive");

assert.deepEqual(notebookDestinationForDeliverable({
  deliverableType: "public_account",
  text: "创作一篇公众号文章",
}), {
  deliverableType: "public_account",
  placement: "dedicated_notebook",
  notebookName: "公众号文章",
  label: "公众号文章",
});

const publicAccountProjectPlan = compileCreativeMutationPlan({
  instruction: "写一篇关于职场焦虑的公众号文章，面向职场新人，1500字，偏理性分析",
  boundDocument: { documentId: "chapter-3", title: "第三章", moduleId: "manuscript" },
  inventory: [{ id: "chapter-3", title: "第三章", moduleId: "manuscript", characters: 1200 }],
  contextDomain: "novel",
  formalWriteIntent: true,
  productionIntent: true,
});
assert.deepEqual(publicAccountProjectPlan.primaryTargets, [], "作品模式公众号文章不得被编译成当前小说文档写入目标");

for (const [instruction, deliverableType] of [
  ["我想创作一篇公众号文章", "public_account"],
  ["我想写一部长篇小说", "novel"],
  ["我想创作一个短剧剧本", "short_drama_script"],
  ["我想写一篇短篇小说", "short_fiction"],
  ["我想做一个短视频剧本", "short_video_script"],
  ["我想写一套视频提示词", "visual_prompt"],
]) {
  const guidanceRoute = buildAdaptiveTaskRoute({ instruction, text: instruction, sourceMessageId: `guidance-${deliverableType}` }, { executionSurface: "chat" });
  assert.equal(guidanceRoute.mode, "creative", `只有创作意图时应保留创作边界并由面板选择模块：${instruction}`);
  assert.equal(guidanceRoute.panelRouteDelegated, true, `软件不得为 Agent 预选引导或主笔：${instruction}`);
  assert.equal(guidanceRoute.deliverableType, deliverableType);
  assert.equal(guidanceRoute.taskPolicy.action, "discuss", "面板尚未选择模块前不得提前生成正文");
  assert.equal(guidanceRoute.taskPolicy.commitDisposition, "no_artifact", "面板尚未选择模块前不得提前落盘");
}

for (const [instruction, deliverableType, routeMode = "creative"] of [
  ["写一篇关于职场焦虑的公众号文章，面向职场新人，1500字，偏理性分析", "public_account"],
  ["写一部都市悬疑长篇小说，主角是记者，面向成年读者，先写第一章3000字", "novel"],
  ["写一部都市复仇短剧第一集，面向女频观众，2分钟，结尾强反转", "short_drama_script"],
  ["写一篇关于亲情和解的短篇小说，面向青年读者，3000字，克制温暖", "short_fiction"],
  ["写一个30秒职场焦虑短视频剧本，面向职场新人，结尾反转", "short_video_script"],
  ["写一组15秒产品广告视频提示词，竖屏，写实电影风，突出产品质感", "visual_prompt", "visual_prompt"],
]) {
  const productionRoute = buildAdaptiveTaskRoute({ instruction, text: instruction, sourceMessageId: `production-${deliverableType}` }, { executionSurface: "chat" });
  assert.equal(productionRoute.mode, routeMode, `完整生产指令必须进入对应生成流程：${instruction}`);
  assert.equal(productionRoute.deliverableType, deliverableType);
  assert.equal(productionRoute.writeAuthorization.state, "commit");
  assert.equal(productionRoute.taskPolicy.commitDisposition, "auto_commit");
}

const target = { documentId: "note-article", revision: "revision-1", title: "公众号文章" };
const route = buildAdaptiveTaskRoute({
  text: "把这段说明写入当前文档",
  authorizationInstruction: "把这段说明写入当前文档",
  sourceMessageId: "user-explicit-write",
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  targetExists: true,
}, { executionSurface: "chat" });
assert.equal(route.writeAuthorization.state, "commit");

for (const instruction of ["保存这段对话说明到当前文档", "把刚才的回答落盘到当前文档"]) {
  const authorization = createFormalWriteAuthorization({
    instruction,
    sourceMessageId: `write-${instruction.length}`,
    targetDocumentIds: [target.documentId],
    expectedRevisions: { [target.documentId]: target.revision },
  });
  assert.equal(authorization.state, "commit", `明确写入指令必须执行：${instruction}`);
}
for (const instruction of ["能不能把这段内容保存到当前文档", "如何将回答写入当前文档"]) {
  const authorization = createFormalWriteAuthorization({
    instruction,
    sourceMessageId: `question-${instruction.length}`,
    targetDocumentIds: [target.documentId],
    expectedRevisions: { [target.documentId]: target.revision },
  });
  assert.equal(authorization.state, "none", `能力咨询不得误写入：${instruction}`);
}
const analyzeAndModifyRoute = buildAdaptiveTaskRoute({
  text: "分析当前文章的问题并直接修改当前文章",
  authorizationInstruction: "分析当前文章的问题并直接修改当前文章",
  sourceMessageId: "analyze-and-modify",
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  targetExists: true,
}, { executionSurface: "chat" });
assert.equal(analyzeAndModifyRoute.writeAuthorization.state, "commit", "分析后明确要求修改必须进入修改写入流程");
assert.equal(analyzeAndModifyRoute.taskPolicy.action, "modify");
assert.equal(analyzeAndModifyRoute.taskPolicy.commitDisposition, "auto_commit");
const analyzeOnlyRoute = buildAdaptiveTaskRoute({
  text: "只分析当前文章的问题，不要修改正文",
  authorizationInstruction: "只分析当前文章的问题，不要修改正文",
  sourceMessageId: "analyze-only",
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  targetExists: true,
}, { executionSurface: "chat" });
assert.equal(analyzeOnlyRoute.writeAuthorization.state, "none", "只分析且明确不修改时不得写入");
assert.equal(analyzeOnlyRoute.taskPolicy.commitDisposition, "no_artifact");
const explicitNonFormalAgentRoute = buildAdaptiveTaskRoute({
  text: "保存这段对话说明到当前文档",
  authorizationInstruction: "保存这段对话说明到当前文档",
  sourceMessageId: "agent-explicit-non-formal-write",
  target,
  targetDocumentId: target.documentId,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  targetExists: true,
  workspaceKind: "notebook",
}, { executionSurface: "agent" });
assert.equal(explicitNonFormalAgentRoute.writeAuthorization.state, "commit");
assert.equal(explicitNonFormalAgentRoute.formalArtifactExpected, false, "非正式内容确认写入不应伪装成正式产物");
assert.equal(explicitNonFormalAgentRoute.commitDisposition, "auto_commit", "明确写入授权必须优先于内容分类");
assert.equal(explicitNonFormalAgentRoute.intentEnvelope.writeMode, "formal_auto", "明确写入且目标清晰时不得因产物分类未知而重复要求确认");
const policy = compileAgentTaskPolicy({
  text: "把这段说明写入当前文档",
  route: { ...route, formalArtifactExpected: false },
  target,
  writeAuthorization: route.writeAuthorization,
});
assert.equal(policy.commitDisposition, "auto_commit", "明确写入不能再被 formalArtifactExpected 二次否决");
assert.equal(isNonFormalTaskByDefault("检查这段说明存在什么问题"), true, "普通检查仍应默认只返回对话结果");
assert.equal(isNonFormalTaskByDefault("检查后把结果保存到当前文档"), false, "明确保存必须覆盖分析类关键词的默认只读分类");
const diagnosticWriteInstruction = "检查后把结果保存到当前文档";
const diagnosticCandidate = "检查结果正文";
const diagnosticAuthorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
  instruction: diagnosticWriteInstruction,
  sourceMessageId: "diagnostic-write",
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  targetExists: true,
}), {
  candidate: diagnosticCandidate,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
});
assert.equal(formalArtifactLandingPolicy({
  instruction: diagnosticWriteInstruction,
  candidateCount: 1,
  writeAuthorization: diagnosticAuthorization,
  candidate: diagnosticCandidate,
  target,
}).shouldLand, true, "获得明确 commit 授权后不得在落盘阶段被分析关键词二次否决");
assert.equal(formalArtifactCommitEligibility({
  route: {
    action: policy.action,
    commitOwner: policy.commitOwner,
    commitDisposition: policy.commitDisposition,
    formalArtifactExpected: false,
    writeAuthorization: route.writeAuthorization,
  },
  runStatus: "completed",
}).eligible, true);

const candidate = "当前无法读取资料，请先补充资料后再生成。";
const authorization = bindFormalWriteCandidate(createFormalWriteAuthorization({
  instruction: "把这段说明写入当前文档",
  sourceMessageId: "user-confirmed-content",
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
  targetExists: true,
  contextualWriteAction: "replace",
}), {
  candidate,
  targetDocumentIds: [target.documentId],
  expectedRevisions: { [target.documentId]: target.revision },
});
const ordinaryExtraction = extractFormalArtifacts({
  response: candidate,
  instruction: "把这段说明写入当前文档",
  target,
  writeAuthorization: authorization,
});
assert.equal(ordinaryExtraction.artifacts.length, 0, "未确认时仍应防止错误说明静默覆盖正文");
const confirmedExtraction = extractFormalArtifacts({
  response: candidate,
  instruction: "把这段说明写入当前文档",
  target,
  writeAuthorization: authorization,
  allowConfirmedNonFormal: true,
});
assert.equal(confirmedExtraction.artifacts.length, 1, "用户确认后必须允许按候选原文写入");
assert.equal(confirmedExtraction.artifacts[0].content, candidate);

const preservedAgentNonFormalCandidate = codexAgentCandidatePreview({
  text: candidate,
  route,
  target,
  instruction: "把这段说明写入当前文档",
  candidateBasisSeed: { documents: {}, canonDocumentIds: [] },
});
assert.ok(preservedAgentNonFormalCandidate, "Agent 无法识别为正式正文的结果也必须保留为候选");
assert.equal(preservedAgentNonFormalCandidate.candidate, candidate);
assert.equal(preservedAgentNonFormalCandidate.target.landingBlocked, true);
assert.equal(preservedAgentNonFormalCandidate.target.requiresContentConfirmation, true);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /taskWorkspaceSourceState\.workspaceKind === "notebook" \|\| agentRoutedDeliverableType === "public_account"/u, "作品区发起的公众号文章也必须进入专用公众号笔记本");
assert.match(appSource, /agentRoutedDeliverableType === "public_account"/u, "公众号文章专用落点必须使用统一 Agent 路由结果");
assert.match(appSource, /notebookDestinationForDeliverable\(/u, "公众号文章专用落点必须调用笔记本落点编译器");
assert.match(appSource, /value: "confirm_candidate_content"/u);
assert.match(appSource, /value: "select_target"/u);
assert.match(appSource, /value: "select_operation"/u);
assert.match(appSource, /重读最新版并重新定位/u);
assert.match(appSource, /forceConfirmedTarget:\s*true/u, "用户重新选择的目标必须覆盖候选自带的旧目标");
assert.match(appSource, /errorCode: error\.code/u, "事务错误码必须传递到恢复面板");
assert.match(appSource, /explicitReferenceDocumentIds:\s*recoverableContextGateRetry\s*\?\s*\[\]/u, "用户确认继续后不得循环提交失效引用");
assert.match(appSource, /recoverableContextGateRetry\s*\?\s*\[\]/u, "Agent 确认继续后也不得循环提交失效引用");
assert.match(appSource, /errorCode: "CONTENT_QUALITY_CONFIRMATION_REQUIRED"/u, "质量或完整性问题必须进入可恢复选择");
assert.match(appSource, /errorCode: "CONTINUATION_TARGET_MISMATCH"/u, "续写目标不一致必须进入可恢复选择");
assert.match(appSource, /forceConfirmedOperation: pending\.reason === "operation"/u, "用户确认追加或覆盖方式后必须按该方式继续");
assert.match(appSource, /forceConfirmedStaleCandidate: true/u, "用户确认采用旧候选后必须允许按最新 revision 再次事务校验");
assert.match(appSource, /kind === "fresh_start"[\s\S]{0,900}void sendMessage\(retryInstruction,[\s\S]{0,360}executionSurface: "agent"/u, "Agent 的资料缺口确认必须回到统一 Agent 入口");
assert.doesNotMatch(appSource, /kind === "fresh_start"[\s\S]{0,900}sendCodexAgentMessage/u, "创作重试不得绕回原生 Agent 路由");
assert.match(appSource, /incompleteCandidateRequiresChoice[\s\S]{0,500}CONTENT_QUALITY_CONFIRMATION_REQUIRED/u, "Agent 的不完整正式候选必须进入可恢复选择");
assert.match(appSource, /forceTypeMismatch: pending\.forceConfirmedContent === true/u, "用户确认结构异常候选后必须只放行本次格式差异");
assert.match(appSource, /const basisSeed = await buildCandidateBasisSeed/u, "用户重新选择目标时必须使用当前文档基线，不能复用旧候选基线");
assert.match(appSource, /landingErrorCode[\s\S]{0,900}openLandingRecoveryChoice/u, "Agent 自动落盘失败必须打开恢复选择而不是只显示错误文字");
assert.match(appSource, /taskRoute\.writeAuthorization\?\.state === "commit"[\s\S]{0,120}taskRoute\.formalArtifactExpected/u, "Agent 的明确非正式写入也必须建立候选基线");
assert.match(appSource, /agentRoutedDeliverableType === "public_account"/u, "Agent 公众号成品必须使用统一路由结果");
assert.match(appSource, /notebookDestinationForDeliverable\(/u, "Agent 公众号成品必须进入专用笔记本落点");
assert.doesNotMatch(appSource, /shouldSuppressAutomaticFormalLanding/u, "落盘执行阶段不得再次用内容分类推翻已经核验的 commit 授权");
assert.match(appSource, /MATERIAL_UPDATE_TARGET_MISMATCH/u, "资料更新目标不一致必须进入可恢复选择");
assert.match(appSource, /MATERIAL_UPDATE_PREFLIGHT_FAILED/u, "资料增量预检失败必须进入可恢复选择");
assert.match(appSource, /重新核对资料差异并生成/u, "资料更新恢复卡必须提供重新核对差异入口");

console.log("v3.17 consolidated landing policy tests passed");
