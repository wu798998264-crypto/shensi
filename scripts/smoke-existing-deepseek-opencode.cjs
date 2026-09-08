const { createHash } = require("node:crypto");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { app, safeStorage } = require("electron");

const reportPath = join(tmpdir(), "shensi-opencode-smoke.json");
const report = (value) => writeFileSync(reportPath, `${JSON.stringify(value)}\n`, "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const deepSeekModelCatalog = async (apiKey) => {
  const response = await fetch("https://api.deepseek.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || payload?.message || `DeepSeek 模型目录请求失败（${response.status}）`);
  const ids = (Array.isArray(payload?.data) ? payload.data : [])
    .map((item) => String(item?.id || "").trim())
    .filter(Boolean);
  if (!ids.length) throw new Error("DeepSeek 当前凭据没有返回可用模型");
  const selected = ["deepseek-chat", "deepseek-reasoner"].find((id) => ids.includes(id)) || ids[0];
  return { count: ids.length, selected };
};
const vaultPath = join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime", "Credentials", "generation-secrets.dpapi.json");
app.setPath("userData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime"));
app.setPath("sessionData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime", "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");

report({ stage: "electron_started" });
app.whenReady().then(async () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
    const beforeStat = statSync(vaultPath);
    const serialized = readFileSync(vaultPath, "utf8");
    const envelope = JSON.parse(serialized);
    const plaintext = safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64"));
    const parsed = JSON.parse(plaintext);
    const channelCounts = Object.fromEntries(Object.entries(parsed && typeof parsed === "object" ? parsed : {}).map(([channel, value]) => [channel, value && typeof value === "object" ? Object.keys(value).length : 0]));
    const records = Object.entries(parsed?.text && typeof parsed.text === "object" ? parsed.text : {}).filter(([, value]) => String(value || "").trim());
    const named = records.filter(([id]) => /deepseek/iu.test(id));
    const candidates = named.length ? named : records.length === 1 ? records : [];
    if (!candidates.length) throw new Error(`无法安全确定 DeepSeek 凭据：文字凭据共 ${records.length} 条，凭据通道计数 ${JSON.stringify(channelCounts)}`);
    report({ stage: "vault_read", credentialCandidates: candidates.length });
    const { testOpenCodeAgentConnection } = await import("../src/server/opencode-agent-runner.mjs");
    let connected = null;
    let lastError = null;
    for (let index = 0; index < candidates.length; index += 1) {
      const [id, apiKey] = candidates[index];
      try {
        const catalog = await deepSeekModelCatalog(apiKey);
        report({ stage: "deepseek_models_read", candidate: index + 1, modelCount: catalog.count });
        const result = await testOpenCodeAgentConnection({
          cwd: process.cwd(), provider: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey,
          credentialSource: "shensi", model: `deepseek/${catalog.selected}`, cliPath: "opencode", timeoutMs: 90_000,
          onProcess: () => report({ stage: "opencode_started", candidate: index + 1 }),
          onEvent: (event) => report({ stage: "opencode_event", type: String(event?.type || event?.part?.type || "unknown").slice(0, 40) }),
        });
        connected = { credentialIdHash: digest(id).slice(0, 12), provider: result.provider, model: result.model, providerModelReported: result.providerModelReported === true, replyMatched: /SHENSI_OPENCODE_OK/iu.test(result.text) };
        break;
      } catch (error) { lastError = error; }
    }
    if (!connected) throw lastError || new Error("DeepSeek OpenCode 真实连接失败");
    const afterStat = statSync(vaultPath);
    const after = readFileSync(vaultPath);
    report({ ok: true, credentialCandidates: candidates.length, ...connected, vaultUnchanged: beforeStat.mtimeMs === afterStat.mtimeMs && digest(serialized) === digest(after) });
  } catch (error) {
    report({ ok: false, message: String(error?.message || error).replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]") });
    process.exitCode = 1;
  } finally { app.quit(); }
}).catch((error) => {
  report({ ok: false, message: String(error?.message || error) });
  app.quit();
});
