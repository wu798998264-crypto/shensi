import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-route-history-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

try {
  const {
    listManagedSkills,
    commitManagedTaskRouteDocumentCandidate,
    readManagedTaskRouteDocument,
    restoreManagedCapabilityTemplateVersion,
    saveManagedCapabilityTemplate,
    setManagedCustomSlotEnabled,
  } = await import("../src/server/skill-store.mjs");

  const initial = await listManagedSkills();
  const saved = await saveManagedCapabilityTemplate({
    bundle: initial.capabilityTemplate.current,
    scopeType: "template",
    scopeId: initial.capabilityTemplate.current.template.id,
  });
  assert.equal(saved.routeVersion.routeRevision, saved.routeRevision);
  assert.equal(saved.routeVersion.version, saved.savedVersion.version);
  assert.match(saved.routeVersion.topologyHash, /^[a-f0-9]{64}$/u);
  assert.equal(saved.routeVersion.routingAudit.valid, true);
  assert.ok(Array.isArray(saved.routeVersion.routeDiff.summary));
  assert.equal(saved.capabilityTemplate.history.template[0].routeRevision, saved.routeRevision);

  const routeDocument = [
    "# 当前面板路由",
    "Agent 按用户完整意图、当前阶段和交付物选择真实可用能力。",
    "并行关系中的能力可以独立调用或按需要协作。",
    "主次关系优先主要能力，并在任务语义需要时调用次要能力。",
    "组织关系由上位能力组织实际需要的下位能力。",
  ].join("\n\n");
  const committedRoute = await commitManagedTaskRouteDocumentCandidate({
    routeRevision: saved.routeRevision,
    topologyHash: saved.routeTopology.hash,
    candidate: { routeRevision: saved.routeRevision, topologyHash: saved.routeTopology.hash, document: routeDocument },
    model: { profileId: "test-profile", provider: "test", model: "test-model", agentEngine: "codex_api", adapter: "api" },
  });
  assert.equal(committedRoute.applied, true);
  assert.equal(committedRoute.routeDocument.current.status, "accepted");
  assert.equal(committedRoute.capabilityTemplate.history.template[0].dynamicRoute.status, "accepted");
  const activeRoute = await readManagedTaskRouteDocument();
  assert.equal(activeRoute.active, true);
  assert.equal(activeRoute.content, routeDocument);

  const restored = await restoreManagedCapabilityTemplateVersion({
    scopeType: "template",
    scopeId: saved.capabilityTemplate.current.template.id,
    versionId: saved.routeVersion.id,
  });
  assert.equal(restored.routingAudit.valid, true);
  assert.equal(restored.routeVersion.restoredFromRouteRevision, saved.routeRevision);
  assert.equal(restored.routeVersion.routeRevision, saved.routeRevision + 1);
  assert.equal(restored.capabilityTemplate.history.template[0].routeRevision, restored.routeRevision);
  const restoredRoute = await readManagedTaskRouteDocument();
  assert.equal(restoredRoute.active, true, "恢复历史面板时必须恢复对应动态路由");
  assert.equal(restoredRoute.content, routeDocument);
  assert.equal(restoredRoute.current.routeRevision, restored.routeRevision);

  const catalogBeforeToggle = await listManagedSkills();
  const slot = catalogBeforeToggle.customSlots[0];
  assert.ok(slot, "测试注册表必须包含预设自定义插槽");
  const toggled = await setManagedCustomSlotEnabled({ id: slot.id, enabled: false });
  const catalogAfterToggle = await listManagedSkills();
  const toggleRecord = catalogAfterToggle.capabilityTemplate.history.template[0];
  assert.equal(toggleRecord.routeRevision, toggled.routeRevision);
  assert.equal(toggleRecord.reason, "slot_disabled");
  assert.equal(toggleRecord.sourceScopeId, slot.id);

  const moduleScope = catalogAfterToggle.capabilityTemplate.current.modules[0];
  const moduleSaved = await saveManagedCapabilityTemplate({
    bundle: catalogAfterToggle.capabilityTemplate.current,
    scopeType: "module",
    scopeId: moduleScope.id,
  });
  assert.equal(moduleSaved.savedVersion.scopeType, "module");
  assert.equal(moduleSaved.routeVersion.scopeType, "template");
  assert.equal(moduleSaved.routeVersion.sourceScopeId, moduleScope.id);
  assert.equal(moduleSaved.routeVersion.routeRevision, moduleSaved.routeRevision);

  console.log("task route unified history runtime contracts passed");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
