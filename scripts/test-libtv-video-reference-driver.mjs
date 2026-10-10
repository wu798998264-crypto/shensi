import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibTvMediaDriver } from "../src/server/media-provider-drivers.mjs";
const root = await mkdtemp(join(tmpdir(), "shensi-libtv-reference-driver-"));
const job = { id: "test", channel: "video", request: { prompt: "已经清理的显示文本", libTvReferencePrompt: "{{ignored}} 角色@「图片1」再次@「图片1」", providerPromptReferenceTokens: ["@「图片1」"], promptReferenceSequence: ["a", "a"], duration: "4", resolution: "720p", aspectRatio: "16:9", generateAudio: false, settings: { model: "star-video2-mini" } } };
const references = [{ id: "a", mimeType: "image/png", absolutePath: "reference.png" }];
try {
  const driver = new LibTvMediaDriver();
  driver.project = async () => ({ projectUuid: "project", boardScopeKey: "board", slot: 2 });
  const calls = [], receipts = [];
  driver.invoke = async (args, options = {}) => {
    calls.push(args);
    if (args[0] === "upload") return { nodeKey: "remote-image" };
    if (args.includes("create")) return { newNodeKey: "canvas-node" };
    if (args.includes("--run")) {
      assert.equal(receipts.length, 0, "未取得任务号前不能把画布节点当作生成任务");
      await options.onProviderTask({ providerTaskId: "real-task", providerStatus: "running" });
      return { status: "completed", taskId: "real-task" };
    }
    return { data: {} };
  };
  await driver.submit({ job, references, workRoot: root, onProviderTaskCreated: async receipt => receipts.push(receipt) });
  const create = calls.find(args => args.includes("create"));
  assert.equal(create[create.indexOf("--prompt") + 1], "{{ignored}} 角色{{Node remote-image}}再次{{Node remote-image}}");
  assert.deepEqual(create.slice(create.indexOf("--left")), ["--left", "remote-image"]);
  assert.equal(create[create.indexOf("--y") + 1], "7200");
  assert.equal(receipts[0].providerTaskId, "real-task");
  assert.equal(JSON.parse(await readFile(join(root, "libtv-node.json"), "utf8")).providerTaskId, "real-task");
  driver.invoke = async () => { throw Object.assign(new Error("original provider disconnect"), { providerErrorCode: "DRIVER_EXIT_FAILED" }); };
  await assert.rejects(driver.submit({ job, references, workRoot: root }), /original provider disconnect/u);
  assert.match(JSON.parse(await readFile(join(root, "libtv-video-run-error.json"), "utf8")).message, /original provider disconnect/u);
  driver.invoke = async () => ({ data: {} });
  const unknown = await driver.getStatus({ job, workRoot: root });
  assert.equal(unknown.providerStatus, "unknown");
  assert.equal(unknown.providerTaskId, "real-task");
  assert.match(unknown.error, /original provider disconnect/u);
  console.log("LibTV driver ordered inline references, real task receipts and error recovery passed");
} finally { await rm(root, { recursive: true, force: true }); }
