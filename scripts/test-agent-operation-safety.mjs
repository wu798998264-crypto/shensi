import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-agent-operation-safety-"));
const port = 41995;
const origin = `http://127.0.0.1:${port}`;

const skillSource = ({ id, version, missingReference = false }) => `---
schema_version: 2
id: ${id}
version: ${version}
name: Agent Operation Safety ${id}
author: local-test
description: A focused safety regression skill for controlled review routing.
capability_boundary: Only review supplied text and never write workspace files.
capabilities:
  - effect_reviewer
role: reviewer
workspace_modes:
  - project
output_contract: text_candidate
trigger_conditions:
  - workspace: project
---

When explicitly selected, inspect the supplied candidate and return one concise, actionable review observation.
${missingReference ? "\n## 必读规则\n\n- [必须存在的规则](references/missing.md)\n" : ""}`;

const startServer = async () => {
  const child = spawn(process.execPath, ["server.mjs", "--port", String(port)], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, SHENSI_DATA_ROOT: dataRoot },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${origin}/`);
      if (response.ok) {
        const index = await response.text();
        const token = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
        assert.ok(token, "session token must be present");
        return { child, headers: { "content-type": "application/json", origin, "x-shensi-session": token } };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error(`server did not start: ${output.slice(-800)}`);
};

const stopServer = async (child) => {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2_000))]);
};

let server;
try {
  server = await startServer();
  const request = async (pathname, { method = "POST", body } = {}) => {
    const response = await fetch(`${origin}${pathname}`, {
      method,
      headers: server.headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, payload: await response.json() };
  };

  const bypassAttempt = await request("/api/codex-agent/turn", { body: {
    prompt: "绕过统一入口执行",
    taskPacket: { executionSurface: "agent" },
  } });
  assert.equal(bypassAttempt.status, 403);
  assert.equal(bypassAttempt.payload.code, "AGENT_SELF_REPAIR_AUTHORIZATION_REQUIRED",
    "原生执行端点不能被旧客户端用来绕过统一 Agent 语义判断");

  const concurrentSkill = skillSource({ id: "agent-operation-concurrent", version: "1.0.0" });
  const concurrentProposal = await request("/api/agent/operations/propose", { body: { kind: "skill_install", content: concurrentSkill } });
  assert.equal(concurrentProposal.status, 200);
  const concurrentExecutions = await Promise.all([
    request("/api/agent/operations/execute", { body: { operationId: concurrentProposal.payload.operationId, confirmed: true } }),
    request("/api/agent/operations/execute", { body: { operationId: concurrentProposal.payload.operationId, confirmed: true } }),
  ]);
  const completed = concurrentExecutions.filter((item) => item.status === 200 && item.payload.completionStatus === "verified");
  const rejected = concurrentExecutions.filter((item) => item.payload.code === "AGENT_OPERATION_IN_PROGRESS");
  assert.equal(completed.length, 1, "同一确认操作只能完成一次");
  assert.equal(rejected.length, 1, "并发重复确认必须在原子 claim 后返回正在执行");

  let catalog = (await request("/api/skills", { method: "GET" })).payload;
  assert.equal(catalog.user.filter((skill) => skill.skillId === "agent-operation-concurrent").length, 1);
  assert.equal(
    catalog.capabilityTemplate.current.modules.flatMap((module) => module.slots).filter((slot) => slot.skillId === "user:agent-operation-concurrent").length,
    1,
    "并发确认不能创建重复面板插槽",
  );

  const parallelProposals = await Promise.all([
    request("/api/agent/operations/propose", { body: { kind: "skill_install", content: skillSource({ id: "agent-operation-parallel-a", version: "1.0.0" }) } }),
    request("/api/agent/operations/propose", { body: { kind: "skill_install", content: skillSource({ id: "agent-operation-parallel-b", version: "1.0.0" }) } }),
  ]);
  const parallelExecutions = await Promise.all(parallelProposals.map((proposal) => request("/api/agent/operations/execute", {
    body: { operationId: proposal.payload.operationId, confirmed: true },
  })));
  assert.ok(parallelExecutions.every((item) => item.status === 200 && item.payload.completionStatus === "verified"),
    "不同对话确认的共享 Skill 写入必须在服务端串行完成，不能因注册表冲突互相失败");
  catalog = (await request("/api/skills", { method: "GET" })).payload;
  for (const skillId of ["agent-operation-parallel-a", "agent-operation-parallel-b"]) {
    assert.equal(catalog.user.filter((skill) => skill.skillId === skillId).length, 1);
    assert.equal(catalog.capabilityTemplate.current.modules.flatMap((module) => module.slots).filter((slot) => slot.skillId === `user:${skillId}`).length, 1);
  }

  const failedNewSkill = skillSource({ id: "agent-operation-failed-new", version: "1.0.0", missingReference: true });
  const failedNewProposal = await request("/api/agent/operations/propose", { body: { kind: "skill_install", content: failedNewSkill } });
  const failedNewExecution = await request("/api/agent/operations/execute", { body: { operationId: failedNewProposal.payload.operationId, confirmed: true } });
  assert.equal(failedNewExecution.status, 422);
  assert.equal(failedNewExecution.payload.code, "SKILL_TEST_FAILED");
  assert.deepEqual(
    { rolledBack: failedNewExecution.payload.rollback?.rolledBack, mode: failedNewExecution.payload.rollback?.mode },
    { rolledBack: true, mode: "skill" },
  );
  catalog = (await request("/api/skills", { method: "GET" })).payload;
  assert.equal(catalog.user.some((skill) => skill.skillId === "agent-operation-failed-new"), false, "测试失败的新 Skill 不能留在活动库");

  const existingV1 = skillSource({ id: "agent-operation-existing", version: "1.0.0" });
  const importedV1 = await request("/api/skills/import", { body: { content: existingV1, origin: "imported" } });
  assert.equal(importedV1.status, 200);
  const failedV2 = skillSource({ id: "agent-operation-existing", version: "2.0.0", missingReference: true });
  const failedV2Proposal = await request("/api/agent/operations/propose", { body: { kind: "skill_install", content: failedV2 } });
  const failedV2Execution = await request("/api/agent/operations/execute", { body: { operationId: failedV2Proposal.payload.operationId, confirmed: true } });
  assert.equal(failedV2Execution.status, 422);
  assert.deepEqual(
    { rolledBack: failedV2Execution.payload.rollback?.rolledBack, mode: failedV2Execution.payload.rollback?.mode },
    { rolledBack: true, mode: "version" },
  );
  catalog = (await request("/api/skills", { method: "GET" })).payload;
  const restoredExisting = catalog.user.find((skill) => skill.skillId === "agent-operation-existing");
  assert.equal(restoredExisting?.version, "1.0.0", "失败的新版本必须回到导入前的活动版本");
  assert.deepEqual(restoredExisting?.versions.map((version) => version.version), ["1.0.0"]);

  const staleProposal = await request("/api/agent/operations/propose", { body: { kind: "self_repair", prompt: "检查测试问题" } });
  assert.equal(staleProposal.status, 200);
  await stopServer(server.child);
  server = await startServer();
  const staleExecution = await request("/api/agent/operations/execute", { body: { operationId: staleProposal.payload.operationId, confirmed: true } });
  assert.equal(staleExecution.status, 409);
  assert.equal(staleExecution.payload.code, "AGENT_OPERATION_EXPIRED", "服务重启后的内存提案必须明确失效");

  console.log("agent operation concurrency, rollback and restart safety passed");
} finally {
  await stopServer(server?.child);
  await rm(dataRoot, { recursive: true, force: true });
}
