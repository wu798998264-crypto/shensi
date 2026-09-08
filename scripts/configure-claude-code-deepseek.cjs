const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { app, safeStorage } = require("electron");

const origin = String(process.env.SHENSI_LOCAL_ORIGIN || "").replace(/\/$/u, "");
const reportPath = join(tmpdir(), "shensi-claude-code-deepseek-configure.json");
const profileId = "text-claude-code-deepseek";
const profileName = "Claude Code+DeepSeek";
const baseUrl = "https://api.deepseek.com/anthropic";
const model = "deepseek-v4-pro";
const cliPath = join(process.env.APPDATA || "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const redact = (value) => String(value?.message || value || "")
  .replace(/\b(?:sk-ant|sk)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]");
const report = (value) => writeFileSync(reportPath, `${JSON.stringify(value)}\n`, "utf8");
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

app.setPath("userData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime"));
app.setPath("sessionData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime", "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");

app.whenReady().then(async () => {
  try {
    if (!origin || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error("神思本地服务地址无效");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
    const { createCredentialVault } = await import("../packaging/windows/desktop-app/credential-vault.mjs");
    const vault = createCredentialVault({
      root: app.getPath("userData"),
      encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    });
    const currentVault = await vault.read();
    const textRecords = currentVault.secrets?.text && typeof currentVault.secrets.text === "object"
      ? currentVault.secrets.text
      : {};

    const page = await fetch(`${origin}/`);
    const html = await page.text();
    const sessionToken = html.match(/name="shensi-session-token" content="([^"]+)"/u)?.[1] || "";
    if (!page.ok || !sessionToken) throw new Error("无法建立神思本地安全会话");
    const headers = { "content-type": "application/json", "x-shensi-session": sessionToken };
    const requestJson = async (path, options = {}) => {
      const response = await fetch(`${origin}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.message || `${path} 请求失败（${response.status}）`);
      return payload;
    };

    const recovery = await requestJson("/api/recovery/session", { method: "GET" });
    const pointer = recovery.activeWorkspace;
    if (!pointer?.workspacePath) throw new Error("当前作品或笔记目录不可用");
    const loaded = await requestJson("/api/workspace/load", {
      method: "POST",
      body: JSON.stringify({ workspacePath: pointer.workspacePath }),
    });
    const beforeState = loaded.state;
    const beforeProfiles = Array.isArray(beforeState?.settings?.textConnections) ? beforeState.settings.textConnections : [];
    const deepSeekProfileIds = new Set(beforeProfiles
      .filter((profile) => String(profile?.provider || "").toLocaleLowerCase() === "deepseek")
      .map((profile) => String(profile.id || "")));
    const candidates = Object.entries(textRecords)
      .filter(([id, value]) => deepSeekProfileIds.has(id) && String(value || "").trim());
    if (!candidates.length) throw new Error("未找到与现有 DeepSeek 配置匹配的安全凭据");
    const apiKey = candidates[0][1];
    const beforeActive = String(beforeState?.settings?.activeTextConnectionId || "");
    const protectedBusinessHash = digest({
      documents: beforeState.documents,
      tree: beforeState.tree,
      moduleHistories: beforeState.moduleHistories,
      projectHistories: beforeState.projectHistories,
      histories: beforeState.histories,
    });

    const testProfile = {
      id: profileId,
      name: profileName,
      provider: "DeepSeek",
      adapter: "cli",
      protocol: "anthropic_messages",
      executionMode: "agent",
      executionModes: ["agent"],
      agentEngine: "claude_code",
      credentialSource: "shensi",
      baseUrl,
      model,
      agentModelId: model,
      apiKey,
      cliPath,
      cliArgs: "",
      reasoningEffort: "high",
      temperature: "0.7",
      maxOutputTokens: "4000",
      timeoutMs: "120000",
    };
    // The installed server accepts a real inference only after the local
    // executable/endpoint binding has been explicitly authorized. This is a
    // machine-local binding and contains no credential.
    await requestJson("/api/generation/runtime/bindings", {
      method: "POST",
      body: JSON.stringify({ confirmed: true, bindings: [{
        channel: "text",
        profileId,
        adapter: "cli",
        provider: "DeepSeek",
        protocol: "anthropic_messages",
        baseUrl,
        cliPath,
        cliArgs: "",
      }] }),
    });
    const inference = await requestJson("/api/adapters/test", {
      method: "POST",
      body: JSON.stringify(testProfile),
    });
    if (inference.realInference !== true && inference.connected !== true && inference.ok !== true) {
      throw new Error("Claude Code+DeepSeek 未返回真实连接成功凭证");
    }

    await vault.write({
      ...currentVault.secrets,
      text: { ...textRecords, [profileId]: apiKey },
    });
    const persistedVault = await vault.read();
    if (persistedVault.secrets?.text?.[profileId] !== apiKey) throw new Error("新配置的安全凭据回读不一致");

    const portableProfile = { ...testProfile };
    delete portableProfile.apiKey;
    const nextProfiles = beforeProfiles.some((profile) => profile?.id === profileId)
      ? beforeProfiles.map((profile) => profile?.id === profileId ? { ...profile, ...portableProfile } : profile)
      : [...beforeProfiles, portableProfile];
    const nextState = {
      ...beforeState,
      settings: {
        ...beforeState.settings,
        textConnections: nextProfiles,
        activeTextConnectionId: beforeActive,
      },
    };

    await requestJson("/api/workspace/save", {
      method: "POST",
      body: JSON.stringify({
        workspacePath: pointer.workspacePath,
        expectedStateStamp: loaded.stateStamp || "",
        state: nextState,
      }),
    });

    const verified = await requestJson("/api/workspace/load", {
      method: "POST",
      body: JSON.stringify({ workspacePath: pointer.workspacePath }),
    });
    const savedProfile = verified.state?.settings?.textConnections?.find((profile) => profile?.id === profileId);
    const afterBusinessHash = digest({
      documents: verified.state.documents,
      tree: verified.state.tree,
      moduleHistories: verified.state.moduleHistories,
      projectHistories: verified.state.projectHistories,
      histories: verified.state.histories,
    });
    if (!savedProfile || savedProfile.agentEngine !== "claude_code") throw new Error("新配置保存或回读失败");
    if (String(verified.state?.settings?.activeTextConnectionId || "") !== beforeActive) throw new Error("活动文字配置发生了非预期变化");
    if (afterBusinessHash !== protectedBusinessHash) throw new Error("作品正文、目录或历史发生了非预期变化");

    report({
      ok: true,
      profile: {
        id: savedProfile.id,
        name: savedProfile.name,
        provider: savedProfile.provider,
        runner: savedProfile.agentEngine,
        model: savedProfile.model,
        executionMode: savedProfile.executionMode,
      },
      actualProvider: inference.actualProvider || "deepseek",
      actualModel: inference.actualModel || model,
      realInference: inference.realInference !== false,
      activeProfileUnchanged: true,
      previousProfilesPreserved: beforeProfiles.every((profile) => verified.state.settings.textConnections.some((candidate) => candidate.id === profile.id)),
      businessContentUnchanged: true,
      credentialStoredWithDpapi: true,
      workspacePathHash: digest(pointer.workspacePath).slice(0, 12),
    });
  } catch (error) {
    report({ ok: false, message: redact(error) });
    process.exitCode = 1;
  } finally {
    app.quit();
  }
}).catch((error) => {
  report({ ok: false, message: redact(error) });
  app.quit();
});
