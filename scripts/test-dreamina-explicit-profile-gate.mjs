import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dreaminaFailureDiagnosis, dreaminaFailureRequiresAccountVerification } from "../src/dreamina-failure.js";

assert.equal(dreaminaFailureRequiresAccountVerification({ code: "DREAMINA_PROFILE_REQUIRED" }), false);
assert.equal(dreaminaFailureDiagnosis({ code: "DREAMINA_PROFILE_REQUIRED" }).category, "profile_selection_required");
assert.equal(dreaminaFailureRequiresAccountVerification({ code: "DREAMINA_PROFILE_ID_INVALID" }), false);
assert.equal(dreaminaFailureRequiresAccountVerification({ code: "DREAMINA_PROFILE_ID_MISMATCH" }), false);
assert.equal(dreaminaFailureDiagnosis({ code: "DREAMINA_PROFILE_ID_MISMATCH" }).category, "profile_routing_mismatch");
assert.equal(dreaminaFailureDiagnosis({ code: "PROVIDER_FAILED", message: "api error: CreditPreDeductNotEnough" }).code, "DREAMINA_INSUFFICIENT_CREDIT");
assert.equal(dreaminaFailureDiagnosis({ code: "PROVIDER_FAILED", message: "api error: CreditPreDeductNotEnough" }).category, "insufficient_credit");

const root = await mkdtemp(join(tmpdir(), "shensi-dreamina-explicit-profile-"));
process.env.SHENSI_DATA_ROOT = root;
process.env.SHENSI_MACHINE_DATA_ROOT = root;

try {
  const { createMediaGenerationJob } = await import(`../src/server/generation-job-store.mjs?explicit=${Date.now()}`);
  const target = {
    workspaceKind: "project",
    workspacePath: join(root, "workspace"),
    documentId: "whiteboard-1",
    nodeId: "card-1",
    targetType: "whiteboard-node",
  };
  await assert.rejects(
    createMediaGenerationJob({
      channel: "image",
      target,
      request: { prompt: "测试", settings: { id: "image-unbound", provider: "即梦", adapter: "cli", model: "5.0" } },
    }),
    (error) => error?.code === "DREAMINA_PROFILE_REQUIRED" && error?.statusCode === 422,
    "缺少明确账号的即梦任务必须在创建与收费提交前被阻断",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("即梦明确账号任务门禁测试通过");
