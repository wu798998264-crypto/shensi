const { createHash } = require("node:crypto");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { app, safeStorage } = require("electron");

const reportPath = join(tmpdir(), "shensi-claude-code-deepseek-smoke.json");
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
    const envelope = JSON.parse(serialized);
    const plaintext = safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64"));
    const parsed = JSON.parse(plaintext);
    const records = Object.entries(parsed?.text && typeof parsed.text === "object" ? parsed.text : {})
      .filter(([, value]) => String(value || "").trim());
    const named = records.filter(([id]) => /deepseek/iu.test(id));
    const candidates = named.length ? named : records.length === 1 ? records : [];
    if (!candidates.length) throw new Error(`无法安全确定 DeepSeek 凭据：文字凭据共 ${records.length} 条`);
    const { runClaudeCodeAgentTurn } = await import("../src/server/claude-code-agent-runner.mjs");
    let connected = null;
    let lastError = null;
    for (const [id, apiKey] of candidates) {
      try {
        const result = await runClaudeCodeAgentTurn({
          prompt: "Reply with exactly SHENSI_CLAUDE_DEEPSEEK_OK.",
          provider: "DeepSeek",
          baseUrl: "https://api.deepseek.com/anthropic",
          apiKey,
          credentialSource: "shensi",
          model: "deepseek-v4-pro[1m]",
          cliPath: "claude",
          cwd: process.cwd(),
          maxTurns: 1,
          permissionMode: "default",
          timeoutMs: 120_000,
        });
        connected = {
          credentialIdHash: digest(id).slice(0, 12),
          provider: result.actualProvider,
          model: result.actualModel,
          replyMatched: /SHENSI_CLAUDE_DEEPSEEK_OK/iu.test(result.text),
        };
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!connected?.replyMatched) throw lastError || new Error("Claude Code+DeepSeek 真实连接失败");
    const afterStat = statSync(vaultPath);
    const after = readFileSync(vaultPath);
    report({
      ok: true,
      credentialCandidates: candidates.length,
      ...connected,
      vaultUnchanged: beforeStat.mtimeMs === afterStat.mtimeMs && digest(serialized) === digest(after),
    });
  } catch (error) {
    report({ ok: false, message: String(error?.message || error).replace(/\b(?:sk-ant|sk)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]") });
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}).catch((error) => {
  report({ ok: false, message: String(error?.message || error) });
  app.quit();
});
