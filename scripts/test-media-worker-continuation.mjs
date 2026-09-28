import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaWorkerContinuation, dreaminaWorkerNeedsContinuation } from "../src/server/media-worker-continuation.mjs";

const dreamina = (patch = {}) => ({
  mode: "server", channel: "image", status: "polling", providerStatus: "queued",
  providerTaskId: "one-existing-paid-task", pollCount: 1,
  request: { settings: { adapter: "cli", provider: "即梦", dreaminaCliProfile: "test-only" } },
  ...patch,
});
let clock = 1_000;
let sequence = 0;
const timers = new Map();
const records = new Map();
const running = new Set();
const launches = [];
let readError = false;
const continuation = createMediaWorkerContinuation({
  readJob: async (id) => { if (readError) throw new Error("temporary IO"); return records.get(id); },
  isRunning: (id) => running.has(id),
  launch: (options) => { launches.push(options); running.add(options.jobId); continuation.track(options.jobId, options); },
  now: () => clock,
  schedule: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, due: clock + delay }); return id; },
  unschedule: (id) => timers.delete(id),
});
const tick = async (ms) => {
  clock += ms;
  for (const [id, timer] of timers) if (timer.due <= clock) { timers.delete(id); timer.fn(); }
  await Promise.resolve();
};
records.set("history", dreamina());
await continuation.sweep();
assert.equal(timers.size, 0, "startup must never discover historical tasks");
records.set("current", dreamina({ nextPollAt: new Date(clock + 2_000).toISOString() }));
const options = { jobId: "current", credentials: { image: { token: "test-only" } } };
continuation.track("current", options);
await Promise.all([continuation.continueJob("current"), continuation.sweep(), continuation.sweep()]);
assert.equal(timers.size, 1, "exit and watchdog races must coalesce");
await tick(1_999);
assert.equal(launches.length, 0, "do not accelerate the provider's existing polling cadence");
await tick(1);
assert.equal(launches.length, 1);
assert.equal(launches[0], options, "continue with the original profile/credential snapshot");
await continuation.sweep();
assert.equal(timers.size, 0, "do not launch a second live worker");
running.delete("current");
records.set("current", dreamina({ pollCount: 2, nextPollAt: new Date(clock + 2_000).toISOString() }));
await continuation.continueJob("current");
await tick(2_000);
assert.equal(launches.length, 2, "second nonterminal observation must schedule another observation");
running.delete("current");
records.set("current", dreamina({ status: "saved", providerStatus: "completed", pollCount: 3 }));
await continuation.continueJob("current");
await continuation.sweep();
assert.equal(timers.size, 0, "saved results no longer query the provider");

for (const status of ["complete", "cancelled", "failed", "waiting_credentials", "waiting_storage", "retry_required", "reconciliation_required"]) {
  assert.equal(dreaminaWorkerNeedsContinuation(dreamina({ status })), false, status);
}
assert.equal(dreaminaWorkerNeedsContinuation(dreamina({ status: "retry_required", providerStatus: "reconciling", nextPollAt: new Date(clock).toISOString() })), true);
assert.equal(dreaminaWorkerNeedsContinuation(dreamina({ forceReleasePendingAt: "now" })), false);
assert.equal(dreaminaWorkerNeedsContinuation(dreamina({ request: { settings: { adapter: "api", provider: "聚合 API" } } })), false);
records.set("stopped", dreamina({ nextPollAt: new Date(clock + 100).toISOString() }));
continuation.track("stopped", { jobId: "stopped" });
await continuation.continueJob("stopped");
continuation.forget("stopped");
await tick(1_000);
assert.equal(launches.length, 2, "force release must cancel pending continuation");

records.set("io", dreamina({ nextPollAt: new Date(clock + 100).toISOString() }));
continuation.track("io", { jobId: "io" });
readError = true;
await continuation.sweep();
assert.equal(timers.size, 0, "a read failure never invents a task/submission");
readError = false;
await continuation.sweep();
assert.equal(timers.size, 1, "existing watchdog may retry a local read");
continuation.forget("io");

// Real child processes exit between observations. No UI resume, provider CLI,
// account config or paid request is involved in this isolated regression.
const root = await mkdtemp(join(tmpdir(), "shensi-continuation-"));
const taskPath = join(root, "task.json");
let processRunning = false;
let processLaunches = 0;
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
let guard;
const actual = createMediaWorkerContinuation({
  readJob: async () => JSON.parse(await readFile(taskPath, "utf8")),
  isRunning: () => processRunning,
  launch: () => { void observe(); },
});
const observe = async () => {
  processRunning = true;
  processLaunches += 1;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { readFile, writeFile } from 'node:fs/promises';
    const path = process.argv[1];
    const job = JSON.parse(await readFile(path, 'utf8'));
    job.pollCount += 1;
    job.nextPollAt = new Date(Date.now() + 120).toISOString();
    if (job.pollCount === 3) { job.status = 'saved'; job.providerStatus = 'completed'; }
    await writeFile(path, JSON.stringify(job));
  `, taskPath], { windowsHide: true, stdio: "ignore" });
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  processRunning = false;
  await actual.continueJob("real");
  if (processLaunches === 3) finish();
};
try {
  await writeFile(taskPath, JSON.stringify(dreamina({ pollCount: 0 })));
  actual.track("real", { jobId: "real" });
  await observe();
  await Promise.race([finished, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error("continuation stalled")), 5_000); })]);
  const result = JSON.parse(await readFile(taskPath, "utf8"));
  assert.equal(result.pollCount, 3);
  assert.equal(result.status, "saved");
  assert.equal(result.providerTaskId, "one-existing-paid-task", "no new provider submission");
  assert.equal(processLaunches, 3);
} finally {
  clearTimeout(guard);
  actual.forget("real");
  await rm(root, { recursive: true, force: true });
}
console.log("Current-session Dreamina continuation: timings, isolation, stop, transient IO and real worker exits passed");
