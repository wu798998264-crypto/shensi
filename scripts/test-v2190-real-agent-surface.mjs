import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createCodexAgentProvider } from "../src/server/codex-agent-provider.mjs";

const machineRoot = resolve(process.env.SHENSI_V2190_AGENT_MACHINE_ROOT || "artifacts/v2190-context-ab/agent-runtime");
const reportPath = resolve(process.env.SHENSI_V2190_AGENT_REPORT || "artifacts/v2190-context-ab/real-agent-surface.json");
await mkdir(machineRoot, { recursive: true });
const provider = createCodexAgentProvider({
  machineRoot,
  appRoot: process.cwd(),
  defaultProjectRoot: process.cwd(),
  appVersion: "2.18.8",
  finalResponseGraceMs: 2_000,
});
const requestId = `v2190-real-agent-${Date.now()}`;
const startedAt = Date.now();
try {
  const status = await provider.startup();
  assert.equal(status.installed, true, "Codex Agent CLI 未安装");
  await provider.setAgentEngine("codex");
  const started = await provider.startTurn("只返回单行 JSON：{\"character\":\"主角\",\"target\":\"目标\"}。不要读文件、不要运行工具。", {
    taskRoute: {
      shensiLed: true,
      recommendedMode: "creative",
      confidence: 1,
      reason: "真实 Agent 上下文表面验收",
      action: "assist",
      reasoningOwner: "agent",
      commitOwner: "none",
      commitDisposition: "no_artifact",
      reviewTier: "none",
      candidatePreviewRequired: false,
    },
    contextBlocks: [{
      type: "resource",
      id: "current-document",
      name: "当前绑定文档当前版本",
      uri: "shensi://current-document",
      text: "叶昭要在雾都公布气税造假账本。",
    }],
    taskPacket: {
      requestId,
      conversationId: requestId,
      threadScopeId: requestId,
      workspaceToolContext: {},
    },
  });
  assert.ok(started.turnId, "Codex Agent 没有返回 turn ID");
  const deadline = Date.now() + 180_000;
  let terminal = null;
  while (Date.now() < deadline) {
    const snapshot = provider.status();
    terminal = [...(snapshot.recentRuns || []), snapshot.lastRun].filter(Boolean)
      .find((run) => run.requestId === requestId && ["completed", "failed", "interrupted"].includes(run.status));
    if (terminal) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  assert.ok(terminal, "Codex Agent 在限时内未进入终态");
  assert.equal(terminal.status, "completed", terminal.error || terminal.text);
  const raw = String(terminal.text || "");
  const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  assert.equal(parsed.character, "叶昭");
  assert.match(String(parsed.target || ""), /公布.*气税|气税.*公布/u);
  assert.equal(terminal.touchedFiles.length, 0, "只读 Agent 验收不得修改文件");
  const report = {
    ok: true,
    provider: "Codex Agent",
    model: terminal.agentModel,
    engine: terminal.engine,
    elapsedMs: Date.now() - startedAt,
    accountAuthenticated: provider.status().authenticated === true,
    contextBlockCount: terminal.contextBlockCount,
    touchedFiles: terminal.touchedFiles,
    usage: terminal.usage || null,
    result: parsed,
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await provider.close();
}
