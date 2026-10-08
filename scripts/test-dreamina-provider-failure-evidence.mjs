import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dreaminaFailureDiagnosis } from "../src/dreamina-failure.js";

const [failureSource, cliSource, workerSource] = await Promise.all([
  readFile(new URL("../src/dreamina-failure.js", import.meta.url), "utf8"),
  readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8"),
]);

assert.match(failureSource, /DREAMINA_CONTENT_POLICY_REJECTED/u);
assert.match(failureSource, /DREAMINA_REFERENCE_POLICY_REJECTED/u);
assert.match(cliSource, /providerPayloadEvidence/u);
assert.match(cliSource, /SENSITIVE_PROVIDER_KEY/u);
assert.match(cliSource, /providerCliStderr/u);
assert.match(workerSource, /providerRawPayload/u);
assert.match(workerSource, /providerCliStderr/u);

const content = dreaminaFailureDiagnosis({
  code: "CONTENT_POLICY_REJECTED",
  message: "content policy violation: generation blocked",
});
assert.equal(content.code, "DREAMINA_CONTENT_POLICY_REJECTED");
assert.equal(content.category, "content_policy_rejected");
assert.match(content.cause, /即梦明确/u);

const reference = dreaminaFailureDiagnosis({
  code: "PROVIDER_FAILED",
  message: "reference image rejected by copyright policy",
  providerTaskId: "task-reference-policy-1",
});
assert.equal(reference.code, "DREAMINA_REFERENCE_POLICY_REJECTED");
assert.equal(reference.category, "reference_policy_rejected");
assert.match(reference.resolution, /不要重新提交同一任务/u);

const generic = dreaminaFailureDiagnosis({
  code: "PROVIDER_FAILED",
  message: "generation failed: final generation failed",
});
assert.equal(generic.code, "PROVIDER_FAILED");
assert.equal(generic.category, "provider_failure");
assert.doesNotMatch(generic.cause, /版权|审核|合规/u, "generic provider text must not be guessed as a policy rejection");

console.log("Dreamina provider failure evidence and explicit policy classification passed");
