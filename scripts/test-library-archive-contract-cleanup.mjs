import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { clearPendingLibraryArchiveDecisions } from "../src/server/library-archive-pending.mjs";

const matching = {
  workflow: "library_archive",
  workflowPayload: {
    fingerprint: "fp-a",
    workspacePath: "C:\\Workspaces\\Book-A",
  },
};
const otherFingerprint = {
  workflow: "library_archive",
  workflowPayload: {
    fingerprint: "fp-b",
    workspacePath: "C:/Workspaces/Book-A",
  },
};
const otherWorkspace = {
  workflow: "library_archive",
  workflowPayload: {
    fingerprint: "fp-a",
    workspacePath: "C:/Workspaces/Book-B",
  },
};
const unrelated = { workflow: "creative_writing" };
const pending = new Map([
  ["matching", matching],
  ["other-fingerprint", otherFingerprint],
  ["other-workspace", otherWorkspace],
  ["unrelated", unrelated],
]);

assert.equal(clearPendingLibraryArchiveDecisions({
  pendingDecisions: pending,
  fingerprint: "fp-a",
  workspacePath: "c:/workspaces/book-a",
}), 1, "只能清理同一工作区和计划指纹的归档合同");
assert.equal(pending.has("matching"), false);
assert.equal(pending.has("other-fingerprint"), true);
assert.equal(pending.has("other-workspace"), true);
assert.equal(pending.has("unrelated"), true);

const failedCommitPending = new Map([["failed", {
  workflow: "library_archive",
  workflowPayload: { fingerprint: "fp-failed", workspacePath: "C:/Workspaces/Book-A" },
}]]);
assert.equal(failedCommitPending.size, 1, "提交失败时合同应保持可重试状态");

const missingWorkspace = new Map([["missing-workspace", {
  workflow: "library_archive",
  workflowPayload: { fingerprint: "fp-missing" },
}]]);
assert.equal(clearPendingLibraryArchiveDecisions({
  pendingDecisions: missingWorkspace,
  fingerprint: "fp-missing",
  workspacePath: "C:/Workspaces/Book-A",
}), 0, "缺少工作区归属的合同不得被精确清理");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const routeStart = serverSource.indexOf('if (pathname === "/api/workspace/library-archive/commit"');
const noChangesCall = serverSource.indexOf("clearPendingLibraryArchiveDecisions({", routeStart);
const transactionFailure = serverSource.indexOf('code: "LIBRARY_ARCHIVE_TRANSACTION_FAILED"', routeStart);
const successCall = serverSource.indexOf("clearPendingLibraryArchiveDecisions({", transactionFailure);
assert.ok(routeStart >= 0 && noChangesCall > routeStart, "成功的无变化归档必须清理已确认合同");
assert.ok(transactionFailure > noChangesCall, "事务失败分支必须位于无变化成功分支之后");
assert.ok(successCall > transactionFailure, "事务成功分支必须清理已确认合同");
assert.match(serverSource.slice(routeStart, transactionFailure), /if \(!built\.operations\.length\)/u);
assert.doesNotMatch(serverSource.slice(routeStart, transactionFailure), /LIBRARY_ARCHIVE_TRANSACTION_FAILED[\s\S]*clearPendingLibraryArchiveDecisions/u,
  "事务失败响应前不得清理合同");

console.log("Library archive pending contract cleanup contracts passed");
