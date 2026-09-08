import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const origin = `http://127.0.0.1:${Number(process.env.SHENSI_TEST_PORT || 41951)}`;
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
const priorAttempt = JSON.parse(await readFile(`artifacts/v260-acceptance-data/generation-attempts/v260-cross-prior-${sourceBuildId}.json`, "utf8"));
const priorText = String(priorAttempt.resultData?.payload?.text || "").replace(/^【(?:正式内容|候选稿)】\s*/u, "").trim();
assert.ok(priorText.length >= 300);
const conversationShell = (id, title, messages) => ({
  id,
  title,
  boundDocumentId: "v260-chat-story-1",
  autoAssociateActiveDocument: false,
  messages,
  currentCandidate: "",
  currentCandidateTarget: null,
  currentCandidateMemoryUpdate: null,
  nativeAgentSession: null,
  constraintIndex: [],
  intentTarget: null,
  queue: [],
  references: [],
  attachments: [],
  createdAt: "今天 22:45",
  updatedAt: "今天 22:45",
  associationAnchorDocumentId: "v260-chat-story-1",
  branchGroups: [],
  candidateBranchGroups: [],
  workspaceReferences: [],
  skillReferences: [],
  referenceContext: { schemaVersion: 1, references: [], workspaceReferences: [], skillReferences: [], attachments: [], sourceMessageId: "", cleared: false, updatedAt: Date.now() },
  webSearchEnabled: false,
  webReaderEnabled: false,
  composerDraft: "",
});
const oldConversation = conversationShell("conversation-v260-wugang-old", "雾港铜铃（早前对话）", [
  { id: "message-v260-wugang-user", role: "user", time: "今天 22:40", requestMode: "creative", content: "创作《雾港铜铃》开篇，守灯人周岑追查周年夜无人触碰却响起的铜铃，写成完整故事。" },
  { id: "message-v260-wugang-result", role: "assistant", time: "今天 22:42", candidate: priorText, content: priorText, pending: false, execution: { status: "complete", result: "正式故事已完成" } },
]);
const newConversation = conversationShell("conversation-v260-wugang-new", "跨对话继续验收", []);
loaded.state.conversations = [oldConversation, newConversation];
loaded.state.activeConversationId = newConversation.id;
loaded.state.messages = [];
loaded.state.currentCandidate = "";
loaded.state.currentCandidateTarget = null;
loaded.state.currentCandidateMemoryUpdate = null;
await request("/api/workspace/save", { workspacePath: project.workspacePath, state: loaded.state });
console.log(JSON.stringify({ ok: true, workspacePath: project.workspacePath, oldConversationId: oldConversation.id, activeConversationId: newConversation.id, priorCharacters: priorText.length }, null, 2));
