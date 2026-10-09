import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { openAiImageRecoveryFailure, openAiImageRecoveryFailurePatch } from "../src/cli/openai-image-recovery-error.mjs";
import { parseStructuredCliError } from "../src/server/adapters.mjs";

const unknown = openAiImageRecoveryFailurePatch(Object.assign(new Error("network lost"), { submissionOutcomeKnown: false }));
assert.equal(unknown.state, "submission_unknown");
assert.equal(openAiImageRecoveryFailure(unknown), null, "未知提交不能误判为终止失败");
assert.equal(openAiImageRecoveryFailure({ state: "running" }), null, "旧格式记录仍可安全找回");

const root = await mkdtemp(join(tmpdir(), "shensi-openai-terminal-recovery-"));
try {
  const skill = join(root, "SKILL.md");
  const submissions = join(root, "submissions.txt");
  await writeFile(skill, "Mock image skill; never uses a provider.");
  const key = "mock-known-failure";
  const env = {
    ...process.env, CODEX_HOME: root, OPENAI_API_KEY: "",
    SHENSI_CODEX_EXECUTABLE: process.execPath,
    SHENSI_CODEX_PREFIX_ARGS: JSON.stringify([fileURLToPath(new URL("./fixtures/openai-image-failure-app-server.mjs", import.meta.url))]),
    SHENSI_OPENAI_IMAGE_SKILL_PATH: skill,
    SHENSI_TEST_IMAGE_SUBMISSIONS: submissions,
    SHENSI_MEDIA_IDEMPOTENCY_KEY: key,
    SHENSI_MEDIA_RECOVERY_ONLY: "",
    SHENSI_MEDIA_FORCE_NEW_SUBMISSION: "",
    SHENSI_TEST_IMAGE_FAILURE: "",
  };
  const cli = fileURLToPath(new URL("../src/cli/openai-image-cli.mjs", import.meta.url));
  const run = promisify(execFile);
  const args = [cli, "--prompt", "mock prompt", "--output", join(root, "output.png")];
  const first = await run(process.execPath, args, { env, timeout: 15_000, windowsHide: true }).then(() => null, (error) => error);
  assert.ok(first);
  const receipt = parseStructuredCliError(first.stderr);
  assert.equal(receipt.providerErrorCode, "badRequest");
  assert.equal(receipt.submissionOutcomeKnown, true);
  const journalPath = join(root, "shensi_media_recovery", "images", `${createHash("sha256").update(key).digest("hex")}.json`);
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  assert.equal(journal.state, "failed");
  assert.equal(journal.failure.message, "mock invalid reference");
  const second = await run(process.execPath, args, { env: { ...env, SHENSI_MEDIA_RECOVERY_ONLY: "1" }, timeout: 15_000, windowsHide: true }).then(() => null, (error) => error);
  assert.equal(parseStructuredCliError(second.stderr).providerErrorCode, "badRequest", "恢复检查必须返回原始终态错误，不得伪装成仍在核对");
  assert.equal((await readFile(submissions, "utf8")).trim(), "submitted", "恢复检查不得再次调用 turn/start");
  assert.deepEqual(JSON.parse(await readFile(journalPath, "utf8")), journal, "只读恢复不得覆写原始失败原因");
  const unknownKey = "mock-unknown-submission";
  const unknownEnv = { ...env, SHENSI_MEDIA_IDEMPOTENCY_KEY: unknownKey, SHENSI_TEST_IMAGE_FAILURE: "stream" };
  const interrupted = await run(process.execPath, args, { env: unknownEnv, timeout: 15_000, windowsHide: true }).then(() => null, (error) => error);
  assert.equal(parseStructuredCliError(interrupted.stderr).submissionOutcomeKnown, false);
  const unknownPath = join(root, "shensi_media_recovery", "images", `${createHash("sha256").update(unknownKey).digest("hex")}.json`);
  const unknownJournal = JSON.parse(await readFile(unknownPath, "utf8"));
  assert.equal(unknownJournal.state, "submission_unknown");
  assert.equal(unknownJournal.failure.message, "mock stream lost");
  const recheck = await run(process.execPath, args, { env: { ...unknownEnv, SHENSI_MEDIA_RECOVERY_ONLY: "1" }, timeout: 15_000, windowsHide: true }).then(() => null, (error) => error);
  assert.match(parseStructuredCliError(recheck.stderr).structuredMessage, /RECOVERY_PENDING.*mock stream lost/u, "未知提交继续核对，但必须保留上次真实错误");
  assert.equal((await readFile(submissions, "utf8")).trim().split("\n").length, 2, "两笔任务各提交一次，任何恢复检查都不能再次提交");
  console.log("OpenAI image terminal diagnostics and no-resubmit recovery passed");
} finally {
  assert.ok(resolve(root).startsWith(resolve(tmpdir())));
  await rm(root, { recursive: true, force: true });
}
