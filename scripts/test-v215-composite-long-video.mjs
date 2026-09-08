import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  COMPOSITE_LONG_VIDEO_MODE,
  LONG_VIDEO_MAX_DURATION_SECONDS,
  createCompositeLongVideoManifest,
  markCompositeLongVideoSegmentCompleted,
  markCompositeLongVideoSegmentFailed,
  markCompositeLongVideoSegmentSubmitted,
  planCompositeLongVideo,
  prepareCompositeLongVideoSegment,
  prioritizeLongVideoReferences,
  requestCompositeLongVideoManualRetry,
} from "../src/video-generation-sequence.js";

assert.equal(LONG_VIDEO_MAX_DURATION_SECONDS, 300);
assert.equal(COMPOSITE_LONG_VIDEO_MODE, "composite_long_video");

const plan = planCompositeLongVideo({
  duration: 300,
  prompt: "人物从雨夜街道进入车站，最后登上列车。",
  globalBible: "女主始终穿红色风衣，冷蓝色雨夜光线。",
  references: [{ id: "style", kind: "style" }, { id: "hero", kind: "identity" }],
});
assert.equal(plan.length, 10);
assert.equal(plan.reduce((sum, item) => sum + item.duration, 0), 300);
assert.equal(plan.every((item) => item.duration <= 30), true);
assert.match(plan[0].prompt, /全片统一约束/u);
assert.match(plan[1].prompt, /上一段提供的稳定尾帧/u);

const narrativePlan = planCompositeLongVideo({
  duration: 90,
  prompt: "雨夜里女主从巷口奔向车站。她在检票口发现追兵逼近。列车启动前，她跃上最后一节车厢。",
});
assert.equal(new Set(narrativePlan.map((item) => item.localPrompt)).size, narrativePlan.length, "long narrative must be split into distinct local segment prompts");

const prioritized = prioritizeLongVideoReferences(
  [{ id: "style", kind: "style" }, { id: "hero", kind: "identity" }],
  { continuityFrame: { id: "tail", mimeType: "image/png" } },
);
assert.deepEqual(prioritized.map((item) => item.id), ["tail", "hero", "style"]);

let manifest = createCompositeLongVideoManifest({
  id: "long-test", cardId: "card-1", duration: 31,
  prompt: "人物推门走入大厅，然后回头看向门外。",
  references: [{ id: "hero", kind: "identity" }],
  settings: { connectionId: "video-profile-test", model: "seedance2.5" },
});
assert.equal(manifest.automaticPaidRetry, false);
manifest = prepareCompositeLongVideoSegment(manifest, 0);
manifest = markCompositeLongVideoSegmentSubmitted(manifest, 0, { childJobId: "generation-child-1" });
manifest = markCompositeLongVideoSegmentCompleted(manifest, 0, {
  output: { relativePath: "attachments/segment-1.mp4" },
  continuityFrame: { relativePath: "attachments/segment-1-tail.png", mimeType: "image/png" },
  actualCredits: 12,
});
manifest = prepareCompositeLongVideoSegment(manifest, 1, { continuityFrame: manifest.segments[0].continuityFrame });
assert.equal(manifest.segments[1].effectiveReferences[0].relativePath, "attachments/segment-1-tail.png");
manifest = markCompositeLongVideoSegmentSubmitted(manifest, 1, { childJobId: "generation-child-2" });
manifest = markCompositeLongVideoSegmentFailed(manifest, 1, "provider failed");
assert.equal(manifest.status, "paused_manual_action_required");
assert.equal(manifest.segments[1].status, "awaiting_manual_retry");
assert.equal(manifest.automaticPaidRetry, false);
manifest = requestCompositeLongVideoManualRetry(manifest, 1);
assert.equal(manifest.segments[1].status, "planned");
assert.equal(manifest.segments[1].childJobId, "");

assert.throws(() => planCompositeLongVideo({ duration: 301, prompt: "too long" }), /31—300/u);
assert.throws(() => planCompositeLongVideo({ duration: 60, prompt: "" }), /不能为空/u);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styleSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(appSource, /const openPreferredWhiteboardGenerationForNode[\s\S]{0,900}requirePrompt:\s*false/u, "a chosen generation type must reopen even before a prompt is entered");
assert.match(appSource, /setWhiteboardAutoOpenDisabled\(config\.form\.dataset\.nodeId, true\)/u, "only the explicit bottom close action disables card-click auto-open");
assert.match(appSource, /const reactivateWhiteboardGenerationIntent[\s\S]{0,260}setWhiteboardAutoOpenDisabled\(nodeId, false\)/u, "an explicit generation choice must restore card-click auto-open");
assert.match(appSource, /if \(action === "generate-text"\)[\s\S]{0,220}createWhiteboardSelectionGenerationTarget\(contextNodeIds, "text"[\s\S]{0,100}openWhiteboardGenerateDialog\(context\.nodeId\)/u);
assert.match(appSource, /if \(action === "generate-image"\)[\s\S]{0,220}createWhiteboardSelectionGenerationTarget\(contextNodeIds, "image"[\s\S]{0,100}openWhiteboardImageDialog\(context\.nodeId\)/u);
assert.match(appSource, /if \(action === "generate-video"\)[\s\S]{0,620}createWhiteboardSelectionGenerationTarget\(contextNodeIds, "video"[\s\S]{0,100}openWhiteboardVideoDialog\(context\.nodeId\)/u);
assert.match(appSource, /const openWhiteboardGenerateDialog[\s\S]{0,1800}reactivateWhiteboardGenerationIntent\(nodeId\)/u, "text generation must reactivate the selected card intent before restoring its form");
assert.match(appSource, /const openWhiteboardImageDialog[\s\S]{0,1800}reactivateWhiteboardGenerationIntent\(nodeId\)/u, "image generation must reactivate the selected card intent before restoring its form");
assert.match(appSource, /const openWhiteboardVideoDialog[\s\S]{0,1800}reactivateWhiteboardGenerationIntent\(nodeId\)/u, "video generation must reactivate the selected card intent before restoring its form");
assert.match(appSource, /const openWhiteboardAudioDialog[\s\S]{0,1800}reactivateWhiteboardGenerationIntent\(nodeId\)/u, "audio generation must reactivate the selected card intent before restoring its form");
assert.match(styleSource, /#whiteboardVideoDialog \.whiteboard-generation-bottom-options \{[\s\S]{0,520}grid-template-columns:[^\n]+minmax\(140px, 1\.05fr\)[^\n]+minmax\(184px, 1\.40fr\)[^\n]+minmax\(126px, \.92fr\)[^\n]+minmax\(212px, 1\.45fr\)/u, "video toolbar must reallocate only eight pixels from model to settings without moving the other buttons");
assert.match(styleSource, /:is\(#whiteboardImageDialog, #whiteboardVideoDialog, #whiteboardAudioDialog\) \.whiteboard-generation-bottom-options \{[\s\S]{0,100}margin-right:\s*12px;[\s\S]{0,80}transform:\s*translateY\(4px\)/u, "image, video and audio controls share the action-button baseline");
assert.match(appSource, /data-generation-profile-toggle="video"/u);
assert.match(appSource, /data-generation-order-list="video" role="listbox" hidden/u);
assert.match(styleSource, /\.generation-order-list\s*\{[\s\S]{0,180}position:\s*absolute/u, "profile order list must live in the dropdown instead of a separate expanded section");
assert.match(appSource, /data-composite-long-video-retry/u);
assert.match(appSource, /不会自动重新提交失败片段/u);
assert.match(appSource, /\/api\/workspace\/video-concat/u);
assert.doesNotMatch(appSource, /超长视频·(?:分段拼接|分段生成并拼接)/u, "the user-facing mode name must remain simply 超长视频");
assert.match(
  appSource,
  /whiteboardImageSettingsTrigger\.addEventListener\("click"[\s\S]{0,420}closeWhiteboardMediaPickerMenus\(\);[\s\S]{0,180}closeWhiteboardVideoModeMenu\(\);[\s\S]{0,220}setWhiteboardImageSettingsPanelOpen\(opening\)/u,
  "opening image settings must close any previously open toolbar picker",
);
assert.match(
  appSource,
  /whiteboardVideoSettingsTrigger\.addEventListener\("click"[\s\S]{0,420}closeWhiteboardMediaPickerMenus\(\);[\s\S]{0,180}closeWhiteboardVideoModeMenu\(\);[\s\S]{0,220}setWhiteboardVideoSettingsPanelOpen\(opening\)/u,
  "opening video settings must close connection, model and mode menus",
);

console.log("Composite long-video 300s planning, continuity references and manual-only retry contracts passed");
