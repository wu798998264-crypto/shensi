import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { verifiedLandingManifestReceipt } from "../src/landing-document-links.js";
import { formalWritePendingReply, classifyFormalWriteFailure } from "../src/formal-write-outcome.js";

// Stream to a bounded block; never load the large app as a whole string.
const block = async (file, start, end, max = 250) => {
  const stream = createReadStream(resolve(import.meta.dirname, "..", file), { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  try {
    for await (const line of reader) {
      if (!lines.length && !line.includes(start)) continue;
      if (lines.length && line.includes(end)) return lines.join("\n");
      lines.push(line);
      assert.ok(lines.length <= max);
    }
    assert.fail(`Missing block ${start}`);
  } finally { reader.close(); stream.destroy(); }
};
const title = await block("src/app.js", "let titleDiskCommitted = false", "const continuationDeliveryInvalid");
assert.ok(title.indexOf("titleDiskCommitted = true") > title.indexOf("await saveWorkspace("));
assert.ok(title.indexOf("if (!outcome.rollbackAllowed)") < title.indexOf("state = rollbackState"));
// The formal write path now includes the transaction receipt and recovery
// branches; keep the streaming guard, but allow this single audited block to
// span its expanded implementation without reading the application wholesale.
const formal = await block("src/app.js", "let formalDiskCommitted = false", "const trustedActionSummary =", 250);
assert.ok(formal.indexOf("evaluateTaskContract(") < formal.indexOf("await saveWorkspace("));
assert.ok(formal.indexOf("formalDiskCommitted = true") > formal.indexOf("await saveWorkspace("));
assert.ok(formal.indexOf("if (!outcome.rollbackAllowed)") < formal.indexOf("body: JSON.stringify({ failed: true"));
assert.ok(formal.indexOf("if (!outcome.rollbackAllowed)") < formal.indexOf("state = rollbackState"));
const hold = await block("src/app.js", "const holdFormalWriteForReadback", "const landPreparedGenerationMessage");
assert.ok(hold.includes("ui.formalWriteReadbackPending =") && hold.includes("workspaceIdentity()"));
assert.ok(!hold.includes("ui.workspaceHydrationBlocked ="), "文字事务不接管媒体共用的持久化开关");
assert.ok(!hold.includes("saveWorkspace("), "读回等待不得再发写请求");
const landing = await block("src/app.js", "const landPreparedGenerationMessage", "const handleGenerationAttemptAction");
assert.ok(landing.includes("!verificationPending && offerRecovery"));
const rollback = await block("src/app.js", "let rollbackSubmissionStarted = false", "const openLandingRecoveryChoice");
assert.ok(rollback.indexOf("if (!outcome.rollbackAllowed)") < rollback.indexOf("state = rollbackState"));
const operation = await block("src/app.js", "operationSubmissionStarted = true", "const cancelWorkspaceOperationPlan");
assert.ok(operation.indexOf("operationDiskCommitted = true") > operation.indexOf("await saveWorkspace("));
assert.ok(operation.indexOf("if (!outcome.rollbackAllowed)") < operation.indexOf("state = rollbackState"));
const pending = formalWritePendingReply({ outcome: classifyFormalWriteFailure({ submissionStarted: true, diskCommitted: true }), receipt: { verified: true } });
assert.equal(verifiedLandingManifestReceipt({ result: pending }), false);
const withoutFlag = { ...pending, commitFailed: false };
assert.equal(verifiedLandingManifestReceipt({ result: withoutFlag }), false);
console.log("Formal write preflight, disk boundary, pending propagation and no-double-submit integration checks passed");
