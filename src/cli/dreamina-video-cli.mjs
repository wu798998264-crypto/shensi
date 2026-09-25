#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { dreaminaAuthRefreshFailureMessage, dreaminaAuthRefreshSessionRejectedMessage, isDreaminaAuthRefreshRetryableFailure, isDreaminaAuthRefreshSessionRejected, isDreaminaAuthRequiredResponse } from "../dreamina-auth-recovery.js";
import { dreaminaFailureDiagnosis } from "../dreamina-failure.js";
import { assertDreaminaCliGenerationAccess, assertDreaminaGenerationCredit, cachedDreaminaAccountIdentity, dreaminaExecutionReceipt, markDreaminaPreSubmitNoTask, verifiedDreaminaAccountForPaidSubmission, verifiedDreaminaAccountWithControlPlaneFallback } from "./dreamina-account-preflight.mjs";
import {
  dreaminaCommandForVideoRequest,
  seedance25CapabilitiesFromCommandHelp,
  validateSeedance25Resolution,
} from "./dreamina-video-capabilities.mjs";
import {
  LONG_VIDEO_MAX_DURATION_SECONDS,
  LONG_VIDEO_MIN_DURATION_SECONDS,
  defaultSmartMultiframeTransitionPrompt,
  normalizeSmartMultiframeTransitions,
  seedanceGenerationModeSupported,
  seedanceGenerationModesForModel,
  seedanceModelFamily,
  smartEditReferenceValidation,
} from "../video-generation-sequence.js";

const argv = process.argv.slice(2);
const OPERATIONS = new Set(["submit", "status", "download", "cancel", "reconcile", "run"]);
const operation = OPERATIONS.has(argv[0]) ? argv.shift() : "run";
const CAPABILITY_PROBE_VERSION = "4";

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

const ffmpegExecutable = () => String(process.env.SHENSI_FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg";

const dreaminaCommandTimeoutMs = (args = []) => {
  const configured = Number(process.env.SHENSI_DREAMINA_COMMAND_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1_000, configured);
  const command = String(args[0] || "").toLowerCase();
  if (command === "version") return 60_000;
  if (command === "user_credit") return 45_000;
  if (["list_task", "query_task", "cancel_task"].includes(command)) return 60_000;
  return 10 * 60_000;
};

const terminateProcessTree = (child) => {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref?.();
    return;
  }
  child.kill("SIGKILL");
};

const retryCount = (name, fallback) => {
  const configured = Number(process.env[name]);
  return Math.max(0, Math.min(8, Number.isInteger(configured) ? configured : fallback));
};
const authRetryDelayMs = () => Math.max(50, Number(process.env.SHENSI_DREAMINA_AUTH_RETRY_DELAY_MS) || 800);
const uploadRetryDelayMs = () => Math.max(50, Number(process.env.SHENSI_DREAMINA_UPLOAD_RETRY_DELAY_MS) || 1_200);
const boundedRetryDelay = (base, attempt, cap = 10_000) => Math.min(cap, base * (2 ** Math.max(0, attempt)));
const referenceUploadDidNotCreateTask = (value) => /upload resource[\s\S]*no file upload|upload (?:image|video|audio): upload phase, no file upload|no (?:reference )?files? (?:were )?uploaded|failed to upload (?:reference|image|video|audio)[\s\S]*(?:before (?:task )?submit|without creating (?:a )?task)/i.test(String(value || ""));
const DREAMINA_VIDEO_GENERATION_COMMANDS = new Set([
  "text2video", "image2video", "frames2video", "multiframe2video", "multimodal2video", "multiframe_video", "longvideo",
]);
const DREAMINA_CONTROL_COMMANDS = new Set([
  "version", "user_credit", "list_task", "query_result", "cancel_task", "cancel", "task_cancel", "login", "relogin", "logout", "--help",
]);
const dreaminaVideoGenerationCommand = (command = "") => {
  const normalized = String(command || "").trim().toLowerCase();
  if (DREAMINA_VIDEO_GENERATION_COMMANDS.has(normalized)) return true;
  // Long-video verbs are advertised by the installed official CLI and may
  // change between releases (for example `ultra_video` or `video_3min`).
  // Treat only non-control commands containing `video` as generation verbs.
  return Boolean(normalized) && !DREAMINA_CONTROL_COMMANDS.has(normalized) && /video/.test(normalized);
};
const DREAMINA_TASK_ID_COMMANDS = new Set([
  ...DREAMINA_VIDEO_GENERATION_COMMANDS,
  "list_task", "query_result", "cancel_task", "cancel", "task_cancel",
]);
const dreaminaCommandMayReturnTaskIdentity = (command = "") => {
  const normalized = String(command || "").trim().toLowerCase();
  return DREAMINA_TASK_ID_COMMANDS.has(normalized) || dreaminaVideoGenerationCommand(normalized);
};
const PLACEHOLDER_DREAMINA_TASK_IDS = new Set([
  "",
  "0",
  "-",
  "none",
  "null",
  "undefined",
  "unknown",
  "missing",
  "n/a",
  "na",
]);
const normalizeDreaminaTaskId = (value) => {
  const normalized = String(value ?? "").trim().replace(/^['"]|['"]$/gu, "");
  return PLACEHOLDER_DREAMINA_TASK_IDS.has(normalized.toLowerCase()) ? "" : normalized;
};
const dreaminaTaskIdInText = (value = "") => {
  const matches = String(value || "").matchAll(/(?:^|[\r\n{,])\s*["']?(?:submit_id|submitId|task_id|taskId|providerTaskId)["']?\s*[=:]\s*["']?([^\s,"'}]+)["']?/gim);
  for (const match of matches) {
    const candidate = normalizeDreaminaTaskId(match?.[1]);
    if (candidate) return candidate;
  }
  return "";
};
const tagDreaminaCommand = (result, command) => {
  if (result && typeof result === "object") {
    try {
      Object.defineProperty(result, "__dreaminaCommand", {
        value: String(command || ""),
        enumerable: false,
        configurable: true,
      });
    } catch {}
  }
  return result;
};
const dreaminaSessionMissing = (error) => String(error?.code || "") === "DREAMINA_AUTH_REQUIRED"
  && isDreaminaAuthRequiredResponse(error?.message);
const dreaminaSessionMissingOutput = (result = {}) => {
  const source = `${result?.stdout || ""}\n${result?.stderr || ""}`.trim();
  if (!isDreaminaAuthRequiredResponse(source)) return false;
  const payload = parsePayload(source);
  if (dreaminaCommandMayReturnTaskIdentity(result.__dreaminaCommand)
    && (submitId(payload) || dreaminaTaskIdInText(source))) return false;
  return payloadHasFailureStatusWithoutTaskId(payload)
    || !payload
    || (typeof payload === "object" && !Object.keys(payload).length);
};
const dreaminaAuthRetryAllowed = (args = []) => [
  "version", "user_credit", "list_task", "query_result", "cancel_task", "cancel", "task_cancel", "--help",
].includes(String(args[0] || "").toLowerCase());
const preserveDreaminaQueryErrorCode = (error) => {
  const code = String(error?.code || "").toUpperCase();
  return [
    "DREAMINA_AUTH_REQUIRED", "DREAMINA_AUTH_REFRESH_TRANSPORT_FAILED", "DREAMINA_PROFILE_BROKER_BUSY", "DREAMINA_GENERATION_SESSION_REJECTED", "DREAMINA_PROVIDER_TASK_AUTH_FAILURE",
  ].includes(code) ? code : "DREAMINA_QUERY_TRANSIENT";
};

const runCliOnce = async (args) => {
  const executable = await dreaminaExecutable();
  const fullArgs = [...dreaminaPrefixArgs(), ...args];
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, fullArgs, {
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
    child.on("close", (code) => {
      if (code !== 0) return finish(() => {
        const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        const payload = parsePayload(combined);
        const providerTaskId = dreaminaCommandMayReturnTaskIdentity(args[0])
          ? submitId(payload) || dreaminaTaskIdInText(combined)
          : "";
        const generationCommand = dreaminaVideoGenerationCommand(args[0]);
        if (generationCommand && providerTaskId) {
          resolveRun(tagDreaminaCommand({
            stdout: stdout.trim() || JSON.stringify(payload),
            stderr: stderr.trim(),
            providerTaskId,
          }, args[0]));
          return;
        }
        const detail = combined || "没有错误输出";
        const rawMarkedCode = detail.match(/(?:^|\r?\n)\[(DREAMINA_[A-Z0-9_]+)\]\s*/)?.[1] || "";
        const markedCode = generationCommand && rawMarkedCode === "DREAMINA_AUTH_REQUIRED"
          ? "DREAMINA_GENERATION_SESSION_REJECTED"
          : rawMarkedCode;
        const error = new Error(`Dreamina CLI 退出码 ${code}：${detail.replace(/(?:^|\r?\n)\[DREAMINA_[A-Z0-9_]+\]\s*/, "\n").trim()}`);
        if (markedCode) error.code = markedCode;
        if (!markedCode && /dreamina_cli\s*使用权限|\bCLI\b.{0,24}仅限会员|当前账号.{0,24}仅限会员/iu.test(detail)) {
          error.code = "DREAMINA_CLI_MEMBERSHIP_REQUIRED";
          error.submissionOutcomeKnown = true;
        }
        if (!markedCode && isDreaminaAuthRequiredResponse(detail)) {
          error.code = generationCommand ? "DREAMINA_GENERATION_SESSION_REJECTED" : "DREAMINA_AUTH_REQUIRED";
          error.submissionOutcomeKnown = !generationCommand;
        }
        if (["DREAMINA_PROFILE_BROKER_BUSY", "DREAMINA_AUTH_REQUIRED", "DREAMINA_CLI_MEMBERSHIP_REQUIRED"].includes(markedCode)) error.submissionOutcomeKnown = true;
        error.stdout = stdout.trim();
        error.stderr = stderr.trim();
        if (providerTaskId) error.providerTaskId = providerTaskId;
        rejectRun(error);
      });
      finish(() => resolveRun(tagDreaminaCommand({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        ...(dreaminaVideoGenerationCommand(args[0]) ? { providerTaskId: dreaminaTaskIdInText([stdout, stderr].filter(Boolean).join("\n")) } : {}),
      }, args[0])));
    });
  });
};

const semanticAuthFailure = (command = "") => {
  const operationLabel = String(command || "").trim();
  const generationCommand = dreaminaVideoGenerationCommand(operationLabel);
  const error = new Error();
  error.code = generationCommand ? "DREAMINA_GENERATION_SESSION_REJECTED" : "DREAMINA_AUTH_REQUIRED";
  error.message = generationCommand
    ? `即梦视频生成命令 ${operationLabel || "unknown"} 的会话在提交阶段被厂商拒绝，且没有返回任务 ID。账号核验状态保持有效；神思将保留幂等记录并在有限时限内只读核对本次提交结果。`
    : `${operationLabel ? `即梦命令 ${operationLabel}：` : ""}${dreaminaAuthRefreshSessionRejectedMessage()}`;
  error.submissionOutcomeKnown = !generationCommand;
  return error;
};

const verifiedSemanticResult = (result = {}) => {
  if (dreaminaSessionMissingOutput(result)) throw semanticAuthFailure(result.__dreaminaCommand || "");
  return result;
};

const runCli = async (args, { authRetries = retryCount("SHENSI_DREAMINA_AUTH_RETRIES", 2) } = {}) => {
  let lastError = null;
  for (let attempt = 0; attempt <= authRetries; attempt += 1) {
    try {
      return verifiedSemanticResult(await runCliOnce(args));
    } catch (error) {
      lastError = error;
      const refreshSessionRejected = isDreaminaAuthRefreshSessionRejected(error?.message);
      const authRejected = dreaminaSessionMissing(error) || refreshSessionRejected;
      // The selected snapshot is imported afresh by the broker for every
      // command. Do not turn a read-only or known-unsubmitted failure into an
      // implicit login that monopolizes the global credential slot. A bounded
      // retry of the same command handles transient authsdk starts safely.
      if (authRejected
        && error.code !== "DREAMINA_AUTH_REQUIRED"
        && (dreaminaAuthRetryAllowed(args) || error.submissionOutcomeKnown === true)
        && attempt < authRetries) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, boundedRetryDelay(authRetryDelayMs(), attempt)));
        continue;
      }
      if (authRejected) throw semanticAuthFailure(args[0]);
      if (dreaminaVideoGenerationCommand(args[0]) && isDreaminaAuthRequiredResponse(error?.message)) {
        throw semanticAuthFailure(args[0]);
      }
      if (String(error?.code || "").toUpperCase() === "DREAMINA_PROFILE_BROKER_BUSY" && attempt < authRetries) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, boundedRetryDelay(400, attempt, 4_000)));
        continue;
      }
      if (!isDreaminaAuthRefreshRetryableFailure(error?.message) || attempt >= authRetries) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, boundedRetryDelay(authRetryDelayMs(), attempt)));
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

const runGenerationSubmitCli = async (args, { uploadRetries = retryCount("SHENSI_DREAMINA_UPLOAD_RETRIES", 4) } = {}) => {
  let lastError = null;
  for (let attempt = 0; attempt <= uploadRetries; attempt += 1) {
    try {
      return await runCli(args);
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
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line);
    } catch {}
  }
  const starts = [...source.matchAll(/\{/g)].map((match) => match.index).reverse();
  for (const start of starts) {
    try {
      return JSON.parse(source.slice(start));
    } catch {}
  }
  return {};
};

const readDreaminaCredit = async () => parsePayload((await runCli(["user_credit"])).stdout);
const verifiedDreaminaAccount = async () => verifiedDreaminaAccountWithControlPlaneFallback(readDreaminaCredit);
const verifiedDreaminaPaidAccount = async () => verifiedDreaminaAccountForPaidSubmission(readDreaminaCredit);

const helpOutput = async (args) => {
  try {
    const result = await runCliOnce(args);
    return `${result.stdout || ""}\n${result.stderr || ""}`.trim();
  } catch {
    return "";
  }
};


const executableResponds = (executable, args = ["-version"], timeoutMs = 8_000) => new Promise((resolveCheck) => {
  const child = spawn(executable, args, { windowsHide: true, stdio: "ignore" });
  const timer = setTimeout(() => {
    child.kill();
    resolveCheck(false);
  }, timeoutMs);
  child.once("error", () => {
    clearTimeout(timer);
    resolveCheck(false);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolveCheck(code === 0);
  });
});

const durationRangeFromHelp = (text = "") => {
  const source = String(text || "");
  const exactSeedance25 = [...source.matchAll(/--duration[^\r\n]*?seedance2\.5\s*(?:->|:)[^\r\n]*?(\d{1,3})\s*(?:-|~|～|—|–|至|到)\s*(\d{1,3})/giu)];
  const explicitOutput = [...source.matchAll(/(?:output duration|输出时长)[^\r\n]{0,80}?(\d{1,3})\s*(?:-|~|～|—|–|至|到)\s*(\d{1,3})/giu)];
  const generic = [...source.matchAll(/(?:duration|时长|秒数)[^\r\n]{0,160}?(\d{1,3})\s*(?:-|~|～|—|–|至|到)\s*(\d{1,3})/giu)];
  const sourceMatches = exactSeedance25.length ? exactSeedance25 : explicitOutput.length ? explicitOutput : generic;
  const ranges = sourceMatches
    .map((match) => [Number(match[1]), Number(match[2])])
    .filter(([minimum, maximum]) => Number.isInteger(minimum) && Number.isInteger(maximum) && minimum > 0 && maximum >= minimum && maximum <= 600);
  if (!ranges.length) return null;
  return {
    minimum: Math.min(...ranges.map(([minimum]) => minimum)),
    maximum: Math.max(...ranges.map(([, maximum]) => maximum)),
  };
};

const advertisedLongVideoCommand = (rootHelp = "") => String(rootHelp || "")
  .split(/\r?\n/u)
  .map((line) => line.trim().split(/\s+/u)[0] || "")
  .find((token) => /video/i.test(token) && /(?:long|ultra|3min|3_min|180)/i.test(token)) || "";

const detectDreaminaVideoCapabilities = async ({ version = {} } = {}) => {
  const versionIdentity = JSON.stringify([CAPABILITY_PROBE_VERSION, version.version || "", version.commit || "", version.build_time || ""]);
  const cachePath = join(stateRoot(), "dreamina-video", "capabilities.json");
  const cached = await readJson(cachePath).catch(() => null);
  const cacheAge = Date.now() - Date.parse(String(cached?.checkedAt || ""));
  if (cached?.versionIdentity === versionIdentity
    && cached?.capabilities?.seedance25
    && cached.capabilities.seedance25.longVideoStrategy
    && cached.capabilities.seedance25.longVideoStrategy !== "segmented_concat"
    && Number.isFinite(cacheAge)
    && cacheAge >= 0
    && cacheAge < 24 * 60 * 60_000) {
    return { ...cached.capabilities, cacheHit: true };
  }
  const rootHelp = await helpOutput(["--help"]);
  // text2video exposes the authoritative model/output duration contract.
  // Avoid spawning every generation command during each connection probe;
  // the version-keyed cache below keeps normal job startup fast.
  const commands = ["text2video", "image2video", "frames2video", "multimodal2video", "multiframe2video"];
  const commandHelp = Object.fromEntries(await Promise.all(commands.map(async (command) => [command, await helpOutput([command, "--help"])])));
  const standardHelp = Object.values(commandHelp).join("\n");
  const seedance25 = seedance25CapabilitiesFromCommandHelp(commandHelp);
  const standardRange = durationRangeFromHelp(standardHelp) || { minimum: 4, maximum: 30 };
  const advertisedCommand = advertisedLongVideoCommand(rootHelp);
  const longHelp = advertisedCommand ? await helpOutput([advertisedCommand, "--help"]) : "";
  const longRange = durationRangeFromHelp(longHelp);
  // Treat the installed official CLI help as authoritative. Never invent a
  // provider capability by splitting the request into multiple paid jobs and
  // stitching them locally.
  const nativeLongRange = standardRange.maximum >= 31 ? standardRange : longRange;
  const longVideoCommand = standardRange.maximum >= 31 ? "text2video" : advertisedCommand;
  const directLongVideoAvailable = Boolean(longVideoCommand && nativeLongRange && nativeLongRange.maximum >= 31);
  const longVideoAvailable = directLongVideoAvailable;
  const capabilities = {
    capabilitySource: "official_cli_help",
    seedance25: {
      durationMin: standardRange.minimum,
      durationMax: standardRange.maximum,
      durationSeconds: Array.from({ length: standardRange.maximum - standardRange.minimum + 1 }, (_, index) => standardRange.minimum + index),
      resolutions: seedance25.resolutions,
      resolutionsByCommand: seedance25.resolutionsByCommand,
      resolutionsByMode: seedance25.resolutionsByMode,
      generationModes: ["smart_params", "first_last_frame", "smart_edit", ...(longVideoAvailable ? ["long_video"] : [])],
      unavailableGenerationModes: longVideoAvailable ? [] : [{
        id: "long_video",
        reason: "当前即梦 CLI 未声明 Seedance 2.5 原生超长视频能力；为避免多次错误计费，本次不会自动拆段拼接",
      }],
      longVideoAvailable,
      longVideoCommand: directLongVideoAvailable ? longVideoCommand : "",
      longVideoStrategy: directLongVideoAvailable ? "provider_direct" : "unavailable",
      longVideoDurationMin: longVideoAvailable ? Math.max(LONG_VIDEO_MIN_DURATION_SECONDS, nativeLongRange.minimum) : null,
      longVideoDurationMax: longVideoAvailable ? Math.min(LONG_VIDEO_MAX_DURATION_SECONDS, nativeLongRange.maximum) : null,
      longVideoReason: longVideoAvailable
        ? "当前官方 CLI 已声明 Seedance 2.5 原生超长视频直出能力"
        : "当前即梦 CLI 未声明原生超长视频能力；神思不会用多任务拼接伪装成原生能力",
    },
  };
  await atomicJson(cachePath, { versionIdentity, checkedAt: new Date().toISOString(), capabilities }).catch(() => {});
  return capabilities;
};

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

// `list_task` may wrap the real task in an operation envelope such as
// `{ status: "submit", data: { task_status: "processing" } }`. Prefer the
// provider's task-specific fields so the envelope verb never hides progress.
const rawStatus = (payload) => String(
  nestedValue(payload, ["gen_status", "task_status"])
  || nestedValue(payload, ["status"])
  || "",
).trim().toLowerCase();
// A generic nested `id` may be a request/log/asset identifier. Only accept
// fields that the Dreamina task API explicitly documents as task identities.
const submitId = (payload) => normalizeDreaminaTaskId(nestedValue(payload, ["submit_id", "submitId", "task_id", "taskId"]));
const payloadHasFailureStatusWithoutTaskId = (payload) => {
  if (Array.isArray(payload)) return payload.some(payloadHasFailureStatusWithoutTaskId);
  if (!payload || typeof payload !== "object") return false;
  const explicitTaskId = normalizeDreaminaTaskId(nestedValue(payload, ["submit_id", "submitId", "task_id", "taskId"]));
  const status = String(payload.gen_status || payload.task_status || payload.status || "").trim().toLowerCase();
  if (!explicitTaskId && ["fail", "failed", "error"].includes(status)) return true;
  return Object.values(payload).some(payloadHasFailureStatusWithoutTaskId);
};
const rawFailureReason = (payload) => String(nestedValue(payload, ["fail_reason", "failure_reason", "message", "error"]) || "Dreamina 视频任务失败");
const concurrencyLimited = (value) => /ExceedConcurrencyLimit|(?:ret|code)\s*[=:]\s*1310/i.test(String(value || ""));
const friendlyFailureReason = (value) => {
  const reason = String(value || "Dreamina 视频任务失败");
  if (concurrencyLimited(reason)) {
    return "即梦当前并发任务数已达上限（ExceedConcurrencyLimit）。";
  }
  return reason;
};
const failureCode = (payload) => String(nestedValue(payload, ["error_code", "errorCode", "code", "ret"]) || "").trim();
const resultUrl = (payload) => String(nestedValue(payload, ["result_url", "download_url", "video_url", "url"]) || "").trim();
const resultUrlExpiresAt = (payload) => String(nestedValue(payload, ["result_url_expires_at", "expires_at", "expire_time"]) || "").trim();
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
const normalizedStatus = (payload, { missingStatus = "unknown" } = {}) => {
  const status = rawStatus(payload);
  if (!status) return missingStatus;
  if (["success", "succeeded", "completed", "complete", "done"].includes(status)) return "completed";
  if (["fail", "failed", "error"].includes(status)) return "failed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["queued", "pending", "created", "waiting"].includes(status)) return "queued";
  const queue = queueInfo(payload);
  if ((queue.position !== null && queue.position > 0) || /queue|wait|排队/i.test(queue.status)) return "queued";
  if (["submit", "submitted", "submitting", "querying", "running", "processing", "generating", "in_progress", "in-progress"].includes(status)) return "running";
  return "unknown";
};

const referenceEntries = async () => {
  const path = option("--reference-images-file") || option("--reference-media-file");
  if (!path) return [];
  const parsed = JSON.parse((await readFile(path, "utf8")).replace(/^\uFEFF/, ""));
  return (Array.isArray(parsed) ? parsed : []).map((item) => {
    if (typeof item === "string") return { path: item, durationSeconds: 0 };
    const entryPath = String(item?.absolutePath || item?.path || item?.relativePath || "");
    const durationSeconds = Number(item?.durationSeconds) > 0
      ? Number(item.durationSeconds)
      : Number(item?.durationMs) > 0 ? Number(item.durationMs) / 1000 : 0;
    return { path: entryPath, durationSeconds };
  }).filter((item) => item.path);
};

const SUPPORTED_REFERENCE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp",
  ".mp4", ".mov", ".webm", ".mkv", ".avi",
  ".mp3", ".wav", ".m4a", ".aac", ".flac",
]);

const assertReferenceFiles = async (paths = []) => {
  for (const rawPath of paths) {
    const path = resolve(String(rawPath || ""));
    const extension = extname(path).toLowerCase();
    if (!SUPPORTED_REFERENCE_EXTENSIONS.has(extension)) {
      const error = new Error(`Dreamina 不支持参考文件格式 ${extension || "（无扩展名）"}：${path}`);
      error.code = "DREAMINA_REFERENCE_INVALID";
      error.submissionOutcomeKnown = true;
      throw error;
    }
    let metadata;
    try {
      metadata = await stat(path);
      await access(path);
    } catch (cause) {
      const error = new Error(`Dreamina 参考文件不存在或不可读取：${path}`);
      error.code = "DREAMINA_REFERENCE_INVALID";
      error.submissionOutcomeKnown = true;
      error.cause = cause;
      throw error;
    }
    if (!metadata.isFile() || metadata.size <= 0) {
      const error = new Error(`Dreamina 参考文件为空或不是普通文件：${path}`);
      error.code = "DREAMINA_REFERENCE_INVALID";
      error.submissionOutcomeKnown = true;
      throw error;
    }
  }
};

const mediaKind = (path) => {
  const extension = extname(path).toLowerCase();
  if ([".mp4", ".mov", ".webm", ".mkv", ".avi"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".m4a", ".aac", ".flac"].includes(extension)) return "audio";
  return "image";
};

const mappedModel = (model) => ({
  "doubao-seedance-2-0-260128": "seedance2.0",
  "doubao-seedance-2-0-fast-260128": "seedance2.0fast",
  "doubao-seedance-1-5-pro-251215": "seedance1.5pro",
}[model] || model || "seedance2.5");

const isSeedance2OmniModel = (model) => /^seedance2\.(?:0|5)/.test(String(model || ""));
const isSeedance25Model = (model) => /^seedance2\.5(?:$|[_-])/.test(String(model || ""));

const validateSeedance25Options = ({ model, duration, resolution, mode, command, capabilities }) => {
  if (!isSeedance25Model(model)) return;
  const seconds = Number(duration);
  const minimum = mode === "long_video" ? LONG_VIDEO_MIN_DURATION_SECONDS : 4;
  const maximum = mode === "long_video" ? LONG_VIDEO_MAX_DURATION_SECONDS : 30;
  if (!Number.isInteger(seconds) || seconds < minimum || seconds > maximum) {
    throw new Error(`Seedance 2.5 ${mode === "long_video" ? "超长视频" : "视频"}时长必须是 ${minimum}—${maximum} 秒的整数`);
  }
  if (mode !== "long_video") validateSeedance25Resolution({ resolution, command, capabilities });
  if (!seedanceGenerationModeSupported(model, mode)) {
    throw new Error("Seedance 2.5 当前仅支持智能多参、首尾帧、智能编辑或超长视频模式");
  }
};

const validateSeedance25References = ({ model, mode, references, images, videos, audios }) => {
  if (!isSeedance25Model(model)) return;
  if (mode === "first_last_frame") {
    if (images.length !== 2 || videos.length || audios.length) {
      throw new Error("Seedance 2.5 首尾帧模式需要恰好 2 张图片，且不能包含视频或音频参考");
    }
    return;
  }
  if (mode === "smart_edit") {
    const validation = smartEditReferenceValidation(references, { requireKnownVideoDuration: false });
    if (!validation.ok) throw new Error(validation.message);
    return;
  }
  if (mode === "long_video") {
    if (references.length) throw new Error("Seedance 2.5 超长视频当前为提示词直出模式，不能附带参考媒体");
    return;
  }
  const total = images.length + videos.length + audios.length;
  if (images.length > 30 || videos.length > 10 || audios.length > 10 || total > 50) {
    throw new Error(`Seedance 2.5 全能参考最多支持 30 张图片、10 个视频、10 个音频，总计不超过 50 项；当前为图片 ${images.length}、视频 ${videos.length}、音频 ${audios.length}，总计 ${total} 项`);
  }
};

const validateSeedanceModeReferences = ({ model, mode, references, images, videos, audios }) => {
  const family = seedanceModelFamily(model);
  if (!family) return;
  if (!seedanceGenerationModeSupported(model, mode)) {
    throw new Error(`${model} 不支持 ${mode}；可用模式为 ${seedanceGenerationModesForModel(model).join("、")}`);
  }
  if (mode === "first_last_frame" && (images.length !== 2 || videos.length || audios.length || references.length !== 2)) {
    throw new Error("首尾帧模式需要恰好 2 张图片，且不能包含视频或音频参考");
  }
  if (mode === "smart_multiframe" && (family !== "seedance1.0fast" || images.length < 2 || images.length > 20 || videos.length || audios.length || references.length !== images.length)) {
    throw new Error("Seedance 1.0 Fast 智能多帧需要 2—20 张图片，且不能包含视频或音频参考");
  }
};

const generationCommand = async () => {
  const promptPath = option("--prompt-file");
  const prompt = promptPath ? await readFile(promptPath, "utf8") : option("--prompt");
  if (!String(prompt).trim()) throw new Error("Dreamina 视频提示词不能为空");
  const referenceEntriesValue = await referenceEntries();
  const references = referenceEntriesValue.map((item) => ({ ...item, kind: mediaKind(item.path), mimeType: `${mediaKind(item.path)}/reference` }));
  const images = references.filter((item) => item.kind === "image").map((item) => item.path);
  const videos = references.filter((item) => item.kind === "video").map((item) => item.path);
  const audios = references.filter((item) => item.kind === "audio").map((item) => item.path);
  const mode = option("--mode", "smart_params");
  const model = mappedModel(option("--model"));
  const duration = option("--duration", "5");
  const ratio = option("--aspect-ratio", "16:9");
  const resolution = option("--resolution", "720p");
  const commandName = dreaminaCommandForVideoRequest({ mode, imageCount: images.length, videoCount: videos.length, audioCount: audios.length });
  let capabilities = null;
  if (isSeedance25Model(model) && mode !== "long_video") {
    const version = parsePayload((await runCli(["version"])).stdout);
    capabilities = (await detectDreaminaVideoCapabilities({ version }))?.seedance25 || null;
  }
  validateSeedanceModeReferences({ model, mode, references, images, videos, audios });
  validateSeedance25Options({ model, duration, resolution, mode, command: commandName, capabilities });
  validateSeedance25References({ model, mode, references, images, videos, audios });
  await assertReferenceFiles(references.map((item) => item.path));
  const transitionsPath = option("--transitions-file");
  const transitionSource = transitionsPath
    ? JSON.parse(await readFile(resolve(transitionsPath), "utf8").catch(() => "[]"))
    : [];
  const transitions = normalizeSmartMultiframeTransitions(transitionSource, {
    frameCount: images.length,
    defaultDuration: Number(duration) || 4,
  });

  if (mode === "long_video") {
    const version = parsePayload((await runCli(["version"])).stdout);
    const capabilities = await detectDreaminaVideoCapabilities({ version });
    const longVideo = capabilities?.seedance25 || {};
    if (longVideo.longVideoAvailable !== true || !longVideo.longVideoCommand) {
      const error = new Error(longVideo.longVideoReason || "当前官方 CLI 未声明 31—180 秒直出命令；为避免错误提交和计费，本次未提交");
      error.code = "DREAMINA_CAPABILITY_UNAVAILABLE";
      error.submissionOutcomeKnown = true;
      throw error;
    }
    return [longVideo.longVideoCommand, `--prompt=${prompt}`, `--model_version=${model}`, `--duration=${duration}`, `--ratio=${ratio}`, `--video_resolution=${resolution}`];
  }
  if (videos.length || audios.length || (images.length && ["smart_params", "smart_edit"].includes(mode) && isSeedance2OmniModel(model))) {
    if (!isSeedance2OmniModel(model)) throw new Error("Dreamina 全能参考仅支持 Seedance 2.0/2.5 系列模型");
    if (!isSeedance25Model(model) && (images.length > 9 || videos.length > 3 || audios.length > 3)) throw new Error("Dreamina 全能参考最多支持 9 张图片、3 个视频和 3 个音频");
    return [
      "multimodal2video",
      ...images.map((path) => `--image=${path}`),
      ...videos.map((path) => `--video=${path}`),
      ...audios.map((path) => `--audio=${path}`),
      `--prompt=${prompt}`, `--model_version=${model}`, `--duration=${duration}`, `--ratio=${ratio}`, `--video_resolution=${resolution}`,
    ];
  }
  if (mode === "first_last_frame" && images.length >= 2) {
    if (!/^(?:seedance1\.(?:0(?:fast)?|5pro)|seedance2\.(?:0|5))/.test(model)) throw new Error("当前 Dreamina 模型不支持首尾帧模式");
    return ["frames2video", `--first=${images[0]}`, `--last=${images[1]}`, `--prompt=${prompt}`, `--model_version=${model}`, `--duration=${duration}`, `--video_resolution=${resolution}`];
  }
  if (images.length >= 2) {
    if (images.length > 20) throw new Error("Dreamina 智能多帧最多支持 20 张图片");
    const transitionPrompt = (index) => transitions[index]?.prompt || (mode === "smart_multiframe" ? defaultSmartMultiframeTransitionPrompt(index) : prompt);
    const transitionDuration = (index) => transitions[index]?.duration || Math.min(8, Math.max(1, Number(duration) / Math.max(1, images.length - 1)));
    if (images.length === 2) return ["multiframe2video", `--images=${images.join(",")}`, `--prompt=${transitionPrompt(0)}`, `--duration=${transitionDuration(0)}`];
    return [
      "multiframe2video", `--images=${images.join(",")}`,
      ...Array.from({ length: images.length - 1 }, (_, index) => `--transition-prompt=${transitionPrompt(index)}`),
      ...Array.from({ length: images.length - 1 }, (_, index) => `--transition-duration=${transitionDuration(index)}`),
    ];
  }
  if (images.length === 1) {
    return ["image2video", `--image=${images[0]}`, `--prompt=${prompt}`, `--model_version=${model}`, `--duration=${duration}`, `--video_resolution=${resolution}`];
  }
  if (!isSeedance2OmniModel(model)) throw new Error("Dreamina 文生视频仅支持 Seedance 2.0/2.5 系列模型");
  return ["text2video", `--prompt=${prompt}`, `--model_version=${model}`, `--duration=${duration}`, `--ratio=${ratio}`, `--video_resolution=${resolution}`];
};

const findDownloadedVideo = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await findDownloadedVideo(path);
      if (nested) return nested;
    } else if ([".mp4", ".mov", ".webm", ".mkv"].includes(extname(entry.name).toLowerCase())) {
      return path;
    }
  }
  return "";
};

const legacyStateRoot = () => resolve(process.env.SHENSI_MEDIA_PROVIDER_LEGACY_STATE_ROOT || join(homedir(), ".shensi", "provider-state"));
const stateRoot = () => resolve(process.env.SHENSI_MEDIA_PROVIDER_STATE_ROOT || legacyStateRoot());
const readableStateRoots = () => [...new Set([stateRoot(), legacyStateRoot()].map((path) => path.toLowerCase()))]
  .map((normalized) => [stateRoot(), legacyStateRoot()].find((path) => path.toLowerCase() === normalized));
const idempotencyPath = (key) => join(stateRoot(), "dreamina-video", "idempotency", `${createHash("sha256").update(key).digest("hex")}.json`);
const readableIdempotencyPaths = (key) => readableStateRoots()
  .map((root) => join(root, "dreamina-video", "idempotency", `${createHash("sha256").update(key).digest("hex")}.json`));
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
const lockDuration = (name, fallback, minimum) => {
  const configured = Number(process.env[name]);
  return Math.max(minimum, Number.isFinite(configured) && configured > 0 ? configured : fallback);
};
const IDEMPOTENCY_LOCK_STALE_MS = lockDuration("SHENSI_DREAMINA_IDEMPOTENCY_LOCK_STALE_MS", 15_000, 250);
const IDEMPOTENCY_LOCK_WAIT_MS = lockDuration("SHENSI_DREAMINA_IDEMPOTENCY_LOCK_WAIT_MS", 30_000, 250);
const IDEMPOTENCY_LOCK_POLL_MS = lockDuration("SHENSI_DREAMINA_IDEMPOTENCY_LOCK_POLL_MS", 100, 25);
const IDEMPOTENCY_LOCK_HEARTBEAT_MS = Math.min(
  Math.max(25, Math.floor(IDEMPOTENCY_LOCK_STALE_MS / 3)),
  lockDuration("SHENSI_DREAMINA_IDEMPOTENCY_LOCK_HEARTBEAT_MS", 2_000, 25),
);

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

const LONG_VIDEO_PROVIDER_PREFIX = "shensi-long-";
const longVideoCompositeRoot = (providerTaskId) => join(stateRoot(), "dreamina-video", "long-video", providerTaskId);
const longVideoCompositeManifestPath = (providerTaskId) => join(longVideoCompositeRoot(providerTaskId), "manifest.json");

const bridgeOperation = (bridgeOperationName, args = [], timeoutMs = 10 * 60_000) => new Promise((resolveBridge, rejectBridge) => {
  const child = spawn(process.execPath, [resolve(process.argv[1]), bridgeOperationName, ...args], {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.once("error", (error) => {
    clearTimeout(timer);
    rejectBridge(error);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    if (code !== 0) return rejectBridge(new Error(stderr.trim() || stdout.trim() || `即梦分段任务退出码 ${code}`));
    resolveBridge(parsePayload(stdout));
  });
});

const segmentedLongVideoResult = (manifest, extra = {}) => ({
  providerTaskId: manifest.providerTaskId,
  providerStatus: manifest.providerStatus,
  rawStatus: manifest.rawStatus || manifest.providerStatus,
  progressPercent: Math.min(100, Math.round((manifest.segments.filter((segment) => segment.status === "completed").reduce((sum, segment) => sum + segment.duration, 0) / manifest.totalDuration) * 100)),
  segmented: true,
  segmentCount: manifest.segments.length,
  completedSegments: manifest.segments.filter((segment) => segment.status === "completed").length,
  totalDuration: manifest.totalDuration,
  strategy: "segmented_concat",
  ...extra,
});

const submitSegmentedLongVideoPart = async (manifest, segmentIndex) => {
  const segment = manifest.segments[segmentIndex];
  if (!segment || segment.providerTaskId) return segment;
  const root = longVideoCompositeRoot(manifest.providerTaskId);
  const promptFile = join(root, `segment-${segmentIndex + 1}.txt`);
  await writeFile(promptFile, segment.prompt, "utf8");
  const submitted = await bridgeOperation("submit", [
    "--prompt-file", promptFile,
    "--model", manifest.model,
    "--aspect-ratio", manifest.aspectRatio,
    "--duration", String(segment.duration),
    "--resolution", manifest.resolution,
    "--mode", "smart_params",
    "--idempotency-key", segment.idempotencyKey,
  ], 180_000);
  segment.providerTaskId = submitted.providerTaskId;
  segment.status = submitted.providerStatus || "running";
  segment.submittedAt = new Date().toISOString();
  manifest.providerStatus = segment.status === "failed" ? "failed" : "running";
  manifest.rawStatus = `segment_${segmentIndex + 1}_${segment.status}`;
  await atomicJson(longVideoCompositeManifestPath(manifest.providerTaskId), manifest);
  return segment;
};

const submitSegmentedLongVideo = async ({ command, idempotencyKey }) => {
  const [, prompt, model, durationValue, aspectRatio, resolution] = command;
  const totalDuration = Number(durationValue);
  const providerTaskId = `${LONG_VIDEO_PROVIDER_PREFIX}${createHash("sha256").update(`${idempotencyKey}|${prompt}|${model}|${totalDuration}|${aspectRatio}|${resolution}`).digest("hex").slice(0, 24)}`;
  const manifestPath = longVideoCompositeManifestPath(providerTaskId);
  const existing = await readJson(manifestPath);
  if (existing?.providerTaskId) return segmentedLongVideoResult(existing, { idempotentReplay: true });
  const segments = planSegmentedLongVideo({ duration: totalDuration, prompt }).map((segment) => ({
    ...segment,
    status: "queued",
    providerTaskId: "",
    downloadedPath: "",
    idempotencyKey: `${idempotencyKey || providerTaskId}:segment:${segment.index + 1}`,
  }));
  const manifest = {
    schemaVersion: 1,
    providerTaskId,
    providerStatus: "queued",
    rawStatus: "segment_1_queued",
    strategy: "segmented_concat",
    model,
    aspectRatio,
    resolution,
    totalDuration,
    segments,
    createdAt: new Date().toISOString(),
    combinedPath: "",
  };
  await mkdir(longVideoCompositeRoot(providerTaskId), { recursive: true });
  await atomicJson(manifestPath, manifest);
  await submitSegmentedLongVideoPart(manifest, 0);
  return segmentedLongVideoResult(manifest);
};

const runFfmpegConcat = async (paths, outputPath) => {
  const listPath = join(dirname(outputPath), "concat.txt");
  const quote = (value) => String(value).replace(/'/g, "'\\''");
  await writeFile(listPath, paths.map((path) => `file '${quote(resolve(path)).replace(/\\/g, "/")}'`).join("\n"), "utf8");
  const run = (args) => new Promise((resolveRun, rejectRun) => {
    const child = spawn(ffmpegExecutable(), args, { windowsHide: true, shell: false, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (code) => code === 0 ? resolveRun() : rejectRun(new Error(stderr.slice(-2000) || `FFmpeg 退出码 ${code}`)));
  });
  await rm(outputPath, { force: true });
  try {
    await run(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", "-movflags", "+faststart", "-y", outputPath]);
  } catch {
    await run(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath, "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-c:a", "aac", "-movflags", "+faststart", "-y", outputPath]);
  }
  const metadata = await stat(outputPath);
  if (!metadata.isFile() || metadata.size <= 0) throw new Error("超长视频拼接没有生成有效文件");
  return outputPath;
};

const querySegmentedLongVideo = async ({ providerTaskId, download = false, output = "" } = {}) => {
  const manifestPath = longVideoCompositeManifestPath(providerTaskId);
  const manifest = await readJson(manifestPath);
  if (!manifest?.providerTaskId) throw new Error("超长视频编排记录不存在或已损坏");
  if (manifest.providerStatus === "cancelled" || manifest.providerStatus === "failed") return segmentedLongVideoResult(manifest, { error: manifest.error || "" });
  const root = longVideoCompositeRoot(providerTaskId);
  const current = manifest.segments.find((segment) => segment.status !== "completed");
  if (current) {
    if (!current.providerTaskId) await submitSegmentedLongVideoPart(manifest, current.index);
    const segmentDownloadDirectory = join(root, `segment-${current.index + 1}-download`);
    const status = await bridgeOperation("status", [
      "--provider-task-id", current.providerTaskId,
      "--idempotency-key", current.idempotencyKey,
      "--download-dir", segmentDownloadDirectory,
    ], 180_000);
    current.status = status.providerStatus || "running";
    current.rawStatus = status.rawStatus || current.status;
    if (current.status === "failed" || current.status === "cancelled") {
      manifest.providerStatus = current.status;
      manifest.rawStatus = `segment_${current.index + 1}_${current.status}`;
      manifest.error = status.error || `第 ${current.index + 1} 段生成失败`;
      await atomicJson(manifestPath, manifest);
      return segmentedLongVideoResult(manifest, { error: manifest.error });
    }
    if (current.status === "completed") {
      let downloadedPath = status.downloadedPath || "";
      if (!downloadedPath) {
        const segmentOutput = join(root, `segment-${current.index + 1}.mp4`);
        const downloaded = await bridgeOperation("download", [
          "--provider-task-id", current.providerTaskId,
          "--idempotency-key", current.idempotencyKey,
          "--download-dir", segmentDownloadDirectory,
          "--output", segmentOutput,
        ]);
        downloadedPath = downloaded.path || downloaded.downloadedPath || segmentOutput;
      }
      current.downloadedPath = downloadedPath;
      current.completedAt = new Date().toISOString();
      const next = manifest.segments.find((segment) => segment.status !== "completed");
      if (next) await submitSegmentedLongVideoPart(manifest, next.index);
    }
  }
  if (manifest.segments.every((segment) => segment.status === "completed" && segment.downloadedPath)) {
    const combinedPath = manifest.combinedPath || join(root, "combined.mp4");
    if (!manifest.combinedPath || !(await stat(combinedPath).catch(() => null))?.size) {
      await runFfmpegConcat(manifest.segments.map((segment) => segment.downloadedPath), combinedPath);
    }
    manifest.combinedPath = combinedPath;
    manifest.providerStatus = "completed";
    manifest.rawStatus = "segments_concatenated";
    manifest.completedAt = new Date().toISOString();
  } else if (!['failed', 'cancelled'].includes(manifest.providerStatus)) {
    manifest.providerStatus = "running";
    const active = manifest.segments.find((segment) => segment.status !== "completed");
    manifest.rawStatus = `segment_${(active?.index ?? 0) + 1}_${active?.status || "queued"}`;
  }
  await atomicJson(manifestPath, manifest);
  const result = segmentedLongVideoResult(manifest, { downloadedPath: manifest.combinedPath || "" });
  if (download && manifest.providerStatus === "completed") {
    if (!output) throw new Error("超长视频下载缺少 --output");
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(manifest.combinedPath, target);
    result.path = target;
  }
  return result;
};

const readExistingIdempotency = async (key) => {
  for (const path of readableIdempotencyPaths(key)) {
    const existing = await readJson(path);
    // Error 1310 is an explicit no-capacity rejection, not a billable task.
    // Replaying it forever would make a safe retry impossible even after a
    // provider slot becomes available.
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
  }
  return null;
};

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
};

const readLockOwner = (lockPath) => readJson(join(lockPath, "owner.json"));

const releaseOwnedLock = async ({ lockPath, token, stopHeartbeat }) => {
  await stopHeartbeat();
  const owner = await readLockOwner(lockPath).catch(() => null);
  if (owner?.token !== token) return;
  const releasedPath = `${lockPath}.${process.pid}.${randomUUID()}.released`;
  try {
    await rename(lockPath, releasedPath);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  const movedOwner = await readLockOwner(releasedPath).catch(() => null);
  if (movedOwner?.token === token) {
    await rm(releasedPath, { recursive: true, force: true });
    return;
  }
  await rename(releasedPath, lockPath).catch(() => {});
};

const acquireIdempotencyLock = async ({ lockPath, journalPath }) => {
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + IDEMPOTENCY_LOCK_WAIT_MS;
  await mkdir(dirname(lockPath), { recursive: true });
  while (Date.now() < deadline) {
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readJson(journalPath);
      if (existing?.providerTaskId) return { existing };
      const [owner, heartbeatMetadata, lockMetadata] = await Promise.all([
        readLockOwner(lockPath).catch(() => null),
        stat(join(lockPath, "heartbeat.json")).catch(() => null),
        stat(lockPath).catch(() => null),
      ]);
      const activityMetadata = heartbeatMetadata || lockMetadata;
      const stale = Boolean(activityMetadata && Date.now() - activityMetadata.mtimeMs > IDEMPOTENCY_LOCK_STALE_MS);
      if (stale && (!owner || !processIsAlive(Number(owner.pid)))) {
        const abandonedPath = `${lockPath}.${process.pid}.${randomUUID()}.abandoned`;
        try {
          await rename(lockPath, abandonedPath);
          await rm(abandonedPath, { recursive: true, force: true });
          continue;
        } catch (recoveryError) {
          if (!["ENOENT", "EEXIST", "EPERM"].includes(recoveryError.code)) throw recoveryError;
        }
      }
      await sleep(IDEMPOTENCY_LOCK_POLL_MS);
      continue;
    }

    try {
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: process.pid, token, acquiredAt: new Date().toISOString() }),
        { encoding: "utf8", flag: "wx" },
      );
      let stopped = false;
      let heartbeatPromise = Promise.resolve();
      const heartbeat = async () => {
        if (stopped) return;
        const owner = await readLockOwner(lockPath);
        if (owner?.token !== token) return;
        await writeFile(join(lockPath, "heartbeat.json"), JSON.stringify({ token, at: new Date().toISOString() }), "utf8");
      };
      await heartbeat();
      const timer = setInterval(() => {
        heartbeatPromise = heartbeatPromise.then(heartbeat, heartbeat).catch(() => {});
      }, IDEMPOTENCY_LOCK_HEARTBEAT_MS);
      timer.unref?.();
      const stopHeartbeat = async () => {
        stopped = true;
        clearInterval(timer);
        await heartbeatPromise.catch(() => {});
      };
      return {
        release: () => releaseOwnedLock({ lockPath, token, stopHeartbeat }),
      };
    } catch (error) {
      const owner = await readLockOwner(lockPath).catch(() => null);
      if (!owner || owner.token === token) await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
  }
  return {};
};

const publicPayload = (payload, fallbackId = "", options = {}) => {
  const status = normalizedStatus(payload, options);
  const queue = queueInfo(payload);
  const rawError = status === "failed" ? rawFailureReason(payload) : "";
  const capacityLimited = status === "failed" && concurrencyLimited(`${rawError} ${failureCode(payload)}`);
  const providerTaskId = submitId(payload) || fallbackId;
  const providerTaskAuthFailure = status === "failed" && Boolean(providerTaskId) && isDreaminaAuthRequiredResponse(rawError);
  const providerSessionExpired = status === "failed" && !providerTaskId && isDreaminaAuthRequiredResponse(rawError);
  const errorCode = capacityLimited
    ? "DREAMINA_CONCURRENCY_LIMIT"
    : providerTaskAuthFailure
      ? "DREAMINA_PROVIDER_TASK_AUTH_FAILURE"
    : providerSessionExpired
      ? "DREAMINA_PROVIDER_SESSION_EXPIRED"
      : status === "failed" ? failureCode(payload) : status === "unknown" ? "DREAMINA_UNKNOWN_STATUS" : "";
  const failure = status === "failed" || status === "unknown"
    ? dreaminaFailureDiagnosis({ code: errorCode, message: rawError, providerTaskId })
    : null;
  return {
    providerTaskId,
    providerStatus: status,
    rawStatus: rawStatus(payload),
    error: status === "failed"
      ? friendlyFailureReason(rawError)
      : status === "unknown" ? `Dreamina CLI 返回无法识别的任务状态：${rawStatus(payload) || "空状态"}` : "",
    errorCode,
    ...(failure ? {
      failureCategory: failure.category,
      failureReason: failure.cause,
      failureResolution: failure.resolution,
    } : {}),
    capacityLimited,
    retryAfterMs: capacityLimited ? 60_000 : 0,
    resultUrl: resultUrl(payload),
    resultUrlExpiresAt: resultUrlExpiresAt(payload),
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
  if (!payloadHasFailureStatusWithoutTaskId(payload)
    || submitId(payload)
    || !isDreaminaAuthRequiredResponse(JSON.stringify(payload))) return null;
  const error = new Error("即梦当前配置的任务资源会话未登录，收费任务尚未提交；请核验该配置后重试");
  error.code = "DREAMINA_AUTH_REQUIRED";
  error.submissionOutcomeKnown = true;
  return error;
};

const listTasks = async ({ submitIdFilter = "", limit = 100 } = {}) => {
  const args = ["list_task", `--limit=${Math.max(1, Math.min(200, Number(limit) || 100))}`];
  if (submitIdFilter) args.push(`--submit_id=${submitIdFilter}`);
  const output = (await runCli(args)).stdout;
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
  try {
    await listTasks({ limit: 1 });
    return { taskResourceChecked: true, taskResourceDeferred: false };
  } catch (error) {
    if (String(error?.code || "").toUpperCase() === "DREAMINA_AUTH_REQUIRED" && cachedDreaminaAccountIdentity()) {
      return {
        taskResourceChecked: false,
        taskResourceDeferred: true,
        taskResourceWarning: "即梦任务资源只读会话暂时报告未登录；保留已核验身份并由本次真实视频提交确认",
      };
    }
    throw error;
  }
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
  const prepared = idempotencyKey ? await readJson(idempotencyPath(idempotencyKey)) : null;
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
  const journalPath = idempotencyKey ? idempotencyPath(idempotencyKey) : "";
  if (journalPath) {
    const existing = await readExistingIdempotency(idempotencyKey);
    if (existing?.providerTaskId) return { ...existing, idempotentReplay: true };
  }
  const lockPath = journalPath ? `${journalPath}.lock` : "";
  let releaseLock = null;
  if (lockPath) {
    const acquired = await acquireIdempotencyLock({ lockPath, journalPath });
    if (acquired.existing?.providerTaskId) return { ...acquired.existing, idempotentReplay: true };
    if (!acquired.release) throw new Error("Dreamina 同一幂等任务仍在提交，请稍后查询");
    releaseLock = acquired.release;
  }
  try {
    if (journalPath) {
      const existing = await readExistingIdempotency(idempotencyKey);
      if (existing?.providerTaskId) return { ...existing, idempotentReplay: true };
    }
    const command = await generationCommand();
    const promptPath = option("--prompt-file");
    const prompt = promptPath ? await readFile(promptPath, "utf8") : option("--prompt");
    const prepared = journalPath ? await readJson(journalPath) : null;
    if (prepared?.preparedAt) {
      const recovered = await reconcileSubmission();
      if (recovered.providerTaskId) return { ...recovered, idempotentReplay: true };
    }
    if (journalPath && !prepared?.preparedAt) {
      await atomicJson(journalPath, {
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
      const cliResult = await runGenerationSubmitCli(command);
      payload = parsePayload([cliResult.stdout || "", cliResult.stderr || ""].filter(Boolean).join("\n"));
      if (!submitId(payload) && cliResult.providerTaskId) {
        payload = { ...payload, submit_id: normalizeDreaminaTaskId(cliResult.providerTaskId) };
      }
    } catch (error) {
      if (error?.submissionOutcomeKnown === true) {
        if (journalPath) await rm(journalPath, { force: true }).catch(() => {});
        throw error;
      }
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
    if (!result.providerTaskId) {
      const error = new Error("Dreamina CLI 未返回 submit_id，无法确认本次提交是否已经创建厂商任务");
      error.code = "DREAMINA_SUBMISSION_UNCERTAIN";
      error.submissionOutcomeKnown = false;
      throw error;
    }
    if (result.errorCode === "DREAMINA_PROVIDER_SESSION_EXPIRED") {
      // The paid task may already exist. Preserve its exact ID and switch to
      // query-only recovery; retrying the generation command could double bill.
      const { failureCategory, failureReason, failureResolution, ...pending } = result;
      result = {
        ...pending,
        providerStatus: "running",
        rawStatus: "session_restore_pending",
        error: "",
        errorCode: "DREAMINA_PROVIDER_SESSION_RESTORE_PENDING",
      };
    }
    // A capacity rejection is known not to have created a paid project. Do not
    // freeze it into the idempotency journal; the worker may safely try the
    // same logical request again after a provider slot becomes available.
    if (journalPath && result.capacityLimited) await rm(journalPath, { force: true });
    else if (journalPath) await atomicJson(journalPath, result);
    return result;
  } finally {
    if (releaseLock) await releaseLock();
  }
};

const query = async ({ download = false, providerTaskId = "" } = {}) => {
  const id = String(providerTaskId || option("--provider-task-id") || option("--submit-id")).trim();
  if (!id) throw new Error("Dreamina 查询缺少 provider task ID");
  const idempotencyKey = String(option("--idempotency-key") || "").trim();
  const output = option("--output");
  const forceRedownload = hasFlag("--force-redownload");
  const downloadDirectory = resolve(option("--download-dir") || (output ? join(dirname(resolve(output)), "dreamina-downloads", id) : join(stateRoot(), "dreamina-video", "downloads", id)));
  if (forceRedownload) await rm(downloadDirectory, { recursive: true, force: true });
  await mkdir(downloadDirectory, { recursive: true });
  const cachedDirectories = [...new Set([
    downloadDirectory,
    ...readableStateRoots().map((root) => join(root, "dreamina-video", "downloads", id)),
  ].map((path) => path.toLowerCase()))]
    .map((normalized) => [downloadDirectory, ...readableStateRoots().map((root) => join(root, "dreamina-video", "downloads", id))]
      .find((path) => path.toLowerCase() === normalized));
  for (const directory of forceRedownload ? [] : cachedDirectories) {
    const downloadedPath = await findDownloadedVideo(directory);
    if (!downloadedPath) continue;
    const result = { providerTaskId: id, providerStatus: "completed", rawStatus: "cached", downloadedPath };
    if (download) {
      if (!output) throw new Error("Dreamina 下载缺少 --output");
      const target = resolve(output);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(downloadedPath, target);
      result.path = target;
    }
    return result;
  }
  // A failed/cancelled submit response is stronger evidence than a later
  // `query_result` response. Dreamina can retain a local submit record and
  // keep returning `querying` even though the paid backend project was never
  // created. Replaying the durable terminal receipt prevents infinite polling.
  if (idempotencyKey) {
    const submitted = await readExistingIdempotency(idempotencyKey);
    if (submitted?.providerTaskId === id
      && ["failed", "cancelled"].includes(submitted.providerStatus)
      && !(submitted.providerStatus === "failed" && concurrencyLimited(submitted.error || submitted.errorCode))) {
      return {
        ...submitted,
        providerTaskId: id,
        ...(submitted.providerStatus === "failed" ? { error: friendlyFailureReason(submitted.error) } : {}),
        idempotentReplay: true,
        downloadedPath: "",
      };
    }
  }
  let payload;
  try {
    payload = parsePayload((await runCli(["query_result", `--submit_id=${id}`, `--download_dir=${downloadDirectory}`])).stdout);
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
        || (queriedStatus === "unknown" && ["queued", "running"].includes(listedStatus))) {
        payload = listed;
      }
    }
  }
  const downloadedPath = await findDownloadedVideo(downloadDirectory);
  // The requested provider task ID is the durable task identity. Query output
  // may contain nested asset IDs or a stale submit_id; neither may retarget the
  // local job to a different (and potentially billable) provider task.
  const result = { ...publicPayload(payload, id), providerTaskId: id, downloadedPath };
  if (download && result.providerStatus === "completed") {
    if (!downloadedPath) throw Object.assign(new Error(`Dreamina 视频任务 ${id} 已完成，但未返回可下载文件`), { code: "DREAMINA_RESULT_PENDING" });
    if (!output) throw new Error("Dreamina 下载缺少 --output");
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(downloadedPath, target);
    result.path = target;
  }
  return result;
};

const cancel = async () => {
  const id = String(option("--provider-task-id") || option("--submit-id")).trim();
  if (!id) throw new Error("Dreamina 取消缺少 provider task ID");
  const configuredCommand = String(process.env.SHENSI_DREAMINA_CANCEL_COMMAND || "").trim();
  let command = configuredCommand;
  if (!command) {
    const help = await runCli(["--help"]).catch(() => ({ stdout: "" }));
    const advertised = String(help.stdout || "").match(/^\s*(cancel_task|cancel|task_cancel)\s/m);
    command = advertised?.[1] || "";
  }
  if (!command) {
    const observed = await query({ providerTaskId: id });
    return {
      ...observed,
      cancellationUnsupported: true,
      cancellationMessage: "当前即梦 CLI 不支持取消厂商任务；神思将继续跟踪原任务，避免丢失已提交的结果。",
    };
  }
  const payload = parsePayload((await runCli([command, `--submit_id=${id}`])).stdout);
  // Missing cancellation status means only that cancellation was requested;
  // it must not be presented as a confirmed terminal cancellation.
  return publicPayload(payload, id, { missingStatus: "running" });
};

const pollIntervalMs = Math.max(10, Number(process.env.SHENSI_DREAMINA_POLL_INTERVAL_MS) || 2000);

const runToCompletion = async () => {
  const outputOption = option("--output");
  if (!outputOption) throw new Error("Dreamina 运行缺少 --output");
  const output = resolve(outputOption);
  const submitted = await submit();
  // A 180-second result is composed from up to six provider jobs. Each part
  // can legitimately queue for several minutes, so the direct-run bridge must
  // not terminate a healthy composite at the old single-job 30-minute limit.
  const deadline = Date.now() + (submitted.segmented ? 2 * 60 * 60_000 : 30 * 60_000);
  while (Date.now() < deadline) {
    const status = await query({ providerTaskId: submitted.providerTaskId });
    if (status.providerStatus === "failed") throw new Error(status.error || "Dreamina 视频任务失败");
    if (status.providerStatus === "cancelled") throw new Error("Dreamina 视频任务已取消");
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
  throw new Error(`Dreamina 视频任务 ${submitted.providerTaskId} 在 30 分钟内未完成`);
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
    const connectionCachePath = join(stateRoot(), "dreamina-video", "connection-check.json");
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
    const version = parsePayload((await runCli(["version"])).stdout);
    const account = await verifiedDreaminaAccount();
    // A valid account/credit response is not sufficient for a paid video
    // submission. Verify the separate task resource session before reporting
    // this profile as generation-ready.
    const taskResource = await ensureDreaminaTaskStoreSession();
    const capabilities = await detectDreaminaVideoCapabilities({ version });
    const result = { ok: true, version, credit: account.credit.total_credit, vipLevel: account.credit.vip_level || "", userId: account.identity.userId, profileId: account.identity.profileId, credentialFingerprint: String(process.env.SHENSI_DREAMINA_CREDENTIAL_FINGERPRINT || ""), controlPlaneDeferred: account.controlPlaneDeferred === true, taskResourceChecked: taskResource.taskResourceChecked === true, taskResourceDeferred: taskResource.taskResourceDeferred === true, taskResourceWarning: taskResource.taskResourceWarning || "", generationReady: taskResource.taskResourceChecked === true || taskResource.taskResourceDeferred === true, capabilities };
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

main().catch(async (error) => {
  if (operation === "download") {
    const output = option("--output");
    if (output) await rm(resolve(output), { force: true }).catch(() => {});
  }
  const code = error.code || (["status", "download"].includes(operation) ? "DREAMINA_QUERY_TRANSIENT" : "");
  const noTaskMarker = error.preSubmitNoTask === true ? "[DREAMINA_PRE_SUBMIT_NO_TASK] " : "";
  process.stderr.write(`${noTaskMarker}${code ? `[${code}] ` : ""}${error.message}\n`);
  process.exitCode = 1;
});
