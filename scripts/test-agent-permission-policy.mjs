import assert from "node:assert/strict";
import {
  AGENT_PERMISSION_MODES,
  DEFAULT_AGENT_PERMISSION_MODE,
  agentPermissionModeInfo,
  agentPermissionModeOptions,
  codexPermissionConfig,
  normalizeAgentPermissionMode,
  normalizeAgentPermissionSettings,
  permissionContractFor,
} from "../src/agent-permission-policy.js";

assert.equal(DEFAULT_AGENT_PERMISSION_MODE, "shensi_only");
assert.equal(normalizeAgentPermissionMode("workspace_scoped"), "shensi_only");
assert.equal(normalizeAgentPermissionMode("on-request"), "shensi_only");
assert.equal(normalizeAgentPermissionMode("approval_required"), "approval_required");
assert.equal(normalizeAgentPermissionMode("danger_full_access"), "full_access");
assert.equal(normalizeAgentPermissionMode("unknown"), "shensi_only");
assert.equal(normalizeAgentPermissionSettings({}).agentPermissionMode, "shensi_only");
assert.deepEqual(agentPermissionModeOptions().map((item) => item.id), ["shensi_only", "approval_required", "full_access"]);

assert.equal(AGENT_PERMISSION_MODES.shensi_only.shell, false);
assert.equal(AGENT_PERMISSION_MODES.approval_required.approvalRequired, true);
assert.equal(AGENT_PERMISSION_MODES.full_access.sandbox, "danger-full-access");
assert.equal(codexPermissionConfig("shensi_only").sandbox, "read-only");
assert.equal(codexPermissionConfig("approval_required").approvalPolicy, "on-request");
assert.equal(codexPermissionConfig("full_access").sandboxPolicy.type, "dangerFullAccess");

const contract = permissionContractFor("approval_required", { runner: "opencode", taskId: "task-1", snapshotAt: "2026-09-09T00:00:00.000Z" });
assert.equal(contract.mode, "approval_required");
assert.equal(contract.runner, "opencode");
assert.equal(contract.taskId, "task-1");
assert.equal(contract.confirmation.scope, "per_operation");
assert.ok(contract.confirmation.protectedOperations.includes("secret_read"));
assert.equal(agentPermissionModeInfo("native").id, "full_access");

console.log("agent permission policy: defaults, aliases, capability matrices, contracts passed");
