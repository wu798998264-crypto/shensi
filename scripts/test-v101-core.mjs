import assert from "node:assert/strict";
import { resolveCrossFormatContentRoute } from "../src/cross-format-content-router.js";
import { getDynamicAttachmentLimit } from "../src/conversation-attachment-intake.js";
import { associatedDocumentId, toggleConversationDocumentAssociation, updateConversationDocumentAssociation } from "../src/automatic-landing-policy.js";
import { uniqueGenerationPickerProfiles } from "../src/generation-profiles.js";
import { cleanFormalDocumentContent } from "../src/obsidian-markdown.js";
import { planSegmentedLongVideo } from "../src/video-generation-sequence.js";
import { guardDesktopStartupDataVersion } from "../src/server/update-data-guard.mjs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docs = [
  { id: "chapter-1", title: "《幻烬》第一章小说", contextDomain: "novel" },
  { id: "chapter-2", title: "《幻烬》第二章小说", contextDomain: "novel" },
];
const adaptation = resolveCrossFormatContentRoute({ instruction: "将《幻烬》第一章小说改编为剧本。", documents: docs });
assert.equal(adaptation.sourceDocumentId, "chapter-1");
assert.equal(adaptation.targetContentType, "script");
assert.equal(adaptation.targetDocumentId, "");
assert.equal(adaptation.create.moduleId, "manuscript");
assert.equal(adaptation.create.viewId, "script");
const prompt = resolveCrossFormatContentRoute({ instruction: "根据这一章生成 Seedance 视频提示词", documents: docs, associatedDocumentId: "chapter-1" });
assert.equal(prompt.sourceDocumentId, "chapter-1");
assert.equal(prompt.targetContentType, "prompt");
assert.equal(prompt.create.viewId, "prompts");
const reverse = resolveCrossFormatContentRoute({ instruction: "把它改写为小说第一章的新版本", documents: [...docs, { id: "script-episode-1", title: "《幻烬》第一集剧本", contextDomain: "script" }], associatedDocumentId: "script-episode-1" });
assert.equal(reverse.sourceDocumentId, "script-episode-1");
assert.equal(reverse.targetDocumentId, "chapter-1");
assert.equal(reverse.operationType, "patch");
assert.ok(getDynamicAttachmentLimit({ provider: "DeepSeek", model: "deepseek-v4-pro" }) > 6);
const conversation = { boundDocumentId: "chapter-1" };
assert.equal(associatedDocumentId(conversation, "chapter-2"), "chapter-2", "visible current document must outrank a stale auto association");
assert.equal(updateConversationDocumentAssociation(conversation, "chapter-2"), true);
assert.equal(associatedDocumentId(conversation, "chapter-2"), "chapter-2");
assert.equal(toggleConversationDocumentAssociation(conversation, "chapter-2"), false);
assert.equal(associatedDocumentId(conversation, "chapter-2"), null);
const duplicateLabelProfiles = [
  { id: "dreamina-a", provider: "即梦", adapter: "cli", remarkName: "视频账号", model: "seedance2.5" },
  { id: "dreamina-b", provider: "即梦", adapter: "cli", remarkName: "视频账号", model: "seedance2.0_vip" },
];
assert.equal(uniqueGenerationPickerProfiles(duplicateLabelProfiles, { channel: "video" }).length, 2, "saved configurations with the same display label must remain selectable");
assert.equal(
  cleanFormalDocumentContent("下面是修改后的版本：\n\n第一场\n她推门而入。\n\n以上是本轮修改内容。"),
  "第一场\n她推门而入。",
);
const longVideoPlan = planSegmentedLongVideo({ duration: 180, prompt: "人物穿过雨夜街道。" });
assert.equal(longVideoPlan.length, 6);
assert.equal(longVideoPlan.reduce((sum, segment) => sum + segment.duration, 0), 180);
assert.ok(longVideoPlan.every((segment) => segment.duration <= 30 && segment.duration >= 4));
const guardRoot = await mkdtemp(join(tmpdir(), "shensi-v101-guard-"));
const machineRoot = join(guardRoot, "machine");
await mkdir(join(machineRoot, "runtime"), { recursive: true });
await writeFile(join(guardRoot, "document.md"), "user data");
await writeFile(join(machineRoot, "runtime", "data-version-state.json"), JSON.stringify({ schemaVersion: 2, appVersion: "1.0.0", buildId: "old", dataSchemaVersion: 1 }));
let migrationCalled = false;
const guard = await guardDesktopStartupDataVersion({ dataRoot: guardRoot, machineRoot, currentVersion: "1.0.1", buildId: "new", dataSchemaVersion: 1, migrate: async () => { migrationCalled = true; return {}; } });
assert.equal(guard.status, "compatible-schema-upgrade");
assert.equal(migrationCalled, false);
await rm(guardRoot, { recursive: true, force: true });
console.log("Shensi core routing contract passed");
