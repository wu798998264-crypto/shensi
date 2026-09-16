import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, serverSource, orchestratorSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/shensi-orchestrator.mjs", import.meta.url), "utf8"),
]);

const memoryProjectionEndpoint = serverSource.slice(
  serverSource.indexOf('if (pathname === "/api/chat/memory-projection"'),
  serverSource.indexOf('if (pathname === "/api/chat/supplement"'),
);
assert.match(memoryProjectionEndpoint, /extractMemoryWithNumberedEvidence/u);
assert.doesNotMatch(memoryProjectionEndpoint, /verifiedMemoryUpdateOrExcerpt/u);
assert.match(memoryProjectionEndpoint, /pendingCandidates/u);
assert.match(memoryProjectionEndpoint, /acceptedItemCount/u);
assert.match(memoryProjectionEndpoint, /deferredItemCount/u);
assert.match(memoryProjectionEndpoint, /agentPreferred:\s*true/u, "资料同步必须使用当前统一 Agent 配置");

const memoryProjectionRequest = appSource.slice(
  appSource.indexOf("const requestVerifiedMemoryProjection"),
  appSource.indexOf("const memorySyncRuntimeKey"),
);
assert.match(memoryProjectionRequest, /generationSettingsForAgentEngine/u);
assert.match(memoryProjectionRequest, /sourceRevision/u);
assert.match(memoryProjectionRequest, /pendingCandidates/u);
assert.match(appSource, /memorySyncDeferredRetries/u);
assert.match(appSource, /retryCount < 3/u, "章节暂存只能有限自动重析，不能无限重试");

const memoryCheckDirective = orchestratorSource.slice(
  orchestratorSource.indexOf('if (stage === "memory-check")'),
  orchestratorSource.indexOf('if (stage === "audit")'),
);
assert.doesNotMatch(memoryCheckDirective, /memoryUpdate/u, "连续性检查不得继续承担记忆提取");
assert.doesNotMatch(orchestratorSource, /if \(useCombinedCheck\)/u, "正式链不得继续保留可重新启用的合并检查分支");
assert.match(orchestratorSource, /extractMemoryWithNumberedEvidence/u);
assert.match(orchestratorSource, /verified_partial_deferred/u);
assert.match(orchestratorSource, /verified_deferred/u);
assert.match(orchestratorSource, /memoryExtractionCallBudget/u);
assert.match(orchestratorSource, /memoryExtractionCallCount/u, "记忆提取必须拥有独立调用预算");

console.log("degraded memory integration boundaries passed");
