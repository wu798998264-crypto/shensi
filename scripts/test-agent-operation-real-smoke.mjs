import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-agent-operation-"));
const port = 41994;
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, SHENSI_DATA_ROOT: root },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += String(chunk); });
child.stderr.on("data", (chunk) => { output += String(chunk); });

const skill = `---
schema_version: 2
id: agent-operation-smoke
version: 1.0.0
name: Agent Operation Smoke
author: local
description: A focused smoke skill for controlled panel binding.
capability_boundary: Only provide concise review advice and never write files.
capabilities:
  - effect_reviewer
role: reviewer
workspace_modes:
  - project
output_contract: text_candidate
trigger_keywords:
  - smoke review
trigger_conditions:
  - workspace: project
---

When explicitly requested, inspect the supplied candidate and return a concise review with one actionable observation.`;

const waitForServer = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) return response.text();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${output.slice(-800)}`);
};

try {
  const index = await waitForServer();
  const token = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "session token must be present");
  const headers = { "content-type": "application/json", origin, "x-shensi-session": token };
  const post = async (pathname, body) => {
    const response = await fetch(`${origin}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.ok, true, `${pathname}: ${payload.message || payload.code || response.status}`);
    assert.notEqual(payload.ok, false, `${pathname}: ${payload.message || payload.code || "operation failed"}`);
    return payload;
  };
  const proposal = await post("/api/agent/operations/propose", { kind: "skill_install", content: skill });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.proposal?.target, "小说自检模块");
  const execution = await post("/api/agent/operations/execute", { operationId: proposal.operationId, confirmed: true });
  assert.equal(execution.completionStatus, "verified");
  assert.equal(execution.skill?.name, "Agent Operation Smoke");
  assert.equal(execution.targetModule?.name, "小说自检模块");
  assert.equal(execution.binding?.capabilities?.[0], "effect_reviewer");
  console.log("agent operation real smoke passed");
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await rm(root, { recursive: true, force: true });
}
