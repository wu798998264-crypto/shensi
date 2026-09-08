import { appendFile, mkdir, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { appDataRoot } from "./app-data.mjs";

const LOG_LIMIT_BYTES = 512 * 1024;
const LOG_GENERATIONS = 5;
const BUNDLE_LOG_LIMIT = 2_000;
const CRASH_RECORD_LIMIT_BYTES = 64 * 1024;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const SECRET_TEXT_PATTERNS = [
  /\b(?:sk|sess|key)-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];
const SENSITIVE_KEY = /(?:authorization|cookie|password|passphrase|secret|token|api.?key|credential|private.?key)/i;
const USER_CONTENT_KEY = /^(?:content|text|prompt|messages?|attachments?|document|manuscript|chapter|article|body|payload|input|output|request|response|state|workspace)$/i;
const FAILURE_EVENT_PATTERN = /(?:fail|error|crash|uncaught|unhandled|corrupt|rollback)/i;
const WARNING_EVENT_PATTERN = /(?:warn|retry|timeout|recover)/i;
const LOW_DISK_WARNING_BYTES = 1024 * 1024 * 1024;
const LOW_DISK_ERROR_BYTES = 256 * 1024 * 1024;

const diagnosticError = (code, message, statusCode = 400) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
};

const cleanSegment = (value = "") => String(value).trim().replace(/[^0-9A-Za-z._-]/g, "-").slice(0, 100) || "unknown";
const timestamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const readableBytes = (value) => {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
};

export const redactDiagnosticValue = (value, { homePath = "", dataRoot = "", depth = 0, key = "" } = {}) => {
  if (depth > 8) return "<redacted-depth>";
  if (SENSITIVE_KEY.test(key)) return "<redacted-secret>";
  if (USER_CONTENT_KEY.test(key)) return "<redacted-user-content>";
  if (typeof value === "string") {
    let result = value.slice(0, 4_000).replace(PRIVATE_KEY_PATTERN, "<redacted-private-key>");
    for (const pattern of SECRET_TEXT_PATTERNS) result = result.replace(pattern, "<redacted-secret>");
    for (const path of [dataRoot, homePath].filter(Boolean).sort((left, right) => right.length - left.length)) {
      result = result.split(path).join(path === dataRoot ? "<data-root>" : "<home>");
      result = result.split(path.replaceAll("\\", "/")).join(path === dataRoot ? "<data-root>" : "<home>");
    }
    return result;
  }
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (value instanceof Error) {
    const rawMessage = String(value.message || "");
    const frames = String(value.stack || "").split(/\r?\n/).slice(1, 30).join("\n");
    return {
      name: String(value.name || "Error").slice(0, 100),
      messageSha256: createHash("sha256").update(rawMessage).digest("hex"),
      code: String(value.code || "").slice(0, 100),
      stackFrames: redactDiagnosticValue(frames, { homePath, dataRoot, depth: depth + 1, key: "stackFrames" }),
    };
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactDiagnosticValue(item, { homePath, dataRoot, depth: depth + 1 }));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 100).map(([entryKey, entryValue]) => [
    String(entryKey).slice(0, 100),
    redactDiagnosticValue(entryValue, { homePath, dataRoot, depth: depth + 1, key: entryKey }),
  ]));
  return String(value).slice(0, 500);
};

export const createDiagnosticManager = ({
  dataRoot = appDataRoot(),
  version = "0.0.0",
  runtime = {},
  env = process.env,
  fetchImpl = fetch,
  homePath = env.USERPROFILE || env.HOME || "",
} = {}) => {
  const diagnosticsRoot = join(resolve(dataRoot), "diagnostics");
  const logPath = join(diagnosticsRoot, "diagnostics.jsonl");
  const uploadUrl = String(env.SHENSI_DIAGNOSTICS_UPLOAD_URL || "").trim();
  const uploadToken = String(env.SHENSI_DIAGNOSTICS_UPLOAD_TOKEN || "").trim();
  let writeQueue = Promise.resolve();
  let lastDiagnosis = null;

  const parsedUploadUrl = () => {
    if (!uploadUrl) return null;
    let parsed;
    try { parsed = new URL(uploadUrl); } catch { throw diagnosticError("DIAGNOSTICS_UPLOAD_URL_INVALID", "诊断上传地址无效", 503); }
    if (parsed.protocol !== "https:") throw diagnosticError("DIAGNOSTICS_UPLOAD_HTTPS_REQUIRED", "诊断上传只允许 HTTPS 地址", 503);
    if (parsed.username || parsed.password) throw diagnosticError("DIAGNOSTICS_UPLOAD_URL_INVALID", "诊断上传地址不能包含凭据", 503);
    return parsed;
  };

  const rotateIfNeeded = async () => {
    const info = await stat(logPath).catch(() => null);
    if (!info || info.size < LOG_LIMIT_BYTES) return;
    await rm(`${logPath}.${LOG_GENERATIONS}`, { force: true });
    for (let index = LOG_GENERATIONS - 1; index >= 1; index -= 1) {
      const source = `${logPath}.${index}`;
      const target = `${logPath}.${index + 1}`;
      await rename(source, target).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    }
    await rename(logPath, `${logPath}.1`);
  };

  const rotateIfNeededSync = () => {
    let info;
    try { info = statSync(logPath); } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    if (info.size < LOG_LIMIT_BYTES) return;
    rmSync(`${logPath}.${LOG_GENERATIONS}`, { force: true });
    for (let index = LOG_GENERATIONS - 1; index >= 1; index -= 1) {
      try { renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`); } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    renameSync(logPath, `${logPath}.1`);
  };

  const buildRecord = (event, detail) => redactDiagnosticValue({
    schemaVersion: 1,
    at: new Date().toISOString(),
    event: cleanSegment(event),
    detail,
  }, { homePath, dataRoot: resolve(dataRoot) });

  const log = (event, detail = {}) => {
    writeQueue = writeQueue.then(async () => {
      await mkdir(diagnosticsRoot, { recursive: true });
      await rotateIfNeeded();
      await appendFile(logPath, `${JSON.stringify(buildRecord(event, detail))}\n`, "utf8");
    }).catch((error) => {
      process.stderr.write(`[diagnostics-write-failed] ${String(error?.message || error).slice(0, 200)}\n`);
    });
    return writeQueue;
  };

  // Fatal-process paths cannot depend on the asynchronous write queue: the process
  // may terminate before a queued promise is serviced. Keep this path synchronous,
  // bounded and best-effort so the last crash evidence reaches durable storage.
  const recordCrash = (event, detail = {}) => {
    try {
      mkdirSync(diagnosticsRoot, { recursive: true });
      rotateIfNeededSync();
      let serialized = JSON.stringify(buildRecord(event, detail));
      if (Buffer.byteLength(serialized, "utf8") > CRASH_RECORD_LIMIT_BYTES) {
        serialized = JSON.stringify(buildRecord(event, {
          truncated: true,
          redactedRecordSha256: createHash("sha256").update(serialized).digest("hex"),
        }));
      }
      appendFileSync(logPath, `${serialized}\n`, { encoding: "utf8", flush: true });
      return true;
    } catch (error) {
      process.stderr.write(`[diagnostics-crash-write-failed] ${String(error?.message || error).slice(0, 200)}\n`);
      return false;
    }
  };

  const readRecentRecords = async () => {
    await writeQueue;
    const names = (await readdir(diagnosticsRoot).catch((error) => error?.code === "ENOENT" ? [] : Promise.reject(error)))
      .filter((name) => /^diagnostics\.jsonl(?:\.\d+)?$/.test(name))
      .sort((left, right) => Number(right.match(/\.(\d+)$/)?.[1] || 0) - Number(left.match(/\.(\d+)$/)?.[1] || 0));
    const records = [];
    for (const name of names) {
      const text = await readFile(join(diagnosticsRoot, name), "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { records.push({ event: "malformed-log-record" }); }
      }
    }
    return records.slice(-BUNDLE_LOG_LIMIT).map((record) => redactDiagnosticValue(record, { homePath, dataRoot: resolve(dataRoot) }));
  };

  const runDiagnosis = async () => {
    const diagnosisId = randomUUID();
    const checkedAt = new Date().toISOString();
    const checks = [];
    const probePath = join(diagnosticsRoot, `.write-probe-${diagnosisId}.tmp`);
    try {
      await mkdir(diagnosticsRoot, { recursive: true });
      await writeFile(probePath, "shensi-diagnostic-probe", "utf8");
      const probe = await readFile(probePath, "utf8");
      if (probe !== "shensi-diagnostic-probe") throw new Error("probe verification failed");
      checks.push({ id: "local-storage", label: "本地数据读写", status: "pass", message: "软件数据目录可以正常读取和写入。" });
    } catch {
      checks.push({ id: "local-storage", label: "本地数据读写", status: "error", message: "软件数据目录无法完成读写，请检查磁盘权限或安全软件拦截。" });
    } finally {
      await rm(probePath, { force: true }).catch(() => {});
    }

    try {
      const disk = await statfs(diagnosticsRoot);
      const freeBytes = Number(disk.bavail) * Number(disk.bsize);
      const status = freeBytes < LOW_DISK_ERROR_BYTES ? "error" : freeBytes < LOW_DISK_WARNING_BYTES ? "warning" : "pass";
      checks.push({
        id: "disk-space",
        label: "可用磁盘空间",
        status,
        message: status === "pass"
          ? `当前可用空间约 ${readableBytes(freeBytes)}。`
          : status === "warning"
            ? `当前仅剩约 ${readableBytes(freeBytes)}，建议尽快清理空间。`
            : `当前仅剩约 ${readableBytes(freeBytes)}，保存与任务恢复可能失败。`,
      });
    } catch {
      checks.push({ id: "disk-space", label: "可用磁盘空间", status: "warning", message: "未能读取磁盘空间，请在系统存储设置中确认。" });
    }

    try {
      const records = await readRecentRecords();
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = records.filter((record) => {
        const at = Date.parse(record?.at || "");
        return !Number.isNaN(at) && at >= cutoff;
      });
      const failures = recent.filter((record) => FAILURE_EVENT_PATTERN.test(String(record?.event || "")));
      const warnings = recent.filter((record) => !FAILURE_EVENT_PATTERN.test(String(record?.event || "")) && WARNING_EVENT_PATTERN.test(String(record?.event || "")));
      checks.push({
        id: "recent-runtime-events",
        label: "近 24 小时运行记录",
        status: failures.length ? "error" : warnings.length ? "warning" : "pass",
        message: failures.length
          ? `发现 ${failures.length} 条失败或崩溃记录，建议导出诊断结果交给维护人员分析。`
          : warnings.length
            ? `发现 ${warnings.length} 条重试、超时或恢复记录，可继续使用并留意是否重复出现。`
            : "没有发现失败、崩溃、超时或反复恢复记录。",
        evidenceCount: failures.length + warnings.length,
      });
    } catch {
      checks.push({ id: "recent-runtime-events", label: "近 24 小时运行记录", status: "warning", message: "运行记录读取失败，导出结果时会保留该异常。" });
    }

    checks.push({
      id: "runtime-environment",
      label: "运行环境",
      status: process.version && process.platform ? "pass" : "warning",
      message: `${process.platform} ${process.arch} · Node ${process.version} · 神思 ${cleanSegment(version)}`,
    });
    const errorCount = checks.filter((check) => check.status === "error").length;
    const warningCount = checks.filter((check) => check.status === "warning").length;
    lastDiagnosis = {
      schemaVersion: 1,
      diagnosisId,
      checkedAt,
      overallStatus: errorCount ? "error" : warningCount ? "warning" : "healthy",
      summary: { total: checks.length, passed: checks.length - errorCount - warningCount, warnings: warningCount, errors: errorCount },
      checks,
    };
    await log("diagnosis-completed", {
      diagnosisId,
      overallStatus: lastDiagnosis.overallStatus,
      summary: lastDiagnosis.summary,
    });
    return lastDiagnosis;
  };

  const getDiagnosis = (diagnosisId = "") => {
    if (!diagnosisId || lastDiagnosis?.diagnosisId !== diagnosisId) return null;
    return structuredClone(lastDiagnosis);
  };

  const buildBundle = async ({ reason = "user-request", diagnosisId = "" } = {}) => ({
    schemaVersion: 1,
    bundleId: randomUUID(),
    createdAt: new Date().toISOString(),
    product: "Shensi Creative Engine",
    version: cleanSegment(version),
    reason: cleanSegment(reason),
    runtime: redactDiagnosticValue(runtime, { homePath, dataRoot: resolve(dataRoot) }),
    platform: { platform: process.platform, arch: process.arch, node: process.version },
    diagnosis: diagnosisId && lastDiagnosis?.diagnosisId === diagnosisId
      ? redactDiagnosticValue(lastDiagnosis, { homePath, dataRoot: resolve(dataRoot) })
      : null,
    logs: await readRecentRecords(),
    privacy: {
      userContentIncluded: false,
      secretsIncluded: false,
      uploadRequiresPerRequestConsent: true,
    },
  });

  const exportBundle = async ({ reason, diagnosisId = "", requireDiagnosis = false } = {}) => {
    if (requireDiagnosis && (!diagnosisId || lastDiagnosis?.diagnosisId !== diagnosisId)) {
      throw diagnosticError("DIAGNOSIS_REQUIRED", "请先完成一次诊断，再导出诊断结果", 409);
    }
    const bundle = await buildBundle({ reason, diagnosisId });
    await mkdir(diagnosticsRoot, { recursive: true });
    const fileName = `diagnostic-bundle-${timestamp()}-${bundle.bundleId}.json`;
    const filePath = join(diagnosticsRoot, fileName);
    await writeFile(filePath, JSON.stringify(bundle, null, 2), "utf8");
    return { filePath, fileName, bundleId: bundle.bundleId, logCount: bundle.logs.length };
  };

  const uploadBundle = async ({ consent = false, reason } = {}) => {
    if (consent !== true) throw diagnosticError("DIAGNOSTICS_UPLOAD_CONSENT_REQUIRED", "每次上传诊断包都必须由用户明确授权", 403);
    const endpoint = parsedUploadUrl();
    if (!endpoint) throw diagnosticError("DIAGNOSTICS_UPLOAD_NOT_CONFIGURED", "尚未配置诊断上传服务器；可仅导出本地诊断包", 503);
    const bundle = await buildBundle({ reason });
    const headers = { "Content-Type": "application/json", "User-Agent": "ShensiCreativeEngine-Diagnostics" };
    if (uploadToken) headers.Authorization = `Bearer ${uploadToken}`;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(bundle),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw diagnosticError("DIAGNOSTICS_UPLOAD_FAILED", `诊断上传失败（${response.status}）`, 502);
    const result = await response.json().catch(() => ({}));
    await log("diagnostic-bundle-uploaded", { bundleId: bundle.bundleId, status: response.status });
    return { uploaded: true, bundleId: bundle.bundleId, receiptId: cleanSegment(result.receiptId || result.id || "accepted") };
  };

  const status = () => {
    let endpointHost = "";
    let configurationError = "";
    try { endpointHost = parsedUploadUrl()?.host || ""; } catch (error) { configurationError = error.code || "DIAGNOSTICS_UPLOAD_URL_INVALID"; }
    return {
      localExportEnabled: true,
      uploadEnabled: Boolean(endpointHost && !configurationError),
      uploadEndpointHost: endpointHost,
      configurationError,
      perRequestConsentRequired: true,
      diagnosticsRoot,
    };
  };

  const attachProcessHooks = () => {
    const uncaught = (error, origin) => { recordCrash("uncaught-exception", { origin, error }); };
    const unhandled = (reason) => { recordCrash("unhandled-rejection", { reason }); };
    const warning = (value) => { void log("process-warning", { warning: value }); };
    process.on("uncaughtExceptionMonitor", uncaught);
    process.on("unhandledRejection", unhandled);
    process.on("warning", warning);
    return () => {
      process.off("uncaughtExceptionMonitor", uncaught);
      process.off("unhandledRejection", unhandled);
      process.off("warning", warning);
    };
  };

  return { attachProcessHooks, buildBundle, exportBundle, getDiagnosis, log, recordCrash, runDiagnosis, status, uploadBundle };
};
