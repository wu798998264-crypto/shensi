const { createHash } = require("node:crypto");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { app, safeStorage } = require("electron");

const reportPath = join(tmpdir(), "shensi-deepseek-chat-smoke.json");
const report = (value) => writeFileSync(reportPath, `${JSON.stringify(value)}\n`, "utf8");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const vaultPath = join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime", "Credentials", "generation-secrets.dpapi.json");
app.setPath("userData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime"));
app.setPath("sessionData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime", "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");

app.whenReady().then(async () => {
  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
    const beforeStat = statSync(vaultPath);
    const serialized = readFileSync(vaultPath, "utf8");
    const parsed = JSON.parse(safeStorage.decryptString(Buffer.from(JSON.parse(serialized).ciphertext, "base64")));
    const records = Object.entries(parsed?.text && typeof parsed.text === "object" ? parsed.text : {}).filter(([, value]) => String(value || "").trim());
    const candidates = records.filter(([id]) => /deepseek/iu.test(id));
    const usable = candidates.length ? candidates : records.length === 1 ? records : [];
    if (!usable.length) throw new Error(`无法安全确定 DeepSeek 凭据：文字凭据共 ${records.length} 条`);
    const { runModelAdapter } = await import("../src/server/adapters.mjs");
    let connected = null;
    let lastError = null;
    for (const [id, apiKey] of usable) {
      try {
        const token = `SHENSI_DEEPSEEK_CHAT_OK_${Date.now().toString(36).toUpperCase()}`;
        const result = await runModelAdapter({
          settings: {
            provider: "DeepSeek",
            adapter: "api",
            protocol: "chat_completions",
            baseUrl: "https://api.deepseek.com/v1",
            apiKey,
            model: "deepseek-chat",
            temperature: "0",
            maxOutputTokens: "64",
            timeoutMs: "90000",
            webSearchEnabled: false,
          },
          system: "Connection test. Follow the exact output request.",
          messages: [{ role: "user", content: `Reply with exactly ${token}` }],
          cwd: process.cwd(),
        });
        if (!String(result?.text || "").includes(token)) throw new Error("DeepSeek Chat 返回文本，但测试口令不匹配");
        connected = { credentialIdHash: digest(id).slice(0, 12), model: "deepseek-chat", protocol: result.protocol, replyMatched: true };
        break;
      } catch (error) { lastError = error; }
    }
    if (!connected) throw lastError || new Error("DeepSeek Chat 真实连接失败");
    const afterStat = statSync(vaultPath);
    report({ ok: true, ...connected, vaultUnchanged: beforeStat.mtimeMs === afterStat.mtimeMs && digest(serialized) === digest(readFileSync(vaultPath, "utf8")) });
  } catch (error) {
    report({ ok: false, message: String(error?.message || error).replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]") });
    process.exitCode = 1;
  } finally { app.quit(); }
}).catch((error) => { report({ ok: false, message: String(error?.message || error) }); app.quit(); });
