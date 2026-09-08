import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  whiteboardGenerationConnectionPhase,
  whiteboardGenerationMeasurementActive,
  whiteboardGenerationProgressActive,
  whiteboardGenerationProgressTarget,
} from "../src/whiteboard-progress.js";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const store = await readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/server/media-generation-worker.mjs", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

const connectingVideo = { channel: "video", status: "connecting", startedAt: Date.now() - 1_000 };
assert.equal(whiteboardGenerationMeasurementActive(connectingVideo), true);
assert.equal(whiteboardGenerationConnectionPhase(connectingVideo), true);
assert.equal(whiteboardGenerationProgressActive(connectingVideo), false);
assert.equal(whiteboardGenerationProgressTarget(connectingVideo), null);

const queuedVideo = {
  channel: "video",
  status: "queued",
  providerStatus: "queued",
  providerTaskId: "provider-1",
  submissionState: "submitted",
  providerQueuePosition: 2,
  providerQueueLength: 9,
};
assert.equal(whiteboardGenerationMeasurementActive(queuedVideo), true);
assert.equal(whiteboardGenerationProgressActive(queuedVideo), false);

const runningVideo = { ...queuedVideo, status: "running", providerStatus: "running", providerProgressPercent: 41 };
assert.equal(whiteboardGenerationProgressActive(runningVideo), true);
assert.equal(whiteboardGenerationProgressTarget(runningVideo), 41);
assert.match(app, /interactionStartedAt: new Date\(submissionFeedback\.startedAt/u);
assert.doesNotMatch(app, /status: "streaming",\s*startedAt: Date\.now\(\),\s*elapsedMs: 0/u);
assert.match(app, /generationJobInteractionStartedAt\(job\)/u);
assert.match(store, /interactionStartedAt: normalizedInteractionStartedAt\(request\)/u);
assert.match(store, /startedAt: normalizedInteractionStartedAt\(normalizedRequest, now\)/u);
assert.match(worker, /capability\.taskResourceChecked !== true/u);
assert.match(worker, /forceFresh: dreaminaCliMediaJob\(job\)/u);
assert.match(worker, /task-resource sessions can expire independently/u);
assert.match(await readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8"), /forceFresh \? \{ SHENSI_DREAMINA_CONNECTION_CACHE_MS: "0" \} : \{\}/u);
assert.match(server, /dreaminaTaskResourceReady/u);

const fixture = fileURLToPath(new URL("./fixtures/fake-dreamina-submit-status.mjs", import.meta.url));
const runBridgeProbe = (bridge, stateRoot, authFailure = false) => spawnSync(process.execPath, [
  fileURLToPath(new URL(`../src/cli/${bridge}`, import.meta.url)),
  "--check",
], {
  encoding: "utf8",
  env: {
    ...process.env,
    SHENSI_DREAMINA_EXECUTABLE: process.execPath,
    SHENSI_DREAMINA_PREFIX_ARGS: JSON.stringify([fixture]),
    SHENSI_DREAMINA_PROFILE_ID: "readiness-contract",
    SHENSI_DREAMINA_EXPECTED_USER_ID: "fixture-user",
    SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT: "fixture-fingerprint",
    SHENSI_DREAMINA_CONNECTION_CACHE_MS: "0",
    SHENSI_MEDIA_PROVIDER_STATE_ROOT: stateRoot,
    ...(authFailure ? { SHENSI_TEST_DREAMINA_TASK_AUTH_FAILURE: "1" } : {}),
  },
});

const temporaryRoot = await mkdtemp(join(tmpdir(), "shensi-generation-lifecycle-"));
try {
  for (const bridge of ["dreamina-image-cli.mjs", "dreamina-video-cli.mjs"]) {
    const successful = runBridgeProbe(bridge, join(temporaryRoot, bridge, "ready"));
    assert.equal(successful.status, 0, `${bridge} 的任务资源成功响应必须通过连接检查：${successful.stderr}`);
    const payload = JSON.parse(successful.stdout);
    assert.equal(payload.taskResourceChecked, true);
    assert.equal(payload.generationReady, true);

    const rejected = runBridgeProbe(bridge, join(temporaryRoot, bridge, "rejected"), true);
    assert.notEqual(rejected.status, 0, `${bridge} 的任务资源未登录不得误报连接成功`);
    assert.match(rejected.stderr, /DREAMINA_AUTH_REQUIRED/u);
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("Whiteboard generation lifecycle and Dreamina readiness contracts passed");
