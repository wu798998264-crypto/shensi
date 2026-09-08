import { readFile } from "node:fs/promises";

const debugPort = Number(process.env.SHENSI_CDP_PORT || 9376);
const profileId = String(process.env.SHENSI_PROFILE_ID || "").trim();
const sidecarPath = String(process.env.SHENSI_SIDECAR_PATH || "C:\\Users\\Administrator\\.antigravity_cockpit\\codex_local_access_sidecar\\config.json");
if (!profileId) throw new Error("missing profile id");
const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
const apiKey = Array.isArray(sidecar?.["api-keys"]) ? sidecar["api-keys"].map(String).map((item) => item.trim()).find(Boolean) : "";
if (!apiKey) throw new Error("no local sidecar key");
const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error(`no page target on ${debugPort}`);
const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.error) entry.reject(new Error(message.error.message));
  else entry.resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const expression = `window.shensiDesktop?.credentials?.writeGeneration?.(${JSON.stringify({ text: { [profileId]: apiKey } })})`;
const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
const value = result.result?.value;
if (!value?.ok) throw new Error(value?.message || "isolated credential write failed");
process.stdout.write(JSON.stringify({ ok: true, profileId, stored: true }));
socket.close();
