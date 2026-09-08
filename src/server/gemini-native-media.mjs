import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

const GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_ROOT = "https://generativelanguage.googleapis.com/upload/v1beta";
const FILE_CACHE_TTL_MS = 44 * 60 * 60 * 1000;
const fileUriCache = new Map();

const wait = (milliseconds, signal) => new Promise((resolveWait, rejectWait) => {
  const timer = setTimeout(resolveWait, milliseconds);
  if (!signal) return;
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    rejectWait(signal.reason instanceof Error ? signal.reason : new Error("Gemini 文件处理已取消"));
  }, { once: true });
});

const geminiJson = async (response, label) => {
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch {}
  if (!response.ok) throw new Error(payload.error?.message || payload.message || `${label}失败（HTTP ${response.status}）`);
  return payload;
};

const fileFingerprint = async (path, signal) => {
  const metadata = await stat(path);
  if (!metadata.isFile() || !metadata.size) throw new Error("Gemini 原生媒体文件为空");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Gemini 文件读取已取消");
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), size: metadata.size, mtimeMs: metadata.mtimeMs };
};

const cachedGeminiFile = ({ sha256, size, mtimeMs }) => {
  const cached = fileUriCache.get(sha256);
  if (!cached || cached.size !== size || cached.mtimeMs !== mtimeMs || cached.expiresAt <= Date.now()) return null;
  return cached.file;
};

const uploadGeminiFile = async ({ settings, attachment, signal }) => {
  if (!settings.apiKey) throw new Error("Gemini 原生视频输入需要当前会话 API Key");
  if (!attachment.absolutePath) throw new Error(`${attachment.name || "媒体"}缺少本地文件路径`);
  const fingerprint = await fileFingerprint(attachment.absolutePath, signal);
  const cached = cachedGeminiFile(fingerprint);
  if (cached) return { ...cached, cacheHit: true, sha256: fingerprint.sha256 };
  const mimeType = String(attachment.mimeType || "application/octet-stream");
  const start = await fetch(`${GEMINI_UPLOAD_ROOT}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": settings.apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(fingerprint.size),
      "X-Goog-Upload-Header-Content-Type": mimeType,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ file: { display_name: basename(attachment.absolutePath) } }),
    signal,
  });
  if (!start.ok) await geminiJson(start, "Gemini 文件上传初始化");
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini 文件上传没有返回续传地址");
  const uploaded = await geminiJson(await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(fingerprint.size),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
      "Content-Type": mimeType,
    },
    body: createReadStream(attachment.absolutePath),
    duplex: "half",
    signal,
  }), "Gemini 文件上传");
  let file = uploaded.file || uploaded;
  if (!file.name || !file.uri) throw new Error("Gemini 文件上传响应缺少文件名称或 URI");
  const deadline = Date.now() + Math.max(60_000, Number(settings.timeoutMs) || 10 * 60_000);
  while (String(file.state || "").toUpperCase() !== "ACTIVE") {
    const state = String(file.state || "").toUpperCase();
    if (state === "FAILED") throw new Error(file.error?.message || "Gemini 视频处理失败");
    if (Date.now() >= deadline) throw new Error("Gemini 视频在限定时间内未进入 ACTIVE 状态");
    await wait(2_000, signal);
    file = await geminiJson(await fetch(`${GEMINI_API_ROOT}/${String(file.name).replace(/^\//, "")}`, {
      headers: { "x-goog-api-key": settings.apiKey },
      signal,
    }), "Gemini 文件状态查询");
  }
  fileUriCache.set(fingerprint.sha256, {
    file,
    size: fingerprint.size,
    mtimeMs: fingerprint.mtimeMs,
    expiresAt: Date.now() + FILE_CACHE_TTL_MS,
  });
  return { ...file, cacheHit: false, sha256: fingerprint.sha256 };
};

const imagePart = (attachment) => {
  const match = String(attachment.dataUrl || "").match(/^data:([^;]+);base64,(.+)$/s);
  return match ? { inlineData: { mimeType: match[1], data: match[2] } } : null;
};

const geminiContents = async ({ settings, messages, attachments, signal }) => {
  const mediaParts = [];
  const uploadedFiles = [];
  for (const attachment of attachments) {
    if (attachment.text) {
      mediaParts.push({ text: `附件：${attachment.name}\n${attachment.text}` });
      continue;
    }
    if (attachment.mimeType?.startsWith("image/")) {
      const part = imagePart(attachment);
      if (part) mediaParts.push(part);
      continue;
    }
    if (/^(?:video|audio)\//.test(String(attachment.mimeType || ""))) {
      const file = await uploadGeminiFile({ settings, attachment, signal });
      mediaParts.push({ fileData: { mimeType: file.mimeType || attachment.mimeType, fileUri: file.uri } });
      uploadedFiles.push({ name: file.name, uri: file.uri, sha256: file.sha256, cacheHit: file.cacheHit });
    }
  }
  const filtered = messages.filter((message) => ["user", "assistant"].includes(message.role));
  const contents = filtered.map((message, index) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [
      { text: String(message.content || "") },
      ...(message.role === "user" && index === filtered.length - 1 ? mediaParts : []),
    ],
  }));
  return { contents, uploadedFiles };
};

export const runGeminiNativeMedia = async ({ settings, messages, system, attachments = [], signal }) => {
  const { contents, uploadedFiles } = await geminiContents({ settings, messages, attachments, signal });
  const generationConfig = { maxOutputTokens: Number(settings.maxOutputTokens) || 4000 };
  const temperature = Number(settings.temperature);
  if (Number.isFinite(temperature)) generationConfig.temperature = temperature;
  const response = await fetch(`${GEMINI_API_ROOT}/models/${encodeURIComponent(settings.model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": settings.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig,
    }),
    signal,
  });
  const payload = await geminiJson(response, "Gemini 原生多模态推理");
  const text = (payload.candidates || []).flatMap((candidate) => candidate.content?.parts || [])
    .map((part) => String(part.text || "")).filter(Boolean).join("\n").trim();
  if (!text) throw new Error("Gemini 原生多模态响应中没有可用文本");
  return {
    text,
    providerResponseId: payload.responseId || null,
    protocol: "gemini_generate_content",
    inputMode: "native_video",
    uploadedFiles,
  };
};

export const clearGeminiFileUriCache = () => fileUriCache.clear();
