import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-manager-continuation-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;
const storeUrl = new URL("../src/server/generation-job-store.mjs", import.meta.url).href;
const { createMediaGenerationJob, getGenerationJob } = await import(storeUrl);
const { launchMediaGenerationWorker } = await import("../src/server/media-worker-manager.mjs");
const launched = [];
const children = [];
const spawnFixture = (_executable, args, options) => {
  const jobId = args[args.indexOf("--job") + 1];
  launched.push(jobId);
  // Exercise the real manager, durable store and process exit events. The
  // fixture replaces only provider work, so no browser/account/CLI is used.
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    const { readGenerationJobForWorker, updateMediaGenerationJob } = await import(process.argv[1]);
    const jobId = process.argv[2];
    const job = await readGenerationJobForWorker({ jobId });
    const pollCount = Number(job.pollCount || 0) + 1;
    await updateMediaGenerationJob({ jobId, patch: {
      pollCount, providerTaskId: 'fixture-existing-provider-task',
      status: pollCount >= 3 ? 'complete' : 'polling',
      providerStatus: pollCount >= 3 ? 'completed' : pollCount === 1 ? 'queued' : 'running',
      nextPollAt: pollCount >= 3 ? '' : new Date(Date.now() + 150).toISOString(),
    } });
  `, storeUrl, jobId], { ...options, detached: false, stdio: "ignore" });
  children.push(child);
  return child;
};
try {
  const request = { prompt: "isolated offline observer fixture", settings: { provider: "即梦", adapter: "cli", model: "5.0", dreaminaCliProfile: "offline-a", connectionId: "offline-only" } };
  const activeTarget = { workspacePath: root, documentId: "test", nodeId: "active", documentTitle: "原白板名称" };
  const submissionId = "manager-continuation-fixture";
  const job = await createMediaGenerationJob({ channel: "image", target: activeTarget, request, submissionId });
  const replay = await createMediaGenerationJob({ channel: "image", target: { ...activeTarget, documentTitle: "重命名后的白板" }, request, submissionId });
  assert.equal(replay.id, job.id, "occupant display labels must never alter idempotency or create duplicate paid tasks");
  const history = await createMediaGenerationJob({ channel: "image", target: { workspacePath: root, documentId: "test", nodeId: "history" }, request });
  launchMediaGenerationWorker({ appRoot: root, jobId: job.id, spawnImpl: spawnFixture });
  const deadline = Date.now() + 8_000;
  let result;
  while (Date.now() < deadline) {
    result = await getGenerationJob({ jobId: job.id });
    if (result.status === "complete" && children.every((child) => child.exitCode !== null)) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.equal(result.status, "complete", "manager must continue after the first nonterminal worker exit");
  assert.equal(result.pollCount, 3);
  assert.equal(result.providerTaskId, "fixture-existing-provider-task");
  assert.deepEqual(launched, [job.id, job.id, job.id]);
  assert.equal((await getGenerationJob({ jobId: history.id })).status, "queued", "historical records are not enrolled implicitly");
  console.log("Actual worker manager + durable store + child exits: 3 sequential observations, one provider task, history untouched");
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await rm(root, { recursive: true, force: true });
}
