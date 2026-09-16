import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  createInitialCapabilityTemplate,
  normalizeCapabilityTemplate,
  resolveCapabilityTemplateRouting,
} from "../src/capability-template.js";
import { FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";
import { loadOfficialSkill } from "../src/server/skill-store.mjs";
import { loadSelectedSkills } from "../src/server/skill-library.mjs";
import { validateShensiBundlePaths } from "../src/server/bundled-shensi.mjs";

const bundledRoot = fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url));
const sourcePaths = {
  reconstructor: "短剧生产链/短剧视频逆推剧本/SKILL.md",
  adaptation: "短剧生产链/短剧结构对位改编/SKILL.md",
  enhancer: "短剧生产链/短剧精髓保真与爆点增强/SKILL.md",
};

assert.equal(CAPABILITY_TEMPLATE_SCHEMA_VERSION, 30);
for (const relativePath of Object.values(sourcePaths)) {
  const content = await readFile(`${bundledRoot}${relativePath}`, "utf8");
  assert.match(content, /^---\s*\nname:/u, `${relativePath} 必须保留 Skill 元数据`);
  assert.ok(content.length > 1_000, `${relativePath} 必须随包保存完整正文`);
}

const fixedById = new Map(FIXED_SKILL_SLOT_CATALOG.map((slot) => [slot.id, slot]));
assert.equal(fixedById.get("builtin:short-drama-script-reconstructor")?.bundledSource, sourcePaths.reconstructor);
assert.equal(fixedById.get("builtin:adapted-script-writer")?.bundledSource, sourcePaths.adaptation);
assert.equal(fixedById.get("builtin:short-drama-review")?.bundledSource, sourcePaths.enhancer);

const template = createInitialCapabilityTemplate();
const auxiliary = template.modules.find((module) => module.id === "module:auxiliary-skills");
assert.ok(auxiliary?.slots.some((slot) => slot.skillId === "builtin:short-drama-script-reconstructor"), "逆推 Skill 必须进入辅助能力模块");
assert.equal(template.modules.find((module) => module.id === "module:adapted-drama-writer")?.slots[0]?.skillId, "builtin:adapted-script-writer");
assert.equal(template.modules.find((module) => module.id === "module:short-drama-review")?.slots[0]?.skillId, "builtin:short-drama-review");

const legacy = structuredClone(template);
legacy.schemaVersion = 15;
legacy.modules.find((module) => module.id === "module:auxiliary-skills").slots = auxiliary.slots
  .filter((slot) => slot.skillId !== "builtin:short-drama-script-reconstructor");
const migrated = normalizeCapabilityTemplate(legacy);
assert.ok(migrated.modules.find((module) => module.id === "module:auxiliary-skills")?.slots.some((slot) => slot.skillId === "builtin:short-drama-script-reconstructor"), "旧面板迁移必须补入逆推 Skill");

const missingShortDramaSkills = structuredClone(template);
missingShortDramaSkills.schemaVersion = 18;
for (const moduleId of ["module:auxiliary-skills", "module:adapted-drama-writer", "module:short-drama-review"]) {
  const module = missingShortDramaSkills.modules.find((candidate) => candidate.id === moduleId);
  module.slots = module.slots.filter((slot) => !String(slot.skillId).includes("short-drama") && slot.skillId !== "builtin:adapted-script-writer");
}
const restored = normalizeCapabilityTemplate(missingShortDramaSkills);
assert.ok(restored.modules.find((module) => module.id === "module:auxiliary-skills")?.slots.some((slot) => slot.skillId === "builtin:short-drama-script-reconstructor"), "迁移必须补入逆推 Skill");
assert.ok(restored.modules.find((module) => module.id === "module:adapted-drama-writer")?.slots.some((slot) => slot.skillId === "builtin:adapted-script-writer"), "迁移必须补入结构对位改编 Skill");
assert.ok(restored.modules.find((module) => module.id === "module:short-drama-review")?.slots.some((slot) => slot.skillId === "builtin:short-drama-review"), "迁移必须补入精髓保真自检 Skill");

const routeCases = [
  {
    text: "请把这个短剧视频逆推成重构剧本",
    contextDomain: "script",
    requiredCapabilities: ["auxiliary_advisor"],
    skillId: "builtin:short-drama-script-reconstructor",
  },
  {
    text: "请将小说做剧情功能结构对位改编",
    contextDomain: "script-adaptation",
    requiredCapabilities: ["adaptation_writer"],
    skillId: "builtin:adapted-script-writer",
  },
  {
    text: "请做短剧精髓保真和爆点增强自检",
    contextDomain: "script",
    requiredCapabilities: ["effect_reviewer"],
    skillId: "builtin:short-drama-review",
  },
];
for (const testCase of routeCases) {
  for (const workspaceMode of ["project", "notebook"]) {
    const routed = resolveCapabilityTemplateRouting(template, {
      text: testCase.text,
      workspaceMode,
      contextDomain: testCase.contextDomain,
      deliverableType: "short_drama_script",
      requiredCapabilities: testCase.requiredCapabilities,
      fixedSlots: FIXED_SKILL_SLOT_CATALOG,
    });
    assert.ok(routed.activatedSelections.some((selection) => selection.id === testCase.skillId), `${testCase.skillId} 必须在 ${workspaceMode} 按文体路由命中`);
    const loaded = await loadSelectedSkills(routed.activatedSelections, { shensiRoot: bundledRoot });
    assert.ok(loaded.some((skill) => skill.id === testCase.skillId && skill.fullText === true), `${testCase.skillId} 在 ${workspaceMode} 路由后必须加载完整正文`);
  }
}

for (const id of [
  "builtin:short-drama-script-reconstructor",
  "builtin:adapted-script-writer",
  "builtin:short-drama-review",
]) {
  const loaded = await loadOfficialSkill({ id, shensiRoot: bundledRoot });
  assert.equal(loaded.testStatus, "passed");
  assert.ok(loaded.contentHash && loaded.content.length > 1_000, `${id} 必须加载完整 Skill 内容`);
  assert.match(loaded.sourcePath, /短剧生产链/u);
}

const manifest = await validateShensiBundlePaths({
  bundleRoot: bundledRoot,
  manifestPath: fileURLToPath(new URL("../packaging/bundled/shensi-bundle-manifest.json", import.meta.url)),
});
assert.equal(manifest.verified, true, "内置能力包清单必须覆盖新增 Skill 文件");

console.log("v4.0.0 short-drama Skill template registration passed");
