// Keep internal Agent protocol, routing evidence and tool diagnostics out of
// the ordinary conversation body.  This is deliberately narrow: creative
// prose may contain words such as “路由” or “Skill”, so only protocol-shaped
// lines and known bridge/schema markers are removed.

const asText = (value) => String(value ?? "");

const PROTOCOL_LINE_PATTERNS = [
  /^\s*面板内容宿主已在本轮受控上下文中/iu,
  /^\s*宿主已在受控上下文中/iu,
  /^\s*按合同要求(?:补全|完成)交付声明/iu,
  /^\s*交付(?:已补全|已完成|声明已完成)[。.!！]?\s*$/iu,
  /^\s*(?:Parameter validation failed|Expected parameter schema:|Please adjust the params)\b/iu,
  /^\s*(?:root|\/[^\s:]+|additionalProperties|must have required property)\s*:/iu,
  /^\s*(?:本轮结构化任务路由|本轮内部生成合同|动态创作胶囊)\s*[：:]/iu,
];

const PROTOCOL_INLINE_PATTERNS = [
  /Parameter validation failed for tool/iu,
  /Expected parameter schema/iu,
  /interaction[_\.]delivery/iu,
  /mcp__shensi__interaction_delivery/iu,
  /(?:routingMode|taskRoute\.mode|selectedModulePlacementId|selectedSkillPlacementIds|routeReason)\s*[=:]/iu,
];

const INTERNAL_THOUGHT_TAG = /<\/?(?:think|thinking|analysis|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/?(?:think|thinking|analysis|reasoning)\s*>/giu;

const countBraces = (value) => {
  let depth = 0;
  for (const character of String(value || "")) {
    if (character === "{") depth += 1;
    if (character === "}") depth -= 1;
  }
  return depth;
};

const isInternalDeliveryObject = (line) => {
  const candidate = String(line || "").trim();
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) return false;
  try {
    const value = JSON.parse(candidate);
    return value && typeof value === "object"
      && (Object.hasOwn(value, "documentIds")
        || Object.hasOwn(value, "routingMode")
        || Object.hasOwn(value, "selectedModulePlacementId")
        || Object.hasOwn(value, "mediaChannels"))
      && (Object.hasOwn(value, "mode") || Object.hasOwn(value, "taskType"));
  } catch {
    return false;
  }
};

const lineLooksInternal = (line) => {
  const value = String(line || "").trim();
  if (!value) return false;
  if (isInternalDeliveryObject(value)) return true;
  return PROTOCOL_LINE_PATTERNS.some((pattern) => pattern.test(value));
};

export const hasInternalConversationMarker = (value = "") => {
  const source = asText(value);
  INTERNAL_THOUGHT_TAG.lastIndex = 0;
  const hasThoughtTag = INTERNAL_THOUGHT_TAG.test(source);
  INTERNAL_THOUGHT_TAG.lastIndex = 0;
  return hasThoughtTag
    || PROTOCOL_INLINE_PATTERNS.some((pattern) => pattern.test(source))
    || source.split(/\r?\n/gu).some(lineLooksInternal);
};

const removeProtocolBlocks = (source) => {
  const lines = asText(source).split(/\r?\n/gu);
  const visible = [];
  let droppingSchema = false;
  let schemaDepth = 0;
  let droppingFence = false;
  let fenceInternal = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("```") && !droppingFence) {
      droppingFence = true;
      fenceInternal = false;
      continue;
    }
    if (droppingFence) {
      fenceInternal ||= lineLooksInternal(line) || PROTOCOL_INLINE_PATTERNS.some((pattern) => pattern.test(line));
      if (trimmed.startsWith("```") && fenceInternal) droppingFence = false;
      else if (trimmed.startsWith("```") && !fenceInternal) {
        droppingFence = false;
        visible.push(line);
      }
      continue;
    }
    if (droppingSchema) {
      if (/^(?:Expected parameter schema:|Please adjust the params\b)/iu.test(trimmed) || !trimmed) continue;
      if (isInternalDeliveryObject(trimmed)) {
        droppingSchema = false;
        continue;
      }
      const delta = countBraces(line);
      if (delta || trimmed.startsWith("{")) {
        schemaDepth += delta;
        if (schemaDepth <= 0 && trimmed.endsWith("}")) droppingSchema = false;
        continue;
      }
      // A provider can report a compact validation error without returning a
      // schema. Do not swallow the following real answer in that case.
      droppingSchema = false;
      visible.push(line);
      continue;
    }
    if (/^\s*(?:Parameter validation failed\b|Expected parameter schema:|Please adjust the params\b)/iu.test(trimmed)) {
      const delta = countBraces(line);
      if (delta > 0) {
        droppingSchema = true;
        schemaDepth = delta;
        if (schemaDepth <= 0) droppingSchema = false;
      } else {
        droppingSchema = true;
        schemaDepth = 0;
      }
      continue;
    }
    if (lineLooksInternal(line)) continue;
    if (PROTOCOL_INLINE_PATTERNS.some((pattern) => pattern.test(trimmed))) continue;
    visible.push(line);
  }
  return visible.join("\n");
};

export const sanitizeConversationOutput = (value = "", { final = true } = {}) => {
  let source = asText(value).replace(INTERNAL_THOUGHT_TAG, "");
  source = removeProtocolBlocks(source);
  // A provider may return an unterminated thinking tag while streaming.  Do
  // not hide an ordinary answer during streaming, but drop the incomplete
  // protocol tail once the final response is available.
  if (final) source = source.replace(/<\/?(?:think|thinking|analysis|reasoning)[^>]*>[\s\S]*$/iu, "");
  return source
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
};

const INTERNAL_ERROR_PATTERNS = [
  /Parameter validation failed/iu,
  /Expected parameter schema/iu,
  /interaction[_\.]delivery/iu,
  /mcp__shensi__/iu,
  /(?:routingMode|taskRoute\.mode|selectedModulePlacementId)/iu,
  /must have required property|additionalProperties/iu,
];

export const sanitizeUserFacingError = (value = "", { fallback = "本轮处理未完成，请重试。" } = {}) => {
  const source = asText(value).trim();
  if (!source) return fallback;
  if (INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(source))) {
    return "本轮交付校验未完成，结果已保留；请重试。";
  }
  return sanitizeConversationOutput(source) || fallback;
};
