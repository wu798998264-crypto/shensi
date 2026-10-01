import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-workspace-lock-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

const { createBlankProjectState } = await import("../src/data.js");
const { loadWorkspaceState, saveWorkspaceState } = await import("../src/server/workspace.mjs");

const workspacePath = join(dataRoot, "作品", "lock-wait");
const initial = createBlankProjectState({ name: "写入锁等待验收", workspacePath });
await saveWorkspaceState({ appRoot: dataRoot, requestedPath: workspacePath, state: initial });
const loaded = await loadWorkspaceState({ appRoot: dataRoot, requestedPath: workspacePath });
const lockPath = join(workspacePath, ".shensi", "workspace.lock");

// Simulate another Shensi process holding the real workspace lock. The child
// exits without cleanup to verify that the next writer waits, detects the dead
// owner, and safely removes only that stale lock record.
const childCode = `
  import { writeFile } from "node:fs/promises";
  await writeFile(${JSON.stringify(lockPath)}, JSON.stringify({
    pid: process.pid,
    token: "child-write-lock",
    mode: "write",
    createdAt: new Date().toISOString(),
  }));
  await new Promise((resolve) => setTimeout(resolve, 900));
`;
const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], { stdio: "ignore" });
for (let attempt = 0; attempt < 40; attempt += 1) {
  try {
    await stat(lockPath);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
await stat(lockPath);

const nextState = structuredClone(loaded.state);
nextState.documents["library-memo"].markdown = "# 删除期间的安全写入";
nextState.documents["library-memo"].html = "<h1>删除期间的安全写入</h1>";
const startedAt = Date.now();
const saved = await saveWorkspaceState({
  appRoot: dataRoot,
  requestedPath: workspacePath,
  state: nextState,
  expectedStateStamp: loaded.stateStamp,
  operationDocumentIds: ["library-memo"],
});
const waitedMs = Date.now() - startedAt;
assert.ok(waitedMs >= 100, `写入应等待活动锁释放，实际只等待 ${waitedMs}ms`);
assert.equal(saved.verificationStatus, "passed");
assert.equal((await stat(lockPath).catch(() => null)), null, "当前写入完成后不得遗留工作区锁");
await child.on("exit", () => {});

console.log(JSON.stringify({ ok: true, waitedMs, staleOwnerRecovered: true }, null, 2));
await rm(dataRoot, { recursive: true, force: true });
