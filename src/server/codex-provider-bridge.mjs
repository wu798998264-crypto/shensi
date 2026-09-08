import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { fetchProvider } from "./network-proxy.mjs";

const contentText = (content) => typeof content === "string" ? content : (Array.isArray(content) ? content : []).map((part) => part.text || "").join("\n");
export const responsesInputToChat = (input = [], instructions = "", names = new Map()) => {
  const messages = instructions ? [{ role: "system", content: instructions }] : [];
  for (const item of typeof input === "string" ? [{ role: "user", content: input }] : input) {
    if (item.type === "function_call") {
      const name = item.namespace ? `${item.namespace}_${item.name}` : item.name;
      const call = { id: item.call_id, type: "function", function: { name, arguments: item.arguments } };
      if (messages.at(-1)?.role === "assistant" && messages.at(-1).tool_calls) messages.at(-1).tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item.type === "function_call_output") messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output) });
    else if (item.role) {
      const images = Array.isArray(item.content) && item.content.some((part) => part.type === "input_image");
      const content = images ? item.content.map((part) => part.type === "input_image" ? { type: "image_url", image_url: { url: part.image_url, detail: part.detail || "auto" } } : { type: "text", text: part.text || "" }) : contentText(item.content);
      if (content) messages.push({ role: item.role === "developer" ? "system" : item.role, content });
    }
  }
  return messages;
};

export const startCodexProviderBridge = async ({ settings, tools, fetchImpl = globalThis.fetch, signal, onRequest = () => {} }) => {
  const token = randomBytes(32).toString("hex");
  const catalog = new Map(tools.dynamicTools.flatMap((ns) => ns.tools.map((tool) => [`${ns.name}_${tool.name}`, { namespace: ns.name, name: tool.name, tool }])));
  const functionTools = [...catalog].map(([name, { tool }]) => ({ type: "function", name, description: tool.description, parameters: tool.inputSchema, strict: false }));
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
      const input = Array.isArray(fullInput) ? fullInput.map((item) => item.type === "function_call" ? { ...item, name: item.namespace ? `${item.namespace}_${item.name}` : item.name, namespace: undefined } : item) : fullInput;
      const upstream = chat ? {
        model: settings.model, messages: responsesInputToChat(fullInput, request.instructions), tools: functionTools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } })), tool_choice: "auto", stream: false, max_tokens: Number(settings.maxOutputTokens) || 12000,
      } : { ...request, model: settings.model, input, previous_response_id: undefined, tools: functionTools, store: false, stream: false, max_output_tokens: Number(settings.maxOutputTokens) || 12000 };
      onRequest({ model: settings.model, protocol: settings.protocol, toolCount: functionTools.length });
      const response = await fetchProvider(`${String(settings.baseUrl).replace(/\/+$/u, "")}/${chat ? "chat/completions" : "responses"}`, { method: "POST", headers: { "content-type": "application/json", ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) }, body: JSON.stringify(upstream), signal: controller.signal }, { fetchImpl, allowDirectFallback: true });
      const payload = await response.json();
      if (!response.ok || payload.error) throw new Error(payload.error?.message || `上游 HTTP ${response.status}`);
      const message = payload.choices?.[0]?.message || {};
      const rawOutput = chat ? [
        ...(message.tool_calls || []).map((call) => ({ type: "function_call", id: `fc_${randomUUID()}`, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: "completed" })),
        ...(contentText(message.content) ? [{ type: "message", id: `msg_${randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: contentText(message.content), annotations: [] }] }] : []),
      ] : payload.output || [];
      const output = rawOutput.map((item) => {
        if (item.type !== "function_call") return item;
        const target = catalog.get(item.name);
        if (!target) throw new Error(`模型请求了当前未提供的工具：${item.name}`);
        return { ...item, name: target.name, namespace: target.namespace };
      });
      if (!output.length) throw new Error("上游没有返回文本或工具调用");
      const id = `resp_${randomUUID()}`, result = { id, object: "response", created_at: Math.floor(Date.now() / 1000), model: settings.model, status: "completed", output, usage: chat ? { input_tokens: payload.usage?.prompt_tokens || 0, output_tokens: payload.usage?.completion_tokens || 0, total_tokens: payload.usage?.total_tokens || 0 } : payload.usage };
      known.set(id, [...(Array.isArray(fullInput) ? fullInput : [{ role: "user", content: fullInput }]), ...output]);
      if (known.size > 8) known.delete(known.keys().next().value);
      if (!request.stream) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result)); return; }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      let seq = 0;
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
      send("response.created", { response: { ...result, status: "in_progress", output: [] } });
      output.forEach((item, index) => {
        send("response.output_item.added", { output_index: index, item: item.type === "function_call" ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } });
        if (item.type === "function_call") {
          send("response.function_call_arguments.delta", { output_index: index, item_id: item.id, delta: item.arguments });
          send("response.function_call_arguments.done", { output_index: index, item_id: item.id, arguments: item.arguments });
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
