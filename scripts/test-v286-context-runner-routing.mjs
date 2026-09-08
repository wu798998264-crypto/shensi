import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { agentContextCompactionPlan } from "../src/agent-context-compaction-policy.js";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

assert.match(app, /scheduleConversationContextCompaction/u, "每轮状态保存后必须安排后台增量压缩");
assert.match(app, /conversationContextCheckpoint/u, "对话必须保存可校验压缩检查点");
for (const engine of ["codex", "opencode", "deepseek_opencode", "claude_code"]) {
  const plan = agentContextCompactionPlan({ agentEngine: engine, nativeCompaction: engine === "codex" });
  assert.equal(plan.owner, "current_agent", `${engine} 的上下文压缩责任必须属于当前 Agent`);
  assert.equal(plan.blockOnFailure, false, "上下文压缩失败不得阻断当前任务");
}
assert.match(app, /agentContextCompactionPlan/u, "客户端必须按当前 Agent 的能力选择上下文压缩方式");
assert.match(app, /const nativeAgentThread = contextCompaction\.strategy === "agent_native"/u);
assert.match(app, /conversationContext:\s*nativeAgentThread \? \[\] : shensiConversationContext/u, "具备原生压缩的 Agent 不得再次收到重复历史");
assert.match(app, /最新用户指令[\s\S]{0,360}?当前绑定文档最新版[\s\S]{0,360}?用户明确引用/u, "上下文来源优先级必须显式进入运行时合同");
assert.match(server, /agentContextCompactionPlan\([\s\S]{0,420}?shensi:\/\/conversation\//u, "服务端必须依据当前 Agent 压缩计划剔除重复对话块");
assert.match(server, /conversation-state-ledger\.js/u, "新增浏览器模块必须由本地服务显式提供");

console.log("Conversation context runner routing tests passed");
