import assert from "node:assert/strict";
import { classifyFormalWriteFailure, formalWritePendingReply, formalWriteVerificationPending } from "../src/formal-write-outcome.js";

assert.equal(classifyFormalWriteFailure({}).rollbackAllowed, true);
assert.equal(classifyFormalWriteFailure({ submissionStarted: true, error: { status: 409, code: "WORKSPACE_STATE_CONFLICT" } }).rollbackAllowed, true);
for (const error of [{}, { code: "WORKSPACE_SAVE_TIMEOUT" }, { status: 503 }, { status: 400 }, { status: 408 }, new TypeError("Failed to fetch")]) {
  const outcome = classifyFormalWriteFailure({ submissionStarted: true, error });
  assert.equal(outcome.status, "commit_unknown");
  assert.equal(outcome.rollbackAllowed, false);
  assert.equal(outcome.retryWriteAllowed, false);
  assert.equal(formalWriteVerificationPending(formalWritePendingReply({ outcome, error })), true);
}
const committed = classifyFormalWriteFailure({ submissionStarted: true, diskCommitted: true, error: { status: 409, code: "WORKSPACE_STATE_CONFLICT" } });
assert.equal(committed.status, "verification_pending");
assert.equal(committed.rollbackAllowed, false);
const reply = formalWritePendingReply({ outcome: committed, documentIds: ["report-novel"], receipt: { verified: true } });
assert.equal(reply.commitFailed, true, "A disk receipt must not turn incomplete delivery acceptance into success");
assert.equal(formalWriteVerificationPending({ execution: reply.engineExecution }), true);
assert.equal(formalWriteVerificationPending({ status: "complete", landingStatus: "committed" }), false);
console.log("Formal write commit-boundary and pending outcome tests passed");
