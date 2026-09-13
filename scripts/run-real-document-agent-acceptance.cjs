const { createHash } = require("node:crypto");
const { readFileSync, statSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app, safeStorage } = require("electron");

const dataRoot = String(process.env.SHENSI_DATA_ROOT || "E:\\ShensiUserData");
const desktopRoot = join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime");
const vaultPath = join(desktopRoot, "Credentials", "generation-secrets.dpapi.json");
const runtimePath = join(dataRoot, "config", "generation-runtime-v1.json");
const settingsStatePath = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_SETTINGS_STATE || "").trim();
const acceptanceScript = resolve(__dirname, "test-real-document-agent-acceptance.mjs");
const digest = (value) => createHash("sha256").update(String(value || "")).digest("hex");
const redact = (value) => String(value?.message || value || "真实文档验收失败")
  .replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]");

app.setPath("userData", desktopRoot);
app.setPath("sessionData", join(desktopRoot, "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");

app.whenReady().then(async () => {
  let vaultSerialized = "";
  let beforeStat = null;
  let exitCode = 0;
  try {
    if (!settingsStatePath) throw new Error("请通过 SHENSI_DOCUMENT_ACCEPTANCE_SETTINGS_STATE 显式指定只读配置来源");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
    beforeStat = statSync(vaultPath);
    vaultSerialized = readFileSync(vaultPath, "utf8");
    const envelope = JSON.parse(vaultSerialized);
    const secrets = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64")));
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
    const state = JSON.parse(readFileSync(settingsStatePath, "utf8"));
    const textProfiles = Array.isArray(state?.settings?.textConnections) ? state.settings.textConnections : [];
    const requestedProfileId = String(process.env.SHENSI_DOCUMENT_ACCEPTANCE_PROFILE || "").trim();
    const binding = (Array.isArray(runtime?.bindings) ? runtime.bindings : []).find((item) => item?.channel === "text"
      && (!requestedProfileId || item?.profileId === requestedProfileId)
      && /^http:\/\/127\.0\.0\.1:5317(?:\/|$)/u.test(String(item?.baseUrl || ""))
      && textProfiles.some((profile) => profile?.id === item?.profileId));
    if (!binding?.profileId) throw new Error("当前作品没有找到可用于真实验收的聚合 API 文字配置");
    const apiKey = String(secrets?.text?.[binding.profileId] || "").trim();
    if (!apiKey) throw new Error("聚合 API 文字配置没有可用的安全凭据");

    process.env.SHENSI_DOCUMENT_ACCEPTANCE_PROFILE = binding.profileId;
    process.env.SHENSI_DOCUMENT_ACCEPTANCE_SETTINGS_STATE = settingsStatePath;
    process.env.SHENSI_DOCUMENT_ACCEPTANCE_RUNTIME_BINDINGS = runtimePath;
    globalThis.__SHENSI_DOCUMENT_ACCEPTANCE_API_KEY = apiKey;
    await import(pathToFileURL(acceptanceScript).href);

    const afterStat = statSync(vaultPath);
    if (beforeStat.mtimeMs !== afterStat.mtimeMs || digest(vaultSerialized) !== digest(readFileSync(vaultPath, "utf8"))) {
      throw new Error("真实验收期间安全凭据仓库发生了意外变化");
    }
  } catch (error) {
    console.error(redact(error));
    exitCode = 1;
  } finally {
    delete globalThis.__SHENSI_DOCUMENT_ACCEPTANCE_API_KEY;
    app.exit(exitCode);
  }
}).catch((error) => {
  delete globalThis.__SHENSI_DOCUMENT_ACCEPTANCE_API_KEY;
  console.error(redact(error));
  app.exit(1);
});
