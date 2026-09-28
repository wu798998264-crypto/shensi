import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const clean = (value = "") => String(value ?? "").replace(/\0/gu, "").trim();
const DEFAULT_TIMEOUT_MS = 1_800_000;
const BRIDGE_READINESS_WINDOW_MS = 12_000;
const BRIDGE_POLL_INTERVAL_MS = 500;
const ACP_HEADERS = { "x-codebuddy-request": "1", "content-type": "application/json", accept: "application/json, text/event-stream" };

const configRoot = (environment = process.env) => clean(environment.WORKBUDDY_CONFIG_DIR || environment.CODEBUDDY_CONFIG_DIR)
  || join(homedir(), ".workbuddy");

const resolvedProductConfigPath = async (environment = process.env) => {
  const root = configRoot(environment);
  const cacheRoot = join(root, "cache");
  const spillRoot = join(cacheRoot, "conversation-product-spill");
  const entries = await readdir(spillRoot, { withFileTypes: true }).catch(() => []);
  const candidates = [
    join(cacheRoot, "acc-product-config-v3.json"),
    ...entries
      .filter((entry) => entry.isFile() && /^acc-product-config-v3-[a-f0-9]+\.json$/iu.test(entry.name))
      .map((entry) => join(spillRoot, entry.name)),
  ];
  const valid = [];
  for (const candidate of candidates) {
    const source = await readFile(candidate, "utf8").catch(() => "");
    if (!source) continue;
    let payload;
    try {
      payload = JSON.parse(source);
      if (!payload || typeof payload !== "object" || (!Array.isArray(payload.models) && !Array.isArray(payload.agents))) continue;
    } catch { continue; }
    const metadata = await stat(candidate).catch(() => null);
    const cliAgent = Array.isArray(payload.agents)
      ? payload.agents.find((agent) => clean(agent?.name).toLocaleLowerCase() === "cli")
      : null;
    const modelCount = Array.isArray(cliAgent?.models) ? cliAgent.models.length : 0;
    valid.push({ path: candidate, modelCount, mtimeMs: Number(metadata?.mtimeMs || 0), size: source.length });
  }
  valid.sort((left, right) => right.modelCount - left.modelCount || right.mtimeMs - left.mtimeMs || right.size - left.size);
  return valid[0]?.path || "";
};

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

const waitForSidecar = async ({ environment = process.env, signal = null, timeoutMs = BRIDGE_READINESS_WINDOW_MS } = {}) => {
  // Synthetic environments used by contract tests intentionally do not touch
  // the desktop process table. Keep those calls immediate; the bounded wait
  // is only for the real first-use WorkBuddy startup race.
  const synthetic = environment !== process.env && environment?.SHENSI_ALLOW_WORKBUDDY_BRIDGE_TEST !== "1";
  const windowMs = synthetic ? 0 : Math.min(BRIDGE_READINESS_WINDOW_MS, Math.max(0, Number(timeoutMs) || BRIDGE_READINESS_WINDOW_MS));
  const deadline = Date.now() + windowMs;
  let sidecar = await discoverSidecar({ environment });
  while (!sidecar && Date.now() < deadline) {
    if (signal?.aborted) throw Object.assign(new Error("WorkBuddy ACP 请求已取消"), { name: "AbortError" });
    await new Promise((resolveDelay, rejectDelay) => {
      const timer = setTimeout(() => { signal?.removeEventListener?.("abort", abort); resolveDelay(); }, Math.min(BRIDGE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
      const abort = () => { clearTimeout(timer); signal?.removeEventListener?.("abort", abort); rejectDelay(Object.assign(new Error("WorkBuddy ACP 请求已取消"), { name: "AbortError" })); };
      signal?.addEventListener?.("abort", abort, { once: true });
      timer.unref?.();
    }).catch((error) => { if (error?.name === "AbortError") throw error; });
    sidecar = await discoverSidecar({ environment });
  }
  return sidecar;
};

const asHeaders = (headers = {}) => Object.entries(headers || {}).filter(([name, value]) => name && value != null).map(([name, value]) => ({ name, value: String(value) }));
const toMcpServers = (nativeHost) => nativeHost?.url ? [{
  name: "shensi",
  type: "http",
  url: String(nativeHost.url),
  headers: asHeaders(nativeHost.headers),
}] : [];

const createHeadlessSession = async ({ sidecar, cwd, nativeHost, environment = process.env, sessionId = randomUUID(), timeoutMs = 90_000 } = {}) => {
  const executable = sidecar.executable || join(dirname(dirname(sidecar.commandLine || "")), "WorkBuddy.exe");
  const root = executable ? dirname(executable) : "";
  const codebuddy = root ? join(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy") : "";
  if (!executable || !codebuddy) throw new Error("未找到 WorkBuddy 桌面端或内置 ACP CLI");
  const productConfigPath = await resolvedProductConfigPath(environment);
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
        // The lite bundle only exposes the stale built-in nine-model list.
        // Keep the headless bundle for a deterministic ACP child, but let the
        // resolved desktop product catalogue provide the full current model
        // set (including hy3 and the current fast/balanced/deep aliases).
        CODEBUDDY_FORCE_LITE_WB_BUNDLE: "0",
        ...(productConfigPath ? { ACC_PRODUCT_CONFIG_PATH: productConfigPath } : {}),
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

const closeAcp = async (endpoint, credentials, { sidecar = null, sessionId = "" } = {}) => {
  if (credentials?.connectionId) {
    await fetch(String(endpoint), {
      method: "DELETE",
      headers: {
        ...ACP_HEADERS,
        "acp-connection-id": credentials.connectionId,
        ...(credentials.sessionToken ? { "acp-session-token": credentials.sessionToken } : {}),
      },
    }).catch(() => {});
  }
  if (sidecar?.controlPipe && clean(sessionId)) {
    await controlRequest(sidecar.controlPipe, {
      jsonrpc: "2.0",
      id: 10,
      method: "session.kill",
      params: { sessionId: clean(sessionId) },
    }).catch(() => {});
  }
};

const sessionModels = (result = {}) => (Array.isArray(result?.models?.availableModels) ? result.models.availableModels : [])
  .map((item) => ({ id: clean(item?.modelId || item?.id), name: clean(item?.name || item?.modelId || item?.id) }))
  .filter((item) => item.id);

const openAcpTaskSession = async ({ sidecar, cwd, nativeHost, environment = process.env, signal = null, timeoutMs = 120_000 } = {}) => {
  // Never reuse an arbitrary sidecar session.  It may have been created by an
  // older Shensi build (or by WorkBuddy itself) with a stale model catalogue
  // and a different environment.  A fresh, explicitly owned session keeps the
  // account/model context deterministic; it is killed in closeAcp below.
  let session = null;
  let credentials = null;
  const prepare = async () => {
    if (!session) session = await createHeadlessSession({ sidecar, cwd, nativeHost, environment, timeoutMs });
    credentials = await connectAcp(session.acpEndpoint, { signal });
    await acpPost(session.acpEndpoint, credentials, {
      jsonrpc: "2.0", id: 5, method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "shensi", version: "1.0" } },
    }, { signal, timeoutMs });
    const created = await acpPost(session.acpEndpoint, credentials, {
      jsonrpc: "2.0", id: 6, method: "session/new",
      params: { cwd: resolve(cwd), mcpServers: toMcpServers(nativeHost) },
    }, { signal, timeoutMs });
    if (created?.error) throw Object.assign(new Error(created.error.message || "WorkBuddy ACP 任务会话创建失败"), { code: "WORKBUDDY_ACP_SESSION_FAILED" });
    const result = created?.result || {};
    if (!clean(result.sessionId)) throw Object.assign(new Error("WorkBuddy ACP 未创建任务会话"), { code: "WORKBUDDY_ACP_SESSION_FAILED" });
    return { session, credentials, result };
  };
  try {
    return await prepare();
  } catch (firstError) {
    // A desktop sidecar may keep a stale ACP child after a restart/update.
    // Recreate exactly once, bounded to the lifecycle handshake; never retry
    // the provider prompt itself and never create a second user task.
    await closeAcp(session?.acpEndpoint, credentials, { sidecar, sessionId: session?.sessionId });
    session = await createHeadlessSession({ sidecar, cwd, nativeHost, environment, timeoutMs });
    credentials = null;
    try {
      return await prepare();
    } catch (secondError) {
      secondError.cause = firstError;
      throw secondError;
    }
  }
};

export const inspectWorkBuddyDesktopBridge = async ({ cwd = process.cwd(), nativeHost = null, environment = process.env, timeoutMs = 90_000 } = {}) => {
  const sidecar = await waitForSidecar({ environment, timeoutMs: Math.min(timeoutMs, BRIDGE_READINESS_WINDOW_MS) });
  if (!sidecar) return { connected: false, authenticated: null, state: "bridge_unavailable", models: [], message: "WorkBuddy 桌面端未提供可用 ACP 桥接；桌面端登录状态未被判定为失效" };
  let session;
  let credentials;
  try {
    const opened = await openAcpTaskSession({ sidecar, cwd, nativeHost, environment, timeoutMs });
    ({ session, credentials } = opened);
    const result = opened.result || {};
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
    await closeAcp(session?.acpEndpoint, credentials, { sidecar, sessionId: session?.sessionId });
  }
};

export const runWorkBuddyDesktopBridge = async ({ prompt, model = "", cwd = process.cwd(), nativeHost = null, environment = process.env, signal = null, timeoutMs = DEFAULT_TIMEOUT_MS, onEvent } = {}) => {
  const sidecar = await waitForSidecar({ environment, signal, timeoutMs: Math.min(timeoutMs, BRIDGE_READINESS_WINDOW_MS) });
  if (!sidecar) {
    const error = new Error("WorkBuddy 桌面端已登录，但神思未发现可用 ACP 桥接；请保持 WorkBuddy 客户端运行后重试");
    error.code = "WORKBUDDY_DESKTOP_BRIDGE_UNAVAILABLE";
    throw error;
  }
  let session;
  let credentials;
  try {
    const opened = await openAcpTaskSession({ sidecar, cwd, nativeHost, environment, signal, timeoutMs: Math.min(timeoutMs, 120_000) });
    ({ session, credentials } = opened);
    const sessionResult = opened.result || {};
    const sessionId = clean(sessionResult.sessionId);
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
    await closeAcp(session?.acpEndpoint, credentials, { sidecar, sessionId: session?.sessionId });
  }
};
