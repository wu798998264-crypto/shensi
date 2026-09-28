import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { seedanceReferenceValidation as validate } from "../src/seedance-reference-limits.js";
import { assertSeedance25VideoRequest, assertSeedanceVideoModeRequest } from "../src/server/generation-job-store.mjs";

const refs = (type, count, seconds = 3) => Array.from({ length: count }, () => ({ mimeType: `${type}/reference`, durationSeconds: seconds }));
const model = "seedance2.5";
const max = [...refs("image", 30), ...refs("video", 10), ...refs("audio", 10)];
assert.equal(validate({ model, references: max }).ok, true, "independent video/audio 30s budgets");
for (const [type, count] of [["image", 31], ["video", 11], ["audio", 11]]) {
  assert.equal(validate({ model, references: refs(type, count, 1) }).code, "VIDEO_REFERENCE_LIMIT_INVALID");
}
for (const type of ["video", "audio"]) {
  assert.equal(validate({ model, references: refs(type, 2, 15) }).ok, true);
  assert.equal(validate({ model, references: refs(type, 2, 15.001) }).ok, false);
  assert.equal(validate({ model, references: [{ mimeType: `${type}/mp4`, durationMs: 30_000 }] }).ok, true);
  assert.equal(validate({ model, references: [{ mimeType: `${type}/mp4` }] }).code, "VIDEO_REFERENCE_DURATION_INVALID");
  assert.equal(validate({ model, references: refs(type, 1, Infinity) }).ok, false);
  assert.equal(validate({ model, references: refs(type, 1, 0), requireKnownDuration: false }).ok, true);
}
assert.equal(validate({ model: "seedance2.0fast", references: [...refs("image", 9), ...refs("video", 1), ...refs("audio", 1)] }).ok, true);
assert.equal(validate({ model: "seedance2.0", references: [...refs("image", 9), ...refs("video", 2), ...refs("audio", 1)] }).ok, false);
assert.equal(validate({ model: "other-model", references: refs("video", 30, 999) }).ok, true, "other providers/models unchanged");
const settings = { adapter: "cli", provider: "即梦", model };
assert.equal(assertSeedance25VideoRequest({ settings, referenceMedia: max }), true);
assert.throws(() => assertSeedance25VideoRequest({ settings, referenceMedia: refs("video", 1, 30.1) }), /30 秒/u);
assert.throws(() => assertSeedanceVideoModeRequest({ settings: { ...settings, model: "seedance2.0" }, referenceMedia: [...refs("image", 9), ...refs("audio", 3)] }), /11 个/u);
const start = performance.now();
for (let i = 0; i < 10_000; i += 1) validate({ model, references: max });
assert.ok(performance.now() - start < 1_000, "50 references must validate entirely from metadata in <0.1ms average");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const submit = app.slice(app.indexOf('elements.whiteboardVideoForm.addEventListener("submit"'), app.indexOf('elements.whiteboardVideoForm.addEventListener("submit"') + 18_000);
assert.ok(submit.indexOf("seedanceReferenceValidation") < submit.indexOf("ensureDreaminaGenerationAccountAvailable"));
assert.doesNotMatch(app, /warnWhiteboardAudioReferenceDuration/u, "no connect-time duration toast");
assert.match(app, /operation === "connect"[\s\S]{0,250}seedance2\.5[\s\S]{0,90}continue/u, "Dreamina quotas no longer reject canvas connections");
console.log("Seedance fast reference preflight: 30/10/10, 11 total, separate 30s limits, unknown metadata and submit order passed");
