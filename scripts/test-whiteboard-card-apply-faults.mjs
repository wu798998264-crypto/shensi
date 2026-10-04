import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const extract = (start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `找不到实际函数 ${start}`);
  return source.slice(from, to);
};
const applySource = extract("const applyCompletedWhiteboardGenerationJobNow =", "const completedWhiteboardApplyRetries =");
const readbackSource = extract("const verifyWhiteboardGenerationCardReadback =", "const renderWhiteboardMultiSelection =");
const originalJob = {
  id: "generation-fault-result", mode: "server", status: "complete", channel: "image",
  target: { workspacePath: "C:/isolated-test", documentId: "board", nodeId: "card" },
  result: { attachment: { relativePath: "images/result.png", sha256: "a".repeat(64) } },
  landingReceipt: { sha256: "a".repeat(64) },
};
const node = { id: "card", generation: { jobId: originalJob.id } };
const asset = { id: "asset", generationJobId: originalJob.id };
const savedDocument = { documentKind: "whiteboard", canvas: { nodes: [node], assets: [asset] } };

for (const fault of ["409", "timeout", "stale", "success"]) {
  const events = [];
  const job = structuredClone(originalJob);
  const context = vm.createContext({
    Promise, Map, Date, Error, Object, String,
    state: { settings: { workspacePath: "C:/isolated-test" }, documents: {}, activeDocument: "board" },
    ui: { whiteboardCandidates: new Map() },
    recordCustomGenerationJobCapability() {}, usesDreaminaAccountCredits: () => false,
    whiteboardCandidateKey: () => "key", whiteboardCandidateBelongsToJob: () => true,
    normalizedWorkspacePath: (value) => value, whiteboardCanvasSnapshot: () => ({}),
    normalizeCanvas: (value) => value ?? { nodes: [], assets: [] },
    whiteboardGenerationContentFromJob: (value) => ({ kind: "image", attachment: value.result.attachment }),
    canvasNodeDisplaysGenerationContent: (value) => value?.generation?.jobId === job.id,
    updateWhiteboardCompletedApplyStage: (_job, stage) => events.push(["stage", stage]),
    markWhiteboardGenerationJobCardApplyPending: async (_id, status, error) => events.push(["persist-state", status, error]),
    writeWhiteboardGeneration: async () => {
      events.push(["write"]);
      if (fault === "409") throw Object.assign(new Error("保存冲突"), { code: "WORKSPACE_STATE_CONFLICT", statusCode: 409 });
      if (fault === "timeout") throw Object.assign(new Error("工作区保存超时"), { name: "TimeoutError" });
      return { documentState: savedDocument };
    },
    fetchWorkspacePayload: async () => ({ stateStamp: "saved-stamp", state: { documents: { board: fault === "stale"
      ? { documentKind: "whiteboard", canvas: { nodes: [], assets: [] } }
      : savedDocument } } }),
    markWhiteboardGenerationJobApplied: async (_id, _assetId, receipt) => events.push(["applied", receipt.verified]),
    releaseWhiteboardMediaSubmissionLockForJob: () => events.push(["release"]),
    finalizeWhiteboardCompletedCandidate: () => events.push(["finalize"]),
  });
  vm.runInContext(`${readbackSource}\n${applySource}\nglobalThis.applyJob = applyCompletedWhiteboardGenerationJob;`, context);
  if (fault === "success") {
    assert.equal(await context.applyJob(job), true);
    assert.ok(events.some(([type, verified]) => type === "applied" && verified));
    assert.ok(events.some(([type]) => type === "finalize"));
  } else {
    await assert.rejects(context.applyJob(job));
    assert.ok(events.some(([type, status]) => type === "persist-state" && status === "failed"), `${fault} 必须保存结果待回写错误`);
    assert.equal(events.some(([type]) => type === "applied" || type === "finalize"), false, `${fault} 不能误报回写成功或清除任务`);
    assert.deepEqual(job, originalJob, `${fault} 不得改写或丢失已生成结果与文件回执`);
    // No submit function is present in the execution context: any attempted
    // provider resubmission would fail this test rather than spending credits.
    assert.equal(await context.applyJob(job).then(() => true, () => false), false, "失败后 single-flight 必须释放，允许仅重试回写");
    assert.equal(events.filter(([type]) => type === "write").length, 2);
  }
}
console.log("Whiteboard actual card-apply functions: 409, timeout, stale readback, preserved receipts, no provider submit and success passed");
