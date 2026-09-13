import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createBlankNotebookState } from "../src/data.js";

const origin = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_ORIGIN || "http://127.0.0.1:7867").replace(/\/$/u, "");
const settingsStatePath = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_SETTINGS_STATE || "").trim();
const requestedProfileId = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_PROFILE || "text-default").trim();
const requestedModel = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_MODEL || "").trim();
const requestedPermissionMode = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_PERMISSION || "full_access").trim();
const injectedApiKey = String(globalThis.__SHENSI_DOCUMENT_ACCEPTANCE_API_KEY || "").trim();
const runtimeBindingsPath = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_RUNTIME_BINDINGS
  || "E:\\ShensiUserData\\config\\generation-runtime-v1.json");
const keepWorkspace = process.env.SHENSI_KEEP_DOCUMENT_ACCEPTANCE === "1";
const runToken = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const notebookName = `文档真实验收-${runToken}`;
const sourceDocumentId = `document-acceptance-brief-${runToken}`;
const targetDocumentId = `document-acceptance-target-${runToken}`;
const articleTitle = `雨停之前，我们先学会照顾自己-${runToken}`;
const appendMarker = `DOC-ACCEPTANCE-${runToken}`;

assert.ok(settingsStatePath, "真实文档验收必须显式指定只读配置状态文件");

const index = await fetch(`${origin}/`).then((response) => response.text());
const token = index.match(/name="shensi-session-token" content="([^"]+)"/)?.[1];
assert.ok(token, "真实验收服务必须提供本机会话令牌");
const headers = { "content-type": "application/json", origin, "x-shensi-session": token };
const api = async (pathname, body = undefined, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${origin}${pathname}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`${pathname} 返回非 JSON：${text.slice(0, 400)}`); }
  if (!response.ok || payload.ok === false) {
    throw Object.assign(new Error(`${pathname}: ${payload.code || response.status} ${payload.message || text.slice(0, 400)}`), {
      code: payload.code || `HTTP_${response.status}`,
    });
  }
  return payload;
};

const sourceState = JSON.parse(await readFile(settingsStatePath, "utf8"));
const sourceSettings = sourceState.settings || {};
const profiles = Array.isArray(sourceSettings.textConnections) ? sourceSettings.textConnections : [];
const selectedProfile = profiles.find((profile) => profile.id === requestedProfileId)
  || profiles.find((profile) => profile.id === sourceSettings.activeTextAgentConnectionId)
  || profiles.find((profile) => profile.id === sourceSettings.activeTextConnectionId);
assert.ok(selectedProfile, `找不到真实文字配置：${requestedProfileId}`);
const runtimeStore = JSON.parse(await readFile(runtimeBindingsPath, "utf8").catch(() => "{}"));
const runtimeBinding = (Array.isArray(runtimeStore.bindings) ? runtimeStore.bindings : [])
  .find((binding) => binding.channel === "text" && binding.profileId === selectedProfile.id) || {};
const hydratedProfile = { ...selectedProfile };
for (const field of ["provider", "adapter", "protocol", "baseUrl", "cliPath", "cliArgs", "agentEngine"]) {
  if (!String(hydratedProfile[field] || "").trim() && String(runtimeBinding[field] || "").trim()) {
    hydratedProfile[field] = runtimeBinding[field];
  }
}
if (injectedApiKey) hydratedProfile.apiKey = injectedApiKey;
const agentSettings = {
  ...sourceSettings,
  ...hydratedProfile,
  agentEngine: hydratedProfile.agentEngine || "codex",
  agentModelId: hydratedProfile.agentModelId || hydratedProfile.model,
  agentPermissionMode: requestedPermissionMode,
  reasoningEffort: hydratedProfile.reasoningEffort || "low",
  maxOutputTokens: String(Math.max(6_000, Number(hydratedProfile.maxOutputTokens) || 0)),
  ...(injectedApiKey ? { apiKey: injectedApiKey } : {}),
  textConnections: profiles.map((profile) => profile.id === hydratedProfile.id ? hydratedProfile : profile),
  activeTextConnectionId: hydratedProfile.id,
  activeTextAgentConnectionId: hydratedProfile.id,
  ...(hydratedProfile.id === "text-public-agent" && !hydratedProfile.baseUrl
    ? { baseUrl: "https://api.kilo.ai/api/openrouter", protocol: "chat_completions", systemManaged: true, credentialSource: "public" }
    : {}),
  ...(requestedModel ? { model: requestedModel, agentModelId: requestedModel } : {}),
};

const allEvents = [];
const watch = async ({ runId, until, timeoutMs, label }) => {
  let cursor = allEvents.filter((event) => event.runId === runId).reduce((max, event) => Math.max(max, event.sequence), 0);
  let latest = null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    latest = await api(`/api/conversation-agent/${encodeURIComponent(runId)}?after=${cursor}`);
    for (const event of latest.events || []) {
      allEvents.push({ ...event, runId });
      cursor = Math.max(cursor, Number(event.sequence) || 0);
    }
    if (await until(latest, allEvents.filter((event) => event.runId === runId))) return latest;
    await new Promise((resolveWait) => setTimeout(resolveWait, 800));
  }
  throw new Error(`${label}等待超时：${latest?.error || latest?.status || "无状态"}`);
};

const terminalStatus = (status) => ["completed", "failed", "cancelled", "interrupted"].includes(String(status || ""));
const startAgent = (request) => api("/api/conversation-agent/start", request);
let workspacePath = "";

try {
  const created = await api("/api/notebooks/create", { name: notebookName, operationId: `create-${runToken}` });
  workspacePath = String(created.notebook?.workspacePath || created.notebook?.path || "");
  assert.ok(workspacePath, "临时验收笔记本必须返回真实路径");

  const loaded = await api("/api/workspace/load", { workspacePath }, "POST");
  const state = loaded.state
    ? structuredClone(loaded.state)
    : createBlankNotebookState({ name: notebookName, workspacePath, settings: sourceSettings });
  state.settings = { ...sourceSettings, workspacePath };
  state.activeModule = "library";
  state.activeDocument = targetDocumentId;
  state.documents[sourceDocumentId] = {
    title: "文档验收资料",
    moduleId: "library",
    markdown: [
      "# 文档验收资料",
      "",
      "目标读者是长期照顾别人、习惯忽略自身疲惫的成年人。",
      "文章不要制造焦虑，也不要虚构专家、调查或统计数据。",
      "核心场景：一场夜雨后，主人公终于承认自己也需要被照顾。",
      `资料校验标记：BRIEF-${runToken}`,
    ].join("\n"),
  };
  state.documents[targetDocumentId] = { title: "未命名", moduleId: "library", markdown: "" };
  state.moduleItems.library = [
    ...(state.moduleItems.library || []).filter((entry) => ![sourceDocumentId, targetDocumentId].includes(String(entry?.[0] || ""))),
    [sourceDocumentId, "文档验收资料", { workspaceView: "notebook" }],
    [targetDocumentId, "未命名", { workspaceView: "notebook" }],
  ];
  await api("/api/workspace/save", {
    workspacePath,
    state,
    expectedStateStamp: loaded.stateStamp,
    operationDocumentIds: [sourceDocumentId, targetDocumentId],
  });

  const conversationId = `conversation-document-acceptance-${runToken}`;
  const firstSourceMessageId = `message-document-acceptance-${runToken}`;
  const firstPrompt = [
    "请完成一篇约 600 至 800 字的正式公众号文章。",
    "请依据神思任务路由，自主选择并完整读取当前阶段适用的公众号写作 Skill；不要靠关键词绑定，也不要读取无关或空白资料。",
    "必须完整读取《文档验收资料》，遵守其中的受众、证据和场景要求。",
    "第一步只提出一个二选一选择问题，让我选择“故事共鸣”或“实用解析”。",
    "收到选择后，把选择当作最新文字指令，不能停摆、不能重复询问，必须继续完成生成和交付。",
    `将正式正文直接覆盖写入当前打开的《未命名》文档，并把标题更新为《${articleTitle}》。`,
    "不要另建重复文章，不要只在对话区展示，不要谎报落盘；最终回答必须基于可信磁盘回读并提供同名文档链接。",
  ].join("\n");
  const firstRequest = {
    workspacePath,
    workspaceKind: "notebook",
    workspaceName: notebookName,
    conversationId,
    branchId: "main",
    sourceMessageId: firstSourceMessageId,
    messages: [{ role: "user", content: firstPrompt }],
    currentDocument: { documentId: targetDocumentId, title: "未命名" },
    targetDocumentId: "",
    selectedSkills: [],
    references: [],
    attachments: [],
    contentOnly: false,
    settings: agentSettings,
    mediaProfiles: {},
  };
  const started = await startAgent(firstRequest);
  const waiting = await watch({
    runId: started.id,
    timeoutMs: 6 * 60_000,
    label: "真实选择问题",
    until: (status, events) => Boolean(status.question || events.some((event) => event.type === "question") || terminalStatus(status.status)),
  });
  assert.equal(terminalStatus(waiting.status), false, `Agent 未提出选择就提前结束：${waiting.error || waiting.text || waiting.status}`);
  const question = waiting.question || allEvents.find((event) => event.runId === started.id && event.type === "question")?.payload;
  assert.ok(question?.id, "真实 Agent 必须生成结构化选择问题");
  assert.ok(Array.isArray(question.options) && question.options.length >= 2, "选择问题必须包含至少两个可选方向");

  const acceptedAt = Date.now();
  const answer = await api(`/api/conversation-agent/${encodeURIComponent(started.id)}/answer`, {
    decisionId: question.id,
    answer: "故事共鸣",
  });
  assert.equal(answer.accepted, true, "选择必须被原任务接受");
  const resumed = await watch({
    runId: started.id,
    timeoutMs: 30_000,
    label: "选择后的继续响应",
    until: (_status, events) => events.some((event) => event.type === "answer_accepted")
      && events.some((event) => event.type === "progress" && /继续生成/u.test(String(event.payload?.message || ""))),
  });
  const resumeLatencyMs = Date.now() - acceptedAt;
  assert.ok(resumeLatencyMs < 30_000, "选择确认后必须及时出现继续生成状态");
  assert.notEqual(resumed.status, "waiting_input", "选择被接受后不得停留在原选择状态");

  const completed = await watch({
    runId: started.id,
    timeoutMs: 18 * 60_000,
    label: "选择后的正式生成和落盘",
    until: (status) => terminalStatus(status.status),
  });
  assert.equal(completed.status, "completed", `真实 Agent 执行失败：${completed.error || completed.text}`);
  const firstEvents = allEvents.filter((event) => event.runId === started.id);
  assert.equal(firstEvents.filter((event) => event.type === "question").length, 1, "首次任务只能提出约定的一次选择");
  assert.ok(firstEvents.some((event) => event.type === "tool" && event.payload?.name === "skills.read" && event.payload?.success !== false), "任务路由后必须真实调用 Skill 读取工具");
  const skillReads = firstEvents.filter((event) => event.type === "resource_read" && event.payload?.kind === "skill");
  assert.ok(skillReads.some((event) => /公众号.*(?:引导|主笔|理论)|文章.*写作/u.test(String(event.payload?.title || ""))
    && event.payload?.fullText === true && Number(event.payload?.characters) > 0), "必须完整读取适合公众号任务的真实 Skill");
  assert.ok(firstEvents.some((event) => event.type === "resource_read"
    && event.payload?.kind === "document"
    && event.payload?.id === sourceDocumentId
    && event.payload?.title === "文档验收资料"
    && event.payload?.fullText === true
    && Number(event.payload?.characters) > 0), "必须完整读取任务指定的非空资料文档");
  const firstSaveSequence = firstEvents.find((event) => event.type === "document_saved" && event.payload?.documentId === targetDocumentId)?.sequence ?? Number.POSITIVE_INFINITY;
  assert.equal(firstEvents.some((event) => event.sequence < firstSaveSequence
    && event.type === "resource_read"
    && event.payload?.id === targetDocumentId), false, "空白目标文档不得显示为已读取资料；写入后的可信回读应正常显示");

  const saved = firstEvents.find((event) => event.type === "document_saved"
    && event.payload?.documentId === targetDocumentId
    && event.payload?.title === articleTitle
    && event.payload?.trustedDocumentSave === true);
  assert.ok(saved, "正式正文及标题更新必须产生最终同名的可信 document_saved 回执");
  assert.equal(saved.payload.title, articleTitle, "落盘回执标题必须与正式文章标题一致");
  const segment = saved.payload.landingManifest?.segments?.find((item) => item.documentId === targetDocumentId);
  assert.ok(segment?.receiptVerified, "标题链接只能来自完整磁盘验收通过的落盘段");
  assert.equal(segment.title, articleTitle);
  assert.equal(segment.navigationTarget?.documentId, targetDocumentId);
  assert.equal(resolve(segment.navigationTarget?.workspacePath || ""), resolve(workspacePath));

  const afterFirst = await api("/api/workspace/load", { workspacePath }, "POST");
  const firstDocument = afterFirst.state.documents[targetDocumentId];
  assert.equal(firstDocument.title, articleTitle, "未命名文档必须被正式标题替换");
  assert.ok(String(firstDocument.markdown || "").length >= 500, "正式正文必须真实写入而非只返回对话文本");
  assert.doesNotMatch(String(firstDocument.markdown || ""), /刘易超|以下这篇作品|技能为您提供|固定署名|口令/u, "正式正文不得混入环境 Skill 的署名、品牌或内部文字");
  assert.match(String(firstDocument.markdown || ""), /雨|照顾|疲惫/u, "正式正文必须遵守读取资料的主题要求");
  assert.equal(afterFirst.state.documents[sourceDocumentId].title, "文档验收资料", "资料文档不得被误写为目标");
  const firstVersion = String(firstDocument.markdown || "");
  const historyAfterFirst = afterFirst.state.histories?.[targetDocumentId] || [];
  assert.ok(historyAfterFirst.length >= 1, "覆盖空白目标前也必须保存完整历史版本");
  assert.equal(historyAfterFirst[0]?.document?.title || historyAfterFirst[0]?.title, "未命名", "第一次覆盖历史必须保留原标题");

  const secondSourceMessageId = `message-document-append-${runToken}`;
  const secondPrompt = `这是新的直接执行指令：请不要再提选择问题，读取当前文档后，在正文结尾续写一段自然收束的正式结语，并把“验收追踪标记：${appendMarker}”作为最后一行一并落盘。必须续写当前文档，不得另建文档。`;
  const secondStarted = await startAgent({
    ...firstRequest,
    sourceMessageId: secondSourceMessageId,
    messages: [
      { role: "user", content: firstPrompt },
      { role: "assistant", content: completed.text || "已完成正式文章并写入文档。" },
      { role: "user", content: secondPrompt },
    ],
    currentDocument: { documentId: targetDocumentId, title: articleTitle },
  });
  const secondCompleted = await watch({
    runId: secondStarted.id,
    timeoutMs: 18 * 60_000,
    label: "直接指令后的续写和落盘",
    until: (status) => terminalStatus(status.status),
  });
  assert.equal(secondCompleted.status, "completed", `直接指令执行失败：${secondCompleted.error || secondCompleted.text}`);
  const secondEvents = allEvents.filter((event) => event.runId === secondStarted.id);
  assert.equal(secondEvents.some((event) => event.type === "question"), false, "明确直接指令不得再次制造选择阻断");
  assert.ok(secondEvents.some((event) => event.type === "resource_read" && event.payload?.id === targetDocumentId && event.payload?.fullText === true), "续写前必须真实读取当前正文");
  assert.ok(secondEvents.some((event) => event.type === "document_saved" && event.payload?.documentId === targetDocumentId && event.payload?.trustedDocumentSave === true), "直接指令也必须产生可信落盘回执");

  const finalLoaded = await api("/api/workspace/load", { workspacePath }, "POST");
  const finalDocument = finalLoaded.state.documents[targetDocumentId];
  assert.equal(finalDocument.title, articleTitle, "续写不得破坏正式标题");
  assert.match(String(finalDocument.markdown || ""), new RegExp(appendMarker.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), "续写标记必须真实落盘");
  assert.ok(String(finalDocument.markdown || "").startsWith(firstVersion.slice(0, Math.min(240, firstVersion.length))), "续写不得错误覆盖原正文");
  const finalHistory = finalLoaded.state.histories?.[targetDocumentId] || [];
  assert.ok(finalHistory.length > historyAfterFirst.length, "续写前必须再次保存完整历史版本");
  assert.ok(finalHistory.some((version) => String(version?.document?.markdown || version?.content || "") === firstVersion), "历史版本必须完整保存续写前正文");

  console.log(JSON.stringify({
    ok: true,
    workspacePath,
    profile: { id: hydratedProfile.id, name: hydratedProfile.name, provider: hydratedProfile.provider, model: agentSettings.model, engine: agentSettings.agentEngine, permission: agentSettings.agentPermissionMode },
    choice: { question: question.question, answer: "故事共鸣", resumedWithinMs: resumeLatencyMs },
    routing: { skillReads: skillReads.map((event) => ({ id: event.payload.id, title: event.payload.title, characters: event.payload.characters })), documentRead: "文档验收资料" },
    landing: { documentId: targetDocumentId, title: articleTitle, characters: String(finalDocument.markdown || "").length, historyVersions: finalHistory.length, trustedLinkTarget: segment.navigationTarget },
    runs: { choiceAndWrite: started.id, directAppend: secondStarted.id },
  }, null, 2));
} finally {
  if (workspacePath && !keepWorkspace) {
    const normalized = resolve(workspacePath);
    assert.equal(basename(normalized), notebookName, "清理目标必须是本次验收笔记本");
    assert.equal(basename(dirname(normalized)), "笔记", "清理目标必须位于神思笔记目录");
    await api("/api/notebooks/delete", { workspacePath: normalized }).catch((error) => {
      console.error(`验收笔记本自动清理失败：${error.message}`);
    });
  }
}
