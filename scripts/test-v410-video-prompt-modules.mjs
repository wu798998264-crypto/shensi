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
import { loadShensiContext } from "../src/server/shensi-context.mjs";
import { validateShensiBundlePaths } from "../src/server/bundled-shensi.mjs";

const root = fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url));
const manifestPath = fileURLToPath(new URL("../packaging/bundled/shensi-bundle-manifest.json", import.meta.url));
assert.equal(CAPABILITY_TEMPLATE_SCHEMA_VERSION, 31);

const template = createInitialCapabilityTemplate();
const prompt = template.modules.find((module) => module.id === "module:prompt-writer");
const video = template.modules.find((module) => module.id === "module:video-prompt-writer");
assert.ok(video);
assert.deepEqual(prompt.slots.map((slot) => slot.id), ["slot:visual-asset-prompt-writer", "slot:industrial-character-prompt-writer", "slot:guoman-scene-prompt-writer"]);
assert.equal(prompt.relationType, "organization");
assert.deepEqual(prompt.slots.map((slot) => slot.role), ["upper", "lower", "lower"]);
assert.equal(video.relationType, "parallel");
assert.deepEqual(video.slots.map((slot) => slot.id), ["slot:video-prompt-writer"]);
assert.equal(video.slots[0].name, "AI 视频导演（二）");
assert.deepEqual(video.slots.map((slot) => slot.role), ["peer"]);
for (const id of video.slots.map((slot) => slot.id)) {
  const slot = video.slots.find((item) => item.id === id);
  assert.equal(slot.fixedSlotId, "", `${id} 必须是可移除插槽`);
  assert.equal(slot.allowOfficialFallback, false);
}
assert.ok(video.slots.every((slot) => slot.triggerConditions.includes("document_prefix:prompt-video-")));

const legacy = structuredClone(template);
legacy.schemaVersion = 16;
const legacyPrompt = legacy.modules.find((module) => module.id === "module:prompt-writer");
legacyPrompt.slots = [
  legacyPrompt.slots[0],
  { id: "slot:visual-asset-prompt-writer:target", skillId: "builtin:visual-asset-prompt-writer", fixedSlotId: "builtin:visual-asset-prompt-writer", triggerConditions: ["document_prefix:prompt-visual-"], official: true },
  { id: "slot:visual-asset-prompt-writer:intent", skillId: "builtin:visual-asset-prompt-writer", fixedSlotId: "builtin:visual-asset-prompt-writer", triggerKeywords: ["图片资产"], official: true },
  { id: "slot:video-prompt-writer:target", skillId: "builtin:video-prompt-writer", fixedSlotId: "builtin:video-prompt-writer", triggerConditions: ["document_prefix:prompt-video-"], official: true },
  { id: "slot:video-prompt-writer:intent", skillId: "builtin:video-prompt-writer", fixedSlotId: "builtin:video-prompt-writer", triggerKeywords: ["视频提示词"], official: true },
];
const migrated = normalizeCapabilityTemplate(legacy);
assert.equal(migrated.modules.find((module) => module.id === "module:prompt-writer").slots.filter((slot) => slot.skillId === "builtin:visual-asset-prompt-writer").length, 1);
assert.equal(migrated.modules.find((module) => module.id === "module:prompt-writer").slots.some((slot) => slot.id.endsWith(":target") || slot.id.endsWith(":intent")), false);
assert.equal(migrated.modules.find((module) => module.id === "module:video-prompt-writers"), undefined);
const migratedVideo = migrated.modules.find((module) => module.id === "module:video-prompt-writer");
assert.ok(migratedVideo);
assert.equal(migratedVideo.relationType, "parallel");
assert.deepEqual(migratedVideo.slots.map((slot) => slot.skillId), ["builtin:video-prompt-writer"]);
assert.equal(migratedVideo.slots[0].name, "AI 视频导演（二）");
assert.equal(migrated.modules.find((module) => module.id === "module:prompt-writer").slots.some((slot) => slot.skillId === "builtin:video-prompt-writer"), false);
const renamedLegacy = structuredClone(template);
renamedLegacy.schemaVersion = 22;
const renamedLegacySlot = renamedLegacy.modules.find((module) => module.id === "module:video-prompt-writer").slots[0];
renamedLegacySlot.name = "ai导演（二）";
renamedLegacySlot.disabled = true;
const renamedMigration = normalizeCapabilityTemplate(renamedLegacy);
const renamedMigratedSlot = renamedMigration.modules.find((module) => module.id === "module:video-prompt-writer").slots[0];
assert.equal(renamedMigratedSlot.name, "AI 视频导演（二）");
assert.equal(renamedMigratedSlot.disabled, true, "名称迁移不得重置用户禁用状态");
const legacyDirectorTemplate = structuredClone(template);
legacyDirectorTemplate.schemaVersion = 24;
const legacyDirectorModule = legacyDirectorTemplate.modules.find((module) => module.id === "module:video-prompt-writer");
legacyDirectorModule.relationType = "primary-secondary";
legacyDirectorModule.slots.push({
  id: "slot:ai-video-director",
  name: "AI 视频导演",
  skillId: "builtin:ai-video-director",
  fixedSlotId: "",
  triggerKeywords: ["AI 视频导演", "Seedance 2.5"],
  disabled: false,
  official: true,
});
const migratedLegacyDirector = normalizeCapabilityTemplate(legacyDirectorTemplate)
  .modules.find((module) => module.id === "module:video-prompt-writer");
assert.equal(migratedLegacyDirector.relationType, "parallel");
assert.deepEqual(migratedLegacyDirector.slots.map((slot) => slot.skillId), ["builtin:video-prompt-writer"]);
assert.ok(migratedLegacyDirector.slots[0].triggerKeywords.includes("Seedance 2.5"));
const legacyCustom = structuredClone(template);
legacyCustom.schemaVersion = 20;
legacyCustom.modules = legacyCustom.modules.filter((module) => module.id !== "module:video-prompt-writer");
legacyCustom.modules.find((module) => module.id === "module:prompt-writer").slots.push({
  id: "slot:ai-video-director",
  name: "AI 视频导演",
  skillId: "user:custom-ai-director",
  fixedSlotId: "",
  triggerKeywords: ["AI视频导演"],
  disabled: true,
  official: true,
});
const migratedCustom = normalizeCapabilityTemplate(legacyCustom);
const migratedCustomDirector = migratedCustom.modules.find((module) => module.id === "module:prompt-writer").slots.find((slot) => slot.id === "slot:ai-video-director");
assert.equal(migratedCustomDirector.skillId, "user:custom-ai-director");
assert.equal(migratedCustomDirector.disabled, true);
assert.equal(migratedCustom.modules.find((module) => module.id === "module:video-prompt-writer").slots.some((slot) => slot.skillId === "builtin:ai-video-director"), false);
assert.equal(migrated.modules.find((module) => module.id === "module:adapted-drama-writer").slots.some((slot) => slot.skillId === "builtin:adapted-script-writer"), true);
assert.equal(migrated.modules.find((module) => module.id === "module:short-drama-review").slots.some((slot) => slot.skillId === "builtin:short-drama-review"), true);

const route = (text, extra = {}) => resolveCapabilityTemplateRouting(template, {
  text,
  workspaceMode: "project",
  contextDomain: "novel",
  deliverableType: "visual_prompt",
  requiredCapabilities: ["visual_prompt_writer"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
  ...extra,
});
const defaultVideoRoute = route("请将这段剧本转换成视频提示词", { targetDocumentId: "prompt-video-1" });
assert.deepEqual(defaultVideoRoute.activatedSelections.filter((selection) => ["builtin:prompt-writer", "builtin:video-prompt-writer"].includes(selection.id)).map((selection) => selection.id), ["builtin:video-prompt-writer"]);
assert.ok(route("请明确使用 ai导演（二）转换视频提示词", { targetDocumentId: "prompt-video-1" }).activatedSelections.some((selection) => selection.id === "builtin:video-prompt-writer"));
assert.ok(route("请明确使用 AI 视频导演（二）转换视频提示词", { targetDocumentId: "prompt-video-1" }).activatedSelections.some((selection) => selection.id === "builtin:video-prompt-writer"));
assert.equal(route("请明确使用视频提示词主笔转换", { targetDocumentId: "prompt-video-1" }).activatedSelections.some((selection) => selection.id === "builtin:prompt-writer"), false);
assert.ok(route("请用 AI 视频导演按 Seedance 2.5 规范处理这段动作", { targetDocumentId: "prompt-video-1" }).activatedSelections.some((selection) => selection.id === "builtin:video-prompt-writer"));
assert.ok(route("明确调用 AI 视频导演处理这段剧本", { targetDocumentId: "" }).activatedSelections.some((selection) => selection.id === "builtin:video-prompt-writer"));
assert.equal(route("请把这段描述转换成图片提示词", { targetDocumentId: "prompt-visual-1" }).activatedSelections.some((selection) => selection.id === "builtin:video-prompt-writer"), false);
const disabled = structuredClone(template);
disabled.modules.find((module) => module.id === "module:video-prompt-writer").slots.find((slot) => slot.id === "slot:video-prompt-writer").disabled = true;
assert.equal(resolveCapabilityTemplateRouting(disabled, {
  text: "请把剧本转成视频提示词",
  workspaceMode: "project",
  contextDomain: "novel",
  deliverableType: "visual_prompt",
  requiredCapabilities: ["visual_prompt_writer"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
  targetDocumentId: "prompt-video-1",
}).activatedSelections.some((selection) => selection.id === "builtin:video-prompt-writer"), false);
assert.ok(resolveCapabilityTemplateRouting(disabled, {
  text: "明确调用 AI 视频导演处理这段剧本",
  workspaceMode: "project",
  contextDomain: "novel",
  deliverableType: "visual_prompt",
  requiredCapabilities: ["visual_prompt_writer"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
}).activatedSelections.some((selection) => selection.id === "builtin:video-prompt-writer"));

await assert.rejects(
  loadOfficialSkill({ id: "builtin:ai-video-director", shensiRoot: root }),
  /官方 Skill 不存在/u,
  "旧版 AI 视频导演不得再通过兼容别名读取",
);
const defaultContext = await loadShensiContext({ shensiRoot: root, prompt: "请将这段剧本转换成视频提示词", routingText: "", activeModule: "manuscript", targetDocumentId: "prompt-video-1", stage: "visual-generation", contextDomain: "novel", workspaceKind: "project" });
assert.match(defaultContext.promptText, /视频导演二（30秒）/u, "默认视频转换必须读取 AI 视频导演（二）规则");
assert.doesNotMatch(defaultContext.promptText, /Seedance 2\.5 AI 视频导演/u, "默认视频转换不应混入次级 AI 视频导演规则");
const secondaryContext = await loadShensiContext({ shensiRoot: root, prompt: "请明确使用 AI 视频导演按 Seedance 2.5 生成视频提示词", routingText: "", activeModule: "manuscript", targetDocumentId: "prompt-video-1", stage: "visual-generation", contextDomain: "novel", workspaceKind: "project" });
assert.match(secondaryContext.promptText, /视频导演二（30秒）/u, "旧名称必须兼容映射到 AI 视频导演（二）规则");
assert.doesNotMatch(secondaryContext.promptText, /Seedance 2\.5 AI 视频导演/u, "旧 Skill 规则不得再被读取");
const renamedPrimaryContext = await loadShensiContext({ shensiRoot: root, prompt: "请明确使用 AI 视频导演（二）转换视频提示词", routingText: "", activeModule: "manuscript", targetDocumentId: "prompt-video-1", stage: "visual-generation", contextDomain: "novel", workspaceKind: "project" });
assert.doesNotMatch(renamedPrimaryContext.promptText, /Seedance 2\.5 AI 视频导演/u, "明确点名 AI 视频导演（二）时不应混入次级 Skill");
assert.match(renamedPrimaryContext.promptText, /视频导演二（30秒）/u, "明确点名 AI 视频导演（二）时必须读取主 Skill 规则");
const genericWriterContext = await loadShensiContext({ shensiRoot: root, prompt: "请明确使用提示词主笔转换为视频提示词", routingText: "", activeModule: "manuscript", targetDocumentId: "prompt-video-1", stage: "visual-generation", contextDomain: "novel", workspaceKind: "project" });
assert.match(genericWriterContext.promptText, /视频导演二（30秒）/u, "通用提示词主笔已退出视频模块，视频任务必须回到默认 AI 视频导演（二）");
assert.doesNotMatch(genericWriterContext.promptText, /Seedance 2\.5 AI 视频导演/u, "未明确点名 AI 视频导演时不应混入次级规则");
const imagePromptContext = await loadShensiContext({ shensiRoot: root, prompt: "请把这段描述转换成图片资产提示词", routingText: "", activeModule: "manuscript", targetDocumentId: "prompt-visual-1", stage: "visual-generation", contextDomain: "novel", workspaceKind: "project" });
assert.match(imagePromptContext.promptText, /# AI漫剧图片资产提示词skill/u, "图片提示词必须读取图片资产专项 Skill");
assert.doesNotMatch(imagePromptContext.promptText, /视频导演二（30秒）|Seedance 2\.5 AI 视频导演/u, "图片提示词不得混入任何视频提示词主笔规则");
const ordinaryPromptContext = await loadShensiContext({ shensiRoot: root, prompt: "请把这段要求整理成普通提示词", routingText: "", activeModule: "manuscript", targetDocumentId: "prompt-general-1", stage: "visual-generation", contextDomain: "novel", workspaceKind: "project" });
assert.doesNotMatch(ordinaryPromptContext.promptText, /视频导演二（30秒）|Seedance 2\.5 AI 视频导演|# AI漫剧图片资产提示词skill/u, "普通提示词不得误读视频或图片专项 Skill");
const manifest = await validateShensiBundlePaths({ bundleRoot: root, manifestPath });
assert.equal(manifest.verified, true);

console.log("v5.3.0 single AI 视频导演（二） video prompt Skill checks passed");
