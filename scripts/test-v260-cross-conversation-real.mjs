import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { historicalConversationReferencePrompt } from "../src/conversation-context.js";

const port = Number(process.env.SHENSI_TEST_PORT || 41951);
const origin = `http://127.0.0.1:${port}`;
const sourceBuildId = String(process.env.SHENSI_TEST_SOURCE_BUILD_ID || "20260811-real-04");
const index = await fetch(`${origin}/`).then((response) => response.text());
const token = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(token);
const headers = { "content-type": "application/json", origin, "x-shensi-session": token };
const request = async (pathname, body) => {
  const response = await fetch(`${origin}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || JSON.stringify(payload)}`);
  return payload;
};
const projects = await fetch(`${origin}/api/projects/list`, { headers }).then((response) => response.json());
const project = projects.projects.find((item) => String(item.workspacePath || "").endsWith(sourceBuildId));
assert.ok(project?.workspacePath);
const loaded = await request("/api/workspace/load", { workspacePath: project.workspacePath });
const settings = { ...(loaded.state.settings || {}), workspacePath: project.workspacePath };
const priorAttempt = JSON.parse(await readFile(`artifacts/v260-acceptance-data/generation-attempts/v260-cross-prior-${sourceBuildId}.json`, "utf8"));
const priorText = String(priorAttempt.resultData?.payload?.text || "").replace(/^【(?:正式内容|候选稿)】\s*/u, "").trim();
assert.ok(priorText.length >= 300);
const currentRequest = "继续早前对话《雾港铜铃》的任务：让周岑查明铜铃与旧海难的关系，续写至少300个汉字，保留周岑、雾港、铜铃三个关键设定并推进到一个新的结果。";
const historicalPrompt = historicalConversationReferencePrompt({
  sourceConversationId: "conversation-wugang-old",
  sourceConversationTitle: "雾港铜铃",
  userMessage: { id: "wugang-old-user", role: "user", content: "创作《雾港铜铃》开篇，守灯人周岑追查周年夜无人触碰却响起的铜铃。" },
  assistantMessages: [{ id: "wugang-old-result", role: "assistant", candidate: priorText, content: priorText }],
}, currentRequest);
const requestId = `v260-cross-ui-${Date.now()}`;
const response = await request("/api/chat", {
  settings,
  workspaceKind: "project",
  messages: [{ role: "user", content: historicalPrompt }],
  projectContext: "",
  postwriteProjectContext: "",
  activeModule: "manuscript",
  contextDomain: "novel",
  sourceMode: "original",
  targetDocumentId: "",
  attachments: [],
  selectedSkills: [],
  explicitReferenceDocumentIds: [],
  requestId,
  creativeTask: {
    schemaVersion: 1,
    taskId: requestId,
    instruction: currentRequest,
    executionSurface: "chat",
    source: { workId: project.name, documentIds: [], contentType: "novel" },
    context: { associatedDocumentId: "", activeDocumentId: "", referenceDocumentIds: [], skillIds: [], loadingLevel: 1 },
    target: { workId: project.name, contentType: "novel", directoryId: "manuscript", forceCreateNew: true, allowMultiple: false },
    operation: "continue",
    qualityPolicy: { selfCheckRequested: false, fullRewriteRequested: false },
  },
  stream: false,
  mode: "creative",
  outputSurface: "conversation",
  executionSurface: "chat",
  webSearch: false,
});
const text = String(response.text || "").replace(/^【(?:正式内容|候选稿)】\s*/u, "").trim();
const han = (text.match(/[\u3400-\u9fff]/gu) || []).length;
assert.ok(han >= 300, `continuation must contain at least 300 Han characters, got ${han}: ${text.slice(0, 500)}`);
for (const anchor of ["周岑", "雾港", "铜铃"]) assert.match(text, new RegExp(anchor, "u"));
assert.equal(response.execution?.status, "ready_to_land");
console.log(JSON.stringify({ ok: true, requestId, han, anchors: ["周岑", "雾港", "铜铃"], status: response.execution.status, skill: response.execution?.skillRuntime?.primarySkill?.name }, null, 2));
