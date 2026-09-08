import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeContextGapAssessment } from "../context-gap-contract.js";

export const CONTEXT_REQUEST_PROTOCOL_VERSION = 1;
const ABSOLUTE_PATH = /(?:\b[A-Za-z]:[\\/]|file:\/\/|\\\\|\/(?:Users|home|var|opt|etc|root)\/)/i;
const STABLE_ID = /^[\p{L}\p{N}][\p{L}\p{N}:._-]{0,159}$/u;
const sha256 = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const canonicalJson = (value) => JSON.stringify(canonicalize(value));
const objectHash = (value) => sha256(canonicalJson(value));
const signatureFor = (secret, payload) => createHmac("sha256", String(secret || "")).update(canonicalJson(payload), "utf8").digest("hex");
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""), "utf8");
  const b = Buffer.from(String(right || ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

export const createPlanningCheckpoint = ({
  secret,
  requestId,
  taskEnvelope = {},
  templateHash = "",
  initialContext = "",
  plan = {},
  now = Date.now(),
  ttlMs = 10 * 60_000,
} = {}) => {
  if (!String(secret || "")) throw new Error("缺少远程上下文检查点签名密钥");
  const payload = {
    schemaVersion: CONTEXT_REQUEST_PROTOCOL_VERSION,
    resumePhase: "context_resolved",
    requestId: String(requestId || "").slice(0, 100),
    taskHash: objectHash(taskEnvelope),
    templateHash: String(templateHash || taskEnvelope?.templateHash || "").slice(0, 128),
    initialContextHash: sha256(initialContext),
    planHash: objectHash(plan),
    issuedAt: Number(now),
    expiresAt: Number(now) + Math.max(30_000, Math.min(30 * 60_000, Number(ttlMs) || 10 * 60_000)),
  };
  return { ...payload, signature: signatureFor(secret, payload) };
};

export const verifyPlanningCheckpoint = ({
  secret,
  checkpoint,
  requestId,
  taskEnvelope,
  templateHash,
  initialContext,
  plan,
  now = Date.now(),
} = {}) => {
  const source = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  if (source.schemaVersion !== CONTEXT_REQUEST_PROTOCOL_VERSION || source.resumePhase !== "context_resolved") return { valid: false, reason: "unsupported" };
  if (Number(source.expiresAt) <= Number(now)) return { valid: false, reason: "expired" };
  if (requestId !== undefined && String(source.requestId) !== String(requestId)) return { valid: false, reason: "request_mismatch" };
  if (taskEnvelope !== undefined && source.taskHash !== objectHash(taskEnvelope)) return { valid: false, reason: "task_mismatch" };
  if (templateHash !== undefined && source.templateHash !== String(templateHash || "")) return { valid: false, reason: "template_mismatch" };
  if (initialContext !== undefined && source.initialContextHash !== sha256(initialContext)) return { valid: false, reason: "context_mismatch" };
  if (plan !== undefined && source.planHash !== objectHash(plan)) return { valid: false, reason: "plan_mismatch" };
  const { signature, ...payload } = source;
  if (!safeEqual(signature, signatureFor(secret, payload))) return { valid: false, reason: "invalid_signature" };
  return { valid: true, reason: "verified" };
};

const cleanManifestItem = (item) => {
  const id = String(typeof item === "string" ? item : item?.id || "").trim();
  if (!STABLE_ID.test(id)) return null;
  return {
    id,
    name: String(item?.name || id).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 200),
    type: String(item?.type || "reference").slice(0, 40),
    authority: ["canon", "plan", "memory", "reference"].includes(item?.authority) ? item.authority : "reference",
    truncated: item?.truncated === true,
  };
};

export const normalizeContextSupplement = (value = {}) => {
  const prewriteContext = String(value?.prewriteContext || "");
  const postwriteContext = String(value?.postwriteContext || prewriteContext);
  if (ABSOLUTE_PATH.test(`${prewriteContext}\n${postwriteContext}`)) throw new Error("上下文补充不得包含本机绝对路径");
  const manifestSource = value?.manifest && typeof value.manifest === "object" ? value.manifest : {};
  const included = (Array.isArray(manifestSource.included) ? manifestSource.included : [])
    .map(cleanManifestItem)
    .filter(Boolean);
  return {
    prewriteContext,
    postwriteContext,
    manifest: { included },
  };
};

export class ContextRequestRequiredError extends Error {
  constructor({ requestId, needs, planningCheckpoint }) {
    super("远程规划需要本地可信补读");
    this.name = "ContextRequestRequiredError";
    this.code = "CONTEXT_REQUEST_V1";
    const assessment = normalizeContextGapAssessment({ sufficient: false, needs });
    this.publicPayload = {
      schemaVersion: CONTEXT_REQUEST_PROTOCOL_VERSION,
      requestId: String(requestId || ""),
      needs: assessment.needs,
      planningCheckpoint,
    };
  }
}
