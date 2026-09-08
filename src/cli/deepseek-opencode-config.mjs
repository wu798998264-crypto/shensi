const SAFE_MODEL = /^[a-z0-9][a-z0-9._/-]{0,159}$/i;
const DEFAULT_MODELS = Object.freeze([
  "deepseek-chat",
  "deepseek-reasoner",
  "deepseek-v4-flash",
  "deepseek-v4-pro",
]);

export const deepSeekOpenCodeModelId = (value = "") => {
  const candidate = String(value || "deepseek-v4-pro").trim();
  if (!SAFE_MODEL.test(candidate)) throw new Error("DeepSeek CLI 模型名称包含不允许的字符");
  const modelId = candidate.includes("/") ? candidate.split("/").slice(1).join("/") : candidate;
  if (!SAFE_MODEL.test(modelId)) throw new Error("DeepSeek CLI 模型名称包含不允许的字符");
  return modelId;
};

export const qualifiedDeepSeekOpenCodeModel = (value = "") => `deepseek/${deepSeekOpenCodeModelId(value)}`;

export const deepSeekOpenCodeProviderConfig = (models = DEFAULT_MODELS) => {
  const modelIds = [...new Set((Array.isArray(models) ? models : [models]).map(deepSeekOpenCodeModelId))];
  return {
    enabled_providers: ["deepseek"],
    provider: {
      deepseek: {
        npm: "@ai-sdk/openai-compatible",
        name: "DeepSeek",
        options: {
          baseURL: "https://api.deepseek.com/v1",
          apiKey: "{env:DEEPSEEK_API_KEY}",
        },
        models: Object.fromEntries(modelIds.map((modelId) => [modelId, { name: modelId }])),
      },
    },
  };
};
