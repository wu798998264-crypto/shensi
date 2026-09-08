import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-v211-credit-"));
const originalDataRoot = process.env.SHENSI_DATA_ROOT;
process.env.SHENSI_DATA_ROOT = root;

try {
  const {
    readDreaminaProfileIdentityStore,
    recordDreaminaProfileCreditEstimate,
    saveDreaminaProfileIdentity,
  } = await import(`../src/server/dreamina-profile-identity-store.mjs?v211=${Date.now()}`);

  await saveDreaminaProfileIdentity({ profileId: "ui-test", remarkName: "积分校准测试", vipLevel: "maestro" });
  await recordDreaminaProfileCreditEstimate({
    profileId: "ui-test",
    channel: "video",
    request: {
      settings: { model: "seedance2.5" },
      generationMode: "smart_params",
      duration: 4,
      resolution: "720p",
      aspectRatio: "16:9",
      videoCount: 1,
      generateAudio: true,
      referenceMedia: [{ mimeType: "image/png" }],
    },
    creditCount: 12,
    providerTaskId: "task-first",
  });
  let record = (await readDreaminaProfileIdentityStore()).profiles["ui-test"];
  assert.equal(record.creditEstimates.length, 1);
  assert.equal(record.creditEstimates[0].referenceClass, "image");
  assert.equal(record.creditEstimates[0].unitCredit, 3);
  assert.equal(record.creditEstimates[0].membership, "maestro");

  await recordDreaminaProfileCreditEstimate({
    profileId: "ui-test",
    channel: "video",
    request: {
      settings: { model: "seedance2.5" },
      generationMode: "smart_params",
      duration: 8,
      resolution: "720p",
      aspectRatio: "16:9",
      videoCount: 1,
      generateAudio: true,
      referenceMedia: [{ mimeType: "image/png" }],
    },
    creditCount: 32,
    providerTaskId: "task-recalibrated",
  });
  record = (await readDreaminaProfileIdentityStore()).profiles["ui-test"];
  assert.equal(record.creditEstimates.length, 1, "duration changes must reuse one per-second rule");
  assert.equal(record.creditEstimates[0].unitCredit, 4);
  assert.equal(record.creditEstimates[0].previousUnitCredit, 3);
  assert.equal(record.creditEstimates[0].calibrationRevision, 2);
  assert.ok(record.creditEstimates[0].deviationRatio > 0.3);

  await recordDreaminaProfileCreditEstimate({
    profileId: "ui-test",
    channel: "video",
    request: {
      settings: { model: "seedance2.5" },
      generationMode: "first_last_frame",
      duration: 5,
      resolution: "720p",
      aspectRatio: "9:16",
      videoCount: 1,
      generateAudio: false,
      referenceMedia: [{ mimeType: "image/png" }],
    },
    creditCount: 20,
    providerTaskId: "task-non-pricing-options",
  });
  record = (await readDreaminaProfileIdentityStore()).profiles["ui-test"];
  assert.equal(record.creditEstimates.length, 1, "mode, aspect ratio and generated audio must reuse the same per-second rule");
  assert.equal(record.creditEstimates[0].unitCredit, 4);

  await recordDreaminaProfileCreditEstimate({
    profileId: "ui-test",
    channel: "video",
    request: {
      settings: { model: "seedance2.5" },
      generationMode: "smart_params",
      duration: 4,
      resolution: "480p",
      aspectRatio: "16:9",
      videoCount: 1,
      generateAudio: true,
      referenceMedia: [{ mimeType: "image/png" }],
    },
    creditCount: 8,
    providerTaskId: "task-resolution-isolated",
  });
  record = (await readDreaminaProfileIdentityStore()).profiles["ui-test"];
  assert.equal(record.creditEstimates.length, 2, "an unverified resolution requires its own pricing calibration");

  await recordDreaminaProfileCreditEstimate({
    profileId: "ui-test",
    channel: "video",
    request: {
      settings: { model: "seedance2.5" },
      generationMode: "smart_params",
      duration: 4,
      resolution: "720p",
      aspectRatio: "16:9",
      videoCount: 1,
      generateAudio: true,
      referenceMedia: [{ mimeType: "video/mp4" }],
    },
    creditCount: 20,
    providerTaskId: "task-video-reference",
  });
  record = (await readDreaminaProfileIdentityStore()).profiles["ui-test"];
  assert.equal(record.creditEstimates.length, 3, "video references require an isolated pricing rule");
  assert.equal(record.creditEstimates.find((item) => item.referenceClass === "video")?.unitCredit, 5);

  const [app, styles] = await Promise.all([
    readFile(new URL("../src/app.js", import.meta.url), "utf8"),
    readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /本次预计消耗：约/);
  assert.match(app, /本次消耗：待首次生成校准/);
  assert.match(app, /生成后以实际扣除为准/);
  assert.doesNotMatch(app, /note\.textContent = estimatedCredit/);
  assert.match(app, /whiteboardGenerationReferenceClassForForm/);
  assert.doesNotMatch(app, /String\(item\.mode \|\| ""\)[\s\S]{0,500}estimatedCredit/u);
  assert.doesNotMatch(app, /item\.generateAudio !== false[\s\S]{0,500}estimatedCredit/u);
  assert.match(app, /String\(item\.membership \|\| ""\)\.trim\(\)\.toLowerCase\(\) === expected\.membership/u);
  assert.match(app, /whiteboard-media-option-leading/);
  assert.match(app, /whiteboard-video-audio-state[\s\S]{0,240}\\uE767[\s\S]{0,80}\\uE74F/u, "视频设置摘要应用扬声器图标表达音频开关，避免文字被截断");
  for (const dialogId of ["whiteboardGenerateDialog", "whiteboardImageDialog", "whiteboardVideoDialog", "whiteboardAudioDialog"]) {
    const start = app.indexOf(`id="${dialogId}"`);
    const end = app.indexOf("</dialog>", start);
    const dialogMarkup = app.slice(start, end);
    assert.ok(start >= 0 && end > start, `${dialogId} markup must exist`);
    assert.equal((dialogMarkup.match(/data-whiteboard-generation-expand/gu) ?? []).length, 1, `${dialogId} must expose exactly one expand control`);
    assert.match(dialogMarkup, /^id="[^"]+">\s*<button[^>]+data-whiteboard-generation-expand/u, `${dialogId} expand control must be a direct foreground child before the form`);
  }
  assert.match(styles, /v2\.11 compact generation command deck/);
  assert.match(styles, /#whiteboardAudioDialog/);
  assert.match(styles, /--whiteboard-generation-control-height: 36px/);
  assert.match(styles, /grid-template-rows: 18px var\(--whiteboard-generation-control-height\)/);
  assert.match(styles, /grid-template-columns: minmax\(140px, 1\.05fr\) minmax\(184px, 1\.40fr\) minmax\(126px, \.92fr\) minmax\(212px, 1\.45fr\)/);
  assert.match(styles, /:is\(#whiteboardImageDialog, #whiteboardVideoDialog, #whiteboardAudioDialog\) \.whiteboard-generation-bottom-options \{\s*margin-right: 12px;\s*transform: translateY\(4px\)/u);
  assert.match(styles, /#whiteboardVideoDialog \.whiteboard-media-settings-trigger span \{[\s\S]{0,160}text-overflow: ellipsis/u);
  assert.match(styles, /whiteboard-video-audio-state/u);
  assert.match(styles, /min-width: 94px/);
  assert.match(styles, /background: var\(--review, #1769e0\)/);
  assert.match(styles, /\.whiteboard-generation-popover > \.whiteboard-generation-expand \{[\s\S]{0,260}z-index: 120;[\s\S]{0,220}min-width: 32px;[\s\S]{0,320}pointer-events: auto;/u);
  assert.match(styles, /\.whiteboard-generation-popover:not\(\.is-expanded\) \.whiteboard-generation-expand \{[\s\S]{0,180}right: 10px;/u);

  console.log("v2.12.0 compact generation UI and adaptive Dreamina credit calibration tests passed");
} finally {
  if (originalDataRoot === undefined) delete process.env.SHENSI_DATA_ROOT;
  else process.env.SHENSI_DATA_ROOT = originalDataRoot;
  await rm(root, { recursive: true, force: true });
}
