import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, serverSource] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
]);

assert.match(appSource, /agentOperationProposalConfirm/);
assert.match(appSource, /\.skill/);
assert.match(appSource, /agentOperationProposalDeliverables/);
assert.match(appSource, /agentOperationProposalAcceptance/);
assert.match(appSource, /selfRepairAuthorization/);
assert.match(serverSource, /authorizedAgentSelfRepairs/);
assert.match(appSource, /operationId:\s*String\(payload\.operationId/);
assert.match(appSource, /confirmed:\s*true,\s*operationId:\s*operation\.operationId/);
assert.match(appSource, /skipOperationProposal:\s*true/);
assert.match(serverSource, /pendingAgentOperations\.set\(operationId/);
assert.match(serverSource, /pendingAgentOperations\.get\(operationId\)/);
assert.match(serverSource, /AGENT_OPERATION_EXPIRED/);
assert.match(serverSource, /AGENT_OPERATION_IN_PROGRESS/);
assert.match(serverSource, /rollbackAgentInstalledSkill/);
assert.match(serverSource, /withAgentSkillOperationLock/);
assert.match(appSource, /error\.code === "AGENT_OPERATION_EXPIRED"/);
assert.match(appSource, /该确认方案已失效，请重新发送原要求后再确认/);
assert.match(serverSource, /pendingAgentOperations\.delete\(operationId\)/);
assert.match(serverSource, /bindingCapabilities/);
assert.match(serverSource, /skillPanelBindingCapabilities/);
assert.match(serverSource, /SKILL_PANEL_CAPABILITY_AMBIGUOUS/);
assert.match(serverSource, /SKILL_PANEL_BINDING_FAILED/);
assert.match(serverSource, /\["\/api\/agent\/operations\/propose"/);
assert.match(serverSource, /\["\/api\/agent\/operations\/execute"/);

console.log("agent operation UI/server contract passed");
