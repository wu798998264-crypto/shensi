import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = await mkdtemp(join(tmpdir(), "shensi-worker-pipeline-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;
const store = await import("../src/server/generation-job-store.mjs");
const preload = join(root, "provider-fixture.mjs");
const log = join(root, "calls.jsonl");
const driverUrl = new URL("../src/server/media-provider-drivers.mjs", import.meta.url).href;
await writeFile(preload, `
import {appendFile} from 'node:fs/promises';
import {LibTvMediaDriver, DreaminaVideoDriver} from ${JSON.stringify(driverUrl)};
const mode=process.env.FIXTURE_MODE;
globalThis.fetch=()=>{throw new Error('Network forbidden in fixture');};
const failure=(code,message,extra={})=>Object.assign(new Error(message),{providerErrorCode:code,...extra});
LibTvMediaDriver.prototype.probeCapabilities=async()=>({available:true,models:['fixture'],visibilityChecked:true});
LibTvMediaDriver.prototype.modelSchema=async()=>({schema:{modelName:'Fixture',config:{settings:{text2video:[]}}}});
LibTvMediaDriver.prototype.project=async()=>({projectUuid:'fixture-project'});
LibTvMediaDriver.prototype.invoke=async function(args){
  await appendFile(${JSON.stringify(log)},JSON.stringify({mode,args})+'\\n');
  if(args[1]==='create') {
    if(mode==='create-fails') throw failure('CLI_REJECTED','CLI创建节点的真实错误');
    return {nodeKey:'fixture-node'};
  }
  if(mode==='poll-fails') throw failure('DRIVER_EXIT_FAILED','CLI查询原任务的真实网络错误');
  return {taskId:'fixture-task',data:{taskInfo:{status:3,failedReason:'CLI厂商生成失败原因'}}};
};
DreaminaVideoDriver.prototype.probeCapabilities=async()=>{
  if(mode==='broker-busy') throw failure('DREAMINA_PROFILE_BROKER_BUSY','CLI凭证槽忙的真实原因',{submissionOutcomeKnown:true});
  return {available:true,taskResourceChecked:true};
};
DreaminaVideoDriver.prototype.invoke=async()=>({providerTaskId:'dreamina-fixture-task',providerStatus:'failed',rawStatus:'fail',errorCode:'DREAMINA_TASK_REFERENCE_UPLOAD_FAILED',error:'ApplyImageUpload: context deadline exceeded'});
`);
const runWorker = (jobId, mode) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, fileURLToPath(new URL("../src/server/media-generation-worker.mjs", import.meta.url)), "--job", jobId], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), windowsHide: true,
    env: { ...process.env, FIXTURE_MODE: mode }, stdio: ["ignore", "pipe", "pipe"],
  });
  let detail = "";
  child.stdout.on("data", (chunk) => { detail += chunk; });
  child.stderr.on("data", (chunk) => { detail += chunk; });
  child.once("error", reject);
  child.once("close", (code) => code ? reject(new Error(detail || `worker exit ${code}`)) : resolve());
});
let count = 0;
const create = (provider, channel = "image") => store.createMediaGenerationJob({
  channel, target: { workspaceKind: "notebook", workspacePath: root, documentId: "fixture", nodeId: `card-${count++}` },
  request: { prompt: "短提示词", settings: { id: provider === "LibTV" ? "image-libtv" : "video-dreamina-cli", provider, adapter: "cli", protocol: "media", model: "fixture", cliPath: provider === "LibTV" ? "libtv" : "shensi-dreamina-video", dreaminaCliProfile: "fixture-profile" } },
});
try {
  const rejected = await create("LibTV");
  await runWorker(rejected.id, "create-fails");
  const error = await store.getGenerationJob({ jobId: rejected.id });
  assert.equal(error.status, "failed", JSON.stringify(error));
  assert.equal(error.submissionState, "not_submitted");
  assert.equal(error.providerErrorCode, "CLI_REJECTED");
  assert.match(error.error, /CLI创建节点的真实错误/);
  assert.equal(error.lastProviderError.phase, "creating_node");
  assert.equal(error.billingRisk, "");
  const missingReference = await create("LibTV");
  await store.updateMediaGenerationJob({ jobId: missingReference.id, patch: { request: { ...missingReference.request, referenceMedia: [{ relativePath: "not-present.png", mimeType: "image/png" }] } } });
  await runWorker(missingReference.id, "terminal");
  const referenceError = await store.getGenerationJob({ jobId: missingReference.id });
  assert.equal(referenceError.status, "failed");
  assert.equal(referenceError.submissionState, "not_submitted", "本地读取参考失败不得进入提交不确定状态");
  assert.equal(referenceError.attempt, 0);
  const videoRejected = await create("LibTV", "video");
  await runWorker(videoRejected.id, "create-fails");
  const videoError = await store.getGenerationJob({ jobId: videoRejected.id });
  assert.equal(videoError.status, "failed");
  assert.equal(videoError.submissionState, "not_submitted");
  assert.match(videoError.error, /CLI创建节点的真实错误/);
  const terminal = await create("LibTV");
  await runWorker(terminal.id, "terminal");
  const terminalError = await store.getGenerationJob({ jobId: terminal.id });
  assert.equal(terminalError.status, "failed");
  assert.match(terminalError.error, /CLI厂商生成失败原因/);
  const polling = await create("LibTV");
  for (let i = 0; i < 4; i++) {
    await store.updateMediaGenerationJob({ jobId: polling.id, patch: { nextPollAt: "" } });
    await runWorker(polling.id, "poll-fails");
  }
  const exhausted = await store.getGenerationJob({ jobId: polling.id });
  assert.equal(exhausted.status, "retry_required");
  assert.equal(exhausted.providerTaskId, "fixture-node");
  assert.equal(exhausted.connectionRetryExhausted, true);
  assert.match(exhausted.error, /CLI查询原任务的真实网络错误/);
  assert.equal((await store.listMediaGenerationJobsForWorker()).some((job) => job.id === polling.id), false);
  const calls = (await readFile(log, "utf8")).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter((entry) => entry.mode === "poll-fails" && entry.args.includes("--run")).length, 1);
  await store.requestMediaGenerationResume({ jobId: polling.id });
  assert.equal((await store.getGenerationJob({ jobId: polling.id })).connectionRetryExhausted, false);
  const busy = await create("即梦", "video");
  for (let i = 0; i < 4; i++) {
    await store.updateMediaGenerationJob({ jobId: busy.id, patch: { nextPollAt: "" } });
    await runWorker(busy.id, "broker-busy");
  }
  const busyStopped = await store.getGenerationJob({ jobId: busy.id });
  assert.equal(busyStopped.status, "failed", JSON.stringify(busyStopped));
  assert.equal(busyStopped.connectionRetryExhausted, true);
  assert.match(busyStopped.error, /CLI凭证槽忙的真实原因/);
  const taskUpload = await create("即梦", "video");
  await runWorker(taskUpload.id, "task-upload");
  const uploadFailed = await store.getGenerationJob({ jobId: taskUpload.id });
  assert.equal(uploadFailed.status, "failed");
  assert.equal(uploadFailed.providerTaskId, "dreamina-fixture-task");
  assert.equal(uploadFailed.providerErrorCode, "DREAMINA_TASK_REFERENCE_UPLOAD_FAILED");
  assert.match(uploadFailed.error, /ApplyImageUpload/);
  console.log("Real worker process: LibTV submit failure -> stored error, terminal JSON, bounded query-only recovery, Dreamina broker exhaustion passed");
} finally { await rm(root, { recursive: true, force: true }); }
