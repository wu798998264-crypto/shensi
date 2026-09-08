import process from "node:process";

const debugPort = Number(process.env.SHENSI_CDP_PORT || 9376);
const expression = process.argv.slice(2).join(" ");
if (!expression) throw new Error("usage: node scripts/cdp-eval-installed.mjs <expression>");
const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
const target = targets.find((item) => item.type === "page");
if (!target?.webSocketDebuggerUrl) throw new Error(`No page target on ${debugPort}`);
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
const result = await call("Runtime.evaluate", {
  expression,
  awaitPromise: true,
  returnByValue: true,
});
if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
process.stdout.write(JSON.stringify(result.result?.value ?? null, null, 2));
socket.close();
