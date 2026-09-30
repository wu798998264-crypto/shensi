import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { publicGenerationJob } from "../src/server/generation-job-store.mjs";
import { dreaminaWorkerObservationStalled } from "../src/server/media-worker-continuation.mjs";
import { dreaminaProfileSwitchDecision, dreaminaProfileSwitchMessage } from "../src/dreamina-manual-profile-policy.js";
import { mediaRecoveryJobBlocksOperation, mediaRecoveryPromptCandidates, mediaRecoveryPromptSignature } from "../src/media-generation-coordination.js";

const active = {
  id: "generation-occupancy-regression-test", mode: "server", channel: "image", status: "polling", providerStatus: "running",
  providerTaskId: "existing-provider-task", workerPid: process.pid,
  nextPollAt: new Date(Date.now() - 60_000).toISOString(),
  target: { workspacePath: "C:\\测试作品", documentTitle: "预告片白板", documentId: "board-1", documentKind: "whiteboard", nodeName: "海边灯塔" },
  request: { settings: { provider: "即梦", adapter: "cli", dreaminaCliProfile: "account-a" } },
};
assert.equal(dreaminaWorkerObservationStalled(active, { isProcessAlive: () => true }), false, "long-running live workers are not stalled");
assert.equal(dreaminaWorkerObservationStalled(active, { isProcessAlive: () => false }), true);
assert.equal(dreaminaWorkerObservationStalled({ ...active, nextPollAt: new Date(Date.now() + 1000).toISOString() }, { isProcessAlive: () => false }), false, "expected gaps between polls are normal");
assert.equal(dreaminaWorkerObservationStalled({ ...active, providerTaskId: "" }, { isProcessAlive: () => false }), false, "unknown submission cannot be blindly retried");
const publicActive = publicGenerationJob(active);
assert.equal(publicActive.runtimeNeedsAttention, false);
assert.equal(mediaRecoveryJobBlocksOperation(publicActive), false, "normal lock use never enters pending");
const decision = dreaminaProfileSwitchDecision({ jobs: [publicActive], requestedProfileId: "account-b" });
const message = dreaminaProfileSwitchMessage(decision);
assert.equal(decision.allowed, true, "另一个账号应进入本地队列，而不是在创建时拒绝");
assert.equal(decision.queuedBehindCurrent, true);
for (const label of ["C:\\测试作品", "预告片白板", "海边灯塔"]) assert.ok(message.includes(label), label);
assert.equal(decision.blockingTaskNeedsAttention, false);
const raw = { ...active, workerPid: 2_147_483_647 };
const before = JSON.stringify(raw);
const orphan = publicGenerationJob(raw);
assert.equal(JSON.stringify(raw), before, "attention is a read-only diagnostic, not a history mutation");
assert.equal(orphan.status, "polling", "provider state is not invented");
assert.equal(orphan.runtimeNeedsAttention, true);
assert.equal(orphan.availableActions.resumeOriginal, true);
assert.equal(mediaRecoveryJobBlocksOperation(orphan), true);
assert.equal(dreaminaProfileSwitchDecision({ jobs: [orphan], requestedProfileId: "account-b" }).blockingTaskNeedsAttention, true);
const blocked = publicGenerationJob({ ...active, status: "waiting_credentials", providerErrorCode: "DREAMINA_AUTH_REQUIRED", providerTaskId: "" });
assert.equal(mediaRecoveryJobBlocksOperation(blocked), true, "genuine login blocking also has a pending action before submission");
assert.equal(mediaRecoveryJobBlocksOperation({ ...orphan, runtimeNeedsAttention: false, status: "retry_required", providerStatus: "reconciling", automaticRecoveryInProgress: true }), false, "safe automatic reconciliation is not a manual block");
const baselinedScanKeys = new Set();
const promptedJobSignatures = new Map();
const scan = (jobs) => mediaRecoveryPromptCandidates({ scanKey: "workspace", blockingJobs: jobs, baselinedScanKeys, promptedJobSignatures });
assert.equal(scan([orphan]).freshBlockingJobs.length, 0, "cold startup remains silent even for old stalled workers");
assert.equal(scan([{ ...orphan, updatedAt: new Date().toISOString() }]).freshBlockingJobs.length, 0, "heartbeats cannot reopen a dismissed signature");
assert.equal(scan([{ ...orphan, status: "waiting_storage", providerErrorCode: "ENOSPC" }]).freshBlockingJobs.length, 1);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const start = app.indexOf("const promptLiveMediaJobRecovery = ");
const end = app.indexOf("\n};", start);
let opened = 0;
const liveJobs = new Set();
const seen = new Map();
const context = vm.createContext({ currentSessionMediaJobIds: liveJobs, mediaRecoveryPromptedJobSignatures: seen,
  mediaRecoveryJobBlocksOperation, mediaRecoveryPromptSignature, mediaRecoveryJobIsActionable: () => true,
  document: { visibilityState: "visible" }, openMediaRecoveryDialog: () => { opened += 1; }, job: blocked });
vm.runInContext(app.slice(start, end + 3), context);
const observe = () => vm.runInContext("promptLiveMediaJobRecovery(job)", context);
observe();
assert.equal(opened, 0, "restored history must not auto-open");
liveJobs.add(blocked.id);
observe(); observe();
assert.equal(opened, 1, "current-session genuine blocking opens exactly once");
context.job = { ...blocked, updatedAt: "heartbeat", availableActions: { ...blocked.availableActions, stop: false } };
observe();
assert.equal(opened, 1);
context.job = publicActive; observe();
context.job = blocked; observe();
assert.equal(opened, 2, "a later genuine state transition may reopen");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(server, /previous\.runtimeNeedsAttention && previous\.providerTaskId[\s\S]{0,550}jobId: previous\.id[\s\S]{0,220}resumedObservation: true/u, "manual resume actually restarts observation of an orphan, not just alreadyRunning");
console.log("Dreamina occupant paths, live/overdue discrimination, actionable resume, startup silence and popup dedup passed");
