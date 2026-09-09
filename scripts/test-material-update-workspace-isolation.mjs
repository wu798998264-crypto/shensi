import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const sourcePath = resolve(import.meta.dirname, "../src/app.js");

async function sourceWindow(marker, count = 180) {
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

const inspectionRouting = await sourceWindow("const executeConversationAgentMessage =", 60);
assert.match(inspectionRouting, /workspaceState, taskContextSnapshot/u,
  "资料检查与其他 Agent 任务必须继承发送时工作区快照");
assert.match(inspectionRouting, /workspaceKind: taskContextSnapshot\.workspaceKind, workspacePath: taskContextSnapshot\.workspacePath/u,
  "原生 Agent 请求必须显式锁定发送时工作区");

const memorySync = await sourceWindow("const memorySyncRuntimeKey =", 95);
assert.match(memorySync, /state === syncWorkspaceState/u,
  "记忆同步异步返回后必须确认仍是同一个工作区对象");
assert.match(memorySync, /memorySyncPromises\.has\(runtimeKey\)/u);
assert.match(memorySync, /memorySyncLastRunAt\.set\(runtimeKey/u);
assert.match(memorySync, /memorySyncTimers\.set\(runtimeKey/u,
  "不同作品中的同名章节不得共用同步计时器或 Promise");

const materialRun = await sourceWindow("const runConfirmedPostLandingMaterialsUpdate =", 140);
assert.match(materialRun, /workspaceState = pending\.workspaceState \|\| state/u);
assert.match(materialRun, /materialUpdateWorkspaceStillActive/u);
assert.match(materialRun, /persistMaterialUpdateConversation/u,
  "资料更新的中间状态必须按原工作区持久化");
assert.match(materialRun, /conversationDispatchGate\.claim\(conversationId, dispatchToken\)/u);
assert.match(materialRun, /conversationDispatchGate\.release\(conversationId, dispatchToken\)/u,
  "完整资料更新回路必须独占同一对话的调度顺序并最终释放");
assert.match(materialRun, /materialUpdateInspection:[\s\S]*workspaceState,[\s\S]*taskContextSnapshot,[\s\S]*dispatchToken/u);
assert.match(materialRun, /materialUpdateExecutionPlan:[\s\S]*conversationId,[\s\S]*workspaceState,[\s\S]*taskContextSnapshot,[\s\S]*dispatchToken/u,
  "检查和正式资料写入两次调用都必须携带同一个工作区快照");
assert.match(materialRun, /deferForWorkspaceSwitch/u);
assert.match(materialRun, /return null/u,
  "切换工作区造成的中断必须可恢复，不能落为永久失败");

const choiceFlow = await sourceWindow("if (pendingConversationChoice.kind === \"material_update_prompt\"", 75);
assert.match(choiceFlow, /const materialWorkspaceState = state/u);
assert.match(choiceFlow, /materialUpdateRunPromptStatus\(completed\)/u);
assert.match(choiceFlow, /stillActive \? "failed" : "pending"/u,
  "后台切换导致的异常必须回到待处理状态");

const longFormCompletion = await sourceWindow("if (!job.selfCheckRequested) {", 28);
assert.match(longFormCompletion, /materialUpdatePromptFor/u);
assert.match(longFormCompletion, /workspaceState: taskWorkspaceState\(\)/u,
  "长篇任务最终资料提示必须绑定原任务工作区");

const inlineEditCompletion = await sourceWindow("const materialUpdateMessage = [...state.messages]", 25);
assert.match(inlineEditCompletion, /message\.inlineEditResult\?\.id === inlineEditId/u);
assert.match(inlineEditCompletion, /bindMaterialUpdatePromptToMessage/u,
  "局部编辑确认后必须把资料更新项目绑定到对应完成消息");

console.log("material update workspace isolation contracts passed");
