import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const origin = String(process.env.SHENSI_TEST_ORIGIN || "http://127.0.0.1:42117").replace(/\/$/u, "");
const qaRoot = String(process.env.SHENSI_QA_ROOT || "").trim();
const settingsStatePath = String(process.env.SHENSI_REAL_SETTINGS_STATE || "").trim();
const projectName = "浏览器长文质量验收";
const notebookName = "浏览器笔记质量验收";
if (!qaRoot || !settingsStatePath) throw new Error("SHENSI_QA_ROOT 和 SHENSI_REAL_SETTINGS_STATE 是真实模型烟雾测试的必填参数");

const index = await fetch(`${origin}/`).then((response) => response.text());
const sessionToken = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(sessionToken, "浏览器服务必须提供本地会话令牌");
const headers = { "content-type": "application/json", origin, "x-shensi-session": sessionToken };
const request = async (pathname, body) => {
  const response = await fetch(`${origin}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${pathname} 返回非 JSON：${text.slice(0, 300)}`); }
  if (!response.ok) throw Object.assign(new Error(`${pathname} ${response.status}: ${payload.message || text.slice(0, 300)}`), { code: payload.code || "HTTP_ERROR" });
  return payload;
};

const sourceState = JSON.parse(await readFile(settingsStatePath, "utf8"));
const settingsTemplate = structuredClone(sourceState.settings || {});
const workspacePaths = {
  project: join(qaRoot, "作品", projectName),
  notebook: join(qaRoot, "笔记", notebookName),
};
for (const workspacePath of Object.values(workspacePaths)) {
  const loaded = await request("/api/workspace/load", { workspacePath });
  assert.ok(loaded.state, `浏览器 UI 创建的 QA 工作区必须存在：${workspacePath}`);
  const state = structuredClone(loaded.state);
  state.settings = { ...settingsTemplate, workspacePath };
  await request("/api/workspace/save", { workspacePath, state, expectedStateStamp: loaded.stateStamp });
}

const workspacePath = workspacePaths.project;
const settings = { ...settingsTemplate, workspacePath };
const prompt = "只生成一段临时玄幻小说测试文字，不要写入、保存或落盘。内容约 180 至 260 个汉字，必须有场景、人物对白和一个明确转折。";
const requestId = `v500-browser-smoke-${Date.now()}`;
const response = await request("/api/conversation-agent/start", {
  settings,
  workspaceKind: "project",
  messages: [{ id: requestId, role: "user", content: prompt }],
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
    instruction: prompt,
    executionSurface: "chat",
    source: { workId: projectName, documentIds: [], contentType: "novel" },
    context: { associatedDocumentId: "", activeDocumentId: "", referenceDocumentIds: [], skillIds: [], loadingLevel: 1 },
    target: { workId: projectName, contentType: "novel" },
    operation: "assist",
    qualityPolicy: { selfCheckRequested: false, fullRewriteRequested: false },
  },
  stream: false,
  mode: "creative",
  outputSurface: "conversation",
  executionSurface: "chat",
  webSearch: false,
});
const text = String(response.text || "").trim();
const hanCount = (text.match(/[\u3400-\u9fff]/gu) || []).length;
assert.ok(hanCount >= 120, `真实模型烟雾输出不足：${hanCount} 个汉字`);
assert.match(text, /[“”"「」『』]/u, "真实模型烟雾输出应包含人物对白");
assert.match(text, /[，。！？]/u, "真实模型烟雾输出应包含叙事句式");

console.log(JSON.stringify({
  ok: true,
  provider: String(settings.provider || ""),
  model: String(settings.model || ""),
  hanCount,
  executionStatus: String(response.execution?.status || response.execution?.phase || "completed"),
  requestedSkillCount: Array.isArray(response.execution?.requestedSkills) ? response.execution.requestedSkills.length : 0,
  projectPath: workspacePaths.project,
  notebookPath: workspacePaths.notebook,
}));
