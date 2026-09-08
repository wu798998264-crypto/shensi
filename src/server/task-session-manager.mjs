import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { appDataRoot } from "./app-data.mjs";
import { rankRelevantDocuments } from "../context-compiler.js";
import { classifyContextSource } from "../context-source-policy.js";
import { contextDocumentMayBeRead } from "../context-read-policy.js";
import { serverContextDocumentText } from "./server-context-verifier.mjs";

const SCHEMA_VERSION = 1;
const SAFE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const writeQueues = new Map();
const memoryFallbackSessions = new Map();
const sha256 = (value = "") => createHash("sha256").update(String(value), "utf8").digest("hex");
const now = () => new Date().toISOString();
const text = (value, limit = 4_000) => String(value ?? "").trim().slice(0, limit);
const list = (value, limit = 200) => (Array.isArray(value) ? value : []).slice(0, limit);

const safeId = (value, label = "任务") => {
  const id = String(value ?? "").trim();
  if (!SAFE_ID.test(id)) throw new Error(`${label}标识无效`);
  return id;
};

const rootPath = (dataRoot = appDataRoot()) => join(dataRoot, "task-sessions");
const sessionPath = (taskId, dataRoot) => join(rootPath(dataRoot), `${safeId(taskId)}.json`);
const pathKey = (value) => process.platform === "win32" ? String(value).toLowerCase() : String(value);
const sessionKey = (taskId, dataRoot) => pathKey(sessionPath(taskId, dataRoot));
const sessionRootKey = (dataRoot) => `${pathKey(rootPath(dataRoot))}${sep}`;

const withWriteLock = (path, operation) => {
  const key = process.platform === "win32" ? path.toLowerCase() : path;
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  writeQueues.set(key, current);
  return current.finally(() => {
    if (writeQueues.get(key) === current) writeQueues.delete(key);
  });
};

const atomicWriteJson = async (path, value) => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!['EPERM', 'EACCES', 'EEXIST'].includes(error?.code)) throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
};

const writeSession = async (taskId, dataRoot, path, value) => {
  const key = sessionKey(taskId, dataRoot);
  const durable = { ...value, durabilityStatus: "durable", durabilityWarning: "", durabilityErrorCode: "" };
  try {
    if (process.env.SHENSI_TEST_TASK_SESSION_WRITE_FAILURE === "1") {
      throw Object.assign(new Error("测试故障注入：任务会话日志不可写"), { code: "EACCES" });
    }
    await atomicWriteJson(path, durable);
    memoryFallbackSessions.delete(key);
    return durable;
  } catch (error) {
    const memoryOnly = {
      ...value,
      durabilityStatus: "memory_only",
      durabilityWarning: "本次对话任务无法断电恢复；模型仍会继续运行，正式写入仍需通过原有落盘校验。",
      durabilityErrorCode: text(error?.code || "TASK_SESSION_WRITE_FAILED", 80),
    };
    memoryFallbackSessions.set(key, memoryOnly);
    return memoryOnly;
  }
};

const readSession = async (taskId, dataRoot) => {
  const memory = memoryFallbackSessions.get(sessionKey(taskId, dataRoot));
  if (memory) return memory;
  try {
    const parsed = JSON.parse(await readFile(sessionPath(taskId, dataRoot), "utf8"));
    return parsed?.schemaVersion === SCHEMA_VERSION ? parsed : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
};

const cleanDocumentRecord = (record = {}) => ({
  id: text(record.id, 240),
  title: text(record.title, 300),
  type: text(record.type, 100),
  workId: text(record.workId, 240),
  workTitle: text(record.workTitle, 300),
  path: text(record.path, 1_500),
  currentRevision: text(record.currentRevision, 240),
  hash: text(record.hash, 128),
  summary: text(record.summary, 1_200),
  relevance: Math.max(0, Number(record.relevance) || 0),
  required: record.required === true,
  readMode: ["manifest", "excerpt", "full", "delta"].includes(record.readMode) ? record.readMode : "manifest",
  readAt: text(record.readAt, 80),
});

const cleanSkillRecord = (record = {}) => ({
  id: text(record.id, 240),
  name: text(record.name, 300),
  version: text(record.version, 120),
  hash: text(record.hash, 128),
  enabled: record.enabled !== false,
  phases: list(record.phases, 30).map((item) => text(item, 80)).filter(Boolean),
  loadedStages: list(record.loadedStages, 30).map((item) => text(item, 80)).filter(Boolean),
  loadedAt: text(record.loadedAt, 80),
});

const cleanReadEvent = (record = {}) => ({
  stage: text(record.stage, 100),
  startedAt: text(record.startedAt, 80),
  completedAt: text(record.completedAt, 80),
  reusedSnapshot: record.reusedSnapshot === true,
  documents: list(record.documents, 500).map((item) => ({
    id: text(item?.id, 240),
    title: text(item?.title || item?.name || item?.id, 300),
    readMode: ["manifest", "excerpt", "full", "delta", "snapshot"].includes(item?.readMode) ? item.readMode : "full",
    fullText: item?.fullText === true,
    compressed: item?.compressed === true,
    reused: item?.reused === true,
    sourceCharacters: Math.max(0, Number(item?.sourceCharacters) || 0),
    chunksRead: Math.max(0, Number(item?.chunksRead) || 0),
  })).filter((item) => item.id),
  skills: list(record.skills, 200).map((item) => ({
    id: text(item?.id, 240),
    name: text(item?.name || item?.id, 300),
    version: text(item?.version, 120),
  })).filter((item) => item.id),
});

const normalizeSession = (value = {}) => ({
  schemaVersion: SCHEMA_VERSION,
  taskId: safeId(value.taskId),
  conversationId: text(value.conversationId, 240),
  requestId: text(value.requestId || value.taskId, 240),
  branchId: text(value.branchId, 240),
  workspace: {
    kind: value.workspace?.kind === "notebook" ? "notebook" : "project",
    id: text(value.workspace?.id, 240),
    title: text(value.workspace?.title, 300),
    pathHash: text(value.workspace?.pathHash, 128),
  },
  association: {
    enabled: value.association?.enabled !== false,
    documentId: text(value.association?.documentId, 240),
    revision: text(value.association?.revision, 240),
    hash: text(value.association?.hash, 128),
  },
  source: value.source && typeof value.source === "object" ? structuredClone(value.source) : {},
  target: value.target && typeof value.target === "object" ? structuredClone(value.target) : {},
  operation: text(value.operation, 120),
  confirmedRequirements: list(value.confirmedRequirements, 300).map((item) => text(typeof item === "string" ? item : item?.text, 1_500)).filter(Boolean),
  conversationLedger: value.conversationLedger && typeof value.conversationLedger === "object" ? structuredClone(value.conversationLedger) : {},
  documents: Object.fromEntries(Object.entries(value.documents ?? {}).map(([id, item]) => [id, cleanDocumentRecord({ ...item, id })]).filter(([, item]) => item.id)),
  skills: Object.fromEntries(Object.entries(value.skills ?? {}).map(([id, item]) => [id, cleanSkillRecord({ ...item, id })]).filter(([, item]) => item.id)),
  readEvents: list(value.readEvents, 200).map(cleanReadEvent).filter((item) => item.stage),
  currentStage: text(value.currentStage, 100),
  stageFingerprints: value.stageFingerprints && typeof value.stageFingerprints === "object" ? structuredClone(value.stageFingerprints) : {},
  stageResults: Object.fromEntries(Object.entries(value.stageResults ?? {}).slice(-120).map(([fingerprint, result]) => [fingerprint, {
    stage: text(result?.stage, 100),
    text: text(result?.text, 2_000_000),
    protocol: text(result?.protocol, 120),
    providerResponseId: text(result?.providerResponseId, 300),
    sources: list(result?.sources, 100).map((item) => structuredClone(item)),
    webSearchUsed: result?.webSearchUsed === true,
    usage: result?.usage && typeof result.usage === "object" ? structuredClone(result.usage) : null,
    savedAt: text(result?.savedAt, 80) || now(),
  }])),
  adoptedCandidate: value.adoptedCandidate && typeof value.adoptedCandidate === "object" ? structuredClone(value.adoptedCandidate) : null,
  receipts: list(value.receipts, 1_000).map((item) => structuredClone(item)),
  usage: list(value.usage, 2_000).map((item) => structuredClone(item)),
  status: text(value.status || "running", 80),
  durabilityStatus: value.durabilityStatus === "memory_only" ? "memory_only" : "durable",
  durabilityWarning: text(value.durabilityWarning, 500),
  durabilityErrorCode: text(value.durabilityErrorCode, 80),
  createdAt: text(value.createdAt, 80) || now(),
  updatedAt: now(),
});

export const loadTaskSession = ({ taskId, dataRoot = appDataRoot() } = {}) => readSession(safeId(taskId), dataRoot);

export const listTaskSessionProvenance = async ({ conversationId = "", dataRoot = appDataRoot(), limit = 24 } = {}) => {
  const wantedConversationId = text(conversationId, 240);
  if (!wantedConversationId) return [];
  const entries = await readdir(rootPath(dataRoot), { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const sessions = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && SAFE_ID.test(entry.name.slice(0, -5)))
    .map((entry) => readSession(entry.name.slice(0, -5), dataRoot)));
  const memoryRoot = sessionRootKey(dataRoot);
  for (const [key, session] of memoryFallbackSessions.entries()) {
    if (!key.startsWith(memoryRoot)) continue;
    if (session?.conversationId === wantedConversationId && !sessions.some((item) => item?.taskId === session.taskId)) sessions.push(session);
  }
  return sessions
    .filter((session) => session?.conversationId === wantedConversationId)
    .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 24)))
    .map((session) => ({
      taskId: session.taskId,
      request: text(session.conversationLedger?.currentGoal, 1_500),
      targetDocumentId: text(session.target?.documentId || session.association?.documentId, 240),
      operation: session.operation,
      status: session.status,
      documents: Object.values(session.documents ?? {})
        .filter((document) => document.readMode !== "manifest" && document.readAt)
        .map((document) => ({ id: document.id, title: document.title, readMode: document.readMode, readAt: document.readAt })),
      skills: Object.values(session.skills ?? {})
        .filter((skill) => skill.enabled !== false && (skill.loadedAt || skill.loadedStages?.length))
        .map((skill) => ({ id: skill.id, name: skill.name, version: skill.version, loadedAt: skill.loadedAt })),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }));
};

export const beginTaskSession = async ({ taskId, dataRoot = appDataRoot(), ...seed } = {}) => {
  const id = safeId(taskId);
  const path = sessionPath(id, dataRoot);
  return withWriteLock(path, async () => {
    let existing = null;
    let readError = null;
    try {
      if (process.env.SHENSI_TEST_TASK_SESSION_READ_FAILURE === "1") {
        throw Object.assign(new Error("测试故障注入：任务会话日志不可读"), { code: "EACCES" });
      }
      existing = await readSession(id, dataRoot);
    } catch (error) {
      readError = error;
    }
    const session = normalizeSession({
      ...(existing ?? {}),
      ...seed,
      taskId: id,
      createdAt: existing?.createdAt,
      ...(readError ? {
        durabilityStatus: "memory_only",
        durabilityWarning: "本次对话任务无法读取持久任务日志，已在当前会话继续；关闭软件后不能恢复本次任务。",
        durabilityErrorCode: text(readError?.code || "TASK_SESSION_READ_FAILED", 80),
      } : {}),
    });
    if (readError) {
      memoryFallbackSessions.set(sessionKey(id, dataRoot), session);
      return session;
    }
    return writeSession(id, dataRoot, path, session);
  });
};

export const updateTaskSession = async ({ taskId, dataRoot = appDataRoot(), mutate, patch = {} } = {}) => {
  const id = safeId(taskId);
  const path = sessionPath(id, dataRoot);
  return withWriteLock(path, async () => {
    const current = await readSession(id, dataRoot);
    if (!current) throw new Error("没有找到可更新的任务会话");
    const changed = typeof mutate === "function" ? await mutate(structuredClone(current)) : { ...current, ...patch };
    const next = normalizeSession({ ...current, ...changed, taskId: id, createdAt: current.createdAt });
    return writeSession(id, dataRoot, path, next);
  });
};

export const completeTaskSession = ({ taskId, dataRoot = appDataRoot(), status = "complete", receipts = [] } = {}) => updateTaskSession({
  taskId,
  dataRoot,
  mutate: (session) => ({ ...session, status, receipts: [...session.receipts, ...list(receipts, 1_000)] }),
});

const documentRevision = (document = {}) => text(document.currentRevision || document.revision || document.version || document.updatedAt || "current", 240);
const documentPath = (document = {}) => text(document.relativePath || document.path || document.filePath || "", 1_500);
const documentType = (document = {}, policy = {}) => text(document.contentType || document.type || document.moduleId || document.domain || policy.sourceKind || "document", 100);
const documentSummary = (content = "") => {
  const normalized = String(content).replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const units = normalized.match(/[^。！？!?；;\n]{1,240}[。！？!?；;]?/gu) ?? [normalized];
  const seen = new Set();
  let summary = "";
  for (const unit of units) {
    const current = unit.trim();
    const identity = current.replace(/[。！？!?；;]+$/u, "").trim();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    if (summary.length + current.length > 320) break;
    summary += current;
    if (summary.length >= 240) break;
  }
  return summary || normalized.slice(0, 320);
};

const commonPrefixLength = (left = "", right = "") => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
};

const commonSuffixLength = (left = "", right = "", prefixLength = 0) => {
  const limit = Math.min(left.length, right.length) - prefixLength;
  let index = 0;
  while (index < limit && left[left.length - index - 1] === right[right.length - index - 1]) index += 1;
  return index;
};

export const documentTextDelta = ({ previous = "", current = "", contextCharacters = 240 } = {}) => {
  const before = String(previous ?? "");
  const after = String(current ?? "");
  if (before === after) return { changed: false, text: "", prefixLength: after.length, suffixLength: 0 };
  const prefixLength = commonPrefixLength(before, after);
  const suffixLength = commonSuffixLength(before, after, prefixLength);
  const beforeEnd = Math.max(prefixLength, before.length - suffixLength);
  const afterEnd = Math.max(prefixLength, after.length - suffixLength);
  const context = Math.max(0, Math.min(2_000, Number(contextCharacters) || 0));
  const start = Math.max(0, prefixLength - context);
  const previousExcerpt = before.slice(start, Math.min(before.length, beforeEnd + context));
  const currentExcerpt = after.slice(start, Math.min(after.length, afterEnd + context));
  return {
    changed: true,
    prefixLength,
    suffixLength,
    previousRange: [prefixLength, beforeEnd],
    currentRange: [prefixLength, afterEnd],
    text: [
      `修改前范围 ${prefixLength}-${beforeEnd}：`,
      previousExcerpt || "（空）",
      `修改后范围 ${prefixLength}-${afterEnd}：`,
      currentExcerpt || "（空）",
    ].join("\n"),
  };
};

export const buildTaskContextManifest = ({
  documents = {},
  query = "",
  targetDocumentId = "",
  includedIds = [],
  fullTextIds = [],
  requiredIds = [],
  workspace = {},
} = {}) => {
  const map = Array.isArray(documents)
    ? Object.fromEntries(documents.map((item) => [String(item?.id || ""), item]).filter(([id]) => id))
    : documents && typeof documents === "object" ? documents : {};
  const selected = new Set(includedIds.map(String));
  const ids = Object.keys(map).filter((id) => classifyContextSource({
    document: { ...map[id], id },
    moduleId: map[id]?.moduleId,
    domain: map[id]?.domain,
  }).canUseAsReference && contextDocumentMayBeRead({
    documentId: id,
    title: map[id]?.title,
    moduleId: map[id]?.moduleId,
    document: map[id],
    instruction: query,
    targetDomain: map[targetDocumentId]?.domain || "novel",
    explicitlyReferenced: selected.has(id),
  }));
  const contentById = new Map(ids.map((id) => [id, serverContextDocumentText(map[id], id)]));
  const ranked = rankRelevantDocuments({
    ids,
    query,
    titleFor: (id) => map[id]?.title || id,
    contentFor: (id) => contentById.get(id) || "",
    limit: ids.length,
  });
  const relevance = new Map(ranked.map((item) => [item.id, item.score]));
  const fullText = new Set(fullTextIds.map(String));
  const required = new Set(requiredIds.map(String));
  if (targetDocumentId && map[targetDocumentId]) {
    selected.add(targetDocumentId);
    required.add(targetDocumentId);
  }
  return ids.map((id) => {
    const document = map[id] ?? {};
    const content = contentById.get(id) || "";
    const policy = classifyContextSource({ document: { ...document, id }, moduleId: document.moduleId, domain: document.domain });
    return cleanDocumentRecord({
      id,
      title: document.title || id,
      type: documentType(document, policy),
      workId: document.projectId || document.notebookId || workspace.id || "",
      workTitle: document.projectTitle || document.notebookTitle || workspace.title || "",
      path: documentPath(document),
      currentRevision: documentRevision(document),
      hash: sha256(content),
      summary: documentSummary(content),
      relevance: targetDocumentId === id ? Number.MAX_SAFE_INTEGER : relevance.get(id) || 0,
      required: required.has(id),
      readMode: fullText.has(id) || (id === targetDocumentId && selected.has(id)) ? "full" : selected.has(id) ? "excerpt" : "manifest",
      readAt: selected.has(id) ? now() : "",
    });
  }).sort((left, right) => Number(right.required) - Number(left.required) || right.relevance - left.relevance || left.title.localeCompare(right.title, "zh-CN"));
};

export const taskContextManifestPrompt = (records = []) => [
  "# 当前任务资料清单",
  "清单只表示当前工作区可用资料；只有标记为已读的内容才可作为事实引用。需要更多内容时必须通过可信资料代理按需补读。",
  ...list(records, 500).map((item) => [
    item.id,
    item.title,
    item.type,
    item.workTitle || item.workId,
    item.path,
    item.currentRevision,
    item.hash.slice(0, 16),
    item.summary,
    Number.isFinite(item.relevance) ? item.relevance.toFixed(3) : "0",
    item.readMode,
  ].map((value) => String(value || "-").replace(/[|\r\n]+/g, " ")).join(" | ")),
].join("\n");

export const taskSnapshotReferencePrompt = (records = [], { stage = "" } = {}) => [
  "# 当前任务资料快照（复用）",
  `阶段：${text(stage, 100) || "后续处理"}`,
  "本阶段沿用同一任务已经核验的资料版本。不得读取清单外资料、历史版本、回收站、退回消息或未采用候选。",
  "本阶段只处理上一阶段产物与下列当前版本摘要；如确实缺少原文证据，必须通过可信资料代理按 Document ID 定点补读，禁止重新扫描整个工作区。",
  ...list(records, 500)
    .filter((item) => item.readMode !== "manifest" || item.required)
    .map((item) => `${item.id}@${item.currentRevision} ${item.hash.slice(0, 16)} | ${item.title} | ${item.summary || "无摘要"}`),
].join("\n");

export const taskSessionStageFingerprint = ({ stage = "", messages = [], system = "", documents = [], skills = [], attachments = [] } = {}) => sha256(JSON.stringify({
  stage,
  messages: list(messages, 100).map((item) => ({ role: item?.role, hash: sha256(item?.content || "") })),
  system: sha256(system),
  documents: list(documents, 500).map((item) => `${item.id}@${item.currentRevision}:${item.hash}`),
  skills: list(skills, 100).map((item) => `${item.id}@${item.version}:${item.hash}`),
  attachments: list(attachments, 100).map((item) => `${item.relativePath || item.name}:${item.hash || item.size || ""}`),
}));
