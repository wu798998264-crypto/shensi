import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, spawn } from "node:child_process";
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
const WBIPC_HANDSHAKE_TIMEOUT_MS = 5_000;
const WBIPC_IO_TIMEOUT_MS = 30_000;
const ACP_HEADERS = { "x-codebuddy-request": "1", "content-type": "application/json", accept: "application/json, text/event-stream" };
const workBuddyAuthError = (message, statusCode = 0) => Object.assign(new Error(message), {
  code: "WORKBUDDY_AUTH_REQUIRED",
  statusCode: Number(statusCode) || 0,
});

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

const resolvedProductModels = async (environment = process.env) => {
  const path = await resolvedProductConfigPath(environment);
  if (!path) return [];
  let payload;
  try { payload = JSON.parse(await readFile(path, "utf8")); } catch { return []; }
  const definitions = new Map((Array.isArray(payload?.models) ? payload.models : [])
    .map((item) => [clean(item?.id || item?.model || item?.slug), {
      label: clean(item?.name || item?.displayName || item?.label),
      credits: clean(item?.credits || item?.creditMultiplier || item?.倍率),
    }])
    .filter(([id]) => id));
  const cliAgent = Array.isArray(payload?.agents)
    ? payload.agents.find((agent) => clean(agent?.name).toLocaleLowerCase() === "cli")
    : null;
  const models = (Array.isArray(cliAgent?.models) ? cliAgent.models : [])
    .map((item) => clean(typeof item === "string" ? item : item?.id || item?.model || item?.slug))
    .filter(Boolean)
    .map((id) => ({ id, ...(definitions.get(id) || {}), name: definitions.get(id)?.label || id }));
  const duplicateLabels = new Map();
  for (const item of models) duplicateLabels.set(item.name, (duplicateLabels.get(item.name) || 0) + 1);
  return models.map((item) => ({
    ...item,
    name: duplicateLabels.get(item.name) > 1
      ? `${item.name}（${item.credits ? `积分倍率 ${item.credits}` : item.id}）`
      : item.name,
  }));
};

const disambiguateWorkBuddyModelNames = (models = [], metadata = []) => {
  const metadataById = new Map(metadata.map((item) => [item.id, item]));
  const counts = new Map();
  for (const item of models) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  return models.map((item) => ({
    ...item,
    name: counts.get(item.name) > 1
      ? `${item.name}（${metadataById.get(item.id)?.credits || item.credits ? `积分倍率 ${metadataById.get(item.id)?.credits || item.credits}` : item.id}）`
      : item.name,
  }));
};

const controlPipePath = (root, uuid) => `\\\\.\\pipe\\workbuddy-${createHash("sha1").update(resolve(root)).digest("hex").slice(0, 12)}-sidecar-control-${uuid}`;

/**
 * A listening ACP port is not sufficient evidence of a WorkBuddy desktop
 * session.  Only a WorkBuddy.exe child with a real session id and an official
 * daemon/sidecar ancestor can carry the desktop credential bootstrap.
 */
export const isDesktopOwnedGateway = (candidate = {}) => Boolean(
  candidate?.gateway
  && candidate?.desktopOwned === true
  && /^workbuddy\.exe$/iu.test(clean(candidate?.processName)),
);

const wbipcDiscoveryPath = (environment = process.env) => join(configRoot(environment), "wbipc", "endpoint.json");

const wbipcTicketId = (ticket) => createHash("sha256").update(String(ticket), "utf8").digest("hex").slice(0, 16);

const wbipcTranscript = (role, { protocol = 1, endpoint, clientNonce, serverNonce }) => {
  const parts = [role === "server" ? "wbipc-s" : "wbipc-c", String(protocol), endpoint, clientNonce, serverNonce];
  const chunks = [];
  for (const part of parts) {
    const value = Buffer.from(String(part), "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length, 0);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
};

const wbipcProof = (ticket, role, transcript) => createHmac("sha256", Buffer.from(String(ticket), "utf8"))
  .update(wbipcTranscript(role, transcript)).digest("base64url");

const safeProofEqual = (left, right) => {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
};

const wbipcReadFrame = (socket, timeoutMs = WBIPC_HANDSHAKE_TIMEOUT_MS) => new Promise((resolveFrame, rejectFrame) => {
  let buffer = "";
  let settled = false;
  const finish = (error, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    socket.removeListener("data", onData);
    socket.removeListener("error", onError);
    socket.removeListener("close", onClose);
    if (error) rejectFrame(error); else resolveFrame(value);
  };
  const onData = (chunk) => {
    buffer += String(chunk || "");
    const index = buffer.indexOf("\n");
    if (index < 0) return;
    const line = buffer.slice(0, index);
    try { finish(null, JSON.parse(line)); } catch (error) { finish(error); }
  };
  const onError = (error) => finish(error);
  const onClose = () => finish(new Error("WorkBuddy WBIPC 端点在握手期间关闭"));
  const timer = setTimeout(() => finish(new Error("WorkBuddy WBIPC 握手超时")), timeoutMs);
  socket.setEncoding("utf8");
  socket.on("data", onData);
  socket.once("error", onError);
  socket.once("close", onClose);
});

const probeWbipcEndpoint = async ({ endpoint, ticket, timeoutMs = WBIPC_HANDSHAKE_TIMEOUT_MS } = {}) => {
  if (!endpoint || !ticket) return null;
  const socket = net.createConnection(endpoint);
  const close = () => { try { socket.destroy(); } catch {} };
  const clientNonce = randomBytes(16).toString("base64url");
  try {
    await new Promise((resolveConnect, rejectConnect) => {
      const timer = setTimeout(() => rejectConnect(new Error("WorkBuddy WBIPC 连接超时")), timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolveConnect(); });
      socket.once("error", (error) => { clearTimeout(timer); rejectConnect(error); });
    });
    socket.write(`${JSON.stringify({ type: "session_hello", protocol_min: 1, protocol_max: 1, client_nonce: clientNonce, ticket_id: wbipcTicketId(ticket), client: { kind: "shensi", id: "shensi-bridge", version: "1" } })}\n`);
    const challenge = await wbipcReadFrame(socket, timeoutMs);
    if (challenge?.type !== "session_challenge") throw new Error(`WorkBuddy WBIPC 握手被拒绝：${clean(challenge?.code || challenge?.type)}`);
    const transcript = { protocol: 1, endpoint, clientNonce, serverNonce: clean(challenge.server_nonce) };
    if (!transcript.serverNonce || !safeProofEqual(challenge.server_proof, wbipcProof(ticket, "server", transcript))) throw new Error("WorkBuddy WBIPC 服务端证明无效");
    socket.write(`${JSON.stringify({ type: "session_prove", client_proof: wbipcProof(ticket, "client", transcript) })}\n`);
    const ack = await wbipcReadFrame(socket, timeoutMs);
    if (ack?.type !== "session_hello_ack") throw new Error(`WorkBuddy WBIPC 握手确认失败：${clean(ack?.code || ack?.type)}`);
    return { endpoint, pipes: Array.isArray(ack.pipes) ? ack.pipes : [], connectionEpoch: clean(ack.connection_epoch) };
  } finally {
    close();
  }
};

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
  const synthetic = environment !== process.env
    && environment?.SHENSI_WORKBUDDY_BRIDGE_RUNTIME !== "1"
    && environment?.SHENSI_ALLOW_WORKBUDDY_BRIDGE_TEST !== "1";
  if (synthetic) return [];
  const raw = await powershell("Get-CimInstance Win32_Process -Filter \"Name='WorkBuddy.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress").catch(() => "");
  let rows;
  try { rows = JSON.parse(raw || "[]"); } catch { rows = []; }
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const root = configRoot(environment);
  const candidates = rows.map((row) => {
    const commandLine = clean(row?.CommandLine);
    const uuid = commandLine.match(/--control-pipe-uuid\s+([0-9a-f-]{8,})/iu)?.[1] || "";
    const executable = commandLine.match(/"([A-Za-z]:\\[^"]*?WorkBuddy\.exe)"/iu)?.[1]
      || commandLine.match(/(?:^|\s)([A-Za-z]:\\[^"]*?WorkBuddy\.exe)(?:\s|$)/iu)?.[1]
      || "";
    return uuid ? { uuid, pid: Number(row?.ProcessId) || 0, executable, commandLine, controlPipe: controlPipePath(root, uuid) } : null;
  }).filter(Boolean);
  // WorkBuddy 5.6+ no longer exposes --control-pipe-uuid. Its desktop daemon
  // publishes a ticketed WBIPC endpoint instead. Keep the old sidecar result
  // shape intact and append a modern candidate only after the endpoint file is
  // structurally valid; liveness and HMAC proof are checked by discoverSidecar.
  const modernRow = rows.find((row) => /WorkBuddy\.exe/iu.test(clean(row?.CommandLine)) && !/--type=/iu.test(clean(row?.CommandLine)));
  const modernCommandLine = clean(modernRow?.CommandLine);
  const modernExecutable = modernCommandLine.match(/"([A-Za-z]:\\[^"]*?WorkBuddy\.exe)"/iu)?.[1]
    || modernCommandLine.match(/(?:^|\s)([A-Za-z]:\\[^\s]*?WorkBuddy\.exe)(?:\s|$)/iu)?.[1]
    || "";
  const discovery = await readFile(wbipcDiscoveryPath(environment), "utf8").catch(() => "");
  if (discovery && modernExecutable) {
    try {
      const payload = JSON.parse(discovery);
      if (clean(payload?.endpoint) && clean(payload?.ticket)) candidates.push({
        modern: true,
        pid: Number(modernRow?.ProcessId) || 0,
        executable: modernExecutable,
        commandLine: modernCommandLine,
        wbipcEndpoint: clean(payload.endpoint),
        wbipcTicket: clean(payload.ticket),
      });
    } catch {}
  }
  // WorkBuddy 5.6 keeps a logged-in CodeBuddy gateway alive as a separate
  // `codebuddy --serve --port 0` child.  Starting a fresh `codebuddy --acp`
  // process from Shensi bypasses the desktop daemon's credential bootstrap and
  // therefore always answers `Authentication required`.  Reuse the gateway's
  // authenticated ACP HTTP endpoint instead.  The port is kernel-assigned, so
  // discover it from the listening socket owned by that exact child process;
  // never guess a fixed port and never read any token from disk.
  const serverRaw = await powershell(
    "$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine); $byId = @{}; foreach ($item in $all) { $byId[[int]$item.ProcessId] = $item }; $rows = @($all | Where-Object { $_.Name -in @('node.exe','WorkBuddy.exe') -and $_.CommandLine -match '(?i)codebuddy.*--serve' } | ForEach-Object { $processId = $_.ProcessId; $parents = @(); $parentId = [int]$_.ParentProcessId; for ($i = 0; $i -lt 6 -and $parentId -gt 0; $i++) { $parent = $byId[$parentId]; if (-not $parent) { break }; $parents += [string]$parent.CommandLine; $parentId = [int]$parent.ParentProcessId }; $ports = @(Get-NetTCPConnection -State Listen -OwningProcess $processId -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort); [pscustomobject]@{ ProcessId = $processId; ParentProcessId = $_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; ParentChain = ($parents -join [Environment]::NewLine); DesktopOwned = ($_.Name -eq 'WorkBuddy.exe' -and $_.CommandLine -match '(?i)--session-id\\s+[0-9a-f-]{8,}' -and (($parents -join [Environment]::NewLine) -match '(?i)(?:sidecar-entry\\.js|daemon-app-server-entry\\.js|WorkBuddy\\.exe)')); Ports = $ports } }); $rows | ConvertTo-Json -Compress",
    5_000,
  ).catch(() => "");
  let serverRows;
  try { serverRows = JSON.parse(serverRaw || "[]"); } catch { serverRows = []; }
  if (!Array.isArray(serverRows)) serverRows = serverRows ? [serverRows] : [];
  for (const row of serverRows) {
    const ports = (Array.isArray(row?.Ports) ? row.Ports : [row?.Ports])
      .map((port) => Number(port) || 0)
      .filter((port) => port > 0 && port < 65536);
    for (const port of ports) {
      candidates.push({
        modern: true,
        gateway: true,
        desktopOwned: row?.DesktopOwned === true,
        pid: Number(row?.ProcessId) || 0,
        parentPid: Number(row?.ParentProcessId) || 0,
        processName: clean(row?.Name),
        commandLine: clean(row?.CommandLine),
        acpEndpoint: `http://127.0.0.1:${port}/api/v1/acp`,
      });
    }
  }
  return candidates;
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
  // The official sidecar is the only path that receives WorkBuddy's
  // credential-protection bootstrap.  A raw `codebuddy --serve` started by a
  // shell (or by an older Shensi probe) can expose an ACP port while returning
  // `Authentication required`; treating that port as the desktop session is
  // the source of the historic "logged out / bridge unavailable" flip-flop.
  // Prefer sidecar-control, then a desktop-owned gateway with a session id.
  // Never select a bare node/codebuddy gateway, and do not turn WBIPC liveness
  // alone into a usable ACP session.
  const ordered = [
    ...candidates.filter((candidate) => !candidate.gateway && !candidate.modern),
    ...candidates.filter((candidate) => isDesktopOwnedGateway(candidate)),
  ];
  for (const candidate of ordered) {
    if (candidate.gateway && candidate.acpEndpoint) {
      return { ...candidate, direct: true };
    }
    if (candidate.modern) {
      const probe = await probeWbipcEndpoint({ endpoint: candidate.wbipcEndpoint, ticket: candidate.wbipcTicket }).catch(() => null);
      if (probe?.pipes?.includes("wb.request")) return { ...candidate, wbipc: probe, direct: true };
      continue;
    }
    const ping = await controlRequest(candidate.controlPipe, { jsonrpc: "2.0", id: 1, method: "sidecar.ping", params: {} }).catch(() => null);
    if (ping?.pid) return { ...candidate, ping };
  }
  return null;
};

const waitForSidecar = async ({ environment = process.env, signal = null, timeoutMs = BRIDGE_READINESS_WINDOW_MS } = {}) => {
  // Synthetic environments used by contract tests intentionally do not touch
  // the desktop process table. Keep those calls immediate; the bounded wait
  // is only for the real first-use WorkBuddy startup race.
  const synthetic = environment !== process.env
    && environment?.SHENSI_WORKBUDDY_BRIDGE_RUNTIME !== "1"
    && environment?.SHENSI_ALLOW_WORKBUDDY_BRIDGE_TEST !== "1";
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

const directAcpClient = ({ executable, cwd, model = "", environment = process.env, timeoutMs = 90_000 } = {}) => {
  const root = executable ? dirname(executable) : "";
  const codebuddy = root ? join(root, "resources", "app.asar.unpacked", "cli", "bin", "codebuddy") : "";
  if (!codebuddy) throw new Error("未找到 WorkBuddy 桌面端内置 ACP CLI");
  const child = spawn(process.execPath, [codebuddy, "--acp", ...(clean(model) ? ["--model", clean(model)] : [])], {
    cwd: resolve(cwd || process.cwd()),
    env: {
      ...environment,
      WORKBUDDY_CONFIG_DIR: configRoot(environment),
      ELECTRON_RUN_AS_NODE: "1",
      CODEBUDDY_FORCE_HEADLESS_BUNDLE: "1",
      CODEBUDDY_FORCE_LITE_WB_BUNDLE: "0",
      ...(environment.CODEBUDDY_NO_UPDATE_CHECK ? {} : { CODEBUDDY_NO_UPDATE_CHECK: "1" }),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let buffer = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map();
  const finishPending = (error) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
  };
  const onLine = (line) => {
    if (!line.trim()) return;
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame?.method && frame?.params) for (const entry of pending.values()) entry.onUpdate?.(frame.params);
    if (frame?.id === undefined || frame?.id === null) return;
    const entry = pending.get(String(frame.id));
    if (!entry) return;
    pending.delete(String(frame.id));
    clearTimeout(entry.timer);
    if (frame.error) entry.reject(Object.assign(new Error(frame.error.message || "WorkBuddy ACP 请求失败"), { code: frame.error.code, data: frame.error.data }));
    else entry.resolve(frame);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      onLine(buffer.slice(0, index).replace(/\r$/u, ""));
      buffer = buffer.slice(index + 1);
    }
  });
  child.on("error", (error) => finishPending(Object.assign(error, { code: error.code || "WORKBUDDY_ACP_PROCESS_ERROR" })));
  child.on("exit", (code, signal) => finishPending(new Error(`WorkBuddy ACP 进程已退出（${code ?? ""}${signal ? `/${signal}` : ""}）`)));
  const request = (method, params = {}, { signal = null, timeoutMs: requestTimeoutMs = timeoutMs, onUpdate } = {}) => new Promise((resolveRequest, rejectRequest) => {
    if (closed) { rejectRequest(new Error("WorkBuddy ACP 会话已关闭")); return; }
    const id = String(nextId++);
    const entry = { resolve: resolveRequest, reject: rejectRequest, onUpdate, timer: null };
    entry.timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(Object.assign(new Error(`WorkBuddy ACP 请求超时：${method}`), { code: "WORKBUDDY_ACP_TIMEOUT" }));
    }, requestTimeoutMs);
    pending.set(id, entry);
    const abort = () => {
      try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params })}\n`); } catch {}
      clearTimeout(entry.timer);
      pending.delete(id);
      rejectRequest(Object.assign(new Error("WorkBuddy ACP 请求已取消"), { name: "AbortError" }));
    };
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener?.("abort", abort, { once: true });
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`); }
    catch (error) { clearTimeout(entry.timer); pending.delete(id); rejectRequest(error); }
  });
  const close = async () => {
    if (closed) return;
    closed = true;
    finishPending(new Error("WorkBuddy ACP 会话已关闭"));
    try { child.stdin.end(); } catch {}
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => { try { child.kill(); } catch {} resolveClose(); }, 1_000);
      child.once("exit", () => { clearTimeout(timer); resolveClose(); });
    });
  };
  return { kind: "stdio", request, close, child, codebuddy };
};

const createHeadlessSession = async ({ sidecar, cwd, nativeHost, model = "", environment = process.env, sessionId = randomUUID(), timeoutMs = 90_000 } = {}) => {
  if (sidecar?.gateway && sidecar.acpEndpoint) {
    return { acpEndpoint: sidecar.acpEndpoint, sessionId, direct: true };
  }
  if (sidecar?.direct) {
    const client = directAcpClient({ executable: sidecar.executable, cwd, model, environment, timeoutMs });
    return { acpEndpoint: { kind: "stdio", client }, sessionId, direct: true };
  }
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
      args: [codebuddy, "--serve", ...(clean(model) ? ["--model", clean(model)] : [])],
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
  if (endpoint?.kind === "stdio" && endpoint.client?.request) {
    try {
      return await endpoint.client.request(message.method, message.params || {}, { signal, timeoutMs, onUpdate });
    } catch (error) {
      const authFailure = acpAuthFailure({ error: { message: error?.message, code: error?.code, data: error?.data } });
      if (authFailure) throw authFailure;
      throw error;
    }
  }
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
    if (!response.ok) {
      const body = await response.text();
      const message = `WorkBuddy ACP 请求失败（${response.status}）：${body.slice(-400)}`;
      if ([401, 403].includes(Number(response.status))) throw workBuddyAuthError(message, response.status);
      throw Object.assign(new Error(message), { code: "WORKBUDDY_ACP_REQUEST_FAILED", statusCode: Number(response.status) || 0 });
    }
    const isSse = response.headers.get("content-type")?.includes("text/event-stream");
    if (!isSse || !response.body?.getReader) {
      const body = await response.text();
      const messages = isSse ? parseSse(body) : [JSON.parse(body)];
      for (const event of messages) if (event?.method === "session/update") onUpdate?.(event.params || {});
      const result = messages.find((event) => event?.id === message.id) || messages.at(-1) || {};
      const authFailure = acpAuthFailure(result);
      if (authFailure) throw authFailure;
      return result;
    }
    // WorkBuddy keeps the ACP event stream open after emitting the JSON-RPC
    // response. Waiting for response.text() therefore turns a completed
    // prompt into a timeout. Consume frames incrementally and resolve as soon
    // as this request's response id arrives; session updates remain live.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const parseFrame = (frame) => {
      const data = frame.split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) return null;
      try { return JSON.parse(data); } catch { return null; }
    };
    for (;;) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      let boundary = buffer.search(/\r?\n\r?\n/u);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/u, "");
        const event = parseFrame(frame);
        if (event?.method === "session/update") onUpdate?.(event.params || {});
        if (event && String(event.id ?? "") === String(message.id ?? "")) {
          await reader.cancel().catch(() => {});
          const authFailure = acpAuthFailure(event);
          if (authFailure) throw authFailure;
          return event;
        }
        if (message.method === "session/prompt" && event?.method === "session/update" && promptUpdateIsTerminal(event.params)) {
          await reader.cancel().catch(() => {});
          return { jsonrpc: "2.0", id: message.id, result: { status: "completed" }, params: event.params };
        }
        boundary = buffer.search(/\r?\n\r?\n/u);
      }
      if (chunk.done) {
        const event = parseFrame(buffer) || (() => { try { return JSON.parse(buffer); } catch { return null; } })();
        if (event?.method === "session/update") onUpdate?.(event.params || {});
        if (message.method === "session/prompt" && event?.method === "session/update" && promptUpdateIsTerminal(event.params)) {
          return { jsonrpc: "2.0", id: message.id, result: { status: "completed" }, params: event.params };
        }
        const result = event || {};
        const authFailure = acpAuthFailure(result);
        if (authFailure) throw authFailure;
        return result;
      }
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
};

const ACP_TEXT_UPDATE_KINDS = new Set([
  "agent_message_chunk",
  "agent_message",
  "assistant_message",
  "assistant",
  "message",
  "text",
  "text_delta",
  "final_message",
  "final",
]);

export const updateText = (params = {}) => {
  const update = params?.update && typeof params.update === "object" ? params.update : params;
  const kind = clean(update?.sessionUpdate || update?.type || update?.kind || "").toLocaleLowerCase();
  if (!ACP_TEXT_UPDATE_KINDS.has(kind)) return "";
  const content = update.content ?? update.message ?? update.text ?? update.delta ?? update.output;
  if (typeof content === "string") return content;
  return terminalAcpText(content);
};

// ACP implementations differ in where the terminal assistant text is
// placed.  Streaming builds use `update.content.text`, while some desktop
// builds return the completed message under `result.content`, `result.output`
// or a nested `message`.  Keep this extractor deliberately text-only so
// protocol/status/error objects never become user-visible output.
export const terminalAcpText = (value, depth = 0, seen = new Set()) => {
  if (depth > 6 || value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => terminalAcpText(item, depth + 1, seen)).filter(Boolean).join("");
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  for (const key of ["text", "output_text", "content", "output", "message", "answer", "final", "result", "params"]) {
    const candidate = terminalAcpText(value[key], depth + 1, seen);
    if (candidate) return candidate;
  }
  return "";
};

// Some WorkBuddy builds keep the ACP SSE connection open and omit the JSON-RPC
// response id for `session/prompt`. They do, however, emit a terminal
// session/update frame. Treat that frame as the prompt response; otherwise a
// completed answer sits in an open stream until the six-minute watchdog fires.
const promptUpdateIsTerminal = (params = {}) => {
  const update = params?.update && typeof params.update === "object" ? params.update : params;
  const status = clean(update?.status || update?.state || update?.sessionUpdate || update?.type).toLocaleLowerCase();
  if (update?.completed === true || update?.finished === true || update?.done === true) return true;
  return /^(?:completed?|done|finished?|stopped|cancelled|canceled)$/u.test(status)
    || /(?:turn|prompt|session|agent)[ _-]*(?:complete|completed|done|end|ended|finish|finished)$/u.test(status);
};

const parseAcpErrorPayload = (value, depth = 0) => {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") {
    const source = value.trim();
    if (!source) return null;
    try { return parseAcpErrorPayload(JSON.parse(source), depth + 1); } catch {}
    return { message: source };
  }
  if (typeof value !== "object") return null;
  const message = clean(value.message || value.errorMessage || value.details);
  const code = clean(value.code || value.category || value.errorCode);
  const nested = value.error || value.data || value.details;
  const child = nested && typeof nested === "object" ? parseAcpErrorPayload(nested, depth + 1) : null;
  return { ...(child || {}), ...(message ? { message } : {}), ...(code ? { code } : {}) };
};

export const acpAuthFailure = (promptResult = {}) => {
  const candidates = [
    promptResult?.error,
    promptResult?.result?.error,
    promptResult?.result?.errorMessage,
    promptResult?.result?._meta?.["codebuddy.ai/errorMessage"],
    promptResult?._meta?.["codebuddy.ai/errorMessage"],
    promptResult?.params?.error,
  ];
  for (const candidate of candidates) {
    const parsed = parseAcpErrorPayload(candidate);
    const text = clean([parsed?.code, parsed?.message, typeof candidate === "string" ? candidate : ""].filter(Boolean).join(" "));
    if (/(?:authentication required|not authenticated|please use \/login|登录|未登录|auth_required)/iu.test(text)) {
      return workBuddyAuthError(`WorkBuddy 桌面会话未登录：${text.slice(0, 300)}`);
    }
  }
  return null;
};

const connectAcp = async (endpoint, options = {}) => {
  if (endpoint?.kind === "stdio") return { kind: "stdio" };
  const connectEndpoint = `${String(endpoint).replace(/\/$/u, "")}/connect`;
  const response = await fetch(connectEndpoint, { method: "POST", headers: { "x-codebuddy-request": "1" }, signal: options.signal });
  if (!response.ok) {
    if ([401, 403].includes(Number(response.status))) throw workBuddyAuthError(`WorkBuddy ACP 连接失败（${response.status}）`, response.status);
    throw Object.assign(new Error(`WorkBuddy ACP 连接失败（${response.status}）`), { code: "WORKBUDDY_ACP_CONNECT_FAILED", statusCode: Number(response.status) || 0 });
  }
  const credentials = await response.json();
  if (!credentials?.connectionId) throw new Error("WorkBuddy ACP 未返回会话凭据");
  return credentials;
};

const closeAcp = async (endpoint, credentials, { sidecar = null, sessionId = "" } = {}) => {
  if (endpoint?.kind === "stdio") {
    await endpoint.client?.close?.();
    return;
  }
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

const normalizedModelLabel = (value = "") => clean(value).toLocaleLowerCase().replace(/[\s._-]+/gu, "");

/**
 * Resolve a persisted WorkBuddy model against the current desktop catalogue.
 * WorkBuddy has changed the stable ID behind the user-facing Hy3 label more
 * than once (the old Shensi profile used `hy3`, while the current desktop
 * catalogue exposes `hy3-c`/`hy3-x`). Never turn that catalogue drift into an
 * authentication error: use an exact ID first, then a label/legacy alias,
 * and only report unavailable when there is no safe match.
 */
export const resolveWorkBuddyModelId = (requested = "", available = [], labels = {}) => {
  const value = clean(requested);
  const models = (Array.isArray(available) ? available : [])
    .map((item) => typeof item === "string" ? { id: clean(item), name: clean(labels?.[item]) } : { id: clean(item?.id || item?.modelId), name: clean(item?.name || labels?.[item?.id || item?.modelId]) })
    .filter((item) => item.id);
  if (!value) return "";
  const exact = models.find((item) => item.id === value);
  if (exact) return exact.id;
  const normalized = normalizedModelLabel(value);
  const legacyAliases = new Map([
    ["hy3", "hy3"],
    ["hy3c", "hy3"],
    ["hy3x", "hy3"],
  ]);
  const labelNeedle = legacyAliases.get(normalized) || normalized;
  // The desktop catalogue disambiguates duplicate labels with a credit suffix
  // (for example `Hy3（积分倍率 x0.00）`).  Match the stable model id first,
  // then the visible label prefix; otherwise a persisted legacy `hy3` value
  // is incorrectly reported as unavailable even though `hy3-c` is runnable.
  const idMatch = models
    .filter((item) => normalizedModelLabel(item.id).startsWith(labelNeedle))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)))[0];
  if (idMatch) return idMatch.id;
  const labelMatch = models.find((item) => normalizedModelLabel(item.name).startsWith(labelNeedle));
  if (labelMatch) return labelMatch.id;
  return "";
};

const openAcpTaskSession = async ({ sidecar, cwd, nativeHost, model = "", environment = process.env, signal = null, timeoutMs = 120_000 } = {}) => {
  // Never reuse an arbitrary sidecar session.  It may have been created by an
  // older Shensi build (or by WorkBuddy itself) with a stale model catalogue
  // and a different environment.  A fresh, explicitly owned session keeps the
  // account/model context deterministic; it is killed in closeAcp below.
  let session = null;
  let credentials = null;
  const prepare = async () => {
    if (!session) session = await createHeadlessSession({ sidecar, cwd, nativeHost, model, environment, timeoutMs });
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
    session = await createHeadlessSession({ sidecar, cwd, nativeHost, model, environment, timeoutMs });
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
    const sessionCatalog = sessionModels(result);
    const resolvedCatalog = await resolvedProductModels(environment);
    const catalog = disambiguateWorkBuddyModelNames(resolvedCatalog.length > sessionCatalog.length ? resolvedCatalog : sessionCatalog, resolvedCatalog);
    return {
      connected: true,
      authenticated: true,
      state: "ready",
      ready: true,
      models: catalog.map((item) => item.id),
      modelLabels: Object.fromEntries(catalog.map((item) => [item.id, item.name])),
      catalogSource: "workbuddy_acp_session",
      session,
      message: `WorkBuddy 桌面会话有效，已读取 ${catalog.length} 个真实模型`,
    };
  } catch (error) {
    const authRequired = error?.code === "WORKBUDDY_AUTH_REQUIRED" || [401, 403].includes(Number(error?.statusCode));
    return {
      connected: false,
      authenticated: authRequired ? false : null,
      state: authRequired ? "auth_required" : "bridge_error",
      models: [],
      message: authRequired
        ? "WorkBuddy 桌面会话明确返回未登录，请在 WorkBuddy 中完成登录后重新检查"
        : clean(error?.message || error).slice(0, 500),
      errorCode: authRequired ? "WORKBUDDY_AUTH_REQUIRED" : "WORKBUDDY_DESKTOP_BRIDGE_ERROR",
    };
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
    const opened = await openAcpTaskSession({ sidecar, cwd, nativeHost, model, environment, signal, timeoutMs: Math.min(timeoutMs, 120_000) });
    ({ session, credentials } = opened);
    const sessionResult = opened.result || {};
    const sessionId = clean(sessionResult.sessionId);
    const sessionCatalog = sessionModels(sessionResult);
    const resolvedCatalog = await resolvedProductModels(environment);
    // The desktop session may expose the special `auto` selector while the
    // resolved product catalogue exposes the newer full model set. Keep that
    // selector for login probes, but use the resolved catalogue for real
    // model IDs so stale nine-model sessions cannot hide current models.
    const available = disambiguateWorkBuddyModelNames(resolvedCatalog.length > sessionCatalog.length
      ? [...resolvedCatalog, ...sessionCatalog.filter((item) => item.id === "auto")]
      : sessionCatalog, resolvedCatalog);
    const selectedModel = /^auto$/iu.test(clean(model)) ? "" : resolveWorkBuddyModelId(model, available);
    const effectiveModel = clean(model) && !/^auto$/iu.test(clean(model)) ? (selectedModel || "") : "";
    if (clean(model) && !/^auto$/iu.test(clean(model)) && !effectiveModel && available.length) {
      const error = new Error(`WorkBuddy 当前真实目录没有模型“${clean(model)}”；可选模型：${available.map((item) => item.id).join("、")}`);
      error.code = "WORKBUDDY_MODEL_UNAVAILABLE";
      throw error;
    }
    if (effectiveModel) {
      const switched = await acpPost(session.acpEndpoint, credentials, {
        jsonrpc: "2.0",
        id: 8,
        method: "session/set_model",
        params: { sessionId, modelId: effectiveModel },
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
    const authFailure = acpAuthFailure(promptResult);
    if (authFailure) throw authFailure;
    // Do not use `result || params` here: a valid JSON-RPC result often only
    // carries `{ status: "completed" }`, while the actual assistant message
    // remains in params or in the last session/update frame.
    const finalText = text
      || updateText(promptResult?.params || {})
      || terminalAcpText(promptResult);
    if (!finalText) throw new Error("WorkBuddy ACP 已结束，但没有返回可用文本");
    return { text: finalText.trim(), sessionId, actualProvider: "WorkBuddy", actualModel: effectiveModel || "auto", executionRuntime: "workbuddy_desktop_acp", permissionMode: "shensi_only" };
  } finally {
    await closeAcp(session?.acpEndpoint, credentials, { sidecar, sessionId: session?.sessionId });
  }
};
