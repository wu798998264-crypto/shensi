import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { createBlankProjectState } from "../src/data.js";
import { saveWorkspaceState } from "../src/server/workspace.mjs";

const root = resolve(".");
const workspacePath = resolve("./runtime/library-archive-api-test");
const port = 41999;
const base = `http://127.0.0.1:${port}`;

const waitFor = async (predicate, timeoutMs = 30_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("library archive API test server did not become ready");
};

await rm(workspacePath, { recursive: true, force: true });
const state = createBlankProjectState({ name: "归档 API 烟测", workspacePath });
const sourceText = "人物档案：林岚是负责调查旧港失踪案的侦探。她不能读取梦境，也不能修改过去。";
state.documents["library-reference"] = {
  ...(state.documents["library-reference"] || {}),
  title: "参考资料",
  markdown: sourceText,
  html: `<h1>参考资料</h1><p>${sourceText}</p>`,
  moduleId: "library",
};
state.moduleItems.library = [["library-reference", "参考资料"]];
const targetText = "## 林岚\n- 身份：侦探\n- 当前状态：调查旧港失踪案";
state.documents["canon-characters"] = {
  title: "人物设定",
  markdown: targetText,
  html: "<h1>人物设定</h1><h2>林岚</h2><p>- 身份：侦探</p><p>- 当前状态：调查旧港失踪案</p>",
  moduleId: "canon",
};
state.moduleItems.canon = [["canon-characters", "人物设定"]];
await saveWorkspaceState({ appRoot: root, requestedPath: workspacePath, state });

const child = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let childOutput = "";
child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
try {
  await waitFor(async () => {
    try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
  });
  const page = await (await fetch(`${base}/`)).text();
  const token = page.match(/shensi-session-token[^>]*content=["']([^"']+)/u)?.[1];
  assert.ok(token, `session token missing: ${childOutput.slice(-500)}`);
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shensi-session": token },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    assert.equal(typeof payload.ok, "boolean", `${path} returned malformed JSON`);
    return { response, payload };
  };

  const planned = await post("/api/workspace/library-archive/plan", {
    workspacePath,
    instruction: "读取资料库并拆分归档到人物设定",
  });
  assert.equal(planned.response.status, 200);
  assert.ok(planned.payload.sourceSnapshotHash);
  assert.ok(planned.payload.snapshot.documents["library-reference"]);

  const source = planned.payload.snapshot.documents["library-reference"];
  const rawPlan = {
    schema: "shensi.library-archive-plan.v1",
    sourceSnapshotHash: planned.payload.sourceSnapshotHash,
    sourceDocumentIds: planned.payload.sourceDocumentIds,
    candidates: [{
      candidateId: "api-test-candidate",
      sourceDocumentId: "library-reference",
      sourceRevision: source.revision,
      sourceHash: source.contentHash,
      sourceQuote: "林岚是负责调查旧港失踪案的侦探",
      targetDocumentId: "canon-characters",
      targetSection: "林岚",
      disposition: "update",
      operation: "append",
      content: "- 能力与限制：不能读取梦境，也不能修改过去。",
    }],
  };
  const prepared = await post("/api/workspace/library-archive/prepare", {
    workspacePath,
    snapshotHash: planned.payload.sourceSnapshotHash,
    plan: rawPlan,
  });
  assert.equal(prepared.response.status, 200, JSON.stringify(prepared.payload));
  assert.ok(prepared.payload.fingerprint);
  assert.equal(prepared.payload.plan.candidates[0].disposition, "update");

  const committed = await post("/api/workspace/library-archive/commit", {
    workspacePath,
    confirmed: true,
    snapshotHash: prepared.payload.sourceSnapshotHash,
    fingerprint: prepared.payload.fingerprint,
    plan: prepared.payload.plan,
  });
  assert.equal(committed.response.status, 200, JSON.stringify(committed.payload));
  assert.equal(committed.payload.status, "completed");
  assert.equal(committed.payload.transaction.status, "completed");

  const loaded = await post("/api/workspace/load", { workspacePath });
  assert.match(String(loaded.payload.state.documents["canon-characters"].markdown || ""), /不能读取梦境/u);
  assert.equal(String(loaded.payload.state.documents["library-reference"].markdown || ""), sourceText);

  const stale = await post("/api/workspace/library-archive/commit", {
    workspacePath,
    confirmed: true,
    snapshotHash: prepared.payload.sourceSnapshotHash,
    fingerprint: prepared.payload.fingerprint,
    plan: prepared.payload.plan,
  });
  assert.equal(stale.response.status, 409);
  assert.match(String(stale.payload.code || ""), /PLAN_STALE|TARGET_STALE|SNAPSHOT_STALE/u);
  console.log("Library archive HTTP plan/prepare/commit test passed");
} finally {
  child.kill();
  await new Promise((resolveExit) => child.once("exit", resolveExit));
  await rm(workspacePath, { recursive: true, force: true });
}
