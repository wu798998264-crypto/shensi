const TYPED_CONTEXT_TYPES = new Set([
  "text",
  "resource",
  "workspace_image",
  "image",
  "audio",
  "resource_link",
  "file_reference",
  "skill_reference",
  "controlled_skill",
  "task_route",
  "target",
  "canon",
  "workspace_structure",
  "permission_contract",
]);
const SAFE_TYPE = /^[a-z][a-z0-9_.-]{0,79}$/i;
const SAFE_URI = /^(?:$|shensi:|file:|https?:|attachment:|workspace:|[A-Za-z]:[\\/]|[.]{0,2}[\\/]|[^:]+$)/i;

const clone = (value) => structuredClone(value);
const payloadFor = (block = {}) => String(block.text ?? block.data ?? block.uri ?? block.path ?? "");

export const browserAgentContextContentHash = async (value = "") => {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new Error("Web Crypto SHA-256 is unavailable; context blocks cannot be signed safely.");
  const bytes = new TextEncoder().encode(String(value ?? ""));
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const normalizeRendererBlock = async (input = {}) => {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { rejected: { reason: "malformed_block" } };
  }
  const type = String(input.type || "").trim();
  const uri = String(input.uri || input.path || input.relativePath || "").trim();
  if (!type || !SAFE_TYPE.test(type)) return { rejected: { reason: "invalid_type", type } };
  if (uri && (!SAFE_URI.test(uri) || /^(?:javascript|vbscript):/i.test(uri))) {
    return { rejected: { reason: "unsafe_uri", type, uri } };
  }
  const payload = payloadFor(input);
  if (!payload && !input.id && !input.name) return { rejected: { reason: "empty_block", type, uri } };
  const lane = TYPED_CONTEXT_TYPES.has(type) && input.contextLane !== "passthrough" ? "typed" : "passthrough";
  return {
    block: {
      ...clone(input),
      type,
      ...(uri ? { uri } : {}),
      source: String(input.source || (lane === "typed" ? "shensi_renderer" : "user_resource")),
      revision: String(input.revision || ""),
      authority: String(input.authority || (lane === "typed" ? "shensi_declared" : "user_resource")),
      canonLevel: String(input.canonLevel || "reference"),
      explicit: input.explicit === true,
      contentHash: await browserAgentContextContentHash(payload),
      contextLane: lane,
    },
  };
};

export const buildNativeSessionManifest = ({
  conversationId = "",
  threadScopeId = "",
  contextIdentities = [],
} = {}) => ({
  conversationId: String(conversationId || ""),
  threadScopeId: String(threadScopeId || ""),
  contextIdentities: [...new Set((Array.isArray(contextIdentities) ? contextIdentities : []).map(String).filter(Boolean))],
});

export const buildAgentContextLanes = async ({ blocks = [] } = {}) => {
  const typedShensiBlocks = [];
  const passthroughBlocks = [];
  const rejected = [];
  for (const input of Array.isArray(blocks) ? blocks : []) {
    const normalized = await normalizeRendererBlock(input);
    if (normalized.rejected) {
      rejected.push(normalized.rejected);
      continue;
    }
    if (normalized.block.contextLane === "typed") typedShensiBlocks.push(normalized.block);
    else passthroughBlocks.push(normalized.block);
  }
  return { typedShensiBlocks, passthroughBlocks, rejected };
};
