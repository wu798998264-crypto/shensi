import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-route-history-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

try {
  const {
    listManagedSkills,
    restoreManagedCapabilityTemplateVersion,
    saveManagedCapabilityTemplate,
    setManagedCustomSlotEnabled,
  } = await import("../src/server/skill-store.mjs");

  const initial = await listManagedSkills({ shensiRoot: join(process.cwd(), "packaging", "bundled", "skill", "神思") });
  assert.match(initial.routeBundle.panel.text, /# 面板路由/u);
  assert.match(initial.capabilityTemplate.history.template[0].routeDocument, /# 面板路由/u, "初始面板历史必须有可恢复的详细路由文档");
  assert.ok(initial.routeBundle.routes.some((route) => route.kind === "group"), "默认面板必须生成模组路由");
  assert.ok(initial.routeBundle.routes.some((route) => route.kind === "module"), "默认面板必须生成模块路由");
  const initialGroup = initial.capabilityTemplate.current.groups[0];
  const initialModule = initial.capabilityTemplate.current.modules[0];
  assert.match(initial.capabilityTemplate.history.groups[initialGroup.id][0].routeDocument, /# 模组路由/u, "初始模组历史必须有可恢复的详细路由文档");
  assert.match(initial.capabilityTemplate.history.modules[initialModule.id][0].routeDocument, /# 模块路由/u, "初始模块历史必须有可恢复的详细路由文档");
  assert.ok(initial.routeBundle.skillPlacements.length >= 20, "默认面板中启用的 Skill 必须生成真实位置目录");
  const availableSkillIds = new Set([...initial.builtins, ...initial.user].flatMap((skill) => {
    const id = String(skill.id || "");
    const plain = id.replace(/^user:/u, "");
    return [id, plain, `user:${plain}`];
  }));
  const missingPlacementSkills = initial.routeBundle.skillPlacements.filter((placement) => placement.enabled && !availableSkillIds.has(placement.skillId)).map((placement) => placement.skillId);
  assert.deepEqual(missingPlacementSkills, [], `每个启用位置都必须绑定可真实读取的 Skill：${missingPlacementSkills.join("、")}`);
  const imageCharacterPlacement = initial.routeBundle.skillPlacements.find((placement) => placement.skillId === "builtin:industrial-character-prompt-writer");
  assert.ok(imageCharacterPlacement, "默认图片资产模块必须保留角色专项下位 Skill");
  assert.deepEqual(imageCharacterPlacement.organizationUpperPlacementIds.map((id) => initial.routeBundle.skillPlacements.find((placement) => placement.placementId === id)?.skillId), ["builtin:visual-asset-prompt-writer"], "图片资产专项默认必须加载兼具通用主笔和提取主笔职责的上位 Skill");
  const saved = await saveManagedCapabilityTemplate({
    bundle: initial.capabilityTemplate.current,
    scopeType: "template",
    scopeId: initial.capabilityTemplate.current.template.id,
  });
  assert.equal(saved.routeVersion.routeRevision, saved.routeRevision);
  assert.equal(saved.routeVersion.version, saved.savedVersion.version);
  assert.match(saved.routeVersion.topologyHash, /^[a-f0-9]{64}$/u);
  assert.match(saved.routeVersion.routeDocument, /# 面板路由/u);
  assert.doesNotMatch(saved.routeVersion.routeDocument, /## 模块路由/u, "面板历史只能内含顶层面板路由");
  assert.equal(saved.routeVersion.routingAudit.valid, true);
  assert.ok(Array.isArray(saved.routeVersion.routeDiff.summary));
  assert.equal(saved.capabilityTemplate.history.template[0].routeRevision, saved.routeRevision);

  const restored = await restoreManagedCapabilityTemplateVersion({
    scopeType: "template",
    scopeId: saved.capabilityTemplate.current.template.id,
    versionId: saved.routeVersion.id,
  });
  assert.equal(restored.routingAudit.valid, true);
  assert.equal(restored.routeVersion.restoredFromRouteRevision, saved.routeRevision);
  assert.equal(restored.routeVersion.routeRevision, saved.routeRevision + 1);
  assert.equal(restored.capabilityTemplate.history.template[0].routeRevision, restored.routeRevision);

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
  assert.equal(moduleSaved.savedVersion.routeRevision, moduleSaved.routeRevision, "模块结构历史必须绑定同次路由版本");
  assert.match(moduleSaved.savedVersion.routeDocument, /# 模块路由/u, "模块历史必须内含对应模块路由");
  assert.doesNotMatch(moduleSaved.savedVersion.routeDocument, /# 面板路由/u, "模块历史不应复制无关面板路由");
  const moduleRestored = await restoreManagedCapabilityTemplateVersion({
    scopeType: "module",
    scopeId: moduleScope.id,
    versionId: moduleSaved.savedVersion.id,
  });
  assert.equal(moduleRestored.restoredVersion.routeRevision, moduleRestored.routeRevision, "恢复模块时必须建立新的模块—路由联合版本");
  assert.match(moduleRestored.restoredVersion.routeDocument, /# 模块路由/u);

  console.log("task route unified history runtime contracts passed");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
