import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { isShensiAgentCompatibleProfile } from "../src/agent-engine-registry.js";
import { effectiveRuntimeContract, runtimeContractForProfile } from "../src/effective-runtime-contract.js";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { looksLikeWorkspaceOperation } from "../src/workspace-operations.js";

const legacySettings = {
  activeTextChatConnectionId: "custom-chat",
  textConnections: [{
    id: "custom-chat",
    provider: "自定义兼容接口",
    adapter: "api",
    protocol: "chat_completions",
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-only",
    model: "model-x",
    executionMode: "chat",
    executionModes: ["chat"],
    agentEngine: "",
  }],
};

const normalized = normalizeGenerationProfiles(legacySettings);
const profile = normalized.textConnections.find((item) => item.id === "custom-chat");
assert.ok(profile);
assert.equal(profile.executionMode, "agent");
assert.deepEqual(profile.executionModes, ["agent"]);
assert.equal(profile.agentEngine, "codex_api", "API 文字配置必须默认使用内置 Agent");
assert.equal(profile.agentModelId, "model-x");
assert.equal(normalized.activeTextAgentConnectionId, profile.id);
assert.equal(normalized.activeTextConnectionId, profile.id);
assert.equal(isShensiAgentCompatibleProfile(profile), true);
assert.equal(looksLikeWorkspaceOperation("我想写个爽文"), false, "稀疏创作声明不能被工作区操作关键词截获");

const legacyChatContract = effectiveRuntimeContract({ settings: normalized, surface: "chat" });
assert.equal(legacyChatContract.ok, true);
assert.equal(legacyChatContract.surface, "agent", "旧 Chat surface 只能兼容映射到统一 Agent");
assert.equal(legacyChatContract.runner, "codex_api_agent");

for (const protocol of ["responses", "chat_completions"]) {
  const contract = runtimeContractForProfile({ profile: { ...profile, protocol }, surface: "agent" });
  assert.equal(contract.ok, true, `${protocol} 应由内置 Agent 建立 Agent 合同`);
}

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.doesNotMatch(appSource, /chatProviderSelect/u, "旧 Chat Provider 字段必须删除");
assert.match(appSource, /id="whiteboardTextExecutionSurface"[^>]*hidden[^>]*><option value="agent" selected>/u);
assert.doesNotMatch(appSource, /chatAgentGuidance\(content\)/u, "普通发送不得再经过关键词式 Chat→Agent 提示门禁");
assert.match(appSource, /dispatchComposerContent\(content\);/u);
const profileCaptureStart = appSource.indexOf("const captureGenerationFormProfile =");
const profileCaptureEnd = appSource.indexOf("const generationConnectionSummary =", profileCaptureStart);
const profileCapture = appSource.slice(profileCaptureStart, profileCaptureEnd);
assert.match(profileCapture, /patch\.executionMode = "agent";[\s\S]{0,80}patch\.executionModes = \["agent"\]/u,
  "保存任意文字配置时只能保留 Agent 执行模式");
assert.doesNotMatch(profileCapture, /patch\.executionModes\s*=\s*\[[^\]]*"chat"/u,
  "设置界面不得重新写入 Chat 或 Chat+Agent 配置");
assert.match(serverSource, /submittedBody\.executionSurface = "agent"/u);
assert.match(serverSource, /runUnifiedAgentEntryDecision\(\{/u);
assert.match(serverSource, /lane: "direct_reply"/u);
assert.match(serverSource, /agentDecision\.lane === "guided_dialogue"/u);
assert.match(serverSource, /agentDecision\.lane === "task_execution"/u);
assert.ok(
  serverSource.indexOf("runUnifiedAgentEntryDecision({") < serverSource.indexOf("readChatWebReferences({", serverSource.indexOf('pathname === "/api/agent/execute"')),
  "统一入口必须在联网资料读取前运行",
);
assert.ok(
  serverSource.indexOf("runUnifiedAgentEntryDecision({") < serverSource.indexOf("loadWorkspaceCurrentContent({", serverSource.indexOf('pathname === "/api/agent/execute"')),
  "统一入口必须在完整工作区读取前运行",
);

const freshStartBegin = appSource.indexOf('if (pendingConversationChoice.kind === "fresh_start"');
const freshStartEnd = appSource.indexOf('if (pendingConversationChoice.kind === "workspace_binding"', freshStartBegin);
assert.ok(freshStartBegin >= 0 && freshStartEnd > freshStartBegin, "从零开始恢复分支必须存在");
const freshStartBranch = appSource.slice(freshStartBegin, freshStartEnd);
assert.match(freshStartBranch, /void sendMessage\(retryInstruction,[\s\S]{0,360}executionSurface: "agent"/u,
  "从零开始必须回到统一 Agent 入口");
assert.match(freshStartBranch, /taskContextSnapshot: pending\.taskContextSnapshot \|\| captureTaskContextSnapshot\(conversationId\)/u,
  "从零开始必须继续使用原任务的发送时文档快照");
assert.doesNotMatch(freshStartBranch, /sendCodexAgentMessage/u,
  "从零开始不得绕回原生 Agent 路由");

const nativeAgentStart = appSource.indexOf("const sendCodexAgentMessage = async");
const nativeAgentEnd = appSource.indexOf("const dispatchComposerContent =", nativeAgentStart);
assert.ok(nativeAgentStart >= 0 && nativeAgentEnd > nativeAgentStart, "原生 Agent 入口必须存在");
const nativeAgentEntry = appSource.slice(nativeAgentStart, nativeAgentEnd);
const unifiedFallbackIndex = nativeAgentEntry.indexOf("if (!confirmedSelfRepair)");
const nativeFetchIndex = nativeAgentEntry.indexOf('fetch("/api/codex-agent/turn"');
assert.ok(unifiedFallbackIndex >= 0 && nativeFetchIndex > unifiedFallbackIndex,
  "普通任务必须先被原生入口回流到统一 Agent，才能触及原生执行端点");
assert.match(nativeAgentEntry.slice(unifiedFallbackIndex, nativeFetchIndex), /return await sendMessage\(prompt,[\s\S]{0,500}executionSurface: "agent"/u,
  "模糊创作请求即使误入旧入口，也必须统一由 Agent 语义判断");
assert.doesNotMatch(nativeAgentEntry.slice(0, nativeFetchIndex), /isConversationSkillInstallRequest|isSelfRepairRequest/u,
  "原生执行入口不得再用关键词识别安装或自修复任务");

const composerStart = appSource.indexOf("const dispatchComposerContent =");
const composerEnd = appSource.indexOf("let agentProfileChoiceContext", composerStart);
assert.ok(composerStart >= 0 && composerEnd > composerStart, "普通发送分派器必须存在");
assert.doesNotMatch(appSource.slice(composerStart, composerEnd), /sendCodexAgentMessage/u,
  "例如“我想写个爽文”的普通提交不得直达原生 Agent 路由");
assert.doesNotMatch(appSource.slice(composerStart, composerEnd), /isConversationSkillInstallRequest|isSelfRepairRequest/u,
  "普通提交不得在 Agent 判断前识别高影响操作");

assert.match(serverSource, /agentDecision\.lane === "task_execution" && agentDecision\.operation\?\.kind/u,
  "高影响操作必须来自统一 Agent 的结构化语义决定");
assert.match(serverSource, /AGENT_SELF_REPAIR_AUTHORIZATION_REQUIRED/u,
  "原生 Agent 端点必须拒绝未经过高影响确认的旁路请求");
assert.doesNotMatch(appSource.slice(composerStart, composerEnd), /presentAgentOperationProposalFromDecision/u,
  "普通文字任务不得在 Agent 执行前进入旧高影响操作分类器");

const repairConfirmStart = appSource.indexOf("const executeAgentOperationProposal = async");
const repairConfirmEnd = appSource.indexOf("const presentAgentOperationProposalFromDecision", repairConfirmStart);
assert.ok(repairConfirmStart >= 0 && repairConfirmEnd > repairConfirmStart, "自修复确认处理必须存在");
assert.match(appSource.slice(repairConfirmStart, repairConfirmEnd), /AGENT_OPERATION_KINDS\.SELF_REPAIR[\s\S]{0,400}sendCodexAgentMessage\(operation\.prompt,[\s\S]{0,300}selfRepairAuthorization/u,
  "只有用户确认过的自修复才能保留原生 Agent 执行路径");

console.log("Unified Agent mode contracts passed");
