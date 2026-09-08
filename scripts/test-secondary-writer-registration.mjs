import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BUILTIN_SKILL_CATALOG, FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";
import { createInitialCapabilityTemplate, normalizeCapabilityTemplate } from "../src/capability-template.js";
import { fixedSlotSelectionForPrompt } from "../src/fixed-slot-bindings.js";
import { loadOfficialSkill } from "../src/server/skill-store.mjs";
import { generationAttemptCandidateVariants } from "../src/server/generation-attempt-store.mjs";

const novelSlot = FIXED_SKILL_SLOT_CATALOG.find((slot) => slot.id === "builtin:novel-writer");
const prototype = BUILTIN_SKILL_CATALOG.find((slot) => slot.id === "builtin:chinese-novelist-skill");
assert.ok(novelSlot, "正文主笔固定插槽必须存在");
assert.ok(prototype, "小说原型设计必须注册为备用主笔");
assert.equal(prototype.parentGroupId, "");
assert.deepEqual(prototype.replacementCapabilities, ["novel_prose_writer"]);
assert.equal(prototype.bundledSource, "小说写作技能skill/02-chinese-novelist-skill/SKILL.md");
assert.ok((novelSlot.secondarySkillIds ?? []).includes("builtin:chinese-novelist-skill"));

const capabilityTemplate = createInitialCapabilityTemplate();
const writerModule = capabilityTemplate.modules.find((module) => module.id === "module:novel-writer");
assert.ok(writerModule, "能力面板必须包含小说主笔模块");
assert.equal(writerModule.relationType, "primary-secondary", "主笔模组必须沿用主次关系");
assert.deepEqual(
  writerModule.slots.map((slot) => ({ skillId: slot.skillId, role: slot.role })),
  [
    { skillId: "builtin:novel-writer", role: "primary" },
    { skillId: "builtin:chinese-novelist-skill", role: "secondary" },
  ],
  "能力面板必须同时展示主要主笔与备用主笔",
);
const legacyCapabilityTemplate = structuredClone(capabilityTemplate);
legacyCapabilityTemplate.schemaVersion = 14;
const legacyWriterModule = legacyCapabilityTemplate.modules.find((module) => module.id === "module:novel-writer");
legacyWriterModule.slots = legacyWriterModule.slots.filter((slot) => slot.skillId !== "builtin:chinese-novelist-skill");
const migratedCapabilityTemplate = normalizeCapabilityTemplate(legacyCapabilityTemplate);
assert.ok(
  migratedCapabilityTemplate.modules.find((module) => module.id === "module:novel-writer")
    ?.slots.some((slot) => slot.skillId === "builtin:chinese-novelist-skill" && slot.role === "secondary"),
  "已有能力面板必须在内存升级后显示备用主笔，且不需要重写用户配置",
);

const selection = fixedSlotSelectionForPrompt({
  settings: {},
  slot: { ...novelSlot, slotType: "multi" },
  text: "使用小说正文主笔的备用插槽一来写",
});
assert.equal(selection.skillId, "builtin:chinese-novelist-skill");
assert.equal(selection.bindingRole, "secondary");

const loaded = await loadOfficialSkill({
  id: prototype.id,
  shensiRoot: fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url)),
});
assert.match(loaded.content, /自包含主流程/u, "备用主笔必须读取真实 SKILL 全文而不是只有目录或说明");
assert.ok(loaded.content.length > 1000, "备用主笔正文必须完整加载");
assert.ok(loaded.contentHash, "备用主笔必须携带完整 Skill 内容哈希");
assert.match(loaded.sourcePath, /02-chinese-novelist-skill[\\/]SKILL\.md$/u, "备用主笔必须携带真实来源路径");
assert.equal(loaded.testStatus, "passed", "官方备用主笔必须通过受信来源门禁");

const variants = generationAttemptCandidateVariants({
  adoptedCandidate: "候选甲正文",
  landingEligible: true,
  candidates: [
    { text: "候选甲正文", stage: "creative", index: 0, writerId: "builtin:novel-writer", writerName: "小说正文主笔" },
    { text: "候选乙正文", stage: "creative", index: 1, writerId: prototype.id, writerName: prototype.name },
  ],
});
assert.equal(variants.find((item) => item.text === "候选乙正文")?.writerId, prototype.id);

assert.equal(FIXED_SKILL_SLOT_CATALOG.some((slot) => slot.id === prototype.id), false, "备用主笔不能成为第二个默认固定插槽");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /skillCatalog\.fixedSlots[\s\S]{0,100}skillCatalog\.builtins/u, "候选主笔列表必须从完整 Skill 目录暴露备用主笔");
assert.match(app, /skillCatalog\.fixedSlots[\s\S]{0,100}skillCatalog\.builtins/u, "能力面板必须从完整内置目录识别备用主笔");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(server, /candidateWriterRuntimes/u, "服务端必须为每位候选主笔建立真实运行时");
const orchestrator = await readFile(new URL("../src/server/shensi-orchestrator.mjs", import.meta.url), "utf8");
assert.match(orchestrator, /skillRuntimeOverride/u, "候选循环必须按候选主笔覆盖创作阶段 Skill 运行时");

console.log("secondary writer registration regressions passed");
