import { mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = await mkdtemp(join(tmpdir(), "shensi-draft-toolbar-"));
const env = { ...process.env, SHENSI_TEST_NODE: process.execPath, SHENSI_TEST_DRAFT_ROOT: root, SHENSI_DATA_ROOT: join(root, "data"), SHENSI_MACHINE_DATA_ROOT: join(root, "machine"), SHENSI_DISABLE_MEDIA_RECOVERY_WORKERS: "1" };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(fileURLToPath(new URL("../node_modules/electron/dist/electron.exe", import.meta.url)), [fileURLToPath(new URL("./fixtures/generation-draft-toolbar.cjs", import.meta.url))], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let output = "", errors = "";
child.stdout.on("data", value => { output += value; });
child.stderr.on("data", value => { errors = (errors + value).slice(-4500); });
const timer = setTimeout(() => child.kill(), 100_000);
try {
  const code = await new Promise((done, fail) => { child.on("exit", done); child.on("error", fail); });
  if (code !== 0) throw new Error(`操作栏隔离 UI 验收未通过 (${code})：${errors}`);
  const report = output.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(item => item?.passed);
  if (!report) throw new Error(`无 UI 验收报告：${errors}`);
  console.log(JSON.stringify(report));
} finally {
  clearTimeout(timer);
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("拒绝删除非测试临时目录");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
