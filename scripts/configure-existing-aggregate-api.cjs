const { createHash } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { app, safeStorage } = require("electron");

const origin = String(process.env.SHENSI_LOCAL_ORIGIN || "").replace(/\/$/u, "");
const desktopRoot = join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime");
const sidecarConfigPath = join(process.env.USERPROFILE || "", ".antigravity_cockpit", "codex_local_access_sidecar", "config.json");
const reportPath = join(tmpdir(), "shensi-aggregate-api-configure.json");
const digest = (value) => createHash("sha256").update(String(value || "")).digest("hex");
const report = (value) => writeFileSync(reportPath, `${JSON.stringify(value)}\n`, "utf8");
const redact = (value) => String(value?.message || value || "")
  .replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]");

app.setPath("userData", desktopRoot);
app.setPath("sessionData", join(desktopRoot, "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");

app.whenReady().then(async () => {
  try {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error("神思本地服务地址无效");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
    const sidecar = JSON.parse(readFileSync(sidecarConfigPath, "utf8"));
    const currentKey = (Array.isArray(sidecar?.["api-keys"]) ? sidecar["api-keys"] : [])
      .map(String).map((value) => value.trim()).find(Boolean);
    if (!currentKey) throw new Error("Cockpit 当前没有可用的本机访问令牌");

    const page = await fetch(`${origin}/`);
    const html = await page.text();
    const sessionToken = html.match(/name="shensi-session-token" content="([^"]+)"/u)?.[1] || "";
    if (!page.ok || !sessionToken) throw new Error("无法建立神思本地安全会话");
    const headers = { "content-type": "application/json", "x-shensi-session": sessionToken };
    const requestJson = async (path, options = {}) => {
      const response = await fetch(`${origin}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw Object.assign(new Error(payload.message || `${path} 请求失败（${response.status}）`), { payload });
      return payload;
    };
    const recovery = await requestJson("/api/recovery/session");
    const workspacePath = recovery.activeWorkspace?.workspacePath;
    if (!workspacePath) throw new Error("当前工作区不可用");
    const loaded = await requestJson("/api/workspace/load", { method: "POST", body: JSON.stringify({ workspacePath }) });
    const runtime = await requestJson("/api/generation/runtime/bindings");
    const aggregateBinding = (runtime.bindings || []).find((item) => item?.channel === "text"
      && /^http:\/\/127\.0\.0\.1:5317(?:\/|$)/u.test(String(item?.baseUrl || "")));
    if (!aggregateBinding?.profileId) throw new Error("没有找到 Cockpit 聚合 API 运行时绑定");
    const state = loaded.state;
    const profiles = Array.isArray(state?.settings?.textConnections) ? state.settings.textConnections : [];
    const profileIndex = profiles.findIndex((item) => item?.id === aggregateBinding.profileId);
    if (profileIndex < 0) throw new Error("聚合 API 运行时绑定与当前工作区配置不一致");
    const documentsBefore = digest(JSON.stringify(state.documents || {}));
    const model = String(profiles[profileIndex]?.model || "gpt-5.6-sol").trim() || "gpt-5.6-sol";
    const configuredProfile = {
      ...profiles[profileIndex],
      remarkName: "聚合api",
      provider: "自定义兼容接口",
      adapter: "api",
      protocol: "responses",
      baseUrl: "http://127.0.0.1:5317/v1",
      model,
      agentEngine: "codex_api",
      executionMode: "agent",
      executionModes: ["agent"],
      credentialSource: "shensi",
      agentModelId: model,
      cliPath: "",
      cliArgs: "",
      draft: false,
    };
    const nextSettings = {
      ...state.settings,
      textConnections: profiles.map((item, index) => index === profileIndex ? configuredProfile : item),
      activeTextConnectionId: configuredProfile.id,
      activeTextAgentConnectionId: configuredProfile.id,
      adapter: "api",
      provider: "自定义兼容接口",
      protocol: "responses",
      baseUrl: configuredProfile.baseUrl,
      model,
      cliPath: "",
      cliArgs: "",
    };
    const nextState = { ...state, settings: nextSettings };
    await requestJson("/api/generation/runtime/bindings", {
      method: "POST",
      body: JSON.stringify({
        confirmed: true,
        bindings: (runtime.bindings || []).map((item) => item.profileId === configuredProfile.id && item.channel === "text"
          ? { ...item, adapter: "api", provider: "自定义兼容接口", protocol: "responses", baseUrl: configuredProfile.baseUrl, cliPath: "", cliArgs: "" }
          : item),
      }),
    });
    const { createCredentialVault } = await import("../packaging/windows/desktop-app/credential-vault.mjs");
    const vault = createCredentialVault({
      root: desktopRoot,
      encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    });
    await vault.update((secrets) => ({
      ...secrets,
      text: { ...(secrets.text || {}), [configuredProfile.id]: currentKey },
    }));
    await requestJson("/api/workspace/save", {
      method: "POST",
      body: JSON.stringify({ workspacePath, expectedStateStamp: loaded.stateStamp || "", state: nextState }),
    });
    const verified = await requestJson("/api/workspace/load", { method: "POST", body: JSON.stringify({ workspacePath }) });
    const verifiedProfile = (verified.state?.settings?.textConnections || []).find((item) => item?.id === configuredProfile.id);
    const verifiedVault = await vault.read();
    if (verifiedProfile?.remarkName !== "聚合api"
      || verifiedProfile?.protocol !== "responses"
      || verifiedProfile?.agentEngine !== "codex_api"
      || verifiedProfile?.executionMode !== "agent"
      || verifiedVault.secrets?.text?.[configuredProfile.id] !== currentKey) {
      throw new Error("聚合 API 配置保存后回读不一致");
    }
    report({
      ok: true,
      profileIdHash: digest(configuredProfile.id).slice(0, 12),
      remarkName: verifiedProfile.remarkName,
      provider: verifiedProfile.provider,
      model: verifiedProfile.model,
      protocol: verifiedProfile.protocol,
      agentEngine: verifiedProfile.agentEngine,
      executionModes: verifiedProfile.executionModes,
      endpoint: "127.0.0.1:5317",
      credentialStoredWithDpapi: true,
      documentsUnchanged: digest(JSON.stringify(verified.state?.documents || {})) === documentsBefore,
    });
  } catch (error) {
    report({ ok: false, message: redact(error) });
    process.exitCode = 1;
  } finally { app.quit(); }
}).catch((error) => { report({ ok: false, message: redact(error) }); app.quit(); });
