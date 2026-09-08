import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const app = await readFile(resolve("src/app.js"), "utf8");
const server = await readFile(resolve("server.mjs"), "utf8");

assert.doesNotMatch(app, /media-(?:compiler-runtime|skill-routing)\.js/u);
assert.doesNotMatch(server, /media-skill-routing\.js/u);
assert.doesNotMatch(app, /automatic(?:VisualAsset|NovelCover)SkillSelections|mediaPromptCompilerRuntime/u);

const whiteboardStart = app.indexOf("const buildWhiteboardMediaProviderPrompt = async");
const whiteboardEnd = app.indexOf("const whiteboardResolvedAspectRatio", whiteboardStart);
assert.ok(whiteboardStart >= 0 && whiteboardEnd > whiteboardStart, "白板媒体提交必须具有独立的本地提示词准备边界");
const whiteboardSource = app.slice(whiteboardStart, whiteboardEnd);
assert.doesNotMatch(whiteboardSource, /requestModelReply|selectedSkills|skill-route|executionSurface|settingsOverride/u);
assert.match(whiteboardSource, /whiteboardMediaPrompt\([\s\S]{0,500}sanitizeMediaProviderPrompt/u);
assert.match(whiteboardSource, /referenceTokens:\s*providerReferenceTokens/u);

const composerStart = app.indexOf("const composerMediaSubmissionPlan = async");
const composerEnd = app.indexOf("const runConversationMediaPreparations", composerStart);
assert.ok(composerStart >= 0 && composerEnd > composerStart, "对话区媒体提交必须具有独立的本地准备边界");
const composerSource = app.slice(composerStart, composerEnd);
assert.doesNotMatch(composerSource, /requestModelReply|selectedSkills|skill-route|executionSurface|settingsOverride/u);
assert.match(composerSource, /appliedSkills:\s*\[\]/u);
assert.match(composerSource, /new Map\(planned\.map/u);

assert.match(app, /const whiteboardGenerationUsesMediaModel[\s\S]{0,450}nodes\.filter\(\(node\) => !\["skill", "capability"\]\.includes/u);
assert.match(app, /openWhiteboardLinkDialog\(targetNodeId,[\s\S]{0,180}mediaOnly:\s*whiteboardGenerationUsesMediaModel\(form\)/u);
assert.match(app, /const mediaAttachmentsFor[\s\S]{0,220}filter\(\(node\) => !\["skill", "capability"\]\.includes\(node\?\.reference\?\.type\)\)/u);

const composerMediaStart = app.indexOf("const generateMediaFromComposer = async");
const composerMediaEnd = app.indexOf("const generateImageFromComposer", composerMediaStart);
assert.ok(composerMediaStart >= 0 && composerMediaEnd > composerMediaStart, "对话区媒体提交边界必须存在");
const composerMediaSource = app.slice(composerMediaStart, composerMediaEnd);
assert.doesNotMatch(composerMediaSource, /skillReferences\s*=/u);
assert.doesNotMatch(composerMediaSource, /已调用 Skill|execution\.skillNames/u);
assert.match(composerMediaSource, /skillReferences:\s*\[\]/u);

const mediaGuard = server.indexOf('if (["image", "video"].includes(mediaChannel))');
const normalRoute = server.indexOf("const route = planWhiteboardSkillRoute", mediaGuard);
assert.ok(mediaGuard >= 0 && normalRoute > mediaGuard, "服务端必须先阻断媒体 Skill 路由，再进入普通文字 Skill 路由");
const mediaGuardSource = server.slice(mediaGuard, normalRoute);
assert.match(mediaGuardSource, /selections:\s*\[\]/u);
assert.match(mediaGuardSource, /不调用神思文字 Skill/u);

console.log("图片和视频生成与神思文字 Skill 隔离测试通过");
