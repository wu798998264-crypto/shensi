import assert from "node:assert/strict";
import { createInitialCapabilityTemplate, capabilityTemplateTopology } from "../src/capability-template.js";
import {
  compactCapabilityRouteTopology,
  parseTaskRouteDocumentCandidate,
  TASK_ROUTE_GENERATION_TIMEOUT_MS,
  taskRouteDocumentGenerationPrompt,
  validateTaskRouteDocumentCandidate,
} from "../src/server/task-route-document.mjs";

const bundle = createInitialCapabilityTemplate();
const topology = capabilityTemplateTopology(bundle);
const topologyHash = "a".repeat(64);
const routeRevision = 7;
assert.ok(TASK_ROUTE_GENERATION_TIMEOUT_MS > 0 && TASK_ROUTE_GENERATION_TIMEOUT_MS < 30_000,
  "保存面板时的可选动态路由生成不得让界面等待到看似卡死");
const prompt = taskRouteDocumentGenerationPrompt({ bundle, routeRevision, topologyHash });
assert.match(prompt.system, /只输出一个 JSON 对象/u);
const compact = compactCapabilityRouteTopology({ bundle, routeRevision, topologyHash });
assert.equal(compact.routeRevision, routeRevision);
assert.equal(compact.topologyHash, topologyHash);
assert.ok(compact.modules.some((module) => module.slots.length));
assert.equal(topology.valid, true);

const document = [
  "# 动态路由",
  "根据完整意图、阶段、交付物和当前上下文选择能力。",
  "并行成员可以独立或协作；主次关系优先主要项但允许按语义使用次要项；组织关系由上位项组织所需下位项。",
].join("\n\n");
const parsed = parseTaskRouteDocumentCandidate(`\`\`\`json\n${JSON.stringify({ routeRevision, topologyHash, document })}\n\`\`\``);
const accepted = validateTaskRouteDocumentCandidate(parsed, { routeRevision, topologyHash, bundle });
assert.equal(accepted.valid, true);
assert.match(accepted.contentHash, /^[a-f0-9]{64}$/u);

const stale = validateTaskRouteDocumentCandidate({ ...parsed, routeRevision: routeRevision - 1 }, { routeRevision, topologyHash, bundle });
assert.equal(stale.valid, false);
assert.match(stale.errors.join("；"), /版本/u);

const obsolete = validateTaskRouteDocumentCandidate({
  ...parsed,
  document: `${document}\n\n请读取神思-执行入口映射表。`,
}, { routeRevision, topologyHash, bundle });
assert.equal(obsolete.valid, false);
assert.match(obsolete.errors.join("；"), /废弃/u);

const keywordRoute = validateTaskRouteDocumentCandidate({
  ...parsed,
  document: `${document}\n\n出现某个关键词就调用固定 Skill。`,
}, { routeRevision, topologyHash, bundle });
assert.equal(keywordRoute.valid, false);
assert.match(keywordRoute.errors.join("；"), /关键词裁决/u);

console.log("dynamic task route document contracts passed");
