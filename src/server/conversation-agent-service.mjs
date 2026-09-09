import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createConversationAgentTools, conversationAgentInstructions } from "./conversation-agent-tools.mjs";

const keyFor = (request) => createHash("sha256").update(JSON.stringify([resolve(request.workspacePath || ".").toLowerCase(), request.conversationId, request.branchId || "main"])).digest("hex");
const laneFor = (request) => keyFor({ ...request, branchId: "conversation-lane" });
const runIdFor = (request) => {
  if (!request.sourceMessageId) return `agent-${randomUUID()}`;
  const hash = createHash("sha256").update(`${keyFor(request)}:${request.sourceMessageId}`).digest("hex").slice(0, 32);
  return `agent-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};
const terminal = (status) => ["completed", "failed", "cancelled", "interrupted"].includes(status);
const safeRequest = (value) => JSON.parse(JSON.stringify(value, (key, entry) => /api.?key|password|secret|access.?token|refresh.?token/iu.test(key) ? undefined : entry));

export const createConversationAgentService = ({ appRoot, storageRoot, run, skillCatalog, readSkill, readRoute, media, mediaStatus, toolsFactory = createConversationAgentTools } = {}) => {
  const runs = new Map(), lanes = new Map();
  const recordPath = (id) => {
    if (!/^agent-[a-f0-9-]{36}$/u.test(String(id))) throw new Error("无效 Agent 任务ID");
    return join(storageRoot, `${id}.json`);
  };
  const persist = (entry) => {
    const snapshot = JSON.stringify(entry.record);
    entry.saving = (entry.saving || Promise.resolve()).then(async () => {
      await mkdir(storageRoot, { recursive: true });
      const target = recordPath(entry.record.id), temp = `${target}.tmp-${randomUUID()}`;
      await writeFile(temp, snapshot, { encoding: "utf8", flush: true });
      await rename(temp, target);
    });
    return entry.saving;
  };
  const event = async (entry, type, payload = {}) => {
    entry.record.events.push({ sequence: entry.record.events.length + 1, type, payload, at: new Date().toISOString() });
    await persist(entry);
  };
  const get = async (id) => {
    if (runs.has(id)) return runs.get(id);
    let record;
    try { record = JSON.parse(await readFile(recordPath(id), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const recoveredInterruptedRun = !terminal(record.status);
    if (recoveredInterruptedRun) { record.status = "interrupted"; record.error = "服务重启，任务已保留；请检查已完成结果后继续，未自动重提生成。"; }
    const entry = { record, controller: new AbortController(), supplements: [], pending: new Map() };
    runs.set(id, entry);
    if (recoveredInterruptedRun) await persist(entry);
    return entry;
  };
  const execute = async (entry, request) => {
    const { record, controller } = entry;
    try {
      const catalog = await skillCatalog(request);
      const route = await readRoute(request);
      const tools = toolsFactory({ appRoot, ...request, requestId: record.id, signal: controller.signal, catalog, readSkill: (id) => readSkill(id, request),
        ask: async ({ question, options = [], multiple = false }) => {
          if (!String(question || "").trim()) throw new Error("问题不能为空");
          const decision = { id: randomUUID(), question: String(question), options: options.map((label, index) => ({ id: String(index + 1), label: String(label) })), multiple, allowFreeText: true };
          const answer = new Promise((resolveAnswer, reject) => entry.pending.set(decision.id, { resolve: resolveAnswer, reject, decision }));
          void answer.catch(() => {});
          record.status = "waiting_input";
          await event(entry, "question", decision);
          const value = await answer;
          record.status = "running";
          await event(entry, "answer", { decisionId: decision.id, answer: value });
          return { answer: value };
        },
        candidates: async (variants) => { record.candidates = variants; await event(entry, "candidates", { variants }); return { delivered: variants.length, savedToDocument: false }; },
        media: (args) => media(args, { request, runId: record.id, signal: controller.signal, emit: (type, payload) => event(entry, type, payload) }),
        mediaStatus: (jobId) => mediaStatus(jobId, { request }),
        emit: (type, payload) => event(entry, type, payload),
      });
      if (request.contentOnly) request.messages = [...request.messages, { role: "user", content: "本轮是界面请求的候选内容生成；不要写入文档，只返回所需候选正文。原有选区预览与确认流程负责应用修改。" }];
      await event(entry, "started", { engine: request.settings.agentEngine, model: request.settings.model });
      const profileKey = createHash("sha256").update(JSON.stringify([keyFor(request), request.settings.agentEngine, request.settings.id, request.settings.model])).digest("hex");
      const result = await run({ settings: request.settings, stage: "conversation_agent", sessionId: profileKey, prompt: JSON.stringify({ messages: request.messages, currentDocumentId: request.targetDocumentId || "", selection: request.selection || null, references: request.references || [], selectedSkills: request.selectedSkills || [], attachments: request.attachments || [], previousResults: request.previousResults || [] }), contextBlocks: [{ name: "Agent工具使用边界", text: conversationAgentInstructions }, { name: "任务路由文档", text: route }], signal: controller.signal, workspaceToolRuntime: tools, drainSupplements: () => entry.supplements.splice(0), registerSteer: (handler) => { entry.steer = handler; }, onToolEvent: (data) => event(entry, "tool", data), request });
      record.text = result.text || "";
      record.runtime = result.agentRuntime || result.executionRuntime || request.settings.agentEngine;
      if (controller.signal.aborted) throw new Error("任务已取消");
      record.status = "completed";
      record.pendingSupplements = entry.supplements.splice(0);
      await event(entry, "completed", { text: record.text, runtime: record.runtime, candidates: record.candidates || [] });
    } catch (error) {
      record.status = controller.signal.aborted ? "cancelled" : "failed";
      record.error = String(error.message || error).replaceAll(String(request.settings.apiKey || "\0"), "[REDACTED]").replace(/\b(?:sk|ds|sk-ant)[-_][A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]");
      await event(entry, record.status, { message: record.error }).catch(() => {});
    } finally {
      if (lanes.get(record.key) === record.id) lanes.delete(record.key);
      for (const pending of entry.pending.values()) pending.reject(new Error("任务已经结束"));
      entry.pending.clear();
    }
  };
  return {
    async start(request) {
      if (!request.conversationId || !request.messages?.length) throw new Error("缺少对话或用户消息");
      const key = laneFor(request), id = runIdFor(request);
      const busy = lanes.get(key);
      if (busy && busy !== id) throw Object.assign(new Error("同一对话已有运行任务，请排队或补充"), { code: "AGENT_CONVERSATION_BUSY", runId: busy });
      if (busy === id && runs.has(id)) { await runs.get(id).saving; return { id, status: runs.get(id).record.status, reused: true }; }
      lanes.set(key, id);
      let existing;
      try { existing = await get(id); } catch (error) { lanes.delete(key); throw error; }
      if (existing) { lanes.delete(key); return { id, status: existing.record.status, reused: true }; }
      const entry = { record: { id, key, conversationId: request.conversationId, branchId: request.branchId || "main", workspacePath: request.workspacePath, status: "running", request: safeRequest(request), events: [], text: "", createdAt: new Date().toISOString() }, controller: new AbortController(), supplements: [], pending: new Map() };
      lanes.set(key, id); runs.set(id, entry);
      try { await persist(entry); } catch (error) { lanes.delete(key); runs.delete(id); throw error; }
      entry.task = execute(entry, request);
      return { id, status: "running" };
    },
    async status(id, after = 0) {
      const entry = await get(id);
      if (!entry) throw Object.assign(new Error("任务不存在"), { statusCode: 404 });
      const { record } = entry;
      await entry.saving;
      return { id, conversationId: record.conversationId, workspacePath: record.workspacePath, status: record.status, events: record.events.filter((item) => item.sequence > Number(after)).slice(0, 100), lastSequence: record.events.length, question: [...entry.pending.values()][0]?.decision || null, text: record.text, error: record.error || "", pendingSupplements: record.pendingSupplements || [] };
    },
    async answer(id, decisionId, answer) {
      const entry = await get(id), pending = entry?.pending.get(decisionId);
      if (!pending || terminal(entry.record.status)) throw new Error("选项已过期，请直接发送新的要求");
      if (!String(answer || "").trim()) throw new Error("回答不能为空");
      await event(entry, "answer_accepted", { decisionId, answer: String(answer) });
      entry.pending.delete(decisionId); pending.resolve(String(answer));
      return { accepted: true };
    },
    async supplement(id, content) {
      const entry = await get(id);
      if (!entry || terminal(entry.record.status)) return { accepted: false };
      if (!String(content || "").trim()) throw new Error("补充不能为空");
      if (entry.steer) {
        const accepted = await entry.steer(String(content));
        await event(entry, "supplement", { content: String(content), accepted });
        return { accepted: accepted === true };
      }
      return { accepted: false, reason: "当前运行器不支持中途注入；补充保留在对话队列" };
    },
    async cancel(id) {
      const entry = await get(id);
      if (!entry || terminal(entry.record.status)) return { accepted: false };
      entry.controller.abort();
      for (const pending of entry.pending.values()) pending.reject(Object.assign(new Error("任务已取消"), { name: "AbortError" }));
      entry.pending.clear();
      return { accepted: true };
    },
  };
};
