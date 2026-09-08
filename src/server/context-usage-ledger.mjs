import { createHash } from "node:crypto";

const sha256 = (value = "") => createHash("sha256").update(String(value), "utf8").digest("hex");
const number = (...values) => {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 0;
};
const nested = (value, keys) => keys.reduce((current, key) => current?.[key], value);

export const normalizeProviderUsage = (usage = null) => {
  if (!usage || typeof usage !== "object") return null;
  const source = usage.total && typeof usage.total === "object" ? usage.total : usage;
  const inputTokens = number(
    source.input_tokens, source.inputTokens, source.prompt_tokens, source.promptTokens,
    nested(source, ["input", "tokens"]),
  );
  const outputTokens = number(
    source.output_tokens, source.outputTokens, source.completion_tokens, source.completionTokens,
    nested(source, ["output", "tokens"]),
  );
  const cachedInputTokens = number(
    source.cached_input_tokens, source.cachedInputTokens,
    nested(source, ["input_tokens_details", "cached_tokens"]),
    nested(source, ["prompt_tokens_details", "cached_tokens"]),
    source.cache_read_input_tokens,
  );
  const cacheWriteTokens = number(source.cache_creation_input_tokens, source.cacheWriteTokens);
  const reasoningTokens = number(
    source.reasoning_tokens, source.reasoningTokens, source.reasoning_output_tokens, source.reasoningOutputTokens,
    nested(source, ["output_tokens_details", "reasoning_tokens"]),
    nested(source, ["completion_tokens_details", "reasoning_tokens"]),
  );
  const totalTokens = number(source.total_tokens, source.totalTokens, inputTokens + outputTokens);
  const actualCost = Number(source.cost ?? source.actualCost ?? usage.cost ?? usage.actualCost);
  return {
    source: "provider",
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: totalTokens || inputTokens + outputTokens,
    actualCost: Number.isFinite(actualCost) && actualCost >= 0 ? actualCost : null,
  };
};

const block = (category, value) => ({
  category,
  characters: String(value ?? "").length,
  hash: sha256(value),
});

const removeEmbedded = (value = "", embedded = "") => {
  const source = String(value ?? "");
  const target = String(embedded ?? "").trim();
  return target && source.includes(target) ? source.replace(target, "") : source;
};

export const contextUsageBlocks = ({ system = "", messages = [], documents = "", skills = "", attachments = [] } = {}) => {
  const documentText = String(documents ?? "").trim();
  const skillText = String(skills ?? "").trim();
  let systemOnly = removeEmbedded(removeEmbedded(system, documentText), skillText);
  const categorizedMessages = [];
  for (const message of messages) {
    const content = String(message?.content || "");
    if (skillText && content.includes(skillText)) {
      categorizedMessages.push(block("skills", skillText));
      const remainder = removeEmbedded(content, skillText);
      if (remainder.trim()) categorizedMessages.push(block("conversation", `${message?.role || ""}\n${remainder}`));
    } else {
      categorizedMessages.push(block("conversation", `${message?.role || ""}\n${content}`));
    }
  }
  const skillAlreadyCounted = categorizedMessages.some((item) => item.category === "skills");
  return [
    block("system", systemOnly),
    ...categorizedMessages,
    block("documents", documentText),
    ...(skillAlreadyCounted ? [] : [block("skills", skillText)]),
    ...attachments.map((attachment) => block("attachments", attachment?.text || attachment?.dataUrl || attachment?.relativePath || attachment?.name || "")),
  ].filter((item) => item.characters > 0);
};

export const buildUsageRecord = ({
  taskId = "",
  requestId = taskId,
  stage = "",
  protocol = "",
  provider = "",
  model = "",
  usage = null,
  blocks = [],
  previousHashes = [],
  startedAt = "",
  completedAt = new Date().toISOString(),
} = {}) => {
  const normalizedUsage = normalizeProviderUsage(usage);
  const known = new Set(previousHashes.map(String));
  const totalCharacters = blocks.reduce((sum, item) => sum + Math.max(0, Number(item.characters) || 0), 0);
  const repeatedCharacters = blocks.reduce((sum, item) => sum + (known.has(item.hash) ? Math.max(0, Number(item.characters) || 0) : 0), 0);
  const inputTokens = normalizedUsage?.inputTokens ?? 0;
  const byCategoryCharacters = {};
  for (const item of blocks) byCategoryCharacters[item.category] = (byCategoryCharacters[item.category] || 0) + item.characters;
  const categoryTokens = Object.fromEntries(Object.entries(byCategoryCharacters).map(([category, characters]) => [
    category,
    inputTokens && totalCharacters ? Math.round(inputTokens * (characters / totalCharacters)) : null,
  ]));
  return {
    schemaVersion: 1,
    taskId: String(taskId),
    requestId: String(requestId),
    stage: String(stage),
    protocol: String(protocol),
    provider: String(provider),
    model: String(model),
    startedAt: String(startedAt),
    completedAt: String(completedAt),
    usage: normalizedUsage,
    categoryCharacters: byCategoryCharacters,
    categoryTokens,
    inputCharacters: totalCharacters,
    repeatedCharacters,
    duplicateContextRatio: totalCharacters ? repeatedCharacters / totalCharacters : 0,
    hashes: blocks.map((item) => item.hash),
    measurement: normalizedUsage ? "provider_actual_with_proportional_category_attribution" : "characters_only_no_token_estimate",
  };
};

export const summarizeTaskUsage = (records = []) => {
  const source = Array.isArray(records) ? records : [];
  const actual = source.filter((item) => item?.usage);
  const totals = actual.reduce((sum, item) => ({
    inputTokens: sum.inputTokens + number(item.usage.inputTokens),
    outputTokens: sum.outputTokens + number(item.usage.outputTokens),
    reasoningTokens: sum.reasoningTokens + number(item.usage.reasoningTokens),
    cachedInputTokens: sum.cachedInputTokens + number(item.usage.cachedInputTokens),
    cacheWriteTokens: sum.cacheWriteTokens + number(item.usage.cacheWriteTokens),
    totalTokens: sum.totalTokens + number(item.usage.totalTokens),
    actualCost: sum.actualCost + number(item.usage.actualCost),
  }), { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, totalTokens: 0, actualCost: 0 });
  const inputCharacters = source.reduce((sum, item) => sum + number(item.inputCharacters), 0);
  const repeatedCharacters = source.reduce((sum, item) => sum + number(item.repeatedCharacters), 0);
  return {
    calls: source.length,
    callsWithProviderUsage: actual.length,
    ...totals,
    inputCharacters,
    repeatedCharacters,
    duplicateContextRatio: inputCharacters ? repeatedCharacters / inputCharacters : 0,
    actualCostAvailable: actual.some((item) => item.usage.actualCost !== null),
  };
};
