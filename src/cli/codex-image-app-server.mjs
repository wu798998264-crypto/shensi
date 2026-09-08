import { access, readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnLocalCodexAppServer } from "./codex-launch.mjs";

const MAX_IMAGE_BYTES = 50 * 1024 * 1024;

export const resolveCodexImagegenSkillPath = async ({
  environment = process.env,
  homeDirectory = homedir(),
  accessFile = access,
} = {}) => {
  const codexHome = resolve(String(environment.CODEX_HOME || join(homeDirectory, ".codex")));
  const candidates = [
    String(environment.SHENSI_OPENAI_IMAGE_SKILL_PATH || "").trim(),
    join(codexHome, "skills", ".system", "imagegen", "SKILL.md"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const path = resolve(candidate);
    try {
      await accessFile(path);
      return path;
    } catch {}
  }
  throw Object.assign(new Error("当前 Codex 没有安装可用的 imagegen 系统 Skill"), {
    code: "OPENAI_IMAGE_SKILL_MISSING",
    submissionOutcomeKnown: true,
  });
};

const imageBufferFromValue = (value) => {
  if (!value) return null;
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") {
    const source = value.trim();
    const match = source.match(/^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=_-]+)$/i);
    const encoded = match?.[1] || (/^[A-Za-z0-9+/=_-]+$/.test(source) ? source : "");
    if (!encoded) return null;
    try { return Buffer.from(encoded, encoded.includes("-") || encoded.includes("_") ? "base64url" : "base64"); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const buffer = imageBufferFromValue(item);
      if (buffer) return buffer;
    }
    return null;
  }
  if (typeof value === "object") {
    for (const key of ["data", "result", "output", "image", "imageData", "image_url", "imageUrl", "content"]) {
      const buffer = imageBufferFromValue(value[key]);
      if (buffer) return buffer;
    }
  }
  return null;
};

const imageType = (bytes) => {
  if (!bytes || bytes.length < 12 || bytes.length > MAX_IMAGE_BYTES) return "";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) return "jpg";
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "";
};

export const decodeCodexImageResult = (value) => {
  const bytes = imageBufferFromValue(value);
  const extension = imageType(bytes);
  if (!extension) throw Object.assign(new Error("Codex 图片工具返回了不可识别或超过 50MB 的图片数据"), { code: "OPENAI_IMAGE_INVALID_RESULT", submissionOutcomeKnown: true });
  return { bytes, extension };
};

const decodeCodexSavedImage = async (savedPath) => {
  const path = String(savedPath || "").trim();
  if (!isAbsolute(path)) throw Object.assign(new Error("Codex 图片工具返回了非绝对本地文件路径"), { code: "OPENAI_IMAGE_INVALID_RESULT", submissionOutcomeKnown: true });
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.size <= 0 || metadata.size > MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("Codex 图片工具返回的本地文件不存在、为空或超过 50MB"), { code: "OPENAI_IMAGE_INVALID_RESULT", submissionOutcomeKnown: true });
  }
  const bytes = await readFile(path);
  const extension = imageType(bytes);
  if (!extension) throw Object.assign(new Error("Codex 图片工具返回的本地文件不是受支持的真实图片"), { code: "OPENAI_IMAGE_INVALID_RESULT", submissionOutcomeKnown: true });
  return { bytes, extension, savedPath: path };
};

export const decodeCodexImageItem = async (item = {}) => {
  let resultError = null;
  if (item.result !== undefined && item.result !== null && item.result !== "") {
    try {
      return decodeCodexImageResult(item.result);
    } catch (error) {
      resultError = error;
    }
  }
  if (String(item.savedPath || "").trim()) return decodeCodexSavedImage(item.savedPath);
  if (resultError) throw resultError;
  return decodeCodexImageResult(item.output);
};

const safeError = (value) => {
  if (!value) return "";
  if (typeof value === "string") return value.slice(0, 2_000);
  return String(value.message || value.error || JSON.stringify(value)).slice(0, 2_000);
};

export const runCodexImageAppServer = async ({
  cwd = process.cwd(),
  model = "",
  prompt = "",
  imageCount = 1,
  timeoutMs = 600_000,
  onThread = null,
  onImage = null,
  launchServer = spawnLocalCodexAppServer,
  resolveImagegenSkill = resolveCodexImagegenSkillPath,
} = {}) => {
  const expectedCount = Math.max(1, Math.min(4, Number(imageCount) || 1));
  const { child } = await launchServer({ cwd, env: process.env, isolateConfig: true });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map();
  const images = [];
  const toolErrors = [];
  const agentMessages = [];
  const protocolEvents = [];
  let requestId = 0;
  let stderrTail = "";
  let settled = false;
  let imageQueue = Promise.resolve();
  let abortCompletion = null;

  const stop = () => {
    lines.close();
    if (child.exitCode === null && !child.killed) child.kill();
  };
  const request = (method, params, requestTimeoutMs = 30_000) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`${method} 请求超时`));
    }, requestTimeoutMs);
    pending.set(id, { method, timer, resolve: resolveRequest, reject: rejectRequest });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, "utf8");
  });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ method, params })}\n`, "utf8");

  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    const finish = async (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimer);
      try { await imageQueue; } catch (imageError) { error ||= imageError; }
      stop();
      if (error) rejectCompletion(error);
      else if (images.length < expectedCount) {
        const noImageToolResult = !toolErrors.length && !agentMessages.length && protocolEvents.includes("turn/completed");
        rejectCompletion(Object.assign(new Error(
          toolErrors.at(-1)
            || agentMessages.at(-1)
            || (noImageToolResult
              ? "Codex 当前会话已结束，但没有调用图片生成工具，也没有返回图片文件；本次未提交生图任务"
              : `Codex 图片工具只返回 ${images.length}/${expectedCount} 张图片`),
        ), {
          code: noImageToolResult ? "OPENAI_IMAGE_TOOL_NOT_INVOKED" : "OPENAI_IMAGE_INCOMPLETE_RESULT",
          submissionOutcomeKnown: true,
        }));
      } else resolveCompletion(images.slice(0, expectedCount));
    };
    abortCompletion = finish;
    const overallTimer = setTimeout(() => finish(Object.assign(new Error("Codex GPT 生图超时"), {
      code: "OPENAI_IMAGE_APP_SERVER_TIMEOUT",
      submissionOutcomeKnown: false,
    })), Math.max(60_000, Number(timeoutMs) || 600_000));

    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method) {
        const itemType = String(message.params?.item?.type || "").trim();
        const itemStatus = String(message.params?.item?.status || "").trim();
        protocolEvents.push(`${message.method}${itemType ? `:${itemType}` : ""}${itemStatus ? `:${itemStatus}` : ""}`);
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(safeError(message.error)));
        else entry.resolve(message.result);
        return;
      }
      if (message.id !== undefined && message.method) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "GPT Image 专用会话不支持该交互" } })}\n`, "utf8");
        return;
      }
      const item = message.params?.item;
      if (message.method === "item/completed" && item?.type === "agentMessage") {
        const text = safeError(item.text);
        if (text) agentMessages.push(text);
        return;
      }
      if (message.method === "item/completed" && item?.type === "imageGeneration") {
        if (String(item.status || "").toLowerCase() === "failed" || item.error) {
          toolErrors.push(safeError(item.error || item.result || "Codex 图片工具执行失败"));
          return;
        }
        imageQueue = imageQueue.then(async () => {
          const decoded = await decodeCodexImageItem(item);
          const index = images.length;
          const stored = await onImage?.({ ...decoded, index, itemId: String(item.id || "") });
          images.push({ ...decoded, index, itemId: String(item.id || ""), ...(stored && typeof stored === "object" ? stored : {}) });
        });
        return;
      }
      if (message.method === "turn/failed") {
        void finish(Object.assign(new Error(safeError(message.params?.error) || "Codex GPT 生图失败"), {
          code: "OPENAI_IMAGE_TURN_FAILED",
          submissionOutcomeKnown: images.length > 0,
        }));
        return;
      }
      if (message.method === "turn/completed") void finish();
    });
    child.stderr.on("data", (chunk) => { stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-8_000); });
    child.once("error", (error) => void finish(Object.assign(new Error(`Codex app-server 无法启动：${error.message}`), { code: error.code || "OPENAI_IMAGE_APP_SERVER_START_FAILED", submissionOutcomeKnown: true })));
    child.once("exit", (code, signal) => {
      if (!settled) void finish(Object.assign(new Error(`Codex app-server 已退出（${signal || code}）${stderrTail ? `：${stderrTail.slice(-1_000)}` : ""}`), {
        code: "OPENAI_IMAGE_APP_SERVER_EXITED",
        submissionOutcomeKnown: images.length > 0,
      }));
    });
  });

  try {
    await request("initialize", {
      clientInfo: { name: "shensi-gpt-image", title: "神思 GPT Image", version: "2.19.5" },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    }, 15_000);
    notify("initialized", {});
    const account = await request("account/read", { refreshToken: false }, 15_000);
    if (!account?.account) throw Object.assign(new Error("Codex 当前没有有效的 ChatGPT 登录账号"), { code: "MISSING_CREDENTIALS", submissionOutcomeKnown: true });
    const providerCapabilities = await request("modelProvider/capabilities/read", {}, 15_000);
    if (providerCapabilities?.imageGeneration !== true) {
      throw Object.assign(new Error("当前 Codex app-server 会话没有开放图片生成能力"), {
        code: "OPENAI_IMAGE_CAPABILITY_UNAVAILABLE",
        submissionOutcomeKnown: true,
      });
    }
    const imagegenSkillPath = await resolveImagegenSkill();
    const started = await request("thread/start", {
      cwd,
      ...(model ? { model } : {}),
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      developerInstructions: "Generate the requested image by calling the native image generation tool exactly as many times as requested. Do not call any other tool. Return only image results.",
      ephemeral: true,
    }, 30_000);
    const threadId = String(started?.thread?.id || "");
    if (!threadId) throw new Error("Codex app-server 未返回生图会话 ID");
    await onThread?.({ threadId, account: account.account });
    const turn = await request("turn/start", {
      threadId,
      input: [
        { type: "skill", name: "imagegen", path: imagegenSkillPath },
        { type: "text", text: String(prompt || ""), text_elements: [] },
      ],
      cwd,
      runtimeWorkspaceRoots: [cwd],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(model ? { model } : {}),
    }, 30_000);
    if (!turn?.turn?.id) throw new Error("Codex app-server 未返回生图任务 ID");
  } catch (error) {
    void abortCompletion?.(error);
  }
  return completion;
};
