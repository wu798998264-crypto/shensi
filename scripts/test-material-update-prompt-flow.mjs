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
assert.match(choiceRenderer, /更新资料/u);
assert.match(choiceRenderer, /暂不更新/u);
assert.match(choiceRenderer, /记忆、大纲和设定/u);

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
