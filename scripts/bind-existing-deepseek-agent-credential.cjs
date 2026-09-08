const { createHash } = require("node:crypto");
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { app, safeStorage } = require("electron");

const origin = String(process.env.SHENSI_LOCAL_ORIGIN || "").replace(/\/$/u, "");
const reportPath = join(tmpdir(), "shensi-deepseek-agent-credential-bind.json");
const redact = (value) => String(value?.message || value || "")
  .replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]");
const report = (value) => writeFileSync(reportPath, `${JSON.stringify(value)}\n`, "utf8");
const digest = (value) => createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);

app.setPath("userData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime"));
app.setPath("sessionData", join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime", "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");

app.whenReady().then(async () => {
  try {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error("神思本地服务地址无效");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
    const { createCredentialVault } = await import("../packaging/windows/desktop-app/credential-vault.mjs");
    const vault = createCredentialVault({
      root: app.getPath("userData"),
      encryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (value) => safeStorage.encryptString(value),
      decryptString: (value) => safeStorage.decryptString(value),
    });
    const current = await vault.read();
    const textRecords = current.secrets?.text && typeof current.secrets.text === "object"
      ? current.secrets.text
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
    const recovery = await requestJson("/api/recovery/session");
    const workspacePath = recovery.activeWorkspace?.workspacePath;
    if (!workspacePath) throw new Error("当前作品或笔记目录不可用");
    const loaded = await requestJson("/api/workspace/load", {
      method: "POST",
      body: JSON.stringify({ workspacePath }),
    });
    const profiles = Array.isArray(loaded.state?.settings?.textConnections)
      ? loaded.state.settings.textConnections
      : [];
    const deepSeekProfiles = profiles.filter((profile) => String(profile?.provider || "").trim().toLocaleLowerCase() === "deepseek");
    const agentProfiles = deepSeekProfiles.filter((profile) => profile?.adapter === "cli"
      && ["deepseek_opencode", "opencode", "claude_code"].includes(String(profile?.agentEngine || "")));
    if (!agentProfiles.length) throw new Error("当前工作区没有可绑定的 DeepSeek Agent 配置");

    const donorProfiles = deepSeekProfiles.filter((profile) => String(textRecords[String(profile?.id || "")] || "").trim());
    const apiDonor = donorProfiles.find((profile) => profile.adapter === "api");
    const donorValues = [...new Set(donorProfiles.map((profile) => String(textRecords[profile.id] || "").trim()).filter(Boolean))];
    const credential = apiDonor ? String(textRecords[apiDonor.id] || "").trim() : donorValues.length === 1 ? donorValues[0] : "";
    if (!credential) throw new Error(donorValues.length > 1
      ? "检测到多个不同的 DeepSeek 安全凭据，无法在无人确认时自动选择"
      : "未找到与当前 DeepSeek 配置匹配的安全凭据");

    const modelResponse = await fetch("https://api.deepseek.com/v1/models", {
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    const modelPayload = await modelResponse.json().catch(() => ({}));
    if (!modelResponse.ok || !Array.isArray(modelPayload?.data) || !modelPayload.data.length) {
      throw new Error(modelPayload?.error?.message || modelPayload?.message || `DeepSeek 凭据核验失败（${modelResponse.status}）`);
    }

    const nextTextRecords = { ...textRecords };
    const boundIds = [];
    const alreadyBoundIds = [];
    for (const profile of agentProfiles) {
      const profileId = String(profile.id || "").trim();
      if (!profileId) continue;
      if (String(nextTextRecords[profileId] || "") === credential) alreadyBoundIds.push(profileId);
      else {
        nextTextRecords[profileId] = credential;
        boundIds.push(profileId);
      }
    }
    if (boundIds.length) {
      await vault.write({ ...current.secrets, text: nextTextRecords });
    }
    const verified = await vault.read();
    if (!agentProfiles.every((profile) => verified.secrets?.text?.[profile.id] === credential)) {
      throw new Error("DeepSeek Agent 安全凭据回读不一致");
    }
    report({
      ok: true,
      provider: "DeepSeek",
      modelCatalogVerified: true,
      modelCount: modelPayload.data.length,
      agentProfiles: agentProfiles.map((profile) => ({ id: profile.id, idHash: digest(profile.id), engine: profile.agentEngine })),
      boundCount: boundIds.length,
      alreadyBoundCount: alreadyBoundIds.length,
      credentialStoredWithDpapi: true,
      workspaceContentChanged: false,
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
