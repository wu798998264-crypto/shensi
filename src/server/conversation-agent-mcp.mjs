import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const startConversationAgentMcp = async ({ tools, onToolEvent = () => {}, signal } = {}) => {
  const token = randomBytes(32).toString("hex");
  const toolMap = new Map(tools.dynamicTools.flatMap((namespace) => namespace.tools.map((tool) => [`${namespace.name}_${tool.name}`, { namespace: namespace.name, tool }])));
  const server = createServer(async (request, response) => {
    const auth = String(request.headers.authorization || "");
    const expected = `Bearer ${token}`;
    if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) { response.writeHead(403); response.end(); return; }
    if (request.method === "DELETE") { response.writeHead(200); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let id;
    const send = (result, error) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));
    };
    try {
      let source = "";
      for await (const chunk of request) { source += chunk; if (Buffer.byteLength(source) > 4_000_000) throw new Error("MCP 请求过大"); }
      const message = JSON.parse(source); id = message.id;
      if (id === undefined) { response.writeHead(202); response.end(); return; }
      if (message.method === "initialize") return send({ protocolVersion: message.params?.protocolVersion || "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "shensi-workspace", version: "1.0.0" } });
      if (message.method === "ping") return send({});
      if (message.method === "tools/list") return send({ tools: [...toolMap].map(([name, { tool }]) => ({ name, description: tool.description, inputSchema: tool.inputSchema })) });
      if (message.method !== "tools/call") return send(null, { code: -32601, message: "Unknown method" });
      const target = toolMap.get(message.params?.name);
      if (!target || signal?.aborted) throw new Error("工具不可用或任务已取消");
      const input = message.params.arguments || {};
      await onToolEvent({ phase: "started", name: message.params.name, input, callId: String(id) });
      const result = await tools.invoke({ namespace: target.namespace, tool: target.tool.name, arguments: input });
      await onToolEvent({ phase: "completed", name: message.params.name, success: result.success, callId: String(id) });
      return send({ isError: !result.success, content: result.contentItems.map((item) => ({ type: "text", text: item.text || "" })) });
    } catch (error) { send(null, { code: -32603, message: String(error.message || error) }); }
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    toolNames: [...toolMap.keys()],
    close: async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); },
  };
};
