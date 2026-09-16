import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

const sourceWindow = (start, end) => {
  const from = app.indexOf(start);
  assert.notEqual(from, -1, `missing source marker: ${start}`);
  const to = app.indexOf(end, from + start.length);
  assert.notEqual(to, -1, `missing source marker: ${end}`);
  return app.slice(from, to);
};

const loadConversation = sourceWindow("const loadConversation =", "function htmlToMarkdown");
assert.match(loadConversation, /openPendingMaterialUpdateChoiceForConversation/u,
  "切回对话时必须恢复尚未处理的更新资料项目");

const landingFlow = sourceWindow("const materialUpdateSourceDocumentIds =", "const handleGenerationAttemptAction =");
assert.match(landingFlow, /kind: "material_update_prompt"/u);
assert.match(landingFlow, /sourceRevisions: materialUpdateSourceRevisions/u,
  "资料更新提示必须绑定刚落盘正文的版本");
assert.match(landingFlow, /bindMaterialUpdatePromptToMessage/u);
assert.match(landingFlow, /openMaterialUpdateChoice/u);

const formalLanding = sourceWindow(
  "const memoryPendingDocumentIds = markMaterialUpdatePending",
  "aiWritingMetricChanges.forEach",
);
assert.match(formalLanding, /materialUpdatePromptFor/u,
  "正文事务必须产生独立的更新资料项目");
assert.doesNotMatch(formalLanding, /applyCandidateMemoryUpdate|scheduleManualNarrativeMemorySync/u,
  "正文事务不得直接更新记忆、大纲或设定");

const choiceRenderer = sourceWindow("const renderConversationChoicePanel =", "const openChatAgentGuidanceChoice =");
assert.match(choiceRenderer, /pending\.kind === "material_update_prompt"/u);
assert.match(choiceRenderer, /确认更新/u);
assert.match(choiceRenderer, /取消/u);
assert.match(choiceRenderer, /大纲、设定、记忆或资料库/u);

const choiceOpeners = sourceWindow("const openChatAgentGuidanceChoice =", "const openFreshStartChoice =");
assert.match(choiceOpeners, /function openMaterialUpdateChoice/u);
assert.match(choiceOpeners, /conversationHasRunningTask/u,
  "资料更新入口不得抢占仍在执行的任务");
assert.match(choiceOpeners, /promptMessageIds/u,
  "同一对话的多次正文落盘应合并成一个更新资料项目");

const choiceHandler = sourceWindow(
  "elements.conversationChoicePanel?.addEventListener(\"click\"",
  "elements.memoryReviewButton.addEventListener",
);
assert.match(choiceHandler, /runConfirmedPostLandingMaterialsUpdate/u);
assert.match(choiceHandler, /"cancelled"/u,
  "取消必须终结本轮提示，不能作为稍后重复弹出的 deferred 状态");
assert.match(choiceHandler, /sourceRevisions: pending\.sourceRevisions/u,
  "确认更新必须携带落盘时绑定的正文版本");
assert.match(choiceHandler, /updatePromptStatuses\("running"\)/u);
assert.match(choiceHandler, /materialUpdateRunPromptStatus\(completed\)/u,
  "切换工作区造成的暂缓必须恢复为 pending，不能误记为永久失败");
assert.match(choiceHandler, /workspaceState: materialWorkspaceState/u,
  "资料更新选择必须携带点击时的工作区快照");

const materialUpdateRun = sourceWindow(
  "const materialUpdateInspectionProjectContext =",
  "const explicitPostLandingMaterialsUpdateRequested =",
);
assert.match(materialUpdateRun, /workspaceState\?\.documents\?\.\[documentId\]/u,
  "资料差异检查不得读取当前界面的全局文档");
assert.match(materialUpdateRun, /conversationDispatchGate\.claim\(conversationId, dispatchToken\)/u,
  "资料检查、记忆同步和正式资料更新必须共享同一对话调度锁");
assert.match(materialUpdateRun, /dispatchToken,[\s\S]*materialUpdateExecutionPlan/u,
  "两阶段资料更新必须保持统一调度顺序");
assert.match(materialUpdateRun, /workspaceState,[\s\S]*taskContextSnapshot,[\s\S]*dispatchToken/u,
  "资料更新的模型调用必须始终钉在发起工作区");
assert.match(materialUpdateRun, /deferForWorkspaceSwitch/u);
assert.match(materialUpdateRun, /return null/u,
  "切换作品时应保留待处理状态，而不是报告失败");
assert.match(materialUpdateRun, /assertSourceRevisionsCurrent/u,
  "资料检查和正式执行前必须重新验证来源正文版本");
assert.match(materialUpdateRun, /const memoryChanges = plan\.changes\.filter/u,
  "只有差异计划明确命中记忆时才能运行结构化记忆同步");
assert.match(materialUpdateRun, /materialUpdateModuleId\(item\.targetDocumentId\) !== "memory"/u,
  "结构化记忆目标不得混入普通文档生成写入");
assert.match(materialUpdateRun, /captureMaterialUpdateMemoryRollback/u,
  "记忆同步前必须捕获定向补偿快照");
assert.match(materialUpdateRun, /rollbackMaterialMemoryTransaction/u,
  "记忆同步或后续资料写入失败时必须执行补偿回滚");
assert.match(materialUpdateRun, /if \(completed\) memoryTransactionCommitted = true/u,
  "只有全部资料目标成功后才能提交记忆事务");

const pinnedAgent = sourceWindow("const savePinnedAgentLandingMetadata =", "const synchronizeBackgroundGenerationIntoActiveWorkspace =");
assert.match(pinnedAgent, /markMaterialUpdatePending/u);
assert.match(pinnedAgent, /materialUpdatePrompt/u);
assert.doesNotMatch(pinnedAgent, /applyCandidateMemoryUpdate/u,
  "后台 Agent 正文落盘不得直接写入记忆资料");

const pinnedLongForm = sourceWindow("const savePinnedLongFormLandingMetadata =", "const landLongFormCandidate =");
assert.match(pinnedLongForm, /markMaterialUpdatePending/u);
assert.doesNotMatch(pinnedLongForm, /applyCandidateMemoryUpdate/u,
  "后台长篇正文落盘不得直接写入记忆资料");

const inlineEdit = sourceWindow("const acceptInlineEdit =", "const syncSelectionFormatState =");
assert.match(inlineEdit, /markMaterialUpdatePending/u);
assert.match(inlineEdit, /materialUpdatePromptFor/u);
assert.doesNotMatch(inlineEdit, /applyCandidateMemoryUpdate/u,
  "局部正式修改确认后也必须把资料更新拆成独立项目");

const automaticAgentLanding = sourceWindow("const autoLandCodexAgentCandidate =", "const handleCodexAgentEvent =");
assert.match(automaticAgentLanding, /bindMaterialUpdatePromptToMessage/u);
assert.match(automaticAgentLanding, /savePinnedAgentLandingMetadata/u);

console.log("material update prompt flow contracts passed");
