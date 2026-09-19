#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { dreaminaAuthRefreshFailureMessage, dreaminaAuthRefreshSessionRejectedMessage, isDreaminaAuthRefreshRetryableFailure, isDreaminaAuthRefreshSessionRejected, isDreaminaAuthRequiredResponse } from "../dreamina-auth-recovery.js";
import { dreaminaFailureDiagnosis } from "../dreamina-failure.js";
import { assertDreaminaCliGenerationAccess, assertDreaminaGenerationCredit, dreaminaExecutionReceipt, markDreaminaPreSubmitNoTask, verifiedDreaminaAccountForPaidSubmission, verifiedDreaminaAccountWithControlPlaneFallback } from "./dreamina-account-preflight.mjs";

const argv = process.argv.slice(2);
const OPERATIONS = new Set(["submit", "status", "download", "cancel", "reconcile", "run"]);
const operation = OPERATIONS.has(argv[0]) ? argv.shift() : "run";
const CAPABILITY_PROBE_VERSION = "2";

const option = (name, fallback = "") => {
  const direct = argv.find((value) => value.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] ?? fallback : fallback;
};

const hasFlag = (name) => argv.includes(name);

const dreaminaPrefixArgs = () => {
  try {
    const parsed = JSON.parse(process.env.SHENSI_DREAMINA_PREFIX_ARGS || "[]");
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const dreaminaExecutable = async () => {
  const configured = String(process.env.SHENSI_DREAMINA_EXECUTABLE || "").trim();
  if (configured) return configured;
  const candidates = process.platform === "win32"
    ? [join(homedir(), ".local", "bin", "dreamina.exe"), join(homedir(), "bin", "dreamina.exe")]
    : [join(homedir(), ".local", "bin", "dreamina")];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return process.platform === "win32" ? "dreamina.exe" : "dreamina";
};

const dreaminaCommandTimeoutMs = (args = []) => {
  const configured = Number(process.env.SHENSI_DREAMINA_COMMAND_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1_000, configured);
  const command = String(args[0] || "").toLowerCase();
  if (command === "version") return 60_000;
  if (command === "user_credit") return 45_000;
  if (["list_task", "query_result", "cancel_task"].includes(command)) return 90_000;
  return 10 * 60_000;
};

const terminateProcessTree = (child) => {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.unref?.();
    return;
  }
  child.kill("SIGKILL");
};

const runOnce = async (args) => {
  const executable = await dreaminaExecutable();
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, [...dreaminaPrefixArgs(), ...args], {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeoutMs = dreaminaCommandTimeoutMs(args);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      terminateProcessTree(child);
      const timeoutError = new Error(`Dreamina CLI 命令 ${String(args[0] || "unknown")} 超过 ${Math.ceil(timeoutMs / 1000)} 秒未响应`);
      timeoutError.code = String(args[0] || "").toLowerCase() === "user_credit"
        ? "DREAMINA_CREDIT_QUERY_TIMEOUT"
        : "DREAMINA_CONTROL_PLANE_TRANSIENT";
      finish(() => rejectRun(timeoutError));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(() => rejectRun(new Error(`Dreamina CLI 无法启动：${error.message}`))));
    child.on("close", (code) => finish(() => {
      if (code === 0) return resolveRun({ stdout: stdout.trim(), stderr: stderr.trim() });
      const detail = stderr.trim() || stdout.trim() || "没有错误输出";
      const markedCode = detail.match(/(?:^|\r?\n)\[(DREAMINA_[A-Z0-9_]+)\]\s*/)?.[1] || "";
      const error = new Error(`Dreamina CLI 退出码 ${code}：${detail.replace(/(?:^|\r?\n)\[DREAMINA_[A-Z0-9_]+\]\s*/, "\n").trim()}`);
      if (markedCode) error.code = markedCode;
      if (!markedCode && /dreamina_cli\s*使用权限|\bCLI\b.{0,24}仅限会员|当前账号.{0,24}仅限会员/iu.test(detail)) {
        error.code = "DREAMINA_CLI_MEMBERSHIP_REQUIRED";
        error.submissionOutcomeKnown = true;
      }
      if (!markedCode && isDreaminaAuthRequiredResponse(detail)) {
        error.code = "DREAMINA_AUTH_REQUIRED";
        error.submissionOutcomeKnown = true;
      }
      if (["DREAMINA_PROFILE_BROKER_BUSY", "DREAMINA_AUTH_REQUIRED", "DREAMINA_CLI_MEMBERSHIP_REQUIRED"].includes(markedCode)) error.submissionOutcomeKnown = true;
      rejectRun(error);
    }));
  });
};

const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const retryCount = (name, fallback) => {
  const configured = Number(process.env[name]);
  return Math.max(0, Math.min(8, Number.isInteger(configured) ? configured : fallback));
};
const authRetryDelayMs = () => Math.max(50, Number(process.env.SHENSI_DREAMINA_AUTH_RETRY_DELAY_MS) || 800);
const uploadRetryDelayMs = () => Math.max(50, Number(process.env.SHENSI_DREAMINA_UPLOAD_RETRY_DELAY_MS) || 1_200);
const boundedRetryDelay = (base, attempt, cap = 10_000) => Math.min(cap, base * (2 ** Math.max(0, attempt)));
const referenceUploadDidNotCreateTask = (value) => /upload resource[\s\S]*no file upload|upload (?:image|video|audio): upload phase, no file upload|no (?:reference )?files? (?:were )?uploaded|failed to upload (?:reference|image)[\s\S]*(?:before (?:task )?submit|without creating (?:a )?task)/i.test(String(value || ""));
const dreaminaSessionMissing = (error) => String(error?.code || "") === "DREAMINA_AUTH_REQUIRED"
  && isDreaminaAuthRequiredResponse(error?.message);
const dreaminaSessionMissingOutput = (result = {}) => {
  const source = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
  if (!isDreaminaAuthRequiredResponse(source)) return false;
  const payload = parsePayload(source);
  const status = String(payload?.status || payload?.gen_status || payload?.task_status || "").trim().toLowerCase();
  return ["fail", "failed", "error"].includes(status);
};
const dreaminaAuthRetryAllowed = (args = []) => [
  "version", "user_credit", "list_task", "query_result", "cancel_task", "cancel", "task_cancel", "--help",
].includes(String(args[0] || "").toLowerCase());
const preserveDreaminaQueryErrorCode = (error) => {
  const code = String(error?.code || "").toUpperCase();
  return [
    "DREAMINA_AUTH_REQUIRED", "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED", "DREAMINA_PROFILE_BROKER_BUSY",
  ].includes(code) ? code : "DREAMINA_QUERY_TRANSIENT";
};

const semanticAuthFailure = (command = "") => {
  const operationLabel = String(command || "").trim();
  const error = new Error(`${operationLabel ? `即梦命令 ${operationLabel}：` : ""}${dreaminaAuthRefreshSessionRejectedMessage()}`);
  error.code = "DREAMINA_AUTH_REQUIRED";
  error.submissionOutcomeKnown = true;
  return error;
};

const verifiedSemanticResult = (result = {}) => {
  if (dreaminaSessionMissingOutput(result)) throw semanticAuthFailure();
  return result;
};

const run = async (args, { authRetries = retryCount("SHENSI_DREAMINA_AUTH_RETRIES", 2) } = {}) => {
  let lastError = null;
  for (let attempt = 0; attempt <= authRetries; attempt += 1) {
    try {
      return verifiedSemanticResult(await runOnce(args));
    } catch (error) {
      lastError = error;
      const refreshSessionRejected = isDreaminaAuthRefreshSessionRejected(error?.message);
      const authRejected = dreaminaSessionMissing(error) || refreshSessionRejected;
      // Every runner invocation already imports the selected profile's durable
      // credential snapshot. Starting `login --headless` here is not a read:
      // it occupies Dreamina's one global Windows credential slot and can
      // block every other profile. Retry the exact, known-safe command only;
      // explicit OAuth is the sole owner of login/relogin operations.
      if (authRejected
        && (dreaminaAuthRetryAllowed(args) || error.submissionOutcomeKnown === true)
        && attempt < authRetries) {
        await sleep(boundedRetryDelay(authRetryDelayMs(), attempt));
        continue;
      }
      if (authRejected) throw semanticAuthFailure(args[0]);
      if (String(error?.code || "").toUpperCase() === "DREAMINA_PROFILE_BROKER_BUSY" && attempt < authRetries) {
        await sleep(boundedRetryDelay(400, attempt, 4_000));
        continue;
      }
      if (!isDreaminaAuthRefreshRetryableFailure(error?.message) || attempt >= authRetries) break;
      await sleep(boundedRetryDelay(authRetryDelayMs(), attempt));
    }
  }
  if (isDreaminaAuthRefreshRetryableFailure(lastError?.message)) {
    const recovered = new Error(dreaminaAuthRefreshFailureMessage(lastError.message, authRetries));
    recovered.code = "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED";
    recovered.submissionOutcomeKnown = true;
    throw recovered;
  }
  throw lastError;
};

const runGenerationSubmit = async (args, { uploadRetries = retryCount("SHENSI_DREAMINA_UPLOAD_RETRIES", 4) } = {}) => {
  let lastError = null;
  for (let attempt = 0; attempt <= uploadRetries; attempt += 1) {
    try {
      return await run(args);
    } catch (error) {
      lastError = error;
      if (!referenceUploadDidNotCreateTask(error?.message) || attempt >= uploadRetries) break;
      await sleep(boundedRetryDelay(uploadRetryDelayMs(), attempt));
    }
  }
  if (referenceUploadDidNotCreateTask(lastError?.message)) {
    lastError.code = "DREAMINA_REFERENCE_UPLOAD_NO_TASK";
    lastError.submissionOutcomeKnown = true;
  }
  throw lastError;
};

const parsePayload = (stdout) => {
  const source = String(stdout || "").trim();
  if (!source) return {};
  try {
    return JSON.parse(source);
  } catch {}
  const starts = [...source.matchAll(/\{/g)].map((match) => match.index).reverse();
  for (const start of starts) {
    try {
      return JSON.parse(source.slice(start));
    } catch {}
  }
  return {};
};

const readDreaminaCredit = async () => parsePayload((await run(["user_credit"])).stdout);
const verifiedDreaminaAccount = async () => verifiedDreaminaAccountWithControlPlaneFallback(readDreaminaCredit);
const verifiedDreaminaPaidAccount = async () => verifiedDreaminaAccountForPaidSubmission(readDreaminaCredit);

const taskList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["tasks", "task_list", "items", "data", "list"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
};

const normalizedPrompt = (value) => String(value || "")
  .normalize("NFKC")
  .replace(/\s+/gu, " ")
  .trim();

const nestedValue = (value, keys) => {
  if (!value || typeof value !== "object") return "";
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  for (const child of Object.values(value)) {
    const found = nestedValue(child, keys);
    if (found !== "") return found;
  }
  return "";
};

// The CLI may wrap a task in an operation envelope such as
// `{ status: "submit", data: { task_status: "completed" } }`. Prefer the
// task-specific fields so an envelope verb cannot hide the real outcome.
const rawStatus = (payload) => String(
  nestedValue(payload, ["gen_status", "task_status"])
  || nestedValue(payload, ["status"])
  || "",
).trim().toLowerCase();
// A generic nested `id` may identify an asset or request log rather than the
// billable provider task, so only accept documented Dreamina task identifiers.
const submitId = (payload) => String(nestedValue(payload, ["submit_id", "submitId", "task_id", "taskId"]) || "").trim();
const nestedNumber = (payload, keys) => {
  const value = nestedValue(payload, keys);
  if (value === "" || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};
const queueInfo = (payload) => {
  const explicitPosition = nestedNumber(payload, ["queue_position", "queuePosition"]);
  const zeroBasedIndex = nestedNumber(payload, ["queue_idx", "queueIndex"]);
  return {
    position: explicitPosition ?? (zeroBasedIndex === null ? null : zeroBasedIndex + 1),
    length: nestedNumber(payload, ["queue_length", "queueLength", "queue_total", "queueTotal"]),
    priority: nestedNumber(payload, ["priority", "queue_priority", "queuePriority"]),
    status: String(nestedValue(payload, ["queue_status", "queueStatus"]) || "").trim(),
  };
};
const normalizedProgressPercent = (payload) => {
  const explicitPercent = nestedValue(payload, [
    "progress_percent", "progressPercent", "progress_pct", "progressPct",
    "task_progress_percent", "taskProgressPercent", "generate_progress_percent", "generateProgressPercent",
    "completion_percent", "completionPercent",
  ]);
  const genericProgress = explicitPercent === ""
    ? nestedValue(payload, ["task_progress", "taskProgress", "generate_progress", "generateProgress", "progress"])
    : explicitPercent;
  if (genericProgress === "" || genericProgress === null || genericProgress === undefined) return null;
  const source = String(genericProgress).trim();
  const percentSyntax = source.endsWith("%");
  const parsed = Number(percentSyntax ? source.slice(0, -1).trim() : source);
  if (!Number.isFinite(parsed)) return null;
  const percent = explicitPercent === "" && !percentSyntax && parsed > 0 && parsed <= 1 ? parsed * 100 : parsed;
  return percent >= 0 && percent <= 100 ? percent : null;
};
const rawFailureReason = (payload) => String(nestedValue(payload, ["fail_reason", "failure_reason", "message", "error"]) || "Dreamina 图片任务失败");
const failureCode = (payload) => String(nestedValue(payload, ["error_code", "errorCode", "code", "ret"]) || "").trim();
const concurrencyLimited = (value) => /ExceedConcurrencyLimit|(?:ret|code)\s*[=:]\s*1310/i.test(String(value || ""));
const friendlyFailureReason = (value) => concurrencyLimited(value)
  ? "即梦当前并发任务数已达上限（ExceedConcurrencyLimit）。"
  : String(value || "Dreamina 图片任务失败");
const normalizedStatus = (payload, { missingStatus = "unknown" } = {}) => {
  const status = rawStatus(payload);
  if (!status) return missingStatus;
  if (["success", "succeeded", "completed", "complete", "done"].includes(status)) return "completed";
  if (["fail", "failed", "error"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["queued", "pending", "created", "waiting"].includes(status)) return "queued";
  const queue = queueInfo(payload);
  if ((queue.position !== null && queue.position > 0) || /queue|wait|排队/iu.test(queue.status)) return "queued";
  if (["submit", "submitted", "submitting", "querying", "running", "processing", "generating", "in_progress", "in-progress"].includes(status)) return "running";
  return "unknown";
};

const referencePaths = async () => {
  const path = option("--reference-images-file");
  if (!path) return [];
  const parsed = JSON.parse(await readFile(path, "utf8"));
  const paths = (Array.isArray(parsed) ? parsed : [])
    .map(String)
    .filter(Boolean)
    .slice(0, 10);
  for (const rawPath of paths) {
    const path = resolve(rawPath);
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(extname(path).toLowerCase())) {
      const error = new Error(`Dreamina 不支持参考图片格式 ${extname(path) || "（无扩展名）"}：${path}`);
      error.code = "DREAMINA_REFERENCE_INVALID";
      error.submissionOutcomeKnown = true;
      throw error;
    }
    let metadata;
    try {
      metadata = await stat(path);
      await access(path);
    } catch (cause) {
      const error = new Error(`Dreamina 参考图片不存在或不可读取：${path}`);
      error.code = "DREAMINA_REFERENCE_INVALID";
      error.submissionOutcomeKnown = true;
      error.cause = cause;
      throw error;
    }
    if (!metadata.isFile() || metadata.size <= 0) {
      const error = new Error(`Dreamina 参考图片为空或不是普通文件：${path}`);
      error.code = "DREAMINA_REFERENCE_INVALID";
      error.submissionOutcomeKnown = true;
      throw error;
    }
  }
  return paths;
};

const mappedModel = (model) => ({
  "doubao-seedream-5-0-260128": "5.0",
  "doubao-seedream-5-0-lite-260128": "5.0",
  "jimeng-image-5.0-pro": "5.0Pro",
  t2i_v40_jimeng: "4.0",
}[model] || model || "5.0");

const supportedResolutions = (model) => {
  if (["3.0", "3.1"].includes(model)) return ["1k", "2k"];
  if (model === "5.0Pro") return ["1.5k", "2k", "4k"];
  return ["2k", "4k"];
};

const resolvedResolution = (model, requested) => {
  const supported = supportedResolutions(model);
  const normalized = String(requested || "").toLowerCase();
  if (supported.includes(normalized)) return normalized;
  if (normalized === "high") return supported.at(-1);
  return supported[0];
};

const generationCommand = async () => {
  const prompt = await readFile(option("--prompt-file"), "utf8");
  const images = await referencePaths();
  const model = mappedModel(option("--model"));
  const ratio = option("--aspect-ratio", "1:1") === "auto" ? "1:1" : option("--aspect-ratio", "1:1");
  const resolution = resolvedResolution(model, option("--resolution", "standard"));
  const imageCount = Math.max(1, Math.min(4, Number(option("--count", "1")) || 1));
  if (images.length) {
    if (["3.0", "3.1"].includes(model)) throw new Error(`Dreamina ${model} 不支持参考图，请改用 4.0 或更高版本`);
    return ["image2image", `--images=${images.join(",")}`, `--prompt=${prompt}`, `--model_version=${model}`, `--ratio=${ratio}`, `--resolution_type=${resolution}`, `--generate_num=${imageCount}`];
  }
  return ["text2image", `--prompt=${prompt}`, `--model_version=${model}`, `--ratio=${ratio}`, `--resolution_type=${resolution}`, `--generate_num=${imageCount}`];
};

const findDownloadedImages = async (directory) => {
  const entries = (await readdir(directory, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => left.name.localeCompare(right.name, "en", { numeric: true }));
  const images = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      images.push(...await findDownloadedImages(path));
    } else if ([".png", ".jpg", ".jpeg", ".webp"].includes(extname(entry.name).toLowerCase())) {
      images.push(path);
    }
  }
  return images;
};

const copyDownloadedImages = async (downloadedPaths, output) => {
  if (!output) throw new Error("Dreamina 图片下载缺少 --output");
  const target = resolve(output);
  await mkdir(dirname(target), { recursive: true });
  const paths = [];
  for (let index = 0; index < downloadedPaths.length; index += 1) {
    const source = downloadedPaths[index];
    const extension = extname(source).toLowerCase() || ".png";
    const destination = index === 0 ? target : `${target}-${index + 1}${extension}`;
    await copyFile(source, destination);
    paths.push(destination);
  }
  return paths;
};

const stateRoot = () => resolve(process.env.SHENSI_MEDIA_PROVIDER_STATE_ROOT || join(homedir(), ".shensi-media-provider-state"));
const idempotencyPath = (key) => join(stateRoot(), "dreamina-image", "idempotency", `${createHash("sha256").update(key).digest("hex")}.json`);

const atomicJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "w");
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
};

const readJson = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const readIdempotency = async (key) => {
  if (!key) return null;
  return readJson(idempotencyPath(key));
};

const readExistingIdempotency = async (key) => {
  const existing = await readIdempotency(key);
  // A concurrency rejection did not create a paid provider task and must not
  // permanently block a later safe retry with the same logical job key.
  const recoverableSessionFailure = [
    "DREAMINA_AUTH_REQUIRED",
    "DREAMINA_PROVIDER_SESSION_EXPIRED",
    "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED",
    "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING",
  ].includes(String(existing?.errorCode || "").toUpperCase());
  if (existing?.providerTaskId && recoverableSessionFailure) {
    return {
      ...existing,
      providerStatus: "running",
      rawStatus: "session_restore_pending",
      error: "",
      errorCode: "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING",
    };
  }
  if (existing?.providerTaskId && !(existing.providerStatus === "failed" && concurrencyLimited(existing.error || existing.errorCode))) return existing;
  return null;
};

const publicPayload = (payload, fallbackId = "", { missingStatus = "unknown" } = {}) => {
  const providerStatus = normalizedStatus(payload, { missingStatus });
  const rawError = providerStatus === "failed" ? rawFailureReason(payload) : "";
  const capacityLimited = providerStatus === "failed" && concurrencyLimited(`${rawError} ${failureCode(payload)}`);
  const providerSessionExpired = providerStatus === "failed" && isDreaminaAuthRequiredResponse(rawError);
  const providerTaskId = submitId(payload) || fallbackId;
  const errorCode = capacityLimited
    ? "DREAMINA_CONCURRENCY_LIMIT"
    : providerSessionExpired
      ? "DREAMINA_PROVIDER_SESSION_EXPIRED"
      : providerStatus === "failed" ? failureCode(payload) : providerStatus === "unknown" ? "DREAMINA_UNKNOWN_STATUS" : "";
  const failure = providerStatus === "failed" || providerStatus === "unknown"
    ? dreaminaFailureDiagnosis({ code: errorCode, message: rawError, providerTaskId })
    : null;
  const queue = queueInfo(payload);
  return {
    providerTaskId,
    providerStatus,
    rawStatus: rawStatus(payload),
    error: providerStatus === "failed"
      ? friendlyFailureReason(rawError)
      : providerStatus === "unknown" ? `Dreamina CLI 返回无法识别的图片任务状态：${rawStatus(payload) || "空状态"}` : "",
    errorCode,
    ...(failure ? {
      failureCategory: failure.category,
      failureReason: failure.cause,
      failureResolution: failure.resolution,
    } : {}),
    capacityLimited,
    retryAfterMs: capacityLimited ? 60_000 : 0,
    providerQueuePosition: queue.position,
    providerQueueLength: queue.length,
    providerQueuePriority: queue.priority,
    providerQueueStatus: queue.status,
    progressPercent: normalizedProgressPercent(payload),
    creditCount: nestedNumber(payload, ["credit_count", "creditCount"]),
    executionReceipt: dreaminaExecutionReceipt(),
  };
};

const taskStoreSessionError = (payload = {}) => {
  const status = String(payload?.status || payload?.gen_status || payload?.task_status || "").trim().toLowerCase();
  if (!["fail", "failed", "error"].includes(status)
    || !isDreaminaAuthRequiredResponse(JSON.stringify(payload))) return null;
  const error = new Error("即梦当前配置的任务资源会话未登录，收费任务尚未提交；请核验该配置后重试");
  error.code = "DREAMINA_AUTH_REQUIRED";
  error.submissionOutcomeKnown = true;
  return error;
};

const listTasks = async ({ submitIdFilter = "", limit = 100 } = {}) => {
  const args = ["list_task", `--limit=${Math.max(1, Math.min(200, Number(limit) || 100))}`];
  if (submitIdFilter) args.push(`--submit_id=${submitIdFilter}`);
  const output = (await run(args)).stdout;
  const payload = parsePayload(output);
  if (!String(output || "").trim() || (!Array.isArray(payload) && (!payload || typeof payload !== "object" || !Object.keys(payload).length))) {
    const error = new Error("即梦任务资源接口未返回可验证响应，收费任务尚未提交");
    error.code = "DREAMINA_TASK_RESOURCE_UNVERIFIED";
    error.submissionOutcomeKnown = true;
    throw error;
  }
  const sessionError = taskStoreSessionError(payload);
  if (sessionError) throw sessionError;
  return taskList(payload);
};

const ensureDreaminaTaskStoreSession = async () => {
  await listTasks({ limit: 1 });
};

const taskCreatedAt = (task) => {
  const value = nestedValue(task, ["created_at", "create_time", "createdAt", "submitted_at", "submit_time"]);
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
};

const findListedTask = async ({ providerTaskId = "", prompt = "", genTaskType = "", excludedTaskIds = [], preparedAt = "" } = {}) => {
  const tasks = await listTasks({ submitIdFilter: providerTaskId });
  const excluded = new Set((Array.isArray(excludedTaskIds) ? excludedTaskIds : []).map(String));
  const expectedPrompt = normalizedPrompt(prompt);
  const expectedType = String(genTaskType || "").trim().toLowerCase();
  return tasks.find((task) => {
    const id = submitId(task);
    if (!id || excluded.has(id)) return false;
    if (providerTaskId) return id === providerTaskId;
    if (!excluded.size && preparedAt) {
      const createdAt = taskCreatedAt(task);
      if (!createdAt || createdAt < Date.parse(preparedAt) - 60_000) return false;
    }
    if (expectedType && String(task?.gen_task_type || "").trim().toLowerCase() !== expectedType) return false;
    return Boolean(expectedPrompt) && normalizedPrompt(task?.prompt) === expectedPrompt;
  }) || null;
};

const reconcileSubmission = async ({ allowHistoricalMatch = false } = {}) => {
  const idempotencyKey = String(option("--idempotency-key") || "").trim();
  const prepared = await readIdempotency(idempotencyKey);
  const promptPath = option("--prompt-file");
  const prompt = promptPath ? await readFile(promptPath, "utf8") : option("--prompt") || prepared?.prompt || "";
  const genTaskType = option("--task-type") || prepared?.genTaskType || "";
  const beforeTaskIds = Array.isArray(prepared?.beforeTaskIds) ? prepared.beforeTaskIds : [];
  const strictCandidate = await findListedTask({ prompt, genTaskType, excludedTaskIds: beforeTaskIds, preparedAt: prepared?.preparedAt || "" });
  const candidate = strictCandidate || ((!prepared?.preparedAt && allowHistoricalMatch)
    ? await findListedTask({ prompt, genTaskType })
    : null);
  if (!candidate) {
    return {
      providerTaskId: "",
      providerStatus: "running",
      rawStatus: "reconciling",
      reconciliationPending: true,
      errorCode: "DREAMINA_SUBMISSION_NOT_VISIBLE",
    };
  }
  const result = {
    ...publicPayload(candidate),
    providerTaskId: submitId(candidate),
    reconciledAt: new Date().toISOString(),
    idempotencyKey,
  };
  if (idempotencyKey) await atomicJson(idempotencyPath(idempotencyKey), result);
  return result;
};

const submit = async () => {
  let account;
  try {
    account = await verifiedDreaminaPaidAccount();
    assertDreaminaGenerationCredit(account);
    assertDreaminaCliGenerationAccess(account);
    // Balance/identity and task resources are separate Dreamina auth surfaces.
    // Verify the latter with a read-only command before any paid submission.
    await ensureDreaminaTaskStoreSession();
  } catch (error) {
    throw markDreaminaPreSubmitNoTask(error);
  }
  const idempotencyKey = String(option("--idempotency-key") || "").trim();
  const existing = await readExistingIdempotency(idempotencyKey);
  if (existing?.providerTaskId) return { ...existing, idempotentReplay: true };
  const command = await generationCommand();
  const prompt = await readFile(option("--prompt-file"), "utf8");
  const prepared = await readIdempotency(idempotencyKey);
  if (prepared?.preparedAt) {
    const recovered = await reconcileSubmission();
    if (recovered.providerTaskId) return { ...recovered, idempotentReplay: true };
  }
  if (idempotencyKey && !prepared?.preparedAt) {
    await atomicJson(idempotencyPath(idempotencyKey), {
      submissionState: "prepared",
      idempotencyKey,
      prompt,
      genTaskType: command[0],
      beforeTaskIds: [],
      preparedAt: new Date().toISOString(),
    });
  }
  let payload;
  try {
    payload = parsePayload((await runGenerationSubmit(command)).stdout);
  } catch (error) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await sleep(500 * attempt);
      const recovered = await reconcileSubmission().catch(() => null);
      if (recovered?.providerTaskId) return recovered;
    }
    error.code = error.code || "DREAMINA_SUBMISSION_UNCERTAIN";
    throw error;
  }
  let result = {
    ...publicPayload(payload),
    executionReceipt: dreaminaExecutionReceipt(account.identity),
    accountControlPlaneDeferred: account.controlPlaneDeferred === true,
    accountCreditSourceConflict: account.creditSourceConflict === true,
    submittedAt: new Date().toISOString(),
    idempotencyKey,
  };
  if (!result.providerTaskId) throw new Error("Dreamina CLI 未返回 submit_id");
  if (result.errorCode === "DREAMINA_PROVIDER_SESSION_EXPIRED") {
    // Preserve a possibly paid task and continue by exact task ID. Never retry
    // the image generation command merely to refresh the result-store session.
    const { failureCategory, failureReason, failureResolution, ...pending } = result;
    result = {
      ...pending,
      providerStatus: "running",
      rawStatus: "session_restore_pending",
      error: "",
      errorCode: "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING",
    };
  }
  if (idempotencyKey && result.capacityLimited) await rm(idempotencyPath(idempotencyKey), { force: true });
  else if (idempotencyKey) await atomicJson(idempotencyPath(idempotencyKey), result);
  return result;
};

const query = async ({ download = false, providerTaskId = "" } = {}) => {
  const id = String(providerTaskId || option("--provider-task-id") || option("--submit-id") || "").trim();
  if (!id) throw new Error("Dreamina 图片查询缺少 provider task ID");
  const output = option("--output");
  const downloadDirectory = resolve(option("--download-dir") || (output
    ? join(dirname(resolve(output)), "dreamina-downloads", id)
    : join(stateRoot(), "dreamina-image", "downloads", id)));
  await mkdir(downloadDirectory, { recursive: true });
  const cached = await findDownloadedImages(downloadDirectory);
  if (cached.length) {
    const result = { providerTaskId: id, providerStatus: "completed", rawStatus: "cached", downloadedPath: cached[0], downloadedPaths: cached };
    if (download) {
      result.paths = await copyDownloadedImages(cached, output);
      result.path = result.paths[0];
    }
    return result;
  }
  let payload;
  try {
    payload = parsePayload((await run(["query_result", `--submit_id=${id}`, `--download_dir=${downloadDirectory}`])).stdout);
  } catch (error) {
    const listed = await findListedTask({ providerTaskId: id }).catch(() => null);
    if (!listed) {
      error.code = preserveDreaminaQueryErrorCode(error);
      throw error;
    }
    payload = listed;
  }
  if (hasFlag("--verify-list")) {
    const queriedStatus = normalizedStatus(payload);
    if (["queued", "running", "unknown"].includes(queriedStatus)) {
      const listed = await findListedTask({ providerTaskId: id }).catch(() => null);
      const listedStatus = listed ? normalizedStatus(listed) : "unknown";
      if (["completed", "failed", "cancelled"].includes(listedStatus)
        || (queriedStatus === "unknown" && ["queued", "running"].includes(listedStatus))) payload = listed;
    }
  }
  const downloadedPaths = await findDownloadedImages(downloadDirectory);
  const downloadedPath = downloadedPaths[0] || "";
  // The job's provider task ID is durable; nested response IDs must never
  // retarget a local job or accidentally follow a different billable request.
  const result = { ...publicPayload(payload, id), providerTaskId: id, downloadedPath, downloadedPaths };
  if (download && result.providerStatus === "completed") {
    if (!downloadedPath) throw Object.assign(new Error(`Dreamina 图片任务 ${id} 已完成，但未返回可下载文件`), { code: "DREAMINA_RESULT_PENDING" });
    result.paths = await copyDownloadedImages(downloadedPaths, output);
    result.path = result.paths[0];
  }
  return result;
};

const cancel = async () => {
  const id = String(option("--provider-task-id") || option("--submit-id") || "").trim();
  if (!id) throw new Error("Dreamina 图片取消缺少 provider task ID");
  const configuredCommand = String(process.env.SHENSI_DREAMINA_CANCEL_COMMAND || "").trim();
  let command = configuredCommand;
  if (!command) {
    const help = await run(["--help"]).catch(() => ({ stdout: "" }));
    command = String(help.stdout || "").match(/^\s*(cancel_task|cancel|task_cancel)\s/m)?.[1] || "";
  }
  if (!command) {
    return {
      ...await query({ providerTaskId: id }),
      cancellationUnsupported: true,
      cancellationMessage: "当前即梦 CLI 不支持取消厂商任务；神思将继续跟踪原图片任务，避免丢失已提交的结果。",
    };
  }
  const payload = parsePayload((await run([command, `--submit_id=${id}`])).stdout);
  return publicPayload(payload, id, { missingStatus: "running" });
};

const pollIntervalMs = Math.max(10, Number(process.env.SHENSI_DREAMINA_POLL_INTERVAL_MS) || 2000);

const runToCompletion = async () => {
  const outputOption = option("--output");
  if (!outputOption) throw new Error("Dreamina 图片运行缺少 --output");
  const output = resolve(outputOption);
  const submitted = await submit();
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const status = await query({ providerTaskId: submitted.providerTaskId });
    if (status.providerStatus === "failed") throw new Error(status.error || "Dreamina 图片任务失败");
    if (status.providerStatus === "cancelled") throw new Error("Dreamina 图片任务已取消");
    if (status.providerStatus === "completed") {
      if (status.downloadedPath) {
        await mkdir(dirname(output), { recursive: true });
        await copyFile(status.downloadedPath, output);
        return { ...status, path: output };
      }
      return query({ download: true, providerTaskId: submitted.providerTaskId });
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Dreamina 图片任务 ${submitted.providerTaskId} 在 30 分钟内未完成`);
};

const main = async () => {
  const runtimeProfileId = String(process.env.SHENSI_DREAMINA_PROFILE_ID || "").trim();
  if (!runtimeProfileId) throw Object.assign(new Error("当前即梦运行环境缺少明确账号配置"), { code: "DREAMINA_PROFILE_REQUIRED" });
  if (hasFlag("--check")) {
    const executable = await dreaminaExecutable();
    const executableMetadata = await stat(executable).catch(() => null);
    const connectionIdentity = JSON.stringify([
      CAPABILITY_PROBE_VERSION,
      resolve(executable),
      executableMetadata?.size || 0,
      Math.floor(executableMetadata?.mtimeMs || 0),
      dreaminaPrefixArgs(),
      runtimeProfileId,
      String(process.env.SHENSI_DREAMINA_EXPECTED_USER_ID || ""),
      String(process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT || ""),
    ]);
    const connectionCachePath = join(stateRoot(), "dreamina-image", "connection-check.json");
    const configuredConnectionCacheMs = Number(process.env.SHENSI_DREAMINA_CONNECTION_CACHE_MS);
    const connectionCacheMaxAgeMs = Math.max(0, Number.isFinite(configuredConnectionCacheMs) ? configuredConnectionCacheMs : 2 * 60_000);
    const cachedConnection = await readJson(connectionCachePath).catch(() => null);
    const cachedConnectionAge = Date.now() - Date.parse(String(cachedConnection?.checkedAt || ""));
    if (connectionCacheMaxAgeMs > 0
      && cachedConnection?.connectionIdentity === connectionIdentity
      && cachedConnection?.result?.ok === true
      && cachedConnection?.result?.taskResourceChecked === true
      && Number.isFinite(cachedConnectionAge)
      && cachedConnectionAge >= 0
      && cachedConnectionAge < connectionCacheMaxAgeMs) {
      process.stdout.write(JSON.stringify({ ...cachedConnection.result, connectionCacheHit: true }));
      return;
    }
    const version = parsePayload((await run(["version"])).stdout);
    const account = await verifiedDreaminaAccount();
    // Account/credit and task resources are separate auth surfaces. A
    // successful balance lookup alone must never make a paid image request
    // look ready when the result store session is expired or unavailable.
    await ensureDreaminaTaskStoreSession();
    const capabilities = { models: ["5.0Pro", "5.0", "4.7", "4.6", "4.5", "4.1", "4.0", "3.1", "3.0"], inputTypes: ["text", "image"], resolutions: ["1k", "2k", "4k"] };
    const result = { ok: true, version, credit: account.credit.total_credit, vipLevel: account.credit.vip_level || "", userId: account.identity.userId, profileId: account.identity.profileId, credentialFingerprint: String(process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT || ""), controlPlaneDeferred: account.controlPlaneDeferred === true, taskResourceChecked: true, generationReady: true, capabilities };
    await atomicJson(connectionCachePath, { connectionIdentity, checkedAt: new Date().toISOString(), result }).catch(() => {});
    process.stdout.write(JSON.stringify(result));
    return;
  }
  const result = operation === "submit" ? await submit()
    : operation === "status" ? await query()
      : operation === "download" ? await query({ download: true })
        : operation === "cancel" ? await cancel()
          : operation === "reconcile" ? await reconcileSubmission({ allowHistoricalMatch: true })
          : await runToCompletion();
  process.stdout.write(JSON.stringify(result));
};

main().catch((error) => {
  const code = error.code || (["status", "download"].includes(operation) ? "DREAMINA_QUERY_TRANSIENT" : "");
  const noTaskMarker = error.preSubmitNoTask === true ? "[DREAMINA_PRE_SUBMIT_NO_TASK] " : "";
  process.stderr.write(`${noTaskMarker}${code ? `[${code}] ` : ""}${error.message}\n`);
  process.exitCode = 1;
});
