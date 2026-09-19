import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  isExplicitCrossFormatInstruction,
  resolveCrossFormatContentRoute,
} from "../src/cross-format-content-router.js";
import {
  getDynamicAttachmentLimit,
  validateConversationAttachments,
} from "../src/conversation-attachment-intake.js";
import {
  createInitialCapabilityTemplate,
  normalizeCapabilityTemplate,
  resolveCapabilityTemplateRouting,
} from "../src/capability-template.js";
import { defaultAppDataRoot } from "../src/server/app-data.mjs";

const text = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [app, css, server, workspaceSource, modelPresets, externalMarkdown, appData, imageEditor, packageJsonSource, installer, packageScript] = await Promise.all([
  text("src/app.js"),
  text("src/styles.css"),
  text("server.mjs"),
  text("src/server/workspace.mjs"),
  text("src/model-presets.js"),
  text("src/server/external-markdown.mjs"),
  text("src/server/app-data.mjs"),
  text("src/image-card-editor.js"),
  text("package.json"),
  text("packaging/windows/desktop-app/installer-custom.nsh"),
  text("scripts/windows/package-windows.ps1"),
]);

const packageJson = JSON.parse(packageJsonSource);
assert.match(packageJson.version, /^\d+\.\d+\.\d+$/u);
assert.match(packageJson.build.artifactName, /\$\{version\}.*\$\{env\.SHENSI_BUILD_ID\}/u);

// Cross-workspace / cross-format routing keeps Source and Target separate.
const huanjin = [
  { id: "chapter-1", title: "第一章", contextDomain: "novel", projectName: "幻烬", html: "<p>女主第一次出现。</p>" },
  { id: "chapter-2", title: "第二章", contextDomain: "novel", projectName: "幻烬", html: "<p>第二章。</p>" },
];
assert.equal(isExplicitCrossFormatInstruction("将《幻烬》第一章小说改编为剧本。"), true);
const adaptation = resolveCrossFormatContentRoute({
  instruction: "将《幻烬》第一章小说改编为剧本。",
  documents: huanjin,
  projectName: "幻烬",
});
assert.equal(adaptation.sourceDocumentId, "chapter-1");
assert.equal(adaptation.targetContentType, "script");
assert.notEqual(adaptation.targetDocumentId, adaptation.sourceDocumentId);
assert.equal(adaptation.create.viewId, "script");
assert.match(adaptation.targetTitle, /幻烬.*第一集.*剧本/u);

const linkedAdaptation = resolveCrossFormatContentRoute({
  instruction: "将其改编为剧本。",
  documents: huanjin,
  associatedDocumentId: "chapter-1",
  projectName: "幻烬",
});
assert.equal(linkedAdaptation.sourceDocumentId, "chapter-1");
assert.equal(linkedAdaptation.create.viewId, "script");

const novelPrompt = resolveCrossFormatContentRoute({
  instruction: "根据这一章生成完整的 Seedance 视频提示词。",
  documents: huanjin,
  associatedDocumentId: "chapter-1",
  projectName: "幻烬",
});
assert.equal(novelPrompt.targetContentType, "prompt");
assert.equal(novelPrompt.create.viewId, "prompts");

const withScript = [...huanjin, { id: "script-episode-1", title: "第一集剧本", contextDomain: "script", projectName: "幻烬" }];
const reverse = resolveCrossFormatContentRoute({
  instruction: "把它改写为小说第一章的新版本。",
  documents: withScript,
  associatedDocumentId: "script-episode-1",
  projectName: "幻烬",
});
assert.equal(reverse.sourceDocumentId, "script-episode-1");
assert.equal(reverse.targetDocumentId, "chapter-1");
assert.equal(reverse.operationType, "patch");

// One model-capability description drives intake and dispatch; no legacy six-file cap.
assert.doesNotMatch(modelPresets, /DEFAULT_MODEL_MEDIA_REFERENCES\s*=\s*6\b/u);
const capabilitySettings = { provider: "自定义兼容接口", model: "custom-large", maxMediaReferences: 73 };
assert.equal(getDynamicAttachmentLimit(capabilitySettings), 73);
assert.equal(validateConversationAttachments(Array.from({ length: 73 }, (_, index) => ({ name: `${index}.txt`, mimeType: "text/plain", size: 1 })), capabilitySettings).valid, true);
assert.equal(validateConversationAttachments(Array.from({ length: 74 }, (_, index) => ({ name: `${index}.txt`, mimeType: "text/plain", size: 1 })), capabilitySettings).code, "MAX_ATTACHMENTS");
assert.match(app, /slice\(0, dynamicAttachmentLimit\)/u);

// Clipboard images become real conversation attachments and share the upload pipeline.
assert.match(app, /clipboardData/u);
assert.match(app, /addAttachments/u);
assert.match(app, /activeModelAttachments/u);
assert.match(css, /border-radius:\s*50%/u);

// First install has no phantom temporary notebook; legacy entries remain visible.
assert.match(externalMarkdown, /if \(!manifest\.entries\.length\) return null/u);
assert.match(server, /\[temporaryNotebook, \.\.\.notebooks\]\.filter\(Boolean\)/u);

// The visible diagnostics feature is gone while the internal logger remains.
assert.doesNotMatch(server, /pathname === "\/api\/diagnostics\//u);
assert.match(server, /diagnosticManager\.attachProcessHooks/u);

// Skill/module/group/panel disable is persisted and visible to the resolver.
const disabledBundle = createInitialCapabilityTemplate();
disabledBundle.modules[0].disabled = true;
const normalizedDisabled = normalizeCapabilityTemplate(disabledBundle);
assert.equal(normalizedDisabled.modules[0].disabled, true);
const disabledRoute = resolveCapabilityTemplateRouting(normalizedDisabled, { text: normalizedDisabled.modules[0].name });
assert.ok(disabledRoute.diagnostics.disabledNodeIds.includes(normalizedDisabled.modules[0].id));
assert.match(app, /data-capability-context-action="disable"/u);
assert.match(app, /模型基础能力回退/u);

// Generic provider architecture exposes API/CLI separation and agent environments.
assert.doesNotMatch(app, /option value="trae_work">/u);
assert.match(app, /option value="workbuddy">WorkBuddy<\/option>/u);
assert.match(app, /syncGenerationAdapterFields/u);
assert.match(app, /for \(const key of \["baseUrl", "apiKey"\]\)[\s\S]{0,180}label\.hidden = isCli/u);
assert.match(app, /for \(const key of \["cliPath", "cliArgs"\]\)[\s\S]{0,180}label\.hidden = !isCli/u);
assert.match(app, /id="useOpenAiImageCli"[^>]*hidden/u);
assert.match(app, /const isOpenAiImageCli = form\.imageAdapter\.value === "cli" && form\.imageProvider\.value === "OpenAI"/u);
assert.match(app, /openAiImageCliButton\.hidden = !isOpenAiImageCli/u);

// Whiteboard has one square top-right toggle; no circular canvas fullscreen control remains.
assert.equal((app.match(/id="whiteboardFullscreenButton"/gu) || []).length, 1);
assert.match(app, /class="icon-button" id="whiteboardFullscreenButton"/u);
assert.doesNotMatch(app, /editorFullscreenButton/u);
assert.match(app, /elements\.whiteboardFullscreenButton\.hidden = false/u);
assert.doesNotMatch(app, /class="whiteboard-zoom-button" id="whiteboardFullscreenButton"/u);
assert.doesNotMatch(css, /\.whiteboard-editor\.whiteboard-fullscreen-active/u);
assert.match(app, /event\.detail === 3/u);
assert.match(app, /data-whiteboard-card-history-restore/u);
assert.match(app, /data-edit-queued/u);
assert.match(app, /queued-inline-editor/u);

// Image editor uses the stable 2D path and avoids the Windows/Electron
// ImageBitmap large-image black-canvas regression.
assert.doesNotMatch(imageEditor, /desynchronized:\s*true/u);
assert.match(imageEditor, /URL\.createObjectURL\(blob\)/u);
assert.match(imageEditor, /await loadHtmlImage\(objectUrl\)/u);
assert.doesNotMatch(imageEditor, /createImageBitmap\(blob/u);
assert.match(imageEditor, /image\?\.close\?\.\(\)/u);

// Windows data and installer policies.
assert.equal(defaultAppDataRoot({ platform: "win32", env: {}, home: "C:\\Users\\Test" }), "E:\\ShensiUserData");
assert.match(appData, /cp\(src, dest, \{ recursive: true, force: false, errorOnExist: false \}\)/u);
assert.match(installer, /CreateCheckbox.*创建桌面快捷方式/u);
assert.match(installer, /ShensiCreateDesktopShortcut/u);
assert.equal(packageJson.build.nsis.createDesktopShortcut, false);
assert.match(packageScript, /Installer version \$version already exists/u);
assert.match(packageScript, /Increment package\.json version before packaging again/u);
assert.match(app, /activateWorkspaceKind\(kindOption\.dataset\.workspaceKind, \{ activatePreferred: false \}\)/u);
assert.match(app, /ui\.panel = "projects";[\s\S]{0,100}renderProjectMenu\(\)/u);
assert.match(workspaceSource, /restoreMissingManagedDocumentFromLegacySource/u);
assert.match(workspaceSource, /copyFile\(sourcePath, targetPath, fsConstants\.COPYFILE_EXCL\)/u);
assert.match(workspaceSource, /externalContentMissing: true/u);

// Fullscreen editor keeps the status/word-count row.
assert.match(css, /editor-fullscreen-active \.editor-pane[\s\S]{0,180}44px/u);
assert.doesNotMatch(css, /editor-fullscreen-active \.editor-status\s*\{\s*display:\s*none/u);

console.log(`Shensi v${packageJson.version} full optimization contracts passed`);
