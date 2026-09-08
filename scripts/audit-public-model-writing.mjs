import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installedRoot = resolve(process.env.LOCALAPPDATA || "", "Programs", "Shensi", "resources", "app");
const runtimeRoot = process.env.SHENSI_PUBLIC_MODEL_RUNTIME_ROOT
  ? resolve(process.env.SHENSI_PUBLIC_MODEL_RUNTIME_ROOT)
  : installedRoot;
const outputPath = process.argv[2]
  ? resolve(process.argv[2])
  : join(root, "artifacts", "public-model-writing-audit.json");

const [{ runModelAdapter }, { freePublicModels }] = await Promise.all([
  import(pathToFileURL(join(runtimeRoot, "src", "server", "adapters.mjs")).href),
  import(pathToFileURL(join(runtimeRoot, "src", "public-model-catalog.js")).href),
]);

const baseUrl = "https://api.kilo.ai/api/openrouter";
const modelCatalogResponse = await fetch(`${baseUrl}/models`, {
  headers: { Accept: "application/json" },
  signal: AbortSignal.timeout(20_000),
});
const modelCatalogPayload = await modelCatalogResponse.json().catch(() => ({}));
if (!modelCatalogResponse.ok) {
  throw new Error(modelCatalogPayload?.error?.message || `免费模型目录读取失败（${modelCatalogResponse.status}）`);
}

const catalog = Array.isArray(modelCatalogPayload.data)
  ? modelCatalogPayload.data
  : Array.isArray(modelCatalogPayload.models)
    ? modelCatalogPayload.models
    : [];
const requestedModelIds = new Set(String(process.env.SHENSI_PUBLIC_MODEL_IDS || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const models = freePublicModels(catalog)
  .map((item) => String(item.id || item.name || item.baseModelId || "").trim())
  .filter(Boolean)
  .filter((model) => !requestedModelIds.size || requestedModelIds.has(model));
const maximumOutputTokens = String(Math.max(256, Number(process.env.SHENSI_PUBLIC_MODEL_MAX_TOKENS) || 10_000));
const requestTimeoutMs = String(Math.max(5_000, Number(process.env.SHENSI_PUBLIC_MODEL_TIMEOUT_MS) || 120_000));
const maximumAttempts = Math.max(1, Math.min(3, Number(process.env.SHENSI_PUBLIC_MODEL_ATTEMPTS) || 2));
const system = [
  "你是一名中文类型小说作者。",
  "严格完成用户要求，只输出小说标题与正文，不解释写作过程，不附加评分或创作说明。",
  "禁止使用 Markdown 列表。",
].join("\n");
const prompt = [
  "写一篇 450 至 650 个中文字符的近未来悬疑微型小说。",
  "必须自然包含三个要素：废弃火车站、会说话的纸鹤、倒计时。",
  "标题单独一行；正文至少 5 段；至少包含两句人物对话。",
  "结尾必须完成一次由前文伏笔支撑的反转，不能用梦境或失忆敷衍。",
].join("\n");

const wait = (milliseconds) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
const transientFailure = (message) => /(?:PROVIDER_NETWORK_FAILED|HTTP_(?:429|500|502|503|504)|429|500|502|503|504|temporarily unavailable|timeout|超时|fetch failed|系统代理链路失败|ECONNRESET|ETIMEDOUT)/iu.test(message);
const chineseCharacters = (text) => text.match(/[\u3400-\u9fff]/gu)?.length || 0;
const paragraphs = (text) => text.split(/\n\s*\n|\n/u).map((item) => item.trim()).filter(Boolean);
const dialogueCount = (text) => text.match(/[“"][^”"\n]{1,120}[”"]/gu)?.length || 0;

const scoreText = (value) => {
  const text = String(value || "").trim();
  const chineseCount = chineseCharacters(text);
  const paragraphCount = paragraphs(text).length;
  const requirements = ["火车站", "纸鹤", "倒计时"].filter((keyword) => text.includes(keyword));
  const titleLine = paragraphs(text)[0] || "";
  const noMeta = !/(?:创作说明|写作思路|以下是|作为AI|无法满足|Markdown)/iu.test(text);
  const analysisOnly = /(?:Here's a thinking process|Analyze the Requirements|We need to write|Let's craft|User Safety:\s*safe|Count characters|Paragraph \d+:)/iu.test(text);
  const twist = /(?:原来|竟然|却发现|才发现|并不是|真正的|倒计时.{0,24}(?:归零|结束|停止)|直到这时)/su.test(text.slice(-260));
  const lengthScore = chineseCount >= 450 && chineseCount <= 650 ? 15
    : chineseCount >= 350 && chineseCount <= 800 ? 10
      : chineseCount >= 220 ? 5
        : 0;
  const score = (analysisOnly ? 0 : 25)
    + lengthScore
    + Math.round(requirements.length / 3 * 15)
    + (paragraphCount >= 6 ? 10 : paragraphCount >= 4 ? 6 : 0)
    + (dialogueCount >= 2 ? 10 : dialogueCount === 1 ? 5 : 0)
    + (titleLine.length > 1 && titleLine.length <= 30 ? 5 : 0)
    + (chineseCount / Math.max(text.length, 1) >= 0.45 ? 10 : 5)
    + (twist ? 5 : 0)
    + (noMeta && !analysisOnly ? 5 : 0);
  return {
    score: analysisOnly ? Math.min(20, score) : Math.min(100, score),
    chineseCharacters: chineseCount,
    paragraphCount,
    dialogueCount,
    requiredElements: requirements,
    titleLine,
    twistDetected: twist,
    cleanOutput: noMeta,
    analysisOnly,
  };
};

const results = [];
for (let index = 0; index < models.length; index += 1) {
  const model = models[index];
  let finalResult = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await runModelAdapter({
        settings: {
          id: "text-public-kilo",
          connectionId: "text-public-kilo",
          adapter: "api",
          provider: "免费模型",
          protocol: "chat_completions",
          baseUrl,
          model,
          apiKey: "",
          temperature: "0.7",
          maxOutputTokens: maximumOutputTokens,
          timeoutMs: requestTimeoutMs,
          webSearchEnabled: false,
        },
        system,
        messages: [{ role: "user", content: prompt }],
        cwd: root,
        attachments: [],
      });
      const text = String(response.text || "").trim();
      finalResult = {
        model,
        ok: Boolean(text),
        attempt,
        elapsedMs: Date.now() - startedAt,
        protocol: response.protocol || "",
        providerResponseId: response.providerResponseId || "",
        usage: response.usage || null,
        metrics: scoreText(text),
        text,
      };
      break;
    } catch (error) {
      const message = String(error?.message || error);
      finalResult = {
        model,
        ok: false,
        attempt,
        elapsedMs: Date.now() - startedAt,
        code: String(error?.code || ""),
        transient: transientFailure(`${error?.code || ""} ${message}`),
        message,
        metrics: null,
        text: "",
      };
      if (attempt < maximumAttempts && finalResult.transient) await wait(8_000);
      else break;
    }
  }
  results.push(finalResult);
  process.stdout.write(`${index + 1}/${models.length} ${model}: ${finalResult.ok ? `OK ${finalResult.metrics.score}/100` : `FAIL ${finalResult.code || finalResult.message}`}\n`);
  if (index < models.length - 1) await wait(1_500);
}

const report = {
  generatedAt: new Date().toISOString(),
  runtimeRoot,
  endpoint: baseUrl,
  maximumOutputTokens,
  requestTimeoutMs,
  prompt,
  modelCount: models.length,
  passed: results.filter((item) => item.ok).length,
  failed: results.filter((item) => !item.ok).length,
  results,
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ok: true, outputPath, modelCount: report.modelCount, passed: report.passed, failed: report.failed }));
