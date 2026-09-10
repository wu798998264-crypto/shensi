import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { fetchProvider } from "./network-proxy.mjs";
import { normalizeAgentPermissionMode } from "../agent-permission-policy.js";

const contentText = (content) => typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((part) => part.text || "").join("\n");
export const responsesInputToChat = (input = [], instructions = "", names = new Map()) => {
  const messages = instructions ? [{ role: "system", content: instructions }] : [];
  for (const item of typeof input === "string" ? [{ role: "user", content: input }] : input) {
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = item.namespace ? `${item.namespace}_${item.name}` : item.name;
      const args = item.type === "custom_tool_call"
        ? JSON.stringify({ input: String(item.input || "") })
        : item.arguments;
      const call = { id: item.call_id, type: "function", function: { name, arguments: args } };
      if (messages.at(-1)?.role === "assistant" && messages.at(-1).tool_calls) messages.at(-1).tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    else if (item.role) {
      const images = Array.isArray(item.content) && item.content.some((part) => part.type === "input_image");
      const content = images ? item.content.map((part) => part.type === "input_image" ? { type: "image_url", image_url: { url: part.image_url, detail: part.detail || "auto" } } : { type: "text", text: part.text || "" }) : contentText(item.content);
      if (content) messages.push({ role: item.role === "developer" ? "system" : item.role, content });
    }
  }
  return messages;
};

const parsedObject = (value, fallback = {}) => {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const anthropicImageBlock = (part = {}) => {
  const imageUrl = String(part.image_url?.url || part.image_url || "").trim();
  if (!imageUrl) return null;
  const dataUrl = /^data:([^;,]+);base64,(.+)$/su.exec(imageUrl);
  return {
    type: "image",
    source: dataUrl
      ? { type: "base64", media_type: dataUrl[1], data: dataUrl[2] }
      : { type: "url", url: imageUrl },
  };
};

const appendAnthropicMessage = (messages, role, content = []) => {
  const blocks = (Array.isArray(content) ? content : []).filter(Boolean);
  if (!blocks.length) return;
  const normalizedRole = role === "assistant" ? "assistant" : "user";
  if (messages.at(-1)?.role === normalizedRole) messages.at(-1).content.push(...blocks);
  else messages.push({ role: normalizedRole, content: blocks });
};

export const responsesInputToAnthropic = (input = [], instructions = "") => {
  const messages = [];
  const system = [];
  if (String(instructions || "").trim()) system.push(String(instructions).trim());
  for (const item of typeof input === "string" ? [{ role: "user", content: input }] : input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const name = item.namespace ? `${item.namespace}_${item.name}` : item.name;
      appendAnthropicMessage(messages, "assistant", [{
        type: "tool_use",
        id: item.call_id || item.id || `call_${randomUUID()}`,
        name: String(name || ""),
        input: item.type === "custom_tool_call"
          ? { input: String(item.input || "") }
          : parsedObject(item.arguments),
      }]);
      continue;
    }
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      appendAnthropicMessage(messages, "user", [{
        type: "tool_result",
        tool_use_id: item.call_id || item.id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output),
      }]);
      continue;
    }
    if (!item.role) continue;
    const rawParts = typeof item.content === "string" ? [{ type: "text", text: item.content }] : Array.isArray(item.content) ? item.content : [];
    const blocks = rawParts.map((part) => {
      if (!part || typeof part !== "object") return null;
      if (["text", "input_text", "output_text"].includes(part.type) && String(part.text || "").trim()) return { type: "text", text: String(part.text) };
      if (part.type === "input_image") return anthropicImageBlock(part);
      return null;
    }).filter(Boolean);
    if (["system", "developer"].includes(item.role)) {
      const value = blocks.filter((part) => part.type === "text").map((part) => part.text).join("\n").trim();
      if (value) system.push(value);
    } else appendAnthropicMessage(messages, item.role, blocks);
  }
  return { system: system.join("\n\n"), messages };
};

const providerToolsFor = (requestedTools = [], shensiTools = []) => {
  const shensiByName = new Map(shensiTools.map((tool) => [String(tool?.name || ""), tool]));
  const includedShensi = new Set();
  const merged = [];
  for (const tool of Array.isArray(requestedTools) ? requestedTools : []) {
    const name = String(tool?.name || "");
    if (tool?.type === "namespace" && name) {
      for (const child of Array.isArray(tool.tools) ? tool.tools : []) {
        const childName = String(child?.name || "");
        if (childName) includedShensi.add(`${name}_${childName}`);
      }
    }
    if (name && shensiByName.has(name)) {
      if (!includedShensi.has(name)) merged.push(shensiByName.get(name));
      includedShensi.add(name);
      continue;
    }
    merged.push(tool);
  }
  for (const [name, tool] of shensiByName) {
    if (!includedShensi.has(name)) merged.push(tool);
  }
  return merged;
};

const chatToolProjection = (tools = []) => {
  const projected = [];
  const calls = new Map();
  const add = ({ name, description = "", parameters = null, target }) => {
    const normalizedName = String(name || "").replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
    if (!normalizedName || calls.has(normalizedName)) return;
    calls.set(normalizedName, target);
    projected.push({
      type: "function",
      function: {
        name: normalizedName,
        description: String(description || "Agent tool").slice(0, 1_024),
        parameters: parameters && typeof parameters === "object"
          ? parameters
          : { type: "object", properties: {}, additionalProperties: true },
      },
    });
  };
  for (const tool of Array.isArray(tools) ? tools : []) {
    const type = String(tool?.type || "");
    const name = String(tool?.name || "");
    if (type === "function" && name) {
      add({
        name,
        description: tool.description,
        parameters: tool.parameters || tool.input_schema,
        target: { type: "function", name },
      });
      continue;
    }
    if (type === "namespace" && name) {
      for (const child of Array.isArray(tool.tools) ? tool.tools : []) {
        const childName = String(child?.name || "");
        if (!childName) continue;
        add({
          name: `${name}_${childName}`,
          description: child.description || tool.description,
          parameters: child.parameters || child.input_schema || child.inputSchema,
          target: { type: "namespace", namespace: name, name: childName },
        });
      }
      continue;
    }
    if (type === "custom" && name) {
      add({
        name,
        description: `${String(tool.description || name)} Return the custom tool input in the input string field.`,
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "Exact custom tool input" } },
          required: ["input"],
          additionalProperties: false,
        },
        target: { type: "custom", name },
      });
    }
  }
  return { tools: projected, calls };
};

const anthropicToolProjection = (tools = []) => {
  const projected = chatToolProjection(tools);
  const webSearch = (Array.isArray(tools) ? tools : []).some((tool) => ["web_search", "web_search_preview"].includes(String(tool?.type || "")));
  return {
    calls: projected.calls,
    tools: [
      ...(webSearch ? [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }] : []),
      ...projected.tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        input_schema: tool.function.parameters,
      })),
    ],
  };
};

const chatCallAsResponsesItem = (call, projection = new Map()) => {
  const callId = call?.id || `call_${randomUUID()}`;
  const functionName = String(call?.function?.name || "");
  const target = projection.get(functionName) || { type: "function", name: functionName };
  const args = String(call?.function?.arguments || "{}");
  if (target.type === "custom") {
    let input = args;
    try {
      const parsed = JSON.parse(args);
      if (typeof parsed?.input === "string") input = parsed.input;
    } catch {}
    return { type: "custom_tool_call", id: `ctc_${randomUUID()}`, call_id: callId, name: target.name, input, status: "completed" };
  }
  return {
    type: "function_call",
    id: `fc_${randomUUID()}`,
    call_id: callId,
    ...(target.type === "namespace" ? { namespace: target.namespace } : {}),
    name: target.name,
    arguments: args,
    status: "completed",
  };
};

export const startCodexProviderBridge = async ({ settings, tools, permissionContract = null, fetchImpl = globalThis.fetch, signal, onRequest = () => {} }) => {
  const token = randomBytes(32).toString("hex");
  const catalog = new Map(tools.dynamicTools.flatMap((ns) => ns.tools.map((tool) => [`${ns.name}_${tool.name}`, { namespace: ns.name, name: tool.name, tool }])));
  const functionTools = [...catalog].map(([name, { tool }]) => ({ type: "function", name, description: tool.description, parameters: tool.inputSchema, strict: false }));
  const forwardNativeTools = normalizeAgentPermissionMode(permissionContract?.mode || settings.agentPermissionMode) !== "shensi_only";
  const known = new Map();
  const controllers = new Set();
  const server = createServer(async (req, res) => {
    const auth = String(req.headers.authorization || ""), expected = `Bearer ${token}`;
    if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { res.writeHead(403); res.end(); return; }
    const controller = new AbortController(); controllers.add(controller);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      if (req.method !== "POST" || !/\/responses$/u.test(req.url || "")) throw new Error("当前提供商桥仅提供 Responses 任务推理");
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32_000_000) throw new Error("推理输入超过大小上限"); chunks.push(chunk); }
      let buffer = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") buffer = gunzipSync(buffer);
      else if (req.headers["content-encoding"] === "deflate") buffer = inflateSync(buffer);
      else if (req.headers["content-encoding"] === "zstd") buffer = zstdDecompressSync(buffer);
      if (buffer.length > 64_000_000) throw new Error("解压后的推理输入过大");
      const request = JSON.parse(buffer.toString("utf8"));
      const fullInput = request.previous_response_id ? [...(known.get(request.previous_response_id) || []), ...(request.input || [])] : request.input || [];
      if (request.previous_response_id && !known.has(request.previous_response_id)) throw new Error("缺少连续任务上下文，拒绝无上下文重试");
      const chat = settings.protocol === "chat_completions";
      const anthropic = ["anthropic_messages", "messages"].includes(settings.protocol);
      const providerTools = forwardNativeTools ? providerToolsFor(request.tools, functionTools) : functionTools;
      const chatProjection = chatToolProjection(providerTools);
      const anthropicProjection = anthropicToolProjection(providerTools);
      const input = Array.isArray(fullInput) ? fullInput.map((item) => item.type === "function_call" ? { ...item, name: item.namespace ? `${item.namespace}_${item.name}` : item.name, namespace: undefined } : item) : fullInput;
      const anthropicInput = anthropic ? responsesInputToAnthropic(fullInput, request.instructions) : null;
      const upstream = anthropic ? {
        model: settings.model,
        ...(anthropicInput.system ? { system: anthropicInput.system } : {}),
        messages: anthropicInput.messages,
        ...(anthropicProjection.tools.length ? { tools: anthropicProjection.tools } : {}),
        max_tokens: Number(settings.maxOutputTokens) || 12000,
      } : chat ? {
        model: settings.model, messages: responsesInputToChat(fullInput, request.instructions), tools: chatProjection.tools, tool_choice: "auto", stream: false, max_tokens: Number(settings.maxOutputTokens) || 12000,
      } : { ...request, model: settings.model, input, previous_response_id: undefined, tools: providerTools, store: false, stream: false, max_output_tokens: Number(settings.maxOutputTokens) || 12000 };
      onRequest({
        model: settings.model,
        protocol: settings.protocol,
        toolCount: providerTools.length,
        requestedTools: (Array.isArray(request.tools) ? request.tools : []).map((tool) => ({ type: String(tool?.type || ""), name: String(tool?.name || "") })),
        forwardedTools: providerTools.map((tool) => ({ type: String(tool?.type || ""), name: String(tool?.name || "") })),
      });
      const response = await fetchProvider(`${String(settings.baseUrl).replace(/\/+$/u, "")}/${anthropic ? "messages" : chat ? "chat/completions" : "responses"}`, {
        method: "POST",
        headers: anthropic
          ? { "content-type": "application/json", "anthropic-version": "2023-06-01", ...(settings.apiKey ? { "x-api-key": settings.apiKey } : {}) }
          : { "content-type": "application/json", ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
        body: JSON.stringify(upstream),
        signal: controller.signal,
      }, { fetchImpl, allowDirectFallback: true });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error?.message || `上游 HTTP ${response.status}`);
      const message = payload.choices?.[0]?.message || {};
      const anthropicContent = Array.isArray(payload.content) ? payload.content : [];
      const rawOutput = anthropic ? [
        ...anthropicContent.filter((part) => part?.type === "tool_use").map((part) => chatCallAsResponsesItem({
          id: part.id,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input || {}) },
        }, anthropicProjection.calls)),
        ...(anthropicContent.some((part) => part?.type === "text" && String(part.text || "").trim()) ? [{
          type: "message",
          id: `msg_${randomUUID()}`,
          role: "assistant",
          status: "completed",
          content: anthropicContent.filter((part) => part?.type === "text" && String(part.text || "").trim()).map((part) => ({ type: "output_text", text: String(part.text), annotations: [] })),
        }] : []),
      ] : chat ? [
        ...(message.tool_calls || []).map((call) => chatCallAsResponsesItem(call, chatProjection.calls)),
        ...(contentText(message.content) ? [{ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: contentText(message.content), annotations: [] }] }] : []),
      ] : payload.output || [];
      const output = rawOutput.map((item) => {
        if (item.type !== "function_call") return item;
        if (item.namespace) return item;
        const target = catalog.get(item.name);
        if (!target) return item;
        return { ...item, name: target.name, namespace: target.namespace };
      });
      if (!output.length) throw new Error("上游没有返回文本或工具调用");
      const translatedUsage = anthropic
        ? { input_tokens: payload.usage?.input_tokens || 0, output_tokens: payload.usage?.output_tokens || 0, total_tokens: (payload.usage?.input_tokens || 0) + (payload.usage?.output_tokens || 0) }
        : chat ? { input_tokens: payload.usage?.prompt_tokens || 0, output_tokens: payload.usage?.completion_tokens || 0, total_tokens: payload.usage?.total_tokens || 0 } : payload.usage;
      const id = `resp_${randomUUID()}`, result = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: settings.model, status: "completed", output, usage: translatedUsage };
      known.set(id, [...(Array.isArray(fullInput) ? fullInput : [{ role: "user", content: fullInput }]), ...output]);
      if (known.size > 8) known.delete(known.keys().next().value);
      if (!request.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result)); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let seq = 0;
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      send("response.created", { response: { ...result, status: "in_progress", output: [] } });
      output.forEach((item, index) => {
        const functionCall = item.type === "function_call";
        const customToolCall = item.type === "custom_tool_call";
        send("response.output_item.added", { output_index: index, item: functionCall ? { ...item, arguments: "", status: "in_progress" } : customToolCall ? { ...item, input: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
        if (item.type === "function_call") {
          send("response.function_call_arguments.delta", { output_index: index, item_id: item.id, delta: item.arguments });
          send("response.function_call_arguments.done", { output_index: index, item_id: item.id, arguments: item.arguments });
        } else if (customToolCall) {
          send("response.custom_tool_call_input.delta", { output_index: index, item_id: item.id, delta: item.input });
          send("response.custom_tool_call_input.done", { output_index: index, item_id: item.id, input: item.input });
        } else if (item.type === "message") item.content.forEach((part, content_index) => {
          send("response.content_part.added", { output_index: index, item_id: item.id, content_index, part: { ...part, text: "" } });
          send("response.output_text.delta", { output_index: index, item_id: item.id, content_index, delta: part.text });
          send("response.output_text.done", { output_index: index, item_id: item.id, content_index, text: part.text });
          send("response.content_part.done", { output_index: index, item_id: item.id, content_index, part });
        });
        send("response.output_item.done", { output_index: index, item });
      });
      send("response.completed", { response: result }); res.end();
    } catch (error) {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: String(error.message).replaceAll(settings.apiKey || "\0", "[REDACTED]") } }));
    } finally { controllers.delete(controller); signal?.removeEventListener("abort", abort); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, token, close: async () => { for (const c of controllers) c.abort(); server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
};
