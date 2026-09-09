import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAgentProvider } from "../src/server/codex-agent-provider.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-codex-permission-process-"));
const probePath = join(root, "probe.json");
const fixture = [
  "const fs=require('node:fs');",
  "fs.writeFileSync(process.env.SHENSI_PERMISSION_PROBE,JSON.stringify({home:process.env.CODEX_HOME,args:process.argv.slice(1)}));",
  "let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>input+=c);",
  "process.stdin.on('end',()=>{});",
  "setInterval(()=>{const lines=input.split(/\\r?\\n/);input=lines.pop()||'';for(const line of lines){if(!line.trim())continue;const m=JSON.parse(line);if(m.id!==undefined){const result=m.method==='account/read'?{account:{type:'chatgpt'}}:{platformFamily:'test'};process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');}}},10);",
].join("");

const provider = new CodexAgentProvider({
  machineRoot: root,
  appRoot: root,
  environment: { ...process.env, SHENSI_PERMISSION_PROBE: probePath },
  launchResolver: async () => ({ executable: process.execPath, prefixArgs: ["-e", fixture, "--"] }),
});
provider.installed = true;

try {
  await provider.startProcess("shensi_only");
  const restricted = JSON.parse(await readFile(probePath, "utf8"));
  assert.match(restricted.home.replaceAll("\\", "/"), /machine-sessions\/shensi-codex-profile-v1$/u);
  assert.ok(restricted.args.includes("--disable"), "仅限神思必须通过 CLI 隔离层禁用宿主扩展");
  assert.ok(restricted.args.includes("skill_search"), "仅限神思必须禁用全局 Skill 搜索");
  assert.equal(provider.processPermissionMode, "shensi_only");
  await provider.stopProcess();

  await provider.startProcess("full_access");
  const full = JSON.parse(await readFile(probePath, "utf8"));
  assert.equal(full.home, provider.codexProfileRoot, "完全权限必须保留原生 Codex 配置根");
  assert.equal(full.args.includes("--disable"), false, "完全权限不得继承仅限神思的隔离参数");
  await provider.stopProcess();

  provider.process = { stdin: { writable: true, end() {} } };
  provider.initialized = true;
  provider.processPermissionMode = "shensi_only";
  provider.runs.set("active", { id: "active", engine: "codex", status: "running" });
  await assert.rejects(() => provider.ensureStarted("full_access"), (error) => error?.code === "CODEX_AGENT_PERMISSION_PROCESS_BUSY");
  provider.runs.clear();
  provider.process = null;
  provider.initialized = false;
  provider.startingPermissionMode = "shensi_only";
  provider.starting = Promise.resolve();
  await assert.rejects(() => provider.ensureStarted("full_access"), (error) => error?.code === "CODEX_AGENT_PERMISSION_PROCESS_BUSY");
  provider.starting = null;
  provider.startingPermissionMode = null;
  console.log("Codex permission process isolation passed");
} finally {
  await provider.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
