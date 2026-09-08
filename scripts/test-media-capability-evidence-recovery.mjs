import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const jobStore = await readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8");

assert.match(app, /const submittedRequest = \{[\s\S]{0,900}capabilityProfileSignature:[\s\S]{0,300}mediaCapabilityProfileSignature\(channel, request\?\.settings \|\| \{\}\)/u,
  "every media submission must persist a credential-safe capability signature");
assert.match(app, /const capabilitySettingsForJob = \(job = \{\}\) =>/u,
  "capability evidence recovery must have a request-bound settings fallback");
assert.match(app, /const capabilityEvidenceTimestamp = \(job = \{\}\) =>/u,
  "capability evidence must be ordered by durable job timestamps");
assert.match(app, /const previousAt = Date\.parse\(String\(previousProbe\?\.generationCapabilityCheckedAt/u,
  "older failure evidence must not overwrite newer generation evidence");
assert.match(app, /storeMediaCapabilityProbe\(job\.channel, profile,[\s\S]{0,1600}profileSignatureOverride: profileSignature/u,
  "media success evidence must remain bound to the submitted configuration signature");
const recoveryStart = app.indexOf("const recoverWhiteboardGenerationJobsOnce");
const recoveryEnd = app.indexOf("const mediaRecoveryReconciler", recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, "media recovery function must remain present");
const recoverySource = app.slice(recoveryStart, recoveryEnd);
assert.match(recoverySource, /recordCustomGenerationJobCapability\(job\);[\s\S]{0,700}if \(job\.appliedAt\)/u,
  "applied jobs must rebind capability evidence before card-repair early returns");
assert.match(jobStore, /capabilityProfileSignature: String\(request\.capabilityProfileSignature/u,
  "durable media jobs must retain the capability signature in their public request");

console.log("Media capability evidence recovery regression checks passed");
