import { fetchProvider } from "./network-proxy.mjs";
import { isShensiAgentCompatibleProfile } from "../agent-engine-registry.js";
import { isGpt6AstraModel, sanitizeModelControls } from "../model-presets.js";

const text = (value = "") => String(value ?? "").trim();

const safeJson = async (response) => {
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch {}
  if (!response.ok) {
    const detail = text(payload?.error?.message || payload?.message || raw).slice(0, 600);
    const error = new Error(`神思运行器 API 请求失败（${response.status}）${detail ? `：${detail}` : ""}`);
    error.code = response.status === 401 ? "CODEX_API_UNAUTHORIZED"
      : response.status === 403 ? "CODEX_API_FORBIDDEN"
        : response.status === 429 ? "CODEX_API_RATE_LIMITED" : "CODEX_API_REQUEST_FAILED";
    error.statusCode = response.status;
    throw error;
  }
  if (!payload || typeof payload !== "object") throw Object.assign(new Error("神思运行器 API 返回了无效响应"), { code: "CODEX_API_INVALID_RESPONSE" });
  return payload;
};

const missingToolContinuationContext = (error) => error?.statusCode === 400
  && /(?:No tool call found for function call output|function_call_output[\s\S]{0,120}call_id|tool call[\s\S]{0,80}(?:not found|missing))/iu.test(String(error?.message || ""));

const responseContinuationItems = (payload) => (Array.isArray(payload?.output) ? payload.output : [])
  .filter((item) => item && typeof item === "object");

const outputText = (payload) => {
  const direct = text(payload?.output_text);
  if (direct) return direct;
  const values = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value.type === "output_text" && typeof value.text === "string") values.push(value.text);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.values(value).forEach(visit);
  };
  visit(payload?.output);
  return values.join("\n").trim();
};

const contextText = (blocks = []) => (Array.isArray(blocks) ? blocks : [])
  .map((block) => {
    const name = text(block?.name || block?.title || block?.id);
    const value = String(block?.text || "").trim();
    return value ? `[${name || "神思上下文"}]\n${value}` : "";
  })
  .filter(Boolean)
  .join("\n\n");

const buildInstructions = ({ contextBlocks = [], stage = "agent" } = {}) => [
  `<shensi-stage name="${stage}">`,
  ...(stage === "conversation_agent" ? ["你是完整的 Agent。根据当前指令、任务路由和已读取证据自主执行。按需发现文档与 Skill，通过提供的工具完成任务；真实工具结果才是读写和生成成功的依据。"] : [
    "你由神思运行器通过当前配置已核验的 Agent 协议执行。神思服务端负责文档、Skill、任务合同和正式落盘；你只能调用本轮明确提供的受控工具，不能自行猜测未读取的文件内容，也不能声称调用了实际未调用的工具。",
    "工作区工具均为只读且受当前作品、历史授权和读取预算约束。正式文档修改必须返回完整候选内容和目标信息，由神思事务层校验 revision、保存历史并落盘；不得要求只读工具写文件，也不得声称已经直接覆盖作品文件。",
  ]),
  contextText(contextBlocks),
  "</shensi-stage>",
].filter(Boolean).join("\n\n");

const normalizeBaseUrl = (value) => text(value || "https://api.openai.com/v1").replace(/\/+$/u, "");

const workspaceFunctionTools = (workspaceToolRuntime) => {
  const tools = [];
  const calls = new Map();
  for (const namespace of Array.isArray(workspaceToolRuntime?.dynamicTools) ? workspaceToolRuntime.dynamicTools : []) {
    const namespaceName = text(namespace?.name);
    if (!namespaceName) continue;
    for (const entry of Array.isArray(namespace?.tools) ? namespace.tools : []) {
      const toolName = text(entry?.name);
      if (!toolName || entry?.type !== "function") continue;
      const apiName = `${namespaceName}_${toolName}`.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
      if (!apiName || calls.has(apiName)) continue;
      calls.set(apiName, { namespace: namespaceName, tool: toolName });
      tools.push({
        type: "function",
        name: apiName,
        description: text(entry.description || namespace.description || `Call ${namespaceName}.${toolName}`),
        parameters: entry.inputSchema && typeof entry.inputSchema === "object"
          ? entry.inputSchema
          : { type: "object", properties: {}, additionalProperties: false },
        // The host broker performs the authoritative schema and permission
        // checks. Some workspace schemas intentionally contain optional
        // fields, so Responses strict mode must remain disabled here.
        strict: false,
      });
    }
  }
  return { tools, calls };
};

const functionCalls = (payload) => (Array.isArray(payload?.output) ? payload.output : [])
  .filter((item) => item?.type === "function_call" && text(item.call_id || item.id) && text(item.name));

const parsedArguments = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (!text(value)) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const toolResultText = (result) => {
  const items = Array.isArray(result?.contentItems) ? result.contentItems : [];
  const values = items.map((item) => text(item?.text)).filter(Boolean);
  return values.join("\n") || JSON.stringify({ ok: result?.success === true });
};

const webSources = (payload) => {
  const collected = new Map();
  const visit = (value) => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object") return;
    const url = text(value.url || value.link);
    if (/^https?:\/\//iu.test(url) && !collected.has(url)) {
      collected.set(url, { url, title: text(value.title || value.name || url) });
    }
    Object.values(value).forEach(visit);
  };
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    if (item?.type === "web_search_call") visit(item.action?.sources || item.sources);
    if (item?.type === "message") visit(item.content);
  }
  return [...collected.values()].slice(0, 20);
};

export const createCodexApiAgentRuntime = ({ fetchImpl = globalThis.fetch, now = () => new Date().toISOString() } = {}) => {
  const active = new Map();
  const supports = (options = {}) => {
    const settings = options.settings || {};
    return Boolean(
      text(options.sessionId)
      && text(options.stage)
      && settings.agentEngine === "codex_api"
      && settings.adapter === "api"
      && isShensiAgentCompatibleProfile(settings)
      && ["responses", "chat_completions"].includes(text(settings.protocol))
      && (text(settings.apiKey) || text(settings.credentialSource) === "public")
      && text(settings.baseUrl || "https://api.openai.com/v1")
      && text(settings.model),
    );
  };

  const runStage = async ({ settings = {}, prompt = "", contextBlocks = [], stage = "agent", sessionId = "", signal = null, workspaceToolRuntime = null, onToolEvent = null, drainSupplements = () => [] } = {}) => {
    if (!supports({ settings, stage, sessionId })) {
      throw Object.assign(new Error("神思运行器配置不完整：需要已核验的 Responses 或 Chat Completions Agent 配置"), { code: "CODEX_API_AGENT_CONFIG_INVALID" });
    }
    const normalizedSessionId = text(sessionId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    active.set(normalizedSessionId, controller);
    try {
      const instructions = buildInstructions({ contextBlocks, stage });
      const startedAt = now();
      const workspace = workspaceFunctionTools(workspaceToolRuntime);
      const gpt6Controls = isGpt6AstraModel(settings.model) ? sanitizeModelControls({
        ...settings,
        reasoningEffort: settings.agentReasoningEffort || settings.reasoningEffort || "",
        speedMode: settings.agentSpeedMode || settings.speedMode || "default",
      }) : null;
      if (gpt6Controls && text(settings.protocol) === "chat_completions" && workspace.tools.length) {
        throw Object.assign(new Error("GPT-6 Astra 工具调用需要 Responses 协议，请在该文字配置中明确选择 Responses；未修改现有配置。"), { code: "GPT6_RESPONSES_REQUIRED" });
      }
      if (text(settings.protocol) === "chat_completions") {
        const chatTools = workspace.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        }));
        const maxToolCalls = Math.max(1, Math.min(stage === "conversation_agent" ? 256 : 32, Number(settings.maxToolCalls) || (stage === "conversation_agent" ? 96 : 12)));
        const messages = [
          { role: "system", content: instructions },
          { role: "user", content: String(prompt || "") },
        ];
        let payload = null;
        let usedToolCalls = 0;
        let workspaceToolsUsed = false;
        const workspaceToolCalls = [];
        while (true) {
          for (const content of drainSupplements()) messages.push({ role: "user", content: String(content) });
          const response = await fetchProvider(`${normalizeBaseUrl(settings.baseUrl)}/chat/completions`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              ...(text(settings.apiKey) ? { authorization: `Bearer ${text(settings.apiKey)}` } : {}),
            },
            body: JSON.stringify({
              model: text(settings.model),
              messages,
              ...(gpt6Controls ? {
                max_completion_tokens: Math.max(256, Math.min(32_000, Number(settings.maxOutputTokens) || 8_000)),
                ...(gpt6Controls.reasoningEffort ? { reasoning_effort: gpt6Controls.reasoningEffort } : {}),
                ...(gpt6Controls.speedMode === "fast" ? { service_tier: "priority" } : {}),
              } : { max_tokens: Math.max(256, Math.min(32_000, Number(settings.maxOutputTokens) || 8_000)) }),
              ...(chatTools.length ? { tools: chatTools, tool_choice: "auto" } : {}),
            }),
            signal: controller.signal,
          }, { fetchImpl, allowDirectFallback: true });
          payload = await safeJson(response);
          const message = payload?.choices?.[0]?.message || {};
          const calls = Array.isArray(message.tool_calls) ? message.tool_calls.filter((call) => text(call?.id) && text(call?.function?.name)) : [];
          if (!calls.length) {
            const result = text(message.content);
            if (!result) throw Object.assign(new Error("神思运行器响应中没有可用文本"), { code: "CODEX_API_EMPTY_RESPONSE" });
            return {
              text: result,
              protocol: "chat_completions",
              providerResponseId: payload.id || "",
              usage: payload.usage || null,
              sources: [],
              webSearchUsed: false,
              workspaceToolsUsed,
              workspaceToolCalls,
              sessionId: normalizedSessionId,
              startedAt,
              completedAt: now(),
              agentRuntime: { runtime: "shensi_chat_completions_agent", sessionId: normalizedSessionId, stage, toolCalls: usedToolCalls },
            };
          }
          if (usedToolCalls + calls.length > maxToolCalls) {
            throw Object.assign(new Error(`神思运行器工具调用超过单任务上限（${maxToolCalls}）`), { code: "CODEX_API_TOOL_CALL_LIMIT" });
          }
          messages.push({ role: "assistant", content: message.content || null, tool_calls: calls });
          for (const call of calls) {
            usedToolCalls += 1;
            const callId = text(call.id);
            const name = text(call.function?.name);
            const target = workspace.calls.get(name);
            const args = parsedArguments(call.function?.arguments);
            onToolEvent?.({ phase: "started", kind: "workspace", callId, name: target ? `${target.namespace}.${target.tool}` : name, input: args });
            let result;
            if (!target || typeof workspaceToolRuntime?.invoke !== "function") {
              result = { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: { code: "CODEX_API_TOOL_UNAVAILABLE", message: "该工具未获神思授权" } }) }] };
            } else {
              workspaceToolsUsed = true;
              result = await workspaceToolRuntime.invoke({ namespace: target.namespace, tool: target.tool, arguments: args });
              workspaceToolCalls.push({ name: `${target.namespace}.${target.tool}`, success: result?.success === true, target: text(args.path || args.reference || args.documentId || args.query).slice(0, 300) });
            }
            onToolEvent?.({ phase: "completed", kind: "workspace", callId, name: target ? `${target.namespace}.${target.tool}` : name, input: args, success: result?.success === true });
            messages.push({ role: "tool", tool_call_id: callId, content: toolResultText(result) });
          }
        }
      }
      const tools = [
        ...(settings.webSearchEnabled === true ? [{ type: "web_search" }] : []),
        ...workspace.tools,
      ];
      const maxToolCalls = Math.max(1, Math.min(32, Number(settings.maxToolCalls) || 12));
      const commonBody = {
          model: text(settings.model),
          instructions,
          max_output_tokens: Math.max(256, Math.min(32_000, Number(settings.maxOutputTokens) || 8_000)),
          // Agent requests carry their controls as agentReasoningEffort /
          // agentSpeedMode, while generic model requests use the shorter
          // reasoningEffort / speedMode names. Accept both so the API runner
          // follows the same picker choices as the existing local runners.
          ...(gpt6Controls ? (gpt6Controls.reasoningEffort ? { reasoning: { effort: gpt6Controls.reasoningEffort } } : {}) : text(settings.agentReasoningEffort || settings.reasoningEffort) ? {
            reasoning: { effort: text(settings.agentReasoningEffort || settings.reasoningEffort) },
          } : {}),
          ...(gpt6Controls ? (gpt6Controls.speedMode === "fast" ? { service_tier: "priority" } : {}) : text(settings.agentSpeedMode || settings.speedMode)
            && text(settings.agentSpeedMode || settings.speedMode) !== "default" ? {
            service_tier: text(settings.agentSpeedMode || settings.speedMode),
          } : {}),
          // Responses-compatible relays do not consistently implement the
          // OpenAI-only max_tool_calls request parameter. The runtime enforces
          // the same hard limit locally before invoking any returned tools.
          ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      };
      let input = [{ role: "user", content: [{ type: "input_text", text: String(prompt || "") }] }];
      let manualInput = [...input];
      let previousResponseId = "";
      let manualContinuation = false;
      let payload = null;
      let usedToolCalls = 0;
      let workspaceToolsUsed = false;
      let webSearchUsed = false;
      const sources = new Map();
      const workspaceToolCalls = [];
      while (true) {
        try {
          const response = await fetchProvider(`${normalizeBaseUrl(settings.baseUrl)}/responses`, {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              authorization: `Bearer ${text(settings.apiKey)}`,
              ...(text(settings.organization) ? { "OpenAI-Organization": text(settings.organization) } : {}),
            },
            body: JSON.stringify({
              ...commonBody,
              input,
              ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
            }),
            signal: controller.signal,
          }, { fetchImpl, allowDirectFallback: true });
          payload = await safeJson(response);
        } catch (error) {
          if (!manualContinuation && previousResponseId && missingToolContinuationContext(error)) {
            // Some OpenAI-compatible relays return a response id but do not
            // retain its tool-call state. Retry only the provider submission
            // with the complete call/output transcript; the tool itself has
            // already run and must never be invoked or charged twice.
            manualContinuation = true;
            previousResponseId = "";
            input = manualInput;
            continue;
          }
          throw error;
        }
        const webCalls = (Array.isArray(payload.output) ? payload.output : []).filter((item) => item?.type === "web_search_call");
        webSearchUsed ||= webCalls.length > 0;
        for (const call of webCalls) {
          const callId = text(call.id || `web_search_${usedToolCalls + 1}`);
          const query = text(call.action?.query || call.query);
          onToolEvent?.({ phase: "started", kind: "web_search", callId, name: "OpenAI Web Search", input: query ? { query } : null });
          onToolEvent?.({ phase: "completed", kind: "web_search", callId, name: "OpenAI Web Search", input: query ? { query } : null, success: call.status !== "failed" });
        }
        for (const source of webSources(payload)) sources.set(source.url, source);
        const calls = functionCalls(payload);
        if (!calls.length) break;
        if (usedToolCalls + calls.length > maxToolCalls) {
          throw Object.assign(new Error(`神思运行器工具调用超过单任务上限（${maxToolCalls}）`), { code: "CODEX_API_TOOL_CALL_LIMIT" });
        }
        const outputs = [];
        for (const call of calls) {
          usedToolCalls += 1;
          const callId = text(call.call_id || call.id);
          const target = workspace.calls.get(text(call.name));
          const args = parsedArguments(call.arguments);
          onToolEvent?.({ phase: "started", kind: "workspace", callId, name: target ? `${target.namespace}.${target.tool}` : text(call.name), input: args });
          let result;
          if (!target || typeof workspaceToolRuntime?.invoke !== "function") {
            result = { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: { code: "CODEX_API_TOOL_UNAVAILABLE", message: "该工具未获神思授权" } }) }] };
          } else {
            workspaceToolsUsed = true;
            result = await workspaceToolRuntime.invoke({
              namespace: target.namespace,
              tool: target.tool,
              arguments: args,
            });
            workspaceToolCalls.push({
              name: `${target.namespace}.${target.tool}`,
              success: result?.success === true,
              target: text(args.path || args.reference || args.documentId || args.query).slice(0, 300),
            });
          }
          onToolEvent?.({ phase: "completed", kind: "workspace", callId, name: target ? `${target.namespace}.${target.tool}` : text(call.name), input: args, success: result?.success === true });
          outputs.push({ type: "function_call_output", call_id: callId, output: toolResultText(result) });
        }
        manualInput = [...manualInput, ...responseContinuationItems(payload), ...outputs];
        if (manualContinuation) {
          input = manualInput;
          previousResponseId = "";
        } else {
          previousResponseId = text(payload.id);
          if (!previousResponseId) {
            // A stateless compatible endpoint can still continue safely when
            // it returned the function call itself. Send the complete local
            // transcript instead of rejecting an otherwise valid Agent run.
            manualContinuation = true;
            input = manualInput;
          } else {
            input = outputs;
          }
        }
      }
      const result = outputText(payload);
      if (!result) throw Object.assign(new Error("神思运行器响应中没有可用文本"), { code: "CODEX_API_EMPTY_RESPONSE" });
      return {
        text: result,
        protocol: "responses",
        providerResponseId: payload.id || "",
        usage: payload.usage || null,
        sources: [...sources.values()],
        webSearchUsed,
        workspaceToolsUsed,
        workspaceToolCalls,
        sessionId: normalizedSessionId,
        startedAt,
        completedAt: now(),
        agentRuntime: { runtime: "codex_api_agent", sessionId: normalizedSessionId, stage, toolCalls: usedToolCalls },
      };
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted || controller.signal.aborted) {
        throw Object.assign(new Error("神思运行器任务已停止"), { name: "AbortError", code: "TASK_CANCELLED" });
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      if (active.get(normalizedSessionId) === controller) active.delete(normalizedSessionId);
    }
  };

  return {
    supports,
    runStage,
    releaseSession(sessionId = "") {
      const controller = active.get(text(sessionId));
      controller?.abort();
      return Boolean(controller);
    },
    close() {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
};
