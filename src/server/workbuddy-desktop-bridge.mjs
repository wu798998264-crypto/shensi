import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const clean = (value = "") => String(value ?? "").replace(/\0/gu, "").trim();
const DEFAULT_TIMEOUT_MS = 1_800_000;
const ACP_HEADERS = { "x-codebuddy-request": "1", "content-type": "application/json", accept: "application/json, text/event-stream" };

const configRoot = (environment = process.env) => clean(environment.WORKBUDDY_CONFIG_DIR || environment.CODEBUDDY_CONFIG_DIR)
  || join(homedir(), ".workbuddy");

const controlPipePath = (root, uuid) => `\\\\.\\pipe\\workbuddy-${createHash("sha1").update(resolve(root)).digest("hex").slice(0, 12)}-sidecar-control-${uuid}`;

const powershell = async (command, timeoutMs = 5_000) => {
  const result = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 256 * 1024,
  });
  return String(result.stdout || "");
};

const listSidecars = async ({ environment = process.env } = {}) => {
  if (process.platform !== "win32") return [];
  // Unit/contract tests pass synthetic environments.  Never inspect the
  // developer's real WorkBuddy process in that mode, otherwise a fixture
  // intended to represent a logged-out runner would be contaminated by the
  // current desktop session.
  if (environment !== process.env && environment?.SHENSI_ALLOW_WORKBUDDY_BRIDGE_TEST !== "1") return [];
  const raw = await powershell("Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress").catch(() => "");
  let rows;
  try { rows = JSON.parse(raw || "[]"); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const root = configRoot(environment);
  return rows.map((row) => {
    const commandLine = clean(row?.CommandLine);
    const uuid = commandLine.match(/--control-pipe-uuid\s+([0-9a-f-]{8,})/iu)?.[1] || "";
    const executable = commandLine.match(/(?:^|\s)([A-Za-z]:\\[^"]*?WorkBuddy\.exe)(?:\s|$)/iu)?.[1] || "";
    return uuid ? { uuid, pid: Number(row?.ProcessId) || 0, executable, commandLine, controlPipe: controlPipePath(root, uuid) } : null;
  }).filter(Boolean);
};

const controlRequest = (pipe, request, timeoutMs = 30_000) => new Promise((resolveRequest, rejectRequest) => {
  const socket = net.createConnection(pipe);
  let buffer = "";
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.destroy();
    if (error) rejectRequest(error); else resolveRequest(value);
  };
  const timer = setTimeout(() => finish(new Error("WorkBuddy sidecar 控制通道超时")), timeoutMs);
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    try {
      const payload = JSON.parse(line);
      if (payload?.error) finish(Object.assign(new Error(payload.error.message || "WorkBuddy sidecar 请求失败"), { code: payload.error.code }));
      else finish(null, payload?.result);
    } catch (error) { finish(error); }
  });
  socket.once("error", (error) => finish(error));
  socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
});

const discoverSidecar = async (options = {}) => {
  const candidates = await listSidecars(options);
  for (const candidate of candidates) {
    const ping = await controlRequest(candidate.controlPipe, { jsonrpc: "2.0", id: 1, method: "sidecar.ping", params: {} }).catch(() => null);
    if (ping?.pid) return { ...candidate, ping };
  }
  return null;
};

const asHeaders = (headers = {}) => Object.entries(headers || {}).filter(([name, value]) => name && value != null).map(([name, value]) => ({ name, value: String(value) }));
const toMcpServers = (nativeHost) => nativeHost?.url ? [{
  name: "shensi",
  type: "http",
  url: String(nativeHost.url),
  headers: asHeaders(nativeHost.headers),
}] : [];

const createHeadlessSession = async ({ sidecar, cwd, nativeHost, sessionId = randomUUID(), timeoutMs = 90_000 } = {}) => {
  const executable = sidecar.executable || join(dirname(dirname(sidecar.commandLine || "")), "WorkBuddy.exe");
  const root = executable ? dirname(executable) : "";
  const codebuddy = root ? join(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy") : "";
  if (!executable || !codebuddy) throw new Error("未找到 WorkBuddy 桌面端或内置 ACP CLI");
  const result = await controlRequest(sidecar.controlPipe, {
    jsonrpc: "2.0",
    id: 2,
    method: "session.create",
    params: {
      sessionId,
      command: executable,
      cwd: resolve(cwd || process.cwd()),
      port: 0,
      cols: 120,
      rows: 40,
      args: [codebuddy, "--serve"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1",
        CODEBUDDY_FORCE_LITE_WB_BUNDLE: "1",
      },
    },
  }, timeoutMs);
  if (!result?.acpEndpoint) throw new Error("WorkBuddy ACP 会话未返回连接地址");
  return result;
};

const parseSse = (source = "") => {
  const messages = [];
  for (const block of String(source).split(/\r?\n\r?\n/u)) {
    const data = block.split(/\r?\n/u).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data) continue;
    try { messages.push(JSON.parse(data)); } catch {}
  }
  return messages;
};

const acpPost = async (endpoint, credentials, message, { signal, timeoutMs = 120_000, onUpdate } = {}) => {
  const headers = {
    ...ACP_HEADERS,
    "acp-connection-id": credentials.connectionId,
    ...(credentials.sessionToken ? { "acp-session-token": credentials.sessionToken } : {}),
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  try {
    const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(message), signal: controller.signal });
    const body = await response.text();
    if (!response.ok) throw new Error(`WorkBuddy ACP 请求失败（${response.status}）：${body.slice(-400)}`);
    const messages = response.headers.get("content-type")?.includes("text/event-stream") ? parseSse(body) : [JSON.parse(body)];
    for (const event of messages) if (event?.method === "session/update") onUpdate?.(event.params || {});
    return messages.find((event) => event?.id === message.id) || messages.at(-1) || {};
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
};

const updateText = (params = {}) => {
  if (params?.update?.sessionUpdate !== "agent_message_chunk") return "";
  const content = params.update.content;
  if (typeof content === "string") return content;
  if (typeof content?.text === "string") return content.text;
  if (typeof content?.delta === "string") return content.delta;
  return "";
};

const connectAcp = async (endpoint, options = {}) => {
  const connectEndpoint = `${String(endpoint).replace(/\/$/u, "")}/connect`;
  const response = await fetch(connectEndpoint, { method: "POST", headers: { "x-codebuddy-request": "1" }, signal: options.signal });
  if (!response.ok) throw new Error(`WorkBuddy ACP 连接失败（${response.status}）`);
  const credentials = await response.json();
  if (!credentials?.connectionId) throw new Error("WorkBuddy ACP 未返回会话凭据");
  return credentials;
};

const closeAcp = async (endpoint, credentials) => {
  if (!credentials?.connectionId) return;
  await fetch(String(endpoint), {
    method: "DELETE",
    headers: {
      ...ACP_HEADERS,
      "acp-connection-id": credentials.connectionId,
      ...(credentials.sessionToken ? { "acp-session-token": credentials.sessionToken } : {}),
    },
  }).catch(() => {});
};

const sessionModels = (result = {}) => (Array.isArray(result?.models?.availableModels) ? result.models.availableModels : [])
  .map((item) => ({ id: clean(item?.modelId || item?.id), name: clean(item?.name || item?.modelId || item?.id) }))
  .filter((item) => item.id);

export const inspectWorkBuddyDesktopBridge = async ({ cwd = process.cwd(), nativeHost = null, environment = process.env, timeoutMs = 90_000 } = {}) => {
  const sidecar = await discoverSidecar({ environment });
  if (!sidecar) return { connected: false, authenticated: null, state: "bridge_unavailable", models: [], message: "WorkBuddy 桌面端未提供可用 ACP 桥接；桌面端登录状态未被判定为失效" };
  let session;
  let credentials;
  try {
    const listed = await controlRequest(sidecar.controlPipe, { jsonrpc: "2.0", id: 3, method: "session.list", params: {} }).catch(() => []);
    session = Array.isArray(listed) && listed[0]?.acpEndpoint ? listed[0] : await createHeadlessSession({ sidecar, cwd, nativeHost, timeoutMs });
    try {
      credentials = await connectAcp(session.acpEndpoint);
    } catch (error) {
      // A sidecar can outlive its last ACP child after a desktop update or a
      // terminated task.  Recreate one bounded session instead of turning a
      // stale endpoint into a false login failure.
      session = await createHeadlessSession({ sidecar, cwd, nativeHost, timeoutMs });
      credentials = await connectAcp(session.acpEndpoint);
    }
    await acpPost(session.acpEndpoint, credentials, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "shensi", version: "1.0" } } }, { timeoutMs });
    const created = await acpPost(session.acpEndpoint, credentials, { jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: resolve(cwd), mcpServers: toMcpServers(nativeHost) } }, { timeoutMs });
    const result = created?.result || {};
    return {
      connected: true,
      authenticated: true,
      state: "ready",
      ready: true,
      models: sessionModels(result).map((item) => item.id),
      modelLabels: Object.fromEntries(sessionModels(result).map((item) => [item.id, item.name])),
      catalogSource: "workbuddy_acp_session",
      session,
      message: `WorkBuddy 桌面会话有效，已读取 ${sessionModels(result).length} 个真实模型`,
    };
  } catch (error) {
    return { connected: false, authenticated: null, state: "bridge_error", models: [], message: clean(error?.message || error).slice(0, 500), errorCode: "WORKBUDDY_DESKTOP_BRIDGE_ERROR" };
  } finally {
    await closeAcp(session?.acpEndpoint, credentials);
  }
};

export const runWorkBuddyDesktopBridge = async ({ prompt, model = "", cwd = process.cwd(), nativeHost = null, environment = process.env, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent } = {}) => {
  const sidecar = await discoverSidecar({ environment });
  if (!sidecar) {
    const error = new Error("WorkBuddy 桌面端已登录，但神思未发现可用 ACP 桥接；请保持 WorkBuddy 客户端运行后重试");
    error.code = "WORKBUDDY_DESKTOP_BRIDGE_UNAVAILABLE";
    throw error;
  }
  const listed = await controlRequest(sidecar.controlPipe, { jsonrpc: "2.0", id: 4, method: "session.list", params: {} }).catch(() => []);
  let session = Array.isArray(listed) && listed[0]?.acpEndpoint ? listed[0] : await createHeadlessSession({ sidecar, cwd, nativeHost, timeoutMs: Math.min(timeoutMs, 120_000) });
  let credentials;
  try {
    credentials = await connectAcp(session.acpEndpoint, { signal });
  } catch (error) {
    session = await createHeadlessSession({ sidecar, cwd, nativeHost, timeoutMs: Math.min(timeoutMs, 120_000) });
    credentials = await connectAcp(session.acpEndpoint, { signal });
  }
  try {
    await acpPost(session.acpEndpoint, credentials, { jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "shensi", version: "1.0" } } }, { signal, timeoutMs: Math.min(timeoutMs, 120_000) });
    const created = await acpPost(session.acpEndpoint, credentials, { jsonrpc: "2.0", id: 6, method: "session/new", params: { cwd: resolve(cwd), mcpServers: toMcpServers(nativeHost) } }, { signal, timeoutMs: Math.min(timeoutMs, 120_000) });
    const sessionResult = created?.result || {};
    const sessionId = clean(sessionResult.sessionId);
    if (!sessionId) throw new Error("WorkBuddy ACP 未创建任务会话");
    const available = sessionModels(sessionResult);
    const selectedModel = clean(model) && (available.length === 0 || available.some((item) => item.id === clean(model))) ? clean(model) : "auto";
    if (clean(model) && selectedModel === "auto" && available.length && !available.some((item) => item.id === clean(model))) {
      const error = new Error(`WorkBuddy 当前真实目录没有模型“${clean(model)}”；可选模型：${available.map((item) => item.id).join("、")}`);
      error.code = "WORKBUDDY_MODEL_UNAVAILABLE";
      throw error;
    }
    if (selectedModel && selectedModel !== "auto") {
      const switched = await acpPost(session.acpEndpoint, credentials, {
        jsonrpc: "2.0",
        id: 8,
        method: "session/set_model",
        params: { sessionId, modelId: selectedModel },
      }, { signal, timeoutMs: Math.min(timeoutMs, 120_000) });
      if (switched?.error) throw Object.assign(new Error(switched.error.message || "WorkBuddy 模型切换失败"), { code: "WORKBUDDY_MODEL_SWITCH_FAILED" });
    }
    let text = "";
    const update = (params) => {
      const delta = updateText(params);
      if (!delta) return;
      text += delta;
      onEvent?.({ type: "text", phase: "text_delta", text: delta, part: { type: "text", id: "workbuddy-acp", text: delta } });
    };
    const promptResult = await acpPost(session.acpEndpoint, credentials, { jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: String(prompt || "") }] } }, { signal, timeoutMs, onUpdate: update });
    const finalText = text || updateText(promptResult?.params || {}) || clean(promptResult?.result?.text || "");
    if (!finalText) throw new Error("WorkBuddy ACP 已结束，但没有返回可用文本");
    return { text: finalText.trim(), sessionId, actualProvider: "WorkBuddy", actualModel: selectedModel, executionRuntime: "workbuddy_desktop_acp", permissionMode: "shensi_only" };
  } finally {
    await closeAcp(session?.acpEndpoint, credentials);
  }
};
