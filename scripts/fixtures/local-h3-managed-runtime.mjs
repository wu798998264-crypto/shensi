// Protocol/process fixture only. These bytes are NOT a generated H3 video.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
const [port, pidFile] = process.argv.slice(2);
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { windowsHide: true, stdio: "ignore" });
await writeFile(pidFile, JSON.stringify({ pid: process.pid, descendantPid: descendant.pid }));
let submitted = "";
createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  const json = (value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
  if (url.pathname === "/system_stats") return json({ system: { os: process.platform } });
  if (url.pathname === "/object_info") return json({ UNETLoader: {}, CLIPLoader: {}, MiniMaxH3ReferenceToVideo: {}, CreateVideo: {}, SaveVideo: {} });
  if (url.pathname === "/upload/image") { request.resume(); request.on("end", () => json({ name: "reference.png", subfolder: "", type: "input" })); return; }
  if (url.pathname === "/prompt") { for await (const chunk of request) submitted += chunk; return json({ prompt_id: "prompt-1" }); }
  if (url.pathname === "/fixture/prompt") return json({ submitted });
  if (url.pathname === "/history/prompt-1") return json({ "prompt-1": { status: { status_str: "success", completed: true }, outputs: { "6": { videos: [{ filename: "h3.mp4", subfolder: "", type: "output" }] } } } });
  if (url.pathname === "/view") { response.writeHead(200, { "Content-Type": "video/mp4" }); response.end("fake-mp4"); return; }
  json({ message: "not found" }, 404);
}).listen(Number(port), "127.0.0.1");
