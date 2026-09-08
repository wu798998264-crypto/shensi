import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { analyzeFullTextImport, materializeFullTextImport } from "./full-text-import.mjs";

const REGISTRATION_TTL_MS = 30 * 60 * 1_000;
const PREVIEW_TTL_MS = 15 * 60 * 1_000;
const MAX_CONCURRENT_PREVIEWS = 2;
const registrations = new Map();
const previews = new Map();
const previewFlights = new Map();
const previewWaiters = [];
let activePreviews = 0;

const normalizedWorkspace = (value = "") => resolve(String(value || "")).replaceAll("\\", "/").toLowerCase();
const sha256 = (value = "") => createHash("sha256").update(String(value), "utf8").digest("hex");
const now = () => Date.now();

const cleanup = () => {
  const timestamp = now();
  for (const [id, record] of registrations) if (record.expiresAt <= timestamp) registrations.delete(id);
  for (const [id, record] of previews) if (record.expiresAt <= timestamp) previews.delete(id);
};

const acquirePreviewSlot = async () => {
  if (activePreviews < MAX_CONCURRENT_PREVIEWS) {
    activePreviews += 1;
    return;
  }
  await new Promise((resolveWaiter) => previewWaiters.push(resolveWaiter));
  activePreviews += 1;
};

const releasePreviewSlot = () => {
  activePreviews = Math.max(0, activePreviews - 1);
  previewWaiters.shift()?.();
};

const registeredAttachment = ({ workspacePath, attachment = {} } = {}) => {
  cleanup();
  const registrationId = String(attachment.registrationId || attachment.fullTextRegistrationId || "");
  const record = registrations.get(registrationId);
  if (!record) {
    const error = new Error("全文源附件没有有效登记，请从当前对话重新附加文件");
    error.code = "FULL_TEXT_ATTACHMENT_NOT_REGISTERED";
    error.statusCode = 403;
    throw error;
  }
  const matches = record.workspacePath === normalizedWorkspace(workspacePath)
    && record.relativePath === String(attachment.relativePath || "").replaceAll("\\", "/")
    && record.sha256 === String(attachment.sha256 || attachment.objectHash || "").toLowerCase();
  if (!matches) {
    const error = new Error("全文源附件登记信息不匹配，请重新附加原文件");
    error.code = "FULL_TEXT_ATTACHMENT_REGISTRATION_MISMATCH";
    error.statusCode = 403;
    throw error;
  }
  return record;
};

const publicAnalysis = (session) => ({
  previewToken: session.previewToken,
  sourceName: session.sourceName,
  sourceSha256: session.sourceSha256,
  sourceBytes: session.sourceBytes,
  characters: session.analysis.characters,
  candidates: session.analysis.candidates,
  requiresCandidateSelection: session.analysis.requiresCandidateSelection,
  bookTitleCandidates: session.analysis.bookTitleCandidates,
  expiresAt: new Date(session.expiresAt).toISOString(),
});

export const registerFullTextAttachment = ({ workspacePath, attachment = {} } = {}) => {
  cleanup();
  const relativePath = String(attachment.relativePath || "").replaceAll("\\", "/");
  const sourceSha256 = String(attachment.sha256 || attachment.objectHash || "").toLowerCase();
  if (!relativePath || !/^[a-f0-9]{64}$/u.test(sourceSha256)) throw new Error("附件缺少可验证的路径或 SHA-256");
  const registrationId = `fulltext-attachment-${randomUUID()}`;
  const record = {
    registrationId,
    workspacePath: normalizedWorkspace(workspacePath),
    relativePath,
    sha256: sourceSha256,
    name: String(attachment.name || "未命名全文"),
    mimeType: String(attachment.mimeType || "application/octet-stream"),
    size: Math.max(0, Number(attachment.size) || 0),
    registeredAt: now(),
    expiresAt: now() + REGISTRATION_TTL_MS,
  };
  registrations.set(registrationId, record);
  return { registrationId, registrationExpiresAt: new Date(record.expiresAt).toISOString() };
};

export const analyzeRegisteredFullTextImport = async ({ workspacePath, attachment, loadAttachmentText } = {}) => {
  const registration = registeredAttachment({ workspacePath, attachment });
  const existing = [...previews.values()].find((session) => session.registrationId === registration.registrationId && session.expiresAt > now());
  if (existing) return publicAnalysis(existing);
  if (previewFlights.has(registration.registrationId)) return previewFlights.get(registration.registrationId);
  const flight = (async () => {
    await acquirePreviewSlot();
    try {
      const loaded = await loadAttachmentText(registration);
      const actualHash = String(loaded.sourceSha256 || "").toLowerCase();
      if (actualHash !== registration.sha256) {
        const error = new Error("全文源附件内容已变化，请重新附加后再导入");
        error.code = "FULL_TEXT_ATTACHMENT_HASH_MISMATCH";
        error.statusCode = 409;
        throw error;
      }
      const analysis = analyzeFullTextImport({ text: loaded.text, sourceName: loaded.name || registration.name });
      const previewToken = `fulltext-preview-${randomUUID()}`;
      const session = {
        previewToken,
        registrationId: registration.registrationId,
        workspacePath: registration.workspacePath,
        sourceName: loaded.name || registration.name,
        sourceSha256: actualHash,
        sourceBytes: Number(loaded.size) || registration.size,
        text: loaded.text,
        analysis,
        createdAt: now(),
        expiresAt: now() + PREVIEW_TTL_MS,
      };
      previews.set(previewToken, session);
      return publicAnalysis(session);
    } finally {
      releasePreviewSlot();
    }
  })().finally(() => previewFlights.delete(registration.registrationId));
  previewFlights.set(registration.registrationId, flight);
  return flight;
};

export const materializeRegisteredFullTextImport = ({ workspacePath, previewToken, candidateId, bookTitle } = {}) => {
  cleanup();
  const session = previews.get(String(previewToken || ""));
  if (!session || session.workspacePath !== normalizedWorkspace(workspacePath)) {
    const error = new Error("全文导入预览已过期，请重新分析并确认");
    error.code = "FULL_TEXT_PREVIEW_EXPIRED";
    error.statusCode = 409;
    throw error;
  }
  const normalizedBookTitle = String(bookTitle || "").replace(/[\r\n]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 100);
  if (!normalizedBookTitle) {
    const error = new Error("请先确认书名；书名只用于文档命名，不会写入正文");
    error.code = "FULL_TEXT_BOOK_TITLE_REQUIRED";
    error.statusCode = 422;
    throw error;
  }
  const result = materializeFullTextImport({ text: session.text, sourceName: session.sourceName, candidateId });
  const batchId = `fulltext-${sha256(`${session.workspacePath}\u0000${session.sourceSha256}\u0000${result.selectedCandidateId}\u0000${normalizedBookTitle}`).slice(0, 32)}`;
  return {
    batchId,
    previewToken: session.previewToken,
    sourceName: session.sourceName,
    sourceSha256: session.sourceSha256,
    sourceBytes: session.sourceBytes,
    bookTitle: normalizedBookTitle,
    selectedCandidateId: result.selectedCandidateId,
    chapterCount: result.chapterCount,
    chapters: result.chapters,
  };
};

export const fullTextImportGateStatus = () => ({
  activePreviews,
  waitingPreviews: previewWaiters.length,
  registeredAttachments: registrations.size,
  cachedPreviews: previews.size,
});
