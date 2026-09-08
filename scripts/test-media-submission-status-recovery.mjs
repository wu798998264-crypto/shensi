import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  mediaSubmissionOutcomeIsUncertain,
  recoverUnknownMediaSubmission,
} from "../src/media-generation-coordination.js";

assert.equal(mediaSubmissionOutcomeIsUncertain(new TypeError("fetch failed")), true);
assert.equal(mediaSubmissionOutcomeIsUncertain(Object.assign(new Error("余额不足"), {
  code: "INSUFFICIENT_CREDITS",
  status: 402,
  responseReceived: true,
})), false, "明确的业务错误不得被当成响应丢失并自动重试");

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-media-status-recovery-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

try {
  const { createMediaGenerationJob } = await import(`../src/server/generation-job-store.mjs?submission-status-recovery=${Date.now()}`);
  const target = {
    workspaceKind: "notebook",
    workspacePath: join(dataRoot, "workspace"),
    documentId: "image-status-board",
    nodeId: "image-status-card",
  };
  const request = {
    prompt: "验证创建响应丢失后仍能找回同一个图片任务",
    settings: {
      id: "aggregate-image-test",
      connectionId: "aggregate-image-test",
      provider: "OpenAI",
      adapter: "api",
      model: "gpt-image-1",
    },
    aspectRatio: "1:1",
    quality: "standard",
  };
  const submissionId = "submission-status-recovery-0001";
  let attempts = 0;
  let createdBeforeResponseLoss = null;
  const uncertainEvents = [];
  let recoveredEvent = null;
  const recovered = await recoverUnknownMediaSubmission(async () => {
    attempts += 1;
    const job = await createMediaGenerationJob({ channel: "image", target, request, submissionId });
    if (attempts === 1) {
      createdBeforeResponseLoss = job;
      throw new TypeError("fetch failed after the server created the task");
    }
    return job;
  }, {
    wait: async () => {},
    maxAttempts: 3,
    onUncertain: (event) => uncertainEvents.push(event),
    onRecovered: (event) => { recoveredEvent = event; },
  });

  assert.equal(attempts, 2, "首次响应丢失后应以同一提交编号重连一次");
  assert.equal(recovered.id, createdBeforeResponseLoss.id, "重连必须找回原任务，不能创建第二个收费任务");
  assert.equal(recovered.reused, true, "服务端必须把同一提交编号识别为幂等重试");
  assert.equal(uncertainEvents.length, 1);
  assert.equal(recoveredEvent?.uncertainFailures, 1);

  let definitiveAttempts = 0;
  await assert.rejects(() => recoverUnknownMediaSubmission(async () => {
    definitiveAttempts += 1;
    throw Object.assign(new Error("余额不足"), {
      code: "INSUFFICIENT_CREDITS",
      status: 402,
      responseReceived: true,
    });
  }, { wait: async () => {}, maxAttempts: 3 }), /余额不足/);
  assert.equal(definitiveAttempts, 1, "明确失败不得自动重发收费请求");

  console.log("media submission status recovery tests passed");
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
