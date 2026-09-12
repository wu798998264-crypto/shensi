import assert from "node:assert/strict";
import { buildAdaptiveTaskRoute } from "../src/request-routing.js";

const instruction = "请真实联网查询 OpenAI Codex 当前最新版本。不要保存、写入或修改文档，只回答联网结果并附来源。";
const route = buildAdaptiveTaskRoute({ text: instruction, workspaceKind: "project", targetDocumentId: "chapter-1", agentDecision: { lane: "task_execution", requestMode: "general", writePlan: { intent: "none", operation: "none" } } });
assert.equal(route.mode, "general", "否定写入的联网查询不得误路由为创作任务");
const adaptive = buildAdaptiveTaskRoute({ text: instruction, sourceMessageId: "read-only-network-query" });
assert.equal(adaptive.mode, "general");
assert.notEqual(adaptive.writeAuthorization?.state, "commit");
console.log("Read-only network routing tests passed");
