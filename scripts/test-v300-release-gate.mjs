import assert from "node:assert/strict";

import { evaluateV300ReleaseGate } from "../src/release-gate.js";

const localReady = evaluateV300ReleaseGate({
  localChecks: {
    runtimeContract: true,
    contextIsolation: true,
    formalWrite: true,
    historyTransaction: true,
    dreaminaLifecycle: true,
    mediaCardReadback: true,
    exports: true,
    richText: true,
    largeWorkspace: true,
  },
  uiEvidence: true,
  externalChecks: {
    textModels: "verified",
    dreaminaPaidGeneration: "pending_user_authorization",
    nutstoreAccount: "pending_account",
    rankingRestrictedSources: "pending_access",
  },
});
assert.equal(localReady.localReady, true);
assert.equal(localReady.publishReady, false, "外部验收未执行时不得伪造 3.0 发布就绪");
assert.deepEqual(localReady.pendingExternal.map((item) => item.id), ["dreaminaPaidGeneration", "nutstoreAccount", "rankingRestrictedSources"]);

const externalFailure = evaluateV300ReleaseGate({
  localChecks: { runtimeContract: true },
  uiEvidence: true,
  externalChecks: { textModels: "failed" },
});
assert.equal(externalFailure.publishReady, false);
assert.equal(externalFailure.failedExternal[0].id, "textModels");

const localFailure = evaluateV300ReleaseGate({
  localChecks: { runtimeContract: false, contextIsolation: true },
  uiEvidence: true,
  externalChecks: { textModels: "verified" },
});
assert.equal(localFailure.localReady, false);
assert.deepEqual(localFailure.failedLocal, ["runtimeContract"]);

console.log("v3.0 发布门槛测试通过");
