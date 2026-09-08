import { createHash } from "node:crypto";

const KNOWN_TYPES = new Set([
  "text", "resource", "workspace_image", "image", "audio", "resource_link",
  "file_reference", "skill_reference", "controlled_skill", "task_route",
  "target", "canon", "workspace_structure", "permission_contract",
]);
const SAFE_TYPE = /^[a-z][a-z0-9_.-]{0,79}$/i;
// Managed Skill identifiers are URIs in context blocks, even when they do not
// point at a filesystem path.  Reject executable schemes, but keep the three
// trusted Skill namespaces so an enabled Skill is not discarded before the
// final-input proof is built.
const SAFE_URI = /^(?:$|shensi:|file:|https?:|attachment:|workspace:|builtin:|official:|user:|[A-Za-z]:[\\/]|[.]{0,2}[\\/]|[^:]+$)/i;

export const agentContextContentHash = (value = "") => createHash("sha256")
  .update(String(value ?? ""), "utf8")
  .digest("hex");

const blockPayload = (block = {}) => String(block.text ?? block.data ?? block.uri ?? block.path ?? "");
// This value is only a bounded character-weight used before a provider call.
// It must not be exposed or persisted as actual token usage. Actual usage is
// read from the provider response by context-usage-ledger.mjs.
const tokenEstimate = (block = {}) => Math.max(1, blockPayload(block).length);
const safeClone = (value) => structuredClone(value);

const normalizeBlock = (input, { lane, providerCapabilities, createdAt }) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { rejected: { reason: "malformed_block", block: input } };
  }
  const type = String(input.type || "").trim();
  const uri = String(input.uri || input.path || input.relativePath || "").trim();
  if (!type || !SAFE_TYPE.test(type)) return { rejected: { reason: "invalid_type", block: safeClone(input) } };
  if (uri && (!SAFE_URI.test(uri) || /^(?:javascript|vbscript):/i.test(uri))) {
    return { rejected: { reason: "unsafe_uri", block: safeClone(input) } };
  }
  const payload = blockPayload(input);
  if (!payload && !input.id && !input.name) return { rejected: { reason: "empty_block", block: safeClone(input) } };
  const actualHash = agentContextContentHash(payload);
  const suppliedHash = String(input.contentHash || "").trim().toLowerCase();
  const known = KNOWN_TYPES.has(type);
  const supportedTypes = new Set(providerCapabilities.supportedTypes || []);
  const compatible = supportedTypes.has(type)
    || (known && providerCapabilities.supportKnown !== false)
    || (!known && providerCapabilities.passthroughUnknown === true);
  const normalized = {
    ...safeClone(input),
    type,
    ...(uri ? { uri } : {}),
    source: String(input.source || (lane === "typed" ? "shensi" : "passthrough")),
    revision: String(input.revision || ""),
    canonLevel: String(input.canonLevel || "reference"),
    explicit: input.explicit === true,
    characterWeight: Number.isFinite(Number(input.characterWeight ?? input.tokenEstimate))
      ? Math.max(0, Number(input.characterWeight ?? input.tokenEstimate))
      : tokenEstimate(input),
    authority: String(input.authority || (lane === "typed" ? "shensi_trusted" : "user_resource")),
    contentHash: actualHash,
    providerCompatibility: compatible ? "supported" : "unsupported",
    createdAt: String(input.createdAt || createdAt),
    contextLane: lane,
  };
  return {
    normalized,
    warning: suppliedHash && suppliedHash !== actualHash
      ? { code: "CONTENT_HASH_MISMATCH", type, uri, suppliedHash, actualHash }
      : !compatible
        ? { code: "PROVIDER_BLOCK_UNSUPPORTED", type, uri }
        : null,
  };
};

const identityKeys = (block) => [
  block.documentId && block.revision ? `document:${block.documentId}@${block.revision}` : "",
  block.uri && block.revision ? `uri:${block.uri}@${block.revision}` : "",
  block.messageId ? `message:${block.messageId}` : "",
  `content:${block.contentHash}:${blockPayload(block).length}`,
].filter(Boolean);

export const compileHybridAgentContext = ({
  typedShensiBlocks = [],
  passthroughBlocks = [],
  nativeSessionManifest = {},
  providerCapabilities = {},
  now = new Date().toISOString(),
} = {}) => {
  const sourceTyped = safeClone(Array.isArray(typedShensiBlocks) ? typedShensiBlocks : []);
  const sourcePassthrough = safeClone(Array.isArray(passthroughBlocks) ? passthroughBlocks : []);
  const warnings = [];
  const rejected = [];
  const normalized = [];
  for (const [lane, blocks] of [["typed", sourceTyped], ["passthrough", sourcePassthrough]]) {
    for (const block of blocks) {
      const result = normalizeBlock(block, { lane, providerCapabilities, createdAt: now });
      if (result.rejected) rejected.push(result.rejected);
      else {
        normalized.push(result.normalized);
        if (result.warning) warnings.push(result.warning);
      }
    }
  }

  const nativeIds = new Set((nativeSessionManifest.contextIdentities || []).map(String));
  const seen = new Map();
  const blocks = [];
  const omitted = [];
  const revisionHints = [];
  for (const block of normalized) {
    const keys = identityKeys(block);
    const nativeMatch = keys.find((key) => nativeIds.has(key));
    const mustReachCurrentTurn = block.type === "controlled_skill" || block.contextRole === "primary_target";
    if (nativeMatch && !mustReachCurrentTurn) {
      omitted.push({ reason: "native_session_duplicate", identity: nativeMatch, type: block.type, uri: block.uri || "" });
      revisionHints.push({ type: block.type, uri: block.uri || "", revision: block.revision, contentHash: block.contentHash });
      continue;
    }
    const duplicate = keys.map((key) => seen.get(key)).find(Boolean);
    if (duplicate) {
      omitted.push({ reason: "turn_duplicate", identity: duplicate.identity, type: block.type, uri: block.uri || "" });
      continue;
    }
    if (block.providerCompatibility !== "supported") continue;
    blocks.push(block);
    for (const key of keys) seen.set(key, { identity: key, block });
  }
  return {
    schemaVersion: 1,
    typedShensiBlocks: blocks.filter((block) => block.contextLane === "typed"),
    passthroughBlocks: blocks.filter((block) => block.contextLane === "passthrough"),
    blocks,
    warnings,
    rejected,
    omitted,
    revisionHints,
    characterWeight: blocks.reduce((total, block) => total + block.characterWeight, 0),
    compiledAt: now,
  };
};
