export const createConversationAgentApi = ({
  appRoot,
  gateway,
  readJsonBody,
  resolveWorkspaceRoot,
  sendJson,
  requestError,
} = {}) => async ({ pathname, request, response } = {}) => {
  const respond = (status, payload) => {
    sendJson(response, status, payload);
    return true;
  };

  if (pathname === "/api/conversation-agent/start" && request.method === "POST") {
    const body = await readJsonBody(request, 16 * 1024 * 1024);
    if (body.outputSurface === "whiteboard" || body.whiteboardContext) {
      throw requestError("对话 Agent 入口不接收白板任务", 422);
    }
    const workspacePath = body.workspacePath
      ? resolveWorkspaceRoot({ appRoot, requestedPath: body.workspacePath })
      : "";
    const instruction = String(body.messages?.at(-1)?.content || "").trim();
    if (!instruction) throw requestError("指令不能为空", 422);
    const result = await gateway.start({ ...body, workspacePath, instruction });
    return respond(202, { ok: true, ...result });
  }

  const match = pathname.match(/^\/api\/conversation-agent\/(agent-[a-f0-9-]{36})(?:\/(answer|supplement|cancel))?$/u);
  if (!match) return false;
  const [, id, action] = match;
  if (!action && request.method === "GET") {
    const after = new URL(request.url, "http://localhost").searchParams.get("after") || 0;
    return respond(200, { ok: true, ...await gateway.status(id, after) });
  }
  if (action && request.method === "POST") {
    const body = await readJsonBody(request, 1024 * 1024);
    const result = action === "answer"
      ? await gateway.answer(id, body.decisionId, body.answer)
      : action === "supplement"
        ? await gateway.supplement(id, body.content)
        : await gateway.cancel(id);
    return respond(200, { ok: true, ...result });
  }
  return false;
};
