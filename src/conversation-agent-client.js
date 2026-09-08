export const conversationAgentRequest = async (path, body) => {
  const response = await fetch(path, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw Object.assign(new Error(payload.message || "Agent 请求失败"), { code: payload.code, statusCode: response.status });
  return payload;
};

export const watchConversationAgent = async ({ runId, after = 0, onEvent = async () => {}, onConnectionError = () => {} }) => {
  let cursor = after;
  while (true) {
    let state;
    try { state = await conversationAgentRequest(`/api/conversation-agent/${runId}?after=${cursor}`); }
    catch (error) {
      if ([403, 404, 410].includes(error.statusCode)) throw error;
      onConnectionError(error);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    for (const event of state.events || []) {
      if (event.sequence <= cursor) continue;
      await onEvent(event);
      cursor = event.sequence;
    }
    if (state.lastSequence > cursor) continue;
    if (["completed", "failed", "cancelled", "interrupted"].includes(state.status)) return { ...state, cursor };
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
};

export const snapshotAgentConfiguration = (settings) => JSON.parse(JSON.stringify(settings, (key, value) => /api.?key|secret|password|access.?token|refresh.?token/iu.test(key) ? undefined : value));
