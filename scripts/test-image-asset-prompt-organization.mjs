import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_TEMPLATE_SCHEMA_VERSION,
  createInitialCapabilityTemplate,
  normalizeCapabilityTemplate,
  resolveCapabilityTemplateRouting,
} from "../src/capability-template.js";
import { FIXED_SKILL_SLOT_CATALOG } from "../src/module-registry.js";
import { classifyRequestMode } from "../src/request-routing.js";
import { loadOfficialSkill } from "../src/server/skill-store.mjs";
import { loadShensiContext } from "../src/server/shensi-context.mjs";

const shensiRoot = fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url));
const relevantIds = new Set([
  "builtin:visual-asset-prompt-writer",
  "builtin:industrial-character-prompt-writer",
  "builtin:guoman-scene-prompt-writer",
  "builtin:panorama-prompt-writer",
]);

assert.equal(CAPABILITY_TEMPLATE_SCHEMA_VERSION, 31);
const template = createInitialCapabilityTemplate();
const promptModule = template.modules.find((module) => module.id === "module:prompt-writer");
const panoramaModule = template.modules.find((module) => module.id === "module:prompt-panorama-writer");
const promptWriters = template.groups.find((group) => group.id === "group:prompt-writers");
const promptGroup = template.groups.find((group) => group.id === "group:prompt-engineering");
assert.equal(promptWriters.name, "提示词主笔模组");
assert.equal(promptWriters.relationType, "parallel");
assert.deepEqual(promptWriters.items.map((item) => item.targetId), ["module:prompt-writer", "module:prompt-panorama-writer"]);
assert.equal(promptModule.name, "AI 漫剧图片资产提示词模块");
assert.equal(promptModule.relationType, "organization");
assert.deepEqual(promptModule.slots.map((slot) => slot.skillId), [
  "builtin:visual-asset-prompt-writer",
  "builtin:industrial-character-prompt-writer",
  "builtin:guoman-scene-prompt-writer",
]);
assert.deepEqual(promptModule.slots.map((slot) => slot.role), ["upper", "lower", "lower"]);
assert.equal(panoramaModule.name, "辅助功能提示词模块");
assert.equal(panoramaModule.relationType, "parallel");
assert.deepEqual(panoramaModule.slots.map((slot) => slot.skillId), ["builtin:panorama-prompt-writer"]);
assert.ok(promptGroup.items.some((item) => item.targetType === "group" && item.targetId === "group:prompt-writers"));

const legacy = structuredClone(template);
legacy.schemaVersion = 25;
legacy.modules = legacy.modules.filter((module) => module.id !== "module:prompt-panorama-writer");
legacy.groups = legacy.groups.filter((group) => group.id !== "group:prompt-writers");
legacy.groups.find((group) => group.id === "group:prompt-engineering").items = legacy.groups
  .find((group) => group.id === "group:prompt-engineering").items
  .filter((item) => item.targetId !== "group:prompt-writers")
  .concat([
    { id: "legacy:prompt-writer", targetType: "module", targetId: "module:prompt-writer", role: "peer" },
    { id: "legacy:panorama-writer", targetType: "module", targetId: "module:prompt-panorama-writer", role: "peer" },
  ]);
const legacyPrompt = legacy.modules.find((module) => module.id === "module:prompt-writer");
legacyPrompt.relationType = "parallel";
legacyPrompt.slots = [
  { ...legacyPrompt.slots[0], disabled: true, skillId: "user:custom-visual-extractor" },
  {
    id: "slot:user-kept-order",
    name: "用户自定义提示词",
    skillId: "user:custom-prompt",
    fixedSlotId: "",
    disabled: true,
    official: false,
  },
  {
    id: "slot:panorama-prompt-writer",
    name: "多人物场景站位线稿图",
    skillId: "builtin:panorama-prompt-writer",
    fixedSlotId: "builtin:panorama-prompt-writer",
    disabled: true,
    official: true,
  },
];
const migrated = normalizeCapabilityTemplate(legacy);
const migratedPrompt = migrated.modules.find((module) => module.id === "module:prompt-writer");
const migratedPanorama = migrated.modules.find((module) => module.id === "module:prompt-panorama-writer");
const migratedPromptWriters = migrated.groups.find((group) => group.id === "group:prompt-writers");
assert.equal(migratedPrompt.relationType, "organization");
assert.equal(migratedPrompt.slots[0].skillId, "user:custom-visual-extractor", "上位插槽的用户绑定必须保留");
assert.equal(migratedPrompt.slots[0].disabled, true, "上位插槽的禁用状态必须保留");
assert.deepEqual(migratedPrompt.slots.slice(0, 3).map((slot) => slot.role), ["upper", "lower", "lower"]);
assert.equal(migratedPrompt.slots.at(-1).id, "slot:user-kept-order", "用户自定义插槽必须保留且相对顺序稳定");
assert.equal(migratedPrompt.slots.at(-1).disabled, true);
assert.equal(migratedPanorama.slots[0].disabled, true, "迁出的多人站位 Skill 状态必须保留");
assert.deepEqual(migratedPromptWriters.items.map((item) => item.targetId), ["module:prompt-writer", "module:prompt-panorama-writer"]);
assert.ok(migrated.groups.find((group) => group.id === "group:prompt-engineering").items
  .some((item) => item.targetType === "group" && item.targetId === "group:prompt-writers"));

const route = (text, targetDocumentId = "prompt-visual-assets") => resolveCapabilityTemplateRouting(template, {
  text,
  workspaceMode: "project",
  contextDomain: "script",
  deliverableType: "visual_prompt",
  targetDocumentId,
  requiredCapabilities: ["visual_prompt_writer"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
const routed = (text, targetDocumentId) => route(text, targetDocumentId).activatedSelections
  .map((selection) => selection.id)
  .filter((id) => relevantIds.has(id));

assert.deepEqual(routed("设计一个白发少女的角色提示词"), ["builtin:industrial-character-prompt-writer"]);
assert.deepEqual(routed("设计一个国漫人物"), ["builtin:industrial-character-prompt-writer"]);
assert.deepEqual(routed("生成一条荒废地铁站的场景提示词"), ["builtin:guoman-scene-prompt-writer"]);
assert.deepEqual(routed("设计一个废弃车站场景"), ["builtin:guoman-scene-prompt-writer"]);
const extractedCharacterRoute = route("从这段小说中提取人物并生成角色提示词");
assert.deepEqual(extractedCharacterRoute.activatedSelections.map((selection) => selection.id).filter((id) => relevantIds.has(id)), ["builtin:visual-asset-prompt-writer", "builtin:industrial-character-prompt-writer"]);
assert.equal(extractedCharacterRoute.compiledCapabilityPlan.budgets.used.writer, 1, "同一组织中的上位提取与下位输出应共享一份主笔预算");
assert.deepEqual(routed("根据剧本提取地点并生成场景提示词"), ["builtin:visual-asset-prompt-writer", "builtin:guoman-scene-prompt-writer"]);
assert.deepEqual(routed("从整段剧本中提取并生成图片资产总表"), ["builtin:visual-asset-prompt-writer", "builtin:industrial-character-prompt-writer", "builtin:guoman-scene-prompt-writer"]);
assert.deepEqual(routed("为青铜神剑生成道具图片提示词"), ["builtin:visual-asset-prompt-writer"]);
assert.deepEqual(routed("为科幻载具生成图片资产提示词"), ["builtin:visual-asset-prompt-writer"]);
assert.deepEqual(routed("生成多人站位线稿图", "prompt-panorama-1"), ["builtin:panorama-prompt-writer"]);

const videoPromptAssetExtraction = `
提示词一

[画面质感]
冷峻现实主义的现代都市异变质感，电影级细节与空间纵深。

[光照效果]
白天滨海自然光，环境光瞬间压暗后恢复。

[画面内容]
分镜一：滨海商场广场保持日常秩序，路人牵着宠物小狗，海鸥在上空活动。
分镜二：宠物小狗和海鸥发生异变，路人惊恐后退。

提取以上视频提示词中的图片资产提示词，要高精3d建模效果，ue5渲染。
`;
const extractedVideoAssetsRoute = resolveCapabilityTemplateRouting(template, {
  text: videoPromptAssetExtraction,
  workspaceMode: "project",
  contextDomain: "script",
  deliverableType: "visual_prompt",
  targetDocumentId: "",
  requiredCapabilities: ["visual_prompt_writer"],
  fixedSlots: FIXED_SKILL_SLOT_CATALOG,
});
assert.equal(classifyRequestMode({ text: videoPromptAssetExtraction, workspaceKind: "project" }).mode, "visual_prompt");
assert.deepEqual(extractedVideoAssetsRoute.activatedSelections.map((selection) => selection.id).filter((id) => [
  "builtin:visual-asset-prompt-writer",
  "builtin:industrial-character-prompt-writer",
  "builtin:guoman-scene-prompt-writer",
  "builtin:video-prompt-writer",
].includes(id)), [
  "builtin:visual-asset-prompt-writer",
  "builtin:industrial-character-prompt-writer",
  "builtin:guoman-scene-prompt-writer",
]);

const [characterSkill, sceneSkill] = await Promise.all([
  loadOfficialSkill({ id: "builtin:industrial-character-prompt-writer", shensiRoot }),
  loadOfficialSkill({ id: "builtin:guoman-scene-prompt-writer", shensiRoot }),
]);
assert.match(characterSkill.content, /# 工业角色提示词/u);
assert.match(characterSkill.content, /百分之三十四、二十二、二十二、二十二/u);
assert.match(sceneSkill.content, /# 三维国漫场景提示词/u);
assert.match(sceneSkill.content, /完整三维几何建模/u);

const contextFor = (prompt, targetDocumentId = "prompt-visual-assets") => loadShensiContext({
  shensiRoot,
  prompt,
  routingText: "",
  activeModule: "manuscript",
  targetDocumentId,
  stage: "visual-generation",
  contextDomain: "script",
  workspaceKind: "project",
});
const directCharacter = await contextFor("设计一个白发少女的角色提示词");
assert.match(directCharacter.promptText, /# 工业角色提示词/u);
assert.doesNotMatch(directCharacter.promptText, /# AI漫剧图片资产提示词skill/u);
const directScene = await contextFor("生成一条荒废地铁站的场景提示词");
assert.match(directScene.promptText, /# 三维国漫场景提示词/u);
assert.doesNotMatch(directScene.promptText, /# AI漫剧图片资产提示词skill/u);
const extractedCharacter = await contextFor("从这段小说中提取人物并生成角色提示词");
assert.match(extractedCharacter.promptText, /# AI漫剧图片资产提示词skill/u);
assert.match(extractedCharacter.promptText, /# 工业角色提示词/u);
const extractedScene = await contextFor("根据剧本提取地点并生成场景提示词");
assert.match(extractedScene.promptText, /# AI漫剧图片资产提示词skill/u);
assert.match(extractedScene.promptText, /# 三维国漫场景提示词/u);
const extractedVideoAssets = await contextFor(videoPromptAssetExtraction, "");
assert.match(extractedVideoAssets.promptText, /# AI漫剧图片资产提示词skill/u);
assert.match(extractedVideoAssets.promptText, /# 工业角色提示词/u);
assert.match(extractedVideoAssets.promptText, /# 三维国漫场景提示词/u);
assert.doesNotMatch(extractedVideoAssets.promptText, /视频导演二（30秒）/u);
const genuineVideoPrompt = await contextFor("根据这段剧本生成 8 秒视频提示词", "prompt-video-1");
assert.match(genuineVideoPrompt.promptText, /视频导演二（30秒）/u);
assert.doesNotMatch(genuineVideoPrompt.promptText, /# AI漫剧图片资产提示词skill|# 工业角色提示词|# 三维国漫场景提示词/u);
const panorama = await contextFor("生成多人站位线稿图", "prompt-panorama-1");
assert.match(panorama.promptText, /多人物场景站位线稿图/u);
assert.doesNotMatch(panorama.promptText, /# 三维国漫场景提示词|# 工业角色提示词/u);

console.log("Image asset prompt organization checks passed");
