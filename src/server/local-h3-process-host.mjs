// A lightweight supervisor, not the inference service. IPC disconnect means
// Shensi has exited: only the process tree started here is then terminated.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

let child;
let server;
let session;
let stopping;
let failure = "";
const alive = () => Boolean(child?.pid && child.exitCode === null && !child.signalCode);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const state = () => ({ sessionId: session.id, endpoint: session.endpoint, started: alive(), pid: alive() ? child.pid : 0, failure });

const stop = () => stopping ||= (async () => {
  if (!alive()) return;
  if (process.platform === "win32") {
    await new Promise((resolve, reject) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      const timeout = setTimeout(() => { killer.kill(); reject(new Error("停止本地 H3 进程树超时")); }, 10_000);
      killer.once("error", (error) => { clearTimeout(timeout); reject(error); });
      killer.once("close", (code) => { clearTimeout(timeout); code === 0 || !alive() ? resolve() : reject(new Error(`本地 H3 进程树未停止（${code}）`)); });
    });
  } else {
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  }
  const deadline = Date.now() + 5_000;
  while (alive() && Date.now() < deadline) await delay(50);
  if (alive()) throw new Error("本地 H3 尚未退出，不能确认资源已释放");
})().catch((error) => { stopping = null; throw error; });

const shutdown = async () => {
  try { await stop(); server?.close(); process.exit(0); }
  catch (error) { failure = error.message; process.exitCode = 1; }
};
process.once("disconnect", shutdown);
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

process.once("message", async (message) => {
  session = message;
  try {
    if (!process.connected) throw new Error("神思控制连接已关闭");
    const expected = Buffer.from(session.token);
    server = createServer(async (request, response) => {
      const supplied = Buffer.from(String(request.headers.authorization || "").replace(/^Bearer /u, ""));
      const json = (code, value) => { response.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); response.end(JSON.stringify(value)); };
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(403, { message: "Invalid managed session" });
      if (request.method === "GET" && request.url === "/status") return json(200, state());
      if (request.method === "POST" && request.url === "/stop") {
        try {
          await stop();
          json(200, { ...state(), stopped: true });
          server.close(() => process.exit(0));
        } catch (error) { json(500, { ...state(), message: error.message }); }
        return;
      }
      json(404, { message: "Not found" });
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const [executable, ...args] = session.command;
    child = spawn(executable, args, { cwd: session.cwd, env: process.env, windowsHide: true, stdio: "ignore", detached: process.platform !== "win32" });
    child.once("error", (error) => { failure = error.message; });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    if (!process.connected) return shutdown();
    process.send({ ...state(), controlUrl: `http://127.0.0.1:${server.address().port}` });
  } catch (error) {
    failure = error.message;
    if (process.connected) process.send({ error: failure });
    await shutdown();
  }
});
