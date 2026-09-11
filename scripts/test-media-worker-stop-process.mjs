import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminateMediaGenerationWorker } from "../src/server/media-worker-manager.mjs";

if (process.platform !== "win32") {
  console.log("Windows process-owner recovery test is not applicable on this platform");
} else {
  const root = await mkdtemp(join(tmpdir(), "shensi-worker-stop-"));
  const script = join(root, "media-generation-worker.mjs");
  await writeFile(script, 'setInterval(() => {}, 1000); process.stdout.write("ready");');
  const jobs = ["generation-" + randomUUID(), "generation-" + randomUUID()];
  const children = jobs.map((jobId) => spawn(process.execPath, [script, "--job", jobId], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
  const closes = children.map((child) => once(child, "close"));
  try {
    await Promise.all(children.map((child) => once(child.stdout, "data")));
    const result = await terminateMediaGenerationWorker({ jobId: jobs[0], pid: 0 });
    assert.equal(result.verified, true, JSON.stringify(result));
    assert.equal(result.pid, children[0].pid);
    assert.equal(result.terminated, true);
    assert.equal(result.exited, true);
    assert.equal(children[1].exitCode, null, "不得结束另一任务的进程");
    const absent = await terminateMediaGenerationWorker({ jobId: jobs[0], pid: 0 });
    assert.equal(absent.verified, false, "不能把查找进程自身当作媒体进程");
    assert.equal(absent.pid, 0);
    assert.equal(absent.scanError, "");
    console.log("Windows worker recovery: no saved PID, exact job targeting, unrelated worker preserved, scanner excluded passed");
  } finally {
    for (const child of children) if (child.exitCode === null && !child.killed) child.kill();
    await Promise.all(closes);
    await rm(root, { recursive: true, force: true });
  }
}
