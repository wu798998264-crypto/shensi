import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const sourcePath = resolve(import.meta.dirname, "../src/app.js");

async function sourceWindow(marker, count = 220) {
  assert.ok(count > 0 && count <= 250, `source window must stay bounded: ${marker}`);
  const stream = createReadStream(sourcePath, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const collected = [];
  let found = false;
  try {
    for await (const line of lines) {
      if (!found) {
        if (!line.includes(marker)) continue;
        found = true;
      }
      collected.push(line);
      if (collected.length >= count) break;
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  assert.equal(found, true, `missing source marker: ${marker}`);
  return collected.join("\n");
}

const parseReply = await sourceWindow("const parseModelReply =", 90);
assert.match(parseReply, /workspaceState = state/u);
assert.match(parseReply, /const parseWorkspaceState = workspaceState \|\| state/u);
assert.match(parseReply, /withSynchronousWorkspaceState\(parseWorkspaceState/u);

const requestReply = await sourceWindow("const requestModelReply =", 240);
assert.match(requestReply, /const requestWorkspaceState = workspaceState \|\| state/u);
assert.match(requestReply, /documents: requestWorkspaceState\.documents/u);
assert.match(requestReply, /workspaceState: requestWorkspaceState/u,
  "异步模型返回必须交给发起任务的工作区解析");

const pinnedConversation = await sourceWindow("const savePinnedConversationCompletion =", 95);
assert.match(pinnedConversation, /const storedMessages = conversation\.messages/u);
assert.match(pinnedConversation, /completionMessages\.map/u);
assert.match(pinnedConversation, /storedMessages\.filter/u,
  "后台完成回写必须保留保存期间新增的消息");

const agentPersistence = await sourceWindow("const persistAgentTaskRuntime =", 75);
assert.match(agentPersistence, /workspaceTargetIsActive\(runtime\.workspaceScope\.workspaceKind/u);
assert.match(agentPersistence, /mergeAgentRuntimeConversationState\(state, runtime\)/u);
assert.match(agentPersistence, /savePinnedConversationCompletion/u);
assert.match(agentPersistence, /absorbAgentTaskWorkspaceState\(runtime, receipt\.workspaceState\)/u);
assert.match(agentPersistence, /agentTaskRuntimeNeedsRetention/u,
  "仍有队列项时不能提前释放原工作区运行时");

const longFormCheckpoint = await sourceWindow("const saveLongFormCheckpoint =", 75);
assert.match(longFormCheckpoint, /workspaceTargetIsActive\(scope\.workspaceKind, scope\.workspacePath\)/u);
assert.match(longFormCheckpoint, /enqueueInactiveWorkspaceGenerationWrite/u);
assert.match(longFormCheckpoint, /backgroundWorkspaceStateForSave\(workspaceState\)/u);
assert.match(longFormCheckpoint, /adoptPersistedLongFormWorkspace/u);

const longFormFailure = await sourceWindow("const currentJob = taskWorkspaceState()", 35);
assert.match(longFormFailure, /catch \{\s*preserveLongFormRuntimeCheckpointInMemory\(currentJob\);\s*\}/u,
  "长篇检查点写盘失败时必须保留原工作区内存检查点");

const queueDrain = await sourceWindow("const scheduleConversationQueueDrain =", 115);
assert.match(queueDrain, /const taskWorkspaceIsActive = queuedWorkspace[\s\S]*?workspaceTargetIsActive/u);
assert.match(queueDrain, /!taskWorkspaceIsActive[\s\S]*?\|\| !queuedUsesAgent\)[\s\S]*?nackQueuedConversationItem\(conversation, nextQueuedItem, "waiting_for_owned_workspace"\);[\s\S]*?return;/u,
  "非当前工作区的普通队列项必须退回队列，不能交给当前工作区执行");

const workspaceActivation = await sourceWindow("const activateProjectState =", 170);
assert.match(workspaceActivation, /for \(const conversation of state\.conversations \?\? \[\]\)[\s\S]*?scheduleConversationQueueDrain\(conversation\.id\);/u,
  "返回作品或笔记本后必须唤醒此前等待的对话队列");

const chatCompletion = await sourceWindow("const persistTaskConversation = async () =>", 45);
assert.match(chatCompletion, /savePinnedConversationCompletion\(\{[\s\S]*?workspaceKind: workspace\.workspaceKind,[\s\S]*?workspacePath: workspace\.workspacePath,[\s\S]*?messages: taskMessages/u);
assert.match(chatCompletion, /taskWorkspaceState === state[\s\S]*?workspaceTargetIsActive\(workspace\.workspaceKind, workspace\.workspacePath\)/u,
  "当前工作区任务才允许直接保存到前台状态");

const semanticLanding = await sourceWindow("const autoLandCodexAgentCandidate =", 190);
assert.match(semanticLanding, /requestSemanticLandingPackageForContent\(\{[\s\S]*?workspaceState: landingWorkspaceState/u,
  "异步语义落点规划必须使用发送时工作区");
assert.match(semanticLanding, /workspaceTargetIsActive\(workspaceScope\.workspaceKind, workspaceScope\.workspacePath\)/u,
  "落盘前必须重新判断发送时工作区身份");

const agentRefresh = await sourceWindow("const refreshAgentTaskWorkspaceDocuments =", 190);
assert.match(agentRefresh, /workspaceTargetIsActive\(scope\.workspaceKind, scope\.workspacePath\)/u);
assert.match(agentRefresh, /body: JSON\.stringify\(\{ workspacePath: scope\.workspacePath, refresh: true \}\)/u);
assert.match(agentRefresh, /enqueueInactiveWorkspaceGenerationWrite/u);
assert.match(agentRefresh, /absorbAgentTaskWorkspaceState\(runtime, receipt\.workspaceState\)/u,
  "Agent 外部文件回读必须回收到原工作区运行时");

const statusSync = await sourceWindow("const syncCodexAgentExecutionFromStatus =", 150);
assert.match(statusSync, /allConversationMessages\(\)/u);
assert.match(statusSync, /agentTaskRuntimeFor\(/u);
assert.match(statusSync, /refreshAgentTaskWorkspaceDocuments\(/u);
assert.match(statusSync, /finalizeAgentTaskRuntimeInBackground\(runtime\)/u,
  "状态恢复得到终态时也必须保存非当前工作区结果");

const autoLanding = await sourceWindow("const autoLandCodexAgentCandidate =", 180);
assert.match(autoLanding, /!workspaceTargetIsActive\(workspaceScope\.workspaceKind, workspaceScope\.workspacePath\)/u);
assert.match(autoLanding, /workspaceState: landingWorkspaceState/u);
assert.match(autoLanding, /landFormalCandidateInPinnedWorkspace/u);
assert.match(autoLanding, /withActiveWorkspaceFormalLandingLock/u,
  "当前工作区落盘期间切换作品必须等待事务完成");
assert.match(autoLanding, /savePinnedAgentLandingMetadata/u);

const agentEvents = await sourceWindow("const handleCodexAgentEvent =", 245);
assert.match(agentEvents, /agentTaskRuntimeFor\(/u);
assert.match(agentEvents, /runtime\?\.conversation \|\| agentConversationById/u);
assert.match(agentEvents, /refreshAgentTaskWorkspaceDocuments\(/u);
assert.match(agentEvents, /if \(!stillPending\) finalizeAgentTaskRuntimeInBackground\(runtime\)/u);

const agentSendTarget = await sourceWindow("const agentNotebookDestination =", 35);
assert.match(agentSendTarget, /inTaskWorkspace\(\(\) => captureNotebookLandingDestination/u,
  "笔记落点必须按发送时工作区捕获");

const queuedAgentWorkspace = await sourceWindow("const taskWorkspaceStateForQueueItem =", 45);
assert.match(queuedAgentWorkspace, /item\?\.taskContextSnapshot/u);
assert.match(queuedAgentWorkspace, /fetchWorkspacePayload\(workspacePath\)/u);
assert.match(queuedAgentWorkspace, /cacheWorkspaceState\(/u,
  "尚未建立运行时的后台 Agent 队列项也必须按发送时工作区恢复状态");

const agentSendWorkspace = await sourceWindow("const sendCodexAgentMessage =", 75);
assert.match(agentSendWorkspace, /taskWorkspaceStateForQueueItem\(queuedItem\)/u);
assert.match(agentSendWorkspace, /taskWorkspaceConversation/u,
  "跨作品派发 Agent 队列项时必须从所属工作区找回对话");

const chatSendWorkspace = await sourceWindow("const sendMessage = async", 55);
assert.match(chatSendWorkspace, /const taskWorkspaceState = options\.workspaceState \|\| taskRuntime\?\.workspaceState \|\| state/u);
assert.match(chatSendWorkspace, /taskWorkspaceState\.conversations\?\.find/u,
  "Chat 回退路径也不能从当前浏览作品误取同 ID 对话");

console.log("task workspace runtime isolation contracts passed");
