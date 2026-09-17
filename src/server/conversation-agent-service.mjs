import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, appendFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createConversationAgentTools, conversationAgentInstructions } from "./conversation-agent-tools.mjs";
import { normalizeAgentPermissionMode, permissionContractFor } from "../agent-permission-policy.js";

const keyFor = (request) => createHash("sha256").update(JSON.stringify([resolve(request.workspacePath || ".").toLowerCase(), request.conversationId, request.branchId || "main"])).digest("hex");
const laneFor = (request) => keyFor({ ...request, branchId: "conversation-lane" });
const runIdFor = (request) => {
  if (!request.sourceMessageId) return `agent-${randomUUID()}`;
  const hash = createHash("sha256").update(`${keyFor(request)}:${request.sourceMessageId}`).digest("hex").slice(0, 32);
  return `agent-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20)}`;
};
const terminal = (status) => ["completed", "failed", "cancelled", "interrupted"].includes(status);
const safeRequest = (value) => JSON.parse(JSON.stringify(value, (key, entry) => /api.?key|password|secret|access.?token|refresh.?token/iu.test(key) ? undefined : entry));
const redactedErrorMessage = (error, apiKey = "") => String(error?.message || error || "未知错误")
  .replaceAll(String(apiKey || "\0"), "[REDACTED]")
  .replace(/\b(?:sk|ds|sk-ant)[-_][A-Za-z0-9_-]{10,}\b/gu, "[REDACTED]");
const choiceInteractionInstructions = `当且仅当你需要用户从两个或更多具体方向中作出选择时，必须调用 interaction.ask，并动态给出本轮真实问题与选项；不得只在回复正文里提出有限选项问题。问题仍显示在对话记录中，选择框只是便捷回答入口；用户也可以自由输入其他想法。interaction.ask 返回的 answer、instruction 和 userInstruction 是同一条最新用户指令；收到后必须在当前任务内继续推理、生成和交付，不能停在确认步骤或重新询问同一个问题。仅用于阅读的 1/2/3/4 步骤、规则、细则或方案罗列不是选择题，直接作为普通回复输出，不得调用 interaction.ask。不要用正文关键词、编号或固定模板推断选择框。`;

// Models occasionally restate the same decision with different wording after
// receiving an answer. Keep this guard scoped to one Agent run: it is only a
// continuation aid and never participates in task routing or skill selection.
const choiceQuestionTokens = (value = "") => {
  const text = String(value || "")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .replace(/(?:请选择|请你|希望|想要|应采取|作为|唯一|主线|方向|态度|哪一种|哪个|哪些|什么|这篇|文章|本轮|本次|三个|两个|不混写)/gu, "");
  const tokens = new Set();
  for (let index = 0; index < text.length - 1; index += 1) tokens.add(text.slice(index, index + 2));
  return tokens;
};

export const choiceQuestionSimilarity = (left = {}, right = {}) => {
  const leftKey = String(left?.metadata?.dedupeKey || "").trim();
  const rightKey = String(right?.metadata?.dedupeKey || "").trim();
  if (leftKey && rightKey) return leftKey === rightKey ? 1 : 0;
  const leftTokens = choiceQuestionTokens(left.question);
  const rightTokens = choiceQuestionTokens(right.question);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  return overlap / Math.min(leftTokens.size, rightTokens.size);
};

const normalizedChoiceDecision = ({ id, question, options = [], multiple = false, presentation = "", metadata = null } = {}) => {
  const prompt = String(question || "").trim();
  if (!prompt) throw new Error("问题不能为空");
  const seen = new Set();
  const choices = (Array.isArray(options) ? options : []).flatMap((option) => {
    const label = String(option || "").trim();
    if (!label || seen.has(label)) return [];
    seen.add(label);
    return [{ id: String(seen.size), label }];
  });
  if (choices.length < 2) throw new Error("选择问题必须提供至少两个不同选项；普通提问请直接回复文字");
  return {
    id,
    question: prompt,
    options: choices,
    multiple: multiple === true,
    allowFreeText: true,
    ...(presentation ? { presentation: String(presentation).slice(0, 80) } : {}),
    ...(metadata && typeof metadata === "object" ? { metadata: JSON.parse(JSON.stringify(metadata)) } : {}),
  };
};

const trustedDocumentSavedPayload = ({ payload = {}, request = {}, trustedToolRuntime = false } = {}) => {
  const original = payload && typeof payload === "object" ? payload : {};
  const receipt = original.receipt;
  const results = Array.isArray(receipt?.results) ? receipt.results : [];
  const documentId = String(original.documentId || "").trim();
  const result = results.find((item) => String(item?.targetDocumentId || "").trim() === documentId);
  const workspacePath = String(request.workspacePath || "").trim();
  const allResultsVerified = results.length > 0 && results.every((item) => (
    item?.verified === true
    && String(item.writtenHash || "")
    && item.writtenHash === item.verifiedHash
  ));
  const verified = trustedToolRuntime
    && documentId
    && workspacePath
    && receipt?.type === "shensi_batch_landing_receipt"
    && receipt?.status === "completed"
    && receipt?.verified === true
    && Number(receipt?.failed) === 0
    && allResultsVerified
    && result;
  const title = String(result?.requestedTitle || result?.title || "").trim();
  if (!verified || !title) return { ...original, trustedDocumentSave: false };
  const workspaceKind = request.workspaceKind === "notebook" ? "notebook" : "project";
  const workspaceName = String(request.workspaceName || request.projectName || "").trim()
    || basename(resolve(workspacePath));
  const navigationTarget = {
    documentId,
    moduleId: String(result.targetDirectoryId || result.navigationTarget?.moduleId || "").trim(),
    workspaceKind,
    workspacePath,
    workspaceName,
  };
  return {
    ...original,
    title,
    trustedDocumentSave: true,
    landingManifest: {
      schemaVersion: 2,
      kind: "native_agent_document_save",
      nativeAgentDocumentSave: true,
      workspaceKind,
      workspacePath,
      workspaceName,
      segments: [{
        documentId,
        title,
        requestedTitle: title,
        moduleId: navigationTarget.moduleId,
        targetDirectoryId: navigationTarget.moduleId,
        receiptVerified: true,
        navigationTarget,
      }],
      batchLandingReceipt: receipt,
    },
  };
};

export const createConversationAgentService = ({ appRoot, storageRoot, run, skillCatalog, readSkill, readRoute, media, mediaStatus, browser, toolsFactory = createConversationAgentTools } = {}) => {
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
    const item = { sequence: entry.record.events.length + 1, type, payload, at: new Date().toISOString() };
    entry.record.events.push(item);
    // Append only the new event. Full snapshots are reserved for terminal state.
    const line = JSON.stringify({ event: item, status: entry.record.status }) + "\n";
    entry.saving = (entry.saving || Promise.resolve()).then(() => appendFile(`${recordPath(entry.record.id)}.events`, line, { encoding: "utf8", flush: !["tool", "text_delta", "resource_read"].includes(type) }));
    await entry.saving;
    if (terminal(entry.record.status)) await persist(entry);
  };
  const get = async (id) => {
    if (runs.has(id)) return runs.get(id);
    let record;
    try { record = JSON.parse(await readFile(recordPath(id), "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    const journal = await readFile(`${recordPath(id)}.events`, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
    const lines = journal.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!lines[index]) continue;
      let item;
      try { item = JSON.parse(lines[index]); } catch (error) { if (index === lines.length - 1) break; throw error; }
      if (item.event.sequence <= record.events.length) continue;
      if (item.event.sequence !== record.events.length + 1) throw new Error("任务事件序号不连续，保留原记录等待恢复");
      record.events.push(item.event); record.status = item.status;
      if (item.event.type === "completed") record.text = item.event.payload.text;
      if (["failed", "cancelled"].includes(item.event.type)) record.error = item.event.payload.message;
    }
    const recoveredInterruptedRun = !terminal(record.status);
    if (recoveredInterruptedRun) { record.status = "interrupted"; record.error = "服务重启，任务已保留；请检查已完成结果后继续，未自动重提生成。"; }
    const entry = { record, controller: new AbortController(), supplements: [], pending: new Map(), answerFlights: new Map(), choiceAnswers: [] };
    runs.set(id, entry);
    if (recoveredInterruptedRun) await persist(entry);
    return entry;
  };
  const execute = async (entry, request) => {
    const { record, controller } = entry;
    let textBuffer = "", textTimer = null;
    const flushText = () => {
      clearTimeout(textTimer); textTimer = null;
      if (!textBuffer) return Promise.resolve();
      const text = textBuffer; textBuffer = "";
      return event(entry, "text_delta", { text });
    };
    const bufferText = (text) => {
      textBuffer += String(text || "");
      if (!textTimer) textTimer = setTimeout(() => { void flushText().catch(() => {}); }, 160);
    };
    try {
      const catalogSource = await skillCatalog(request);
      const catalog = Array.isArray(catalogSource) ? catalogSource : catalogSource?.skills || [];
      const routeSource = await readRoute({ ...request, routeBundle: catalogSource?.routeBundle || null });
      const routeBundle = routeSource?.routeBundle || catalogSource?.routeBundle || null;
      const route = typeof routeSource === "string" ? routeSource : routeSource?.text || "";
      for (const source of routeSource?.sources || []) {
        if (source.characters > 0) await event(entry, source.userVisible === false ? "route_read" : "resource_read", source);
      }
      if (routeBundle?.panel?.text) await event(entry, "route_read", { kind: "panel_route", placementId: routeBundle.panel.placementId, title: routeBundle.panel.name || "面板路由", characters: routeBundle.panel.text.length, userVisible: false });
      const trustedToolRuntime = toolsFactory === createConversationAgentTools;
      const requestUserInput = async ({ question, options = [], multiple = false, presentation = "", metadata = null, kind = "question", detail = null }) => {
        const decision = kind === "agent_permission"
          ? {
              id: randomUUID(),
              kind: "agent_permission",
              question: String(question || "").trim(),
              options: options.map((option, index) => ({ id: String(option?.id || index + 1), label: String(option?.label || option) })),
              multiple: multiple === true,
              allowFreeText: false,
              ...(detail && typeof detail === "object" ? { detail } : {}),
            }
          : normalizedChoiceDecision({ id: randomUUID(), question, options, multiple, presentation, metadata });
        if (!decision.question) throw new Error("问题不能为空");
        const prior = kind === "agent_permission"
          ? null
          : (entry.choiceAnswers || []).find((item) => choiceQuestionSimilarity(item.decision, decision) >= 0.58);
        if (prior) {
          await event(entry, "answer_reused", {
            decisionId: decision.id,
            sourceDecisionId: prior.decision.id,
            answer: prior.answer,
            reason: "同一运行内已回答过语义相同的选择问题",
          });
          return {
            answer: prior.answer,
            instruction: prior.answer,
            userInstruction: prior.answer,
            continueOriginalTask: true,
          };
        }
        const answer = new Promise((resolveAnswer, reject) => entry.pending.set(decision.id, { resolve: resolveAnswer, reject, decision }));
        void answer.catch(() => {});
        record.status = "waiting_input";
        await event(entry, "question", decision);
        const value = await answer;
        record.status = "running";
        if (kind !== "agent_permission") {
          entry.choiceAnswers ??= [];
          entry.choiceAnswers.push({ decision, answer: value });
        }
        await event(entry, "answer", { decisionId: decision.id, answer: value });
        return {
          answer: value,
          instruction: value,
          userInstruction: value,
          continueOriginalTask: true,
        };
      };
      const tools = toolsFactory({ appRoot, ...request, requestId: record.id, signal: controller.signal, catalog, routeBundle, readSkill: (id) => readSkill(id, request), browser,
        ask: requestUserInput,
        candidates: async (variants) => { record.candidates = variants; await event(entry, "candidates", { variants }); return { delivered: variants.length, savedToDocument: false }; },
        media: (args) => media(args, { request, runId: record.id, signal: controller.signal, emit: (type, payload) => event(entry, type, payload) }),
        mediaStatus: (jobId, archive = false) => mediaStatus(jobId, { request, archive, emit: (type, payload) => event(entry, type, payload) }),
        emit: (type, payload) => event(entry, type, type === "document_saved"
          ? trustedDocumentSavedPayload({ payload, request, trustedToolRuntime })
          : payload),
      });
      if (request.contentOnly) request.messages = [...request.messages, { role: "user", content: "本轮是界面请求的候选内容生成；不要写入文档，只返回所需候选正文。原有选区预览与确认流程负责应用修改。" }];
      await event(entry, "started", { engine: request.settings.agentEngine, model: request.settings.model, permissionMode: request.settings.agentPermissionMode });
      const profileKey = createHash("sha256").update(JSON.stringify([keyFor(request), request.settings.agentEngine, request.settings.id, request.settings.model, request.settings.agentPermissionMode])).digest("hex");
      const runOptions = { settings: request.settings, stage: "conversation_agent", sessionId: profileKey, prompt: JSON.stringify({ messages: request.messages, currentDocumentId: request.currentDocument?.documentId || request.targetDocumentId || "", currentDocument: request.currentDocument || null, targetDocumentId: request.targetDocumentId || "", selection: request.selection || null, references: request.references || [], selectedSkills: request.selectedSkills || [], attachments: request.attachments || [], previousResults: request.previousResults || [], mediaDispatch: request.mediaDispatch || null }), contextBlocks: [{ name: "Agent工具使用边界", text: conversationAgentInstructions }, { name: "动态选择交互", text: choiceInteractionInstructions }, { name: "面板路由与运行规范", text: route }, { name: "本轮权限快照", text: JSON.stringify(record.permissionContract) }], signal: controller.signal, workspaceToolRuntime: tools, drainSupplements: () => entry.supplements.splice(0), registerSteer: (handler) => { entry.steer = handler; }, isWaitingForUser: () => record.status === "waiting_input", onToolEvent: (data) => data.phase === "text_delta" ? bufferText(data.text) : event(entry, "tool", data), requestApproval: (details) => requestUserInput({ ...details, kind: "agent_permission" }), permissionContract: record.permissionContract, request  };
      let result = await run(runOptions);
      const deliveryReviewWarnings = [];
      // Reconcile conversation-only delivery against the original user request,
      // not the writer's self-declared mode. This stays semantic, never keyword-routed.
      if (tools.deliveryStatus?.().mode === "conversation" && !request.contentOnly) {
        await event(entry, "progress", { message: "正在核对成果归档" });
        const previousText = result.text;
        try {
          const checked = await run({ ...runOptions, deliveryReview: true,
            onToolEvent: (data) => data.phase === "text_delta" ? undefined : runOptions.onToolEvent(data),
            prompt: JSON.stringify({ originalTask: runOptions.prompt, result: previousText, delivery: tools.deliveryStatus(), instruction: "请独立复核原始用户要求和本轮成果是否一致。真实图片或视频任务必须声明media并调用media.generate，不能只返回提示词或文字声称已生成。用户要求制作自检、质检或审稿报告时，应保存到编译报告集合中的具体报告文档；不修改被检查正文不等于不保存报告。只有用户明确只在对话交付、普通问答或未采用候选，才保持conversation。选择面板能力分支后必须真实调用 skills.read；只读取面板、模组或模块路由不等于读取 Skill。确实无需 Skill 的通用问答，重新调用 interaction.delivery，声明 routingMode=general 并给出基于完整任务语义的 routingReason。若需要归档，先声明正确交付类型并完成对应工具调用；只凭检索片段不能声称全文自检或已加载Skill。若原先conversation确实正确，原样返回本轮成果，不添加核验闲话。不要重复已验收写入或媒体任务。" }) });
          result = { ...checked, text: checked.text || previousText };
        } catch (error) {
          deliveryReviewWarnings.push(`交付复核未完成：${redactedErrorMessage(error, request.settings.apiKey)}`);
          result = { ...result, text: previousText };
        }
      }
      // Give the Agent a bounded pair of delivery-repair attempts. The first
      // pass can correct a missing declaration; the second can complete a
      // failed media/document tool call. A hard cap prevents silent infinite
      // retries while still allowing the normal correction loop to finish.
      for (let attempt = 0; attempt < 2 && tools.deliveryStatus; attempt++) {
        const delivery = tools.deliveryStatus();
        if (delivery.declared && !delivery.missing.length && !delivery.failed.length) break;
        await event(entry, "progress", { message: "Agent 正在核对并完成交付" });
        const previousText = result.text;
        try {
          const repaired = await run({ ...runOptions,
            onToolEvent: (data) => data.phase === "text_delta" ? undefined : runOptions.onToolEvent(data),
            prompt: JSON.stringify({ originalTask: runOptions.prompt, previousResponse: previousText, delivery, instruction: "继续同一任务，根据原始用户要求核对交付。若 routing.complete=false，先根据面板路由选择真实分支，读取对应模组/模块路由并调用 skills.read；只读路由不能代替读取 Skill。确实无需 Skill 的通用问答，应调用 interaction.delivery 声明 routingMode=general，并提供基于完整任务语义的 routingReason。随后声明真实任务类型和交付方式；要求保存的内容必须用 documents 工具完成并验收，真实图片或视频必须用 media.generate 完成下载验收。不要重复已成功的操作，不要凭文字声称已保存、已生成或已读取 Skill。" }) });
          result = { ...repaired, text: repaired.text || previousText };
        } catch (error) {
          deliveryReviewWarnings.push(`交付补救未完成：${redactedErrorMessage(error, request.settings.apiKey)}`);
          result = { ...result, text: previousText };
          break;
        }
      }
      const finalDelivery = tools.deliveryStatus?.();
      const deliveryWarnings = [...new Set([
        ...deliveryReviewWarnings,
        ...(!finalDelivery?.declared ? ["本轮没有完成交付方式声明"] : []),
        ...(finalDelivery?.warnings || []),
        ...(finalDelivery?.missing || []).map((item) => `未完成：${item}`),
        ...(finalDelivery?.failed || []).map((item) => `执行失败：${item}`),
      ])];
      const deliveryFailures = [...new Set([
        ...(finalDelivery?.missing || []).map((item) => `未完成：${item}`),
        ...(finalDelivery?.failed || []).map((item) => `执行失败：${item}`),
      ])];
      if (deliveryWarnings.length) {
        record.deliveryWarnings = deliveryWarnings;
        await event(entry, "delivery_warning", {
          message: deliveryFailures.length
            ? "结果正文已保留，但本轮交付未完成；请根据真实错误处理后重试。"
            : "结果已保留并正常交付；以下验收项存在提示，不影响查看本次结果。",
          warnings: deliveryWarnings,
          delivery: finalDelivery,
        });
      }
      record.text = result.text || "";
      await flushText();
      record.runtime = result.agentRuntime || result.executionRuntime || request.settings.agentEngine;
      if (controller.signal.aborted) throw new Error("任务已取消");
      if (deliveryFailures.length) {
        record.status = "failed";
        record.error = deliveryFailures.join("；");
        await event(entry, "failed", {
          message: record.error,
          warnings: record.deliveryWarnings || [],
          delivery: finalDelivery,
        });
      } else {
        record.status = "completed";
      }
      record.pendingSupplements = entry.supplements.splice(0);
      if (record.status === "completed") {
        await event(entry, "completed", { text: record.text, runtime: record.runtime, candidates: record.candidates || [], warnings: record.deliveryWarnings || [] });
      }
    } catch (error) {
      record.status = controller.signal.aborted ? "cancelled" : "failed";
      record.error = redactedErrorMessage(error, request.settings.apiKey);
      await event(entry, record.status, { message: record.error }).catch(() => {});
    } finally {
      clearTimeout(textTimer);
      if (lanes.get(record.key) === record.id) lanes.delete(record.key);
      for (const pending of entry.pending.values()) pending.reject(new Error("任务已经结束"));
      entry.pending.clear();
    }
  };
  return {
    async start(request) {
      if (!request.conversationId || !request.messages?.length) throw new Error("缺少对话或用户消息");
      request = {
        ...request,
        settings: {
          ...(request.settings || {}),
          agentPermissionMode: normalizeAgentPermissionMode(request.settings?.agentPermissionMode),
        },
      };
      const key = laneFor(request), id = runIdFor(request);
      const busy = lanes.get(key);
      if (busy && busy !== id) throw Object.assign(new Error("同一对话已有运行任务，请排队或补充"), { code: "AGENT_CONVERSATION_BUSY", runId: busy });
      if (busy === id && runs.has(id)) { await runs.get(id).saving; return { id, status: runs.get(id).record.status, reused: true }; }
      lanes.set(key, id);
      let existing;
      try { existing = await get(id); } catch (error) { lanes.delete(key); throw error; }
      if (existing) { lanes.delete(key); return { id, status: existing.record.status, reused: true }; }
      const permissionContract = permissionContractFor(request.settings.agentPermissionMode, { runner: request.settings.agentEngine, taskId: id });
      const entry = { record: { id, key, conversationId: request.conversationId, branchId: request.branchId || "main", workspacePath: request.workspacePath, status: "running", permissionContract, request: safeRequest(request), events: [], text: "", createdAt: new Date().toISOString() }, controller: new AbortController(), supplements: [], pending: new Map(), answerFlights: new Map(), choiceAnswers: [] };
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
      return { id, conversationId: record.conversationId, workspacePath: record.workspacePath, status: record.status, events: record.events.filter((item) => item.sequence > Number(after)).slice(0, 100), lastSequence: record.events.length, question: [...entry.pending.values()][0]?.decision || null, text: record.text, error: record.error || "", deliveryWarnings: record.deliveryWarnings || [], pendingSupplements: record.pendingSupplements || [], permissionContract: record.permissionContract || null };
    },
    async answer(id, decisionId, answer) {
      const entry = await get(id);
      if (!entry) throw new Error("选项已过期，请直接发送新的要求");
      entry.answerFlights ??= new Map();
      const existingFlight = entry.answerFlights.get(decisionId);
      if (existingFlight) return existingFlight;
      const operation = (async () => {
        const pending = entry.pending.get(decisionId);
        if (!pending && entry.record.events.some(item => item.type === "answer_accepted" && item.payload.decisionId === decisionId)) return { accepted: true };
        if (!pending || terminal(entry.record.status)) throw new Error("选项已过期，请直接发送新的要求");
        if (!String(answer || "").trim()) throw new Error("回答不能为空");
        const value = String(answer);
        entry.record.status = "running";
        await event(entry, "answer_accepted", { decisionId, answer: value });
        await event(entry, "progress", { message: "已收到选择，Agent 正在继续生成" });
        entry.pending.delete(decisionId);
        pending.resolve(value);
        return { accepted: true };
      })();
      entry.answerFlights.set(decisionId, operation);
      try {
        return await operation;
      } finally {
        if (entry.answerFlights.get(decisionId) === operation) entry.answerFlights.delete(decisionId);
      }
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
