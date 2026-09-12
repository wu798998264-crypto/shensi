import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createBlankProjectState } from "../src/data.js";
import { historicalConversationReferencePrompt } from "../src/conversation-context.js";

const port = Number(process.env.SHENSI_TEST_PORT || 41951);
const origin = `http://127.0.0.1:${port}`;
const buildId = String(process.env.SHENSI_TEST_BUILD_ID || Date.now());
const crossOnly = process.env.SHENSI_TEST_CROSS_ONLY === "1";
const index = await fetch(`${origin}/`).then((response) => response.text());
const sessionToken = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(sessionToken, "session token must be present");
const headers = { "content-type": "application/json", origin, "x-shensi-session": sessionToken };
const request = async (pathname, body) => {
  const response = await fetch(`${origin}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${pathname} returned non-JSON: ${text.slice(0, 600)}`); }
  if (!response.ok) throw new Error(`${pathname} ${response.status}: ${payload.message || text.slice(0, 600)}`);
  return payload;
};

const projectName = `v2.6.0核心写作验收-${buildId}`;
const created = await request("/api/projects/create", { name: projectName });
const workspacePath = created.project.path || created.project.workspacePath;
assert.ok(workspacePath, "acceptance workspace path must be returned");
let initial = await request("/api/workspace/load", { workspacePath });
if (!initial.state) {
  const blankState = createBlankProjectState(projectName);
  const configuredStatePath = process.env.SHENSI_TEST_SETTINGS_STATE || "E:\\ShensiUserData\\笔记\\我的笔记\\.shensi\\current-state.json";
  const configuredState = JSON.parse(await readFile(configuredStatePath, "utf8"));
  blankState.settings = { ...(configuredState.settings || blankState.settings || {}) };
  await request("/api/workspace/save", { workspacePath, state: blankState });
  initial = await request("/api/workspace/load", { workspacePath });
}
const baselineSettings = initial.state.settings || {};
const settings = {
  ...baselineSettings,
  workspacePath,
  model: baselineSettings.provider === "OpenAI" ? "gpt-5.6-terra" : baselineSettings.model,
  agentModel: "gpt-5.6-terra",
  agentReasoningEffort: "low",
  textConnections: (baselineSettings.textConnections || []).map((profile) => profile.id === baselineSettings.activeTextConnectionId && profile.provider === "OpenAI"
    ? { ...profile, model: "gpt-5.6-terra", reasoningEffort: "low" }
    : profile),
};

const hanCount = (value) => (String(value || "").match(/[\u3400-\u9fff]/gu) || []).length;
const storyTurnPattern = /突然|终于|却|后来|直到|发现|决定|回到|推开|追|逃|救|原来|竟然|没想到|真相|揭开|查明|找出|认出|得知|证明|露出|松脱/u;
const assertStory = (story, label) => {
  assert.ok(hanCount(story) >= 300, `${label} must contain at least 300 Chinese characters, got ${hanCount(story)}`);
  assert.ok(/[“\"]/.test(story), `${label} must contain dialogue`);
  assert.ok(/[，。！？]/u.test(story), `${label} must contain narrative sentences`);
  assert.ok(storyTurnPattern.test(story), `${label} must contain an actual story turn`);
};
const storyNeedsRepair = (story) => (
  hanCount(story) < 300
  || !/[“”"「」『』]/u.test(String(story || ""))
  || !/[，。！？]/u.test(String(story || ""))
  || !storyTurnPattern.test(String(story || ""))
);
const parseStories = (value, expected = 5) => {
  const text = String(value || "").replace(/^【(?:正式内容|候选稿)】\s*/u, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error(`model did not return a story JSON array: ${text.slice(0, 800)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  assert.equal(parsed.length, expected, `model must return exactly ${expected} stories`);
  return parsed.map((item, index) => ({
    title: String(item.title || `故事${index + 1}`).trim(),
    body: String(item.body || "").trim(),
  }));
};
const invoke = async ({ surface, prompt, requestId, messages = null, projectContext = "" }) => {
  const creativeTask = {
    schemaVersion: 1,
    taskId: requestId,
    instruction: prompt,
    executionSurface: surface,
    source: { workId: projectName, documentIds: [], contentType: "novel" },
    context: { associatedDocumentId: "", activeDocumentId: "", referenceDocumentIds: [], skillIds: [], loadingLevel: 1 },
    target: { workId: projectName, contentType: "novel", directoryId: "manuscript", forceCreateNew: true, allowMultiple: true },
    operation: "batch",
    qualityPolicy: { selfCheckRequested: false, fullRewriteRequested: false },
  };
  return request("/api/conversation-agent/start", {
    settings,
    workspaceKind: "project",
    messages: messages || [{ role: "user", content: prompt }],
    projectContext,
    postwriteProjectContext: "",
    activeModule: "manuscript",
    contextDomain: "novel",
    sourceMode: "original",
    targetDocumentId: "",
    attachments: [],
    selectedSkills: [],
    explicitReferenceDocumentIds: [],
    requestId,
    creativeTask,
    stream: false,
    mode: "creative",
    outputSurface: "conversation",
    executionSurface: surface,
    webSearch: false,
  });
};

const results = [];
for (const surface of crossOnly ? [] : ["chat", "agent"]) {
  const requestId = `v260-${surface}-${buildId}`;
  const prompt = [
    `使用神思 ${surface.toUpperCase()} 批量创作五篇彼此独立的中文微型故事。`,
    `标题必须分别以“${surface === "chat" ? "Chat" : "Agent"}故事”开头并编号一至五。`,
    "每篇正文至少包含300个汉字，必须有人物、场景、对白、冲突、转折和有结果的结尾，不能写提纲、说明、诊断或占位内容。",
    "只返回严格 JSON 数组，不要 Markdown 代码块，格式为 [{\"title\":\"...\",\"body\":\"...\"}]。",
  ].join("\n");
  let response = await invoke({ surface, prompt, requestId });
  let stories = parseStories(response.text);
  for (let retry = 1; retry <= 2 && stories.some((item) => storyNeedsRepair(item.body)); retry += 1) {
    const repair = `以下五篇故事至少有一篇未同时满足300个汉字、带引号的直接人物对白、冲突、转折和有结果的结尾。保持标题和故事核心不变，把每篇扩写到至少380个汉字并补齐这些要素。只返回同格式 JSON 数组：\n${JSON.stringify(stories)}`;
    response = await invoke({ surface, prompt: repair, requestId: `${requestId}-repair-${retry}` });
    stories = parseStories(response.text);
  }
  stories.forEach((item, index) => assertStory(item.body, `${surface} story ${index + 1}`));
  const operations = stories.map((item, index) => ({
    operationId: `${requestId}-op-${index + 1}`,
    type: "create",
    targetDocumentId: `v260-${surface}-story-${index + 1}`,
    targetDirectoryId: "manuscript",
    contentType: "novel",
    requestedTitle: item.title,
    content: item.body,
  }));
  const receipt = await request("/api/document-transactions/execute", {
    workspacePath,
    requestId,
    batchId: `${requestId}-batch`,
    task: { ...response.execution?.creativeTask, taskId: requestId, executionSurface: surface, operation: "batch" },
    operations,
    commitMode: "atomic",
  });
  assert.equal(receipt.succeeded, 5);
  assert.equal(receipt.verified, true);
  assert.equal(receipt.results.every((item) => item.navigationTarget?.documentId === item.targetDocumentId), true);
  const loaded = await request("/api/workspace/load", { workspacePath });
  assert.equal(operations.every((item) => loaded.state.documents[item.targetDocumentId]?.markdown === item.content), true);
  const skillRecords = response.execution?.skillRuntime?.records || response.execution?.capabilityRuntime?.records || [];
  const capabilityPlan = response.execution?.capabilityPlan || {};
  assert.ok(skillRecords.length > 0 || Object.keys(capabilityPlan).length > 0, `${surface} must expose a real Skill/capability route`);
  results.push({
    surface,
    generated: stories.length,
    landed: receipt.succeeded,
    verified: receipt.verified,
    minHan: Math.min(...stories.map((item) => hanCount(item.body))),
    titles: stories.map((item) => item.title),
    skillRecordCount: skillRecords.length,
    capabilityPlan,
  });
}

const priorPrompt = "创作一个名为《雾港铜铃》的故事开篇：守灯人周岑发现每逢沉船周年，灯塔底层的铜铃会在无人触碰时响起。写至少300个汉字，包含对白和一个尚未揭开的秘密。";
const prior = crossOnly ? { text: [
  "雾港入夜后总有一层贴着石阶爬行的白雾。守灯人周岑独自检查灯塔时，听见底层仓房传来铜铃声。那只铜铃早在二十年前的白鹭号海难后就被父亲锁进铁柜，钥匙也随父亲下葬。",
  "“谁在里面？”周岑举起风灯问。门后没有回答，铃声却按三短一长的节奏再次响起，正是雾港旧船工求救的暗号。",
  "他撬开铁柜，发现铜铃表面全是新鲜海水，下面压着一张遇难者名单。名单最后一行原本空白，此刻慢慢浮出他的名字。窗外传来港务员老沈的脚步声，老沈隔门喊道：“别碰那张纸，你父亲当年就是因为它失踪的。”",
  "周岑追问父亲到底隐瞒了什么，老沈却只把一把标着‘船舱’的钥匙塞进门缝，转身逃进雾里。铜铃忽然自行转向北墙，铃舌指着一块颜色不同的石砖。周岑取下石砖，墙内露出一卷受潮录音带和父亲年轻时的照片。照片上，父亲抱着一个从白鹭号救下的孩子，孩子胸前也挂着同样的铜铃。",
  "录音带里只剩一句断续的话：“如果雾港的铃再响，说明那艘船从来没有真正沉下去。”周岑握紧钥匙，决定在潮水最高前打开灯塔下方被封死的旧船舱，查清铜铃与海难的关系。",
].join("\n\n") } : await invoke({ surface: "chat", prompt: priorPrompt, requestId: `v260-cross-prior-${buildId}` });
assertStory(prior.text, "cross-conversation prior story");
const continuationPrompt = "这是一个新对话。继续上一段《雾港铜铃》的任务，让周岑查明铜铃与旧海难的关系，写至少300个汉字，保留周岑、雾港、铜铃三个关键设定并推进到新的结果。";
const recalledContinuationPrompt = historicalConversationReferencePrompt({
  sourceConversationId: "v260-prior-conversation",
  sourceConversationTitle: "雾港铜铃",
  userMessage: { id: "v260-prior-user", role: "user", content: priorPrompt, requestMode: "creative" },
  assistantMessages: [{ id: "v260-prior-result", role: "assistant", content: prior.text, candidate: prior.text }],
}, continuationPrompt);
const continued = await invoke({
  surface: "chat",
  prompt: continuationPrompt,
  requestId: `v260-cross-new-${buildId}`,
  messages: [{ role: "user", content: recalledContinuationPrompt }],
});
assertStory(continued.text, "cross-conversation continuation");
for (const anchor of ["周岑", "雾港", "铜铃"]) assert.match(continued.text, new RegExp(anchor, "u"));

const finalState = await request("/api/workspace/load", { workspacePath });
console.log(JSON.stringify({
  ok: true,
  version: "2.6.0",
  buildId,
  workspacePath,
  results,
  documentCount: Object.keys(finalState.state.documents || {}).length,
  crossConversation: {
    priorHan: hanCount(prior.text),
    continuationHan: hanCount(continued.text),
    anchorsPreserved: ["周岑", "雾港", "铜铃"],
  },
}, null, 2));
