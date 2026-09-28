import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { cp, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { inspectH3ManagedSession, launchH3ManagedSession, stopH3ManagedSession } from "./local-h3-managed-session.mjs";

const RELEASE = Object.freeze({
  repository: "wu798998264-crypto/shensi-local-h3",
  tag: "v0.1.1",
  manifestUrl: "https://raw.githubusercontent.com/wu798998264-crypto/shensi-local-h3/v0.1.1/manifest.json",
  manifestSha256: "6a8c6d1b67d78a3e4749c03b1adb567fcb504eb9dcf78ab7d90a095d93cabc12",
});

const jobs = new Map();

const localDataRoot = () => String(process.env.SHENSI_LOCAL_H3_ROOT || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "Shensi", "runtimes", "local-h3")).trim();
const runtimeRoot = () => join(localDataRoot(), RELEASE.tag);
const installJobFile = () => join(localDataRoot(), "install-job.json");
const runtimeFile = () => join(runtimeRoot(), "runtime.json");
const workflowFile = () => join(runtimeRoot(), "workflow.json");
const sessionFile = () => join(runtimeRoot(), "managed-session.json");
const text = (value, fallback = "") => String(value ?? fallback).trim();
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const loopbackUrl = (value) => {
  const raw = text(value, "http://127.0.0.1:8188");
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error("本地 H3 地址无效"); }
  if (!/^https?:$/u.test(parsed.protocol) || !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) throw new Error("本地 H3 只允许连接本机地址");
  return parsed.origin;
};
const jsonFetch = async (url, options = {}, timeoutMs = 5_000) => {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.message || `本地 H3 返回 HTTP ${response.status}`);
    error.providerErrorCode = `LOCAL_H3_HTTP_${response.status}`;
    throw error;
  }
  return payload;
};

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const persistJob = async (job) => {
  await mkdir(dirname(installJobFile()), { recursive: true });
  await writeFile(installJobFile(), `${JSON.stringify(job, null, 2)}\n`, "utf8");
};
const findFile = async (root, expected) => {
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === expected.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, expected);
      if (found) return found;
    }
  }
  return "";
};

export const localH3Release = () => ({ ...RELEASE });
export const localH3RuntimeRoot = () => runtimeRoot();

export const readLocalH3Runtime = async () => {
  const runtime = await readJson(runtimeFile()).catch(() => null);
  if (!runtime || runtime.version !== RELEASE.tag) return null;
  return runtime;
};

const runtimeEndpoint = (settings, runtime) => loopbackUrl(settings?.baseUrl || runtime?.baseUrl || "http://127.0.0.1:8188");
const runtimeComplete = (runtime) => Boolean(runtime?.managedByShensi === true
  && runtime.requiresExternalRuntime !== true && Array.isArray(runtime.launch?.command) && runtime.launch.command.length);
const requiredNodeTypes = ["UNETLoader", "CLIPLoader", "MiniMaxH3ReferenceToVideo", "CreateVideo", "SaveVideo"];

export const probeLocalH3Runtime = async ({ settings = {}, start = false } = {}) => {
  const runtime = await readLocalH3Runtime();
  const endpoint = runtimeEndpoint(settings, runtime);
  const session = await inspectH3ManagedSession(sessionFile(), endpoint);
  const started = session.started === true;
  const reasons = [];
  if (!runtime) reasons.push("尚未装配本地 H3 运行时");
  if (runtime && runtime.managedByShensi !== true) reasons.push("运行时不是由神思装配，已拒绝连接");
  if (runtime && !runtimeComplete(runtime)) reasons.push("当前装配包仅含 H3 适配器，缺少完整推理环境、模型或启动命令，不能用于本地生成");
  if (session.reason) reasons.push(session.reason);
  if (session.failure) reasons.push(`本地 H3 进程失败：${session.failure}`);
  const hasWorkflow = Boolean(await stat(workflowFile()).catch(() => null));
  if (runtime && !hasWorkflow) reasons.push("本地 H3 固定工作流不存在");
  let workflow = null;
  if (hasWorkflow) workflow = await readJson(workflowFile()).catch(() => null);
  const workflowTypes = new Set(Object.values(workflow || {}).map((node) => text(node?.class_type)));
  for (const required of requiredNodeTypes) {
    if (!workflowTypes.has(required)) reasons.push(`固定工作流缺少节点：${required}`);
  }
  let system = null;
  let objectInfo = null;
  if (!started) reasons.push("本地 H3 尚未启动，请先点击启动");
  if (started) {
    try { system = await jsonFetch(`${endpoint}/system_stats`, {}, 4_000); } catch (error) { reasons.push(`ComfyUI 未就绪：${error.message}`); }
  }
  if (system) {
    try { objectInfo = await jsonFetch(`${endpoint}/object_info`, {}, 8_000); } catch (error) { reasons.push(`ComfyUI 节点目录读取失败：${error.message}`); }
  }
  const objectTypes = new Set(Object.keys(objectInfo || {}));
  for (const required of requiredNodeTypes) {
    if (objectInfo && !objectTypes.has(required)) reasons.push(`ComfyUI 缺少节点：${required}`);
  }
  const ready = Boolean(started && runtimeComplete(runtime) && hasWorkflow && system && objectInfo
    && requiredNodeTypes.every((required) => workflowTypes.has(required) && objectTypes.has(required)));
  return {
    available: ready,
    installed: runtimeComplete(runtime) && hasWorkflow,
    adapterInstalled: Boolean(runtime),
    started,
    pid: session.pid || 0,
    uncertain: session.uncertain === true,
    starting: session.starting === true,
    ready,
    endpoint,
    version: runtime?.version || RELEASE.tag,
    workflowVersion: runtime?.workflowVersion || "",
    system,
    hasWorkflow,
    models: ready ? ["minimax-h3-reference-video"] : [],
    reasons,
    installable: !runtimeComplete(runtime),
  };
};

const waitForReady = async (settings, timeoutMs = 60_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const probe = await probeLocalH3Runtime({ settings, start: false });
    if (probe.ready) return probe;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  return probeLocalH3Runtime({ settings, start: false });
};

export const ensureLocalH3Runtime = async ({ settings = {}, timeoutMs = 60_000 } = {}) => {
  const probe = await probeLocalH3Runtime({ settings, start: false });
  if (probe.ready) return probe;
  const runtime = await readLocalH3Runtime();
  if (!runtime) throw Object.assign(new Error("本地 H3 尚未装配，请先点击“一键装配本地 H3”"), { providerErrorCode: "LOCAL_H3_NOT_INSTALLED" });
  if (!probe.installed) throw Object.assign(new Error(probe.reasons.join("；")), { providerErrorCode: "LOCAL_H3_RUNTIME_INCOMPLETE" });
  if (!probe.started) throw Object.assign(new Error("本地 H3 尚未启动，请先点击“启动本地 H3”"), { providerErrorCode: "LOCAL_H3_NOT_STARTED" });
  if (!probe.ready) throw Object.assign(new Error(`本地 H3 运行时尚未就绪：${probe.reasons.join("；") || "请检查 ComfyUI、模型和端口"}`), { providerErrorCode: "LOCAL_H3_NOT_READY" });
  return probe;
};

export const startLocalH3Runtime = async ({ settings = {}, timeoutMs = 0 } = {}) => {
  const runtime = await readLocalH3Runtime();
  if (!runtime) throw Object.assign(new Error("本地 H3 尚未装配，请先点击“一键装配本地 H3”"), { providerErrorCode: "LOCAL_H3_NOT_INSTALLED" });
  if (!runtimeComplete(runtime)) throw Object.assign(new Error("H3 装配不完整：当前包仅含适配器，没有可启动的本地推理环境"), { providerErrorCode: "LOCAL_H3_RUNTIME_INCOMPLETE" });
  const endpoint = runtimeEndpoint(settings, runtime);
  await launchH3ManagedSession(sessionFile(), { endpoint, command: runtime.launch.command.map(String), cwd: runtime.root || runtimeRoot() });
  return timeoutMs > 0
    ? waitForReady({ ...settings, baseUrl: endpoint }, Math.min(timeoutMs, 60_000))
    : probeLocalH3Runtime({ settings });
};

export const stopLocalH3Runtime = async ({ settings = {} } = {}) => {
  const runtime = await readLocalH3Runtime();
  if (!runtime) return { installed: false, started: false, stopped: false, message: "本地 H3 尚未装配" };
  await stopH3ManagedSession(sessionFile(), runtimeEndpoint(settings, runtime));
  return { installed: runtimeComplete(runtime), started: false, stopped: true, ready: false, available: false, message: "本地 H3 已停止，已释放受管理的后台进程" };
};

const downloadBytes = async (url, onProgress) => {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(15 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`本地 H3 下载失败（HTTP ${response.status || "?"}）`);
  const length = Number(response.headers.get("content-length") || 0);
  const chunks = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const buffer = Buffer.from(chunk.value || []);
    chunks.push(buffer);
    received += buffer.length;
    onProgress?.(length ? received / length : 0);
  }
  return Buffer.concat(chunks);
};

export const startLocalH3Install = async () => {
  const existing = await readLocalH3Runtime();
  if (runtimeComplete(existing)) return { ok: true, alreadyInstalled: true, stage: "complete", percent: 100, message: "本地 H3 运行时已装配；点击启动后才会运行" };
  const active = [...jobs.values()].find((job) => !["complete", "failed"].includes(job.stage));
  if (active) return { ok: true, jobId: active.id, ...active };
  const id = randomUUID();
  const job = { id, stage: "queued", percent: 0, message: "等待开始装配", createdAt: Date.now() };
  jobs.set(id, job);
  await persistJob(job);
  (async () => {
    const tempRoot = join(localDataRoot(), "temporary", id);
    try {
      job.stage = "manifest"; job.percent = 4; job.message = "正在读取固定版本安装清单"; await persistJob(job);
      const manifestBytes = await downloadBytes(RELEASE.manifestUrl);
      const expectedManifestHash = RELEASE.manifestSha256;
      if (!expectedManifestHash.startsWith("__") && sha256(manifestBytes) !== expectedManifestHash) throw new Error("本地 H3 安装清单校验失败");
      const manifest = JSON.parse(manifestBytes.toString("utf8"));
      if (manifest.schemaVersion !== 1 || manifest.releaseTag !== RELEASE.tag || !manifest.archive?.url || !manifest.archive?.sha256) throw new Error("本地 H3 安装清单版本或字段无效");
      if (manifest.requiresExternalRuntime === true) throw new Error("固定版本发布包仅包含 H3 适配器，未提供完整本地推理环境与模型；装配未完成，不能用于真实生成");
      job.stage = "download"; job.percent = 8; job.message = "正在下载固定版本本地运行时"; await persistJob(job);
      const archive = await downloadBytes(manifest.archive.url, (fraction) => { job.percent = 8 + Math.round(fraction * 52); job.message = `正在下载本地 H3 运行时（${job.percent}%）`; });
      if (sha256(archive) !== String(manifest.archive.sha256).toLowerCase()) throw new Error("本地 H3 运行时压缩包校验失败，已拒绝安装");
      await mkdir(tempRoot, { recursive: true });
      const archivePath = join(tempRoot, "runtime.zip");
      await writeFile(archivePath, archive);
      const extractRoot = join(tempRoot, "extract");
      job.stage = "extract"; job.percent = 65; job.message = "正在原子装配本地 H3 运行时"; await persistJob(job);
      const command = `$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Force -Path '${extractRoot.replaceAll("'", "''")}' | Out-Null; Expand-Archive -LiteralPath '${archivePath.replaceAll("'", "''")}' -DestinationPath '${extractRoot.replaceAll("'", "''")}' -Force`;
      await new Promise((resolve, reject) => { const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], { windowsHide: true }); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve() : reject(new Error("本地 H3 解压失败"))); });
      const sourceRoot = await findFile(extractRoot, "runtime.json").then((path) => path ? dirname(path) : "");
      if (!sourceRoot || !await stat(join(sourceRoot, "workflow.json")).catch(() => null)) throw new Error("安装包缺少 runtime.json 或 workflow.json");
      const nextRoot = `${runtimeRoot()}.next-${id}`;
      await rm(nextRoot, { recursive: true, force: true });
      await mkdir(nextRoot, { recursive: true });
      await cp(sourceRoot, nextRoot, { recursive: true, force: true });
      const installedRuntime = { ...(await readJson(join(nextRoot, "runtime.json"))), version: RELEASE.tag, installedAt: new Date().toISOString(), root: runtimeRoot() };
      if (!runtimeComplete(installedRuntime)) throw new Error("H3 安装包缺少完整推理环境或启动命令，已拒绝标记为装配完成");
      await writeFile(join(nextRoot, "runtime.json"), `${JSON.stringify(installedRuntime, null, 2)}\n`, "utf8");
      await rm(runtimeRoot(), { recursive: true, force: true });
      await rename(nextRoot, runtimeRoot());
      job.stage = "complete"; job.percent = 100; job.message = "本地 H3 已装配；点击启动后才会运行"; job.result = await probeLocalH3Runtime();
      await persistJob(job);
    } catch (error) {
      job.stage = "failed"; job.percent = 0; job.message = String(error?.message || error).slice(0, 500); await persistJob(job);
    } finally { await rm(tempRoot, { recursive: true, force: true }).catch(() => {}); }
  })();
  return { ok: true, jobId: id, ...job };
};

export const localH3InstallStatus = async (jobId = "") => {
  let job = jobs.get(String(jobId));
  if (!job) job = await readJson(installJobFile()).catch(() => null);
  if (!job) return { ok: false, stage: "missing", message: "找不到本地 H3 装配任务" };
  return { ok: true, ...job };
};

export const localH3WorkflowPath = () => workflowFile();
