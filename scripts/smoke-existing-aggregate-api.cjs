const { createHash } = require("node:crypto");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");
const { tmpdir } = require("node:os");
const { app, safeStorage } = require("electron");

const origin = String(process.env.SHENSI_LOCAL_ORIGIN || "").replace(/\/$/u, "");
const dataRoot = String(process.env.SHENSI_DATA_ROOT || "E:\\ShensiUserData");
const desktopRoot = join(process.env.LOCALAPPDATA || "", "ShensiCreativeEngine-DesktopRuntime");
const vaultPath = join(desktopRoot, "Credentials", "generation-secrets.dpapi.json");
const runtimePath = join(dataRoot, "config", "generation-runtime-v1.json");
const sidecarConfigPath = join(process.env.USERPROFILE || "", ".antigravity_cockpit", "codex_local_access_sidecar", "config.json");
const reportPath = join(tmpdir(), "shensi-aggregate-api-smoke.json");
const testedAppRoot = String(process.env.SHENSI_APP_ROOT || join(__dirname, "..")).trim();
const digest = (value) => createHash("sha256").update(String(value || "")).digest("hex");
const redact = (value) => String(value?.message || value || "")
  .replace(/\b(?:sk|ds|api)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]");
const report = (value) => writeFileSync(reportPath, `${JSON.stringify(value)}\n`, "utf8");

app.setPath("userData", desktopRoot);
app.setPath("sessionData", join(desktopRoot, "Session"));
app.setName("神思");
app.setAppUserModelId("com.shensi.creativeengine");

app.whenReady().then(async () => {
  try {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error("神思本地服务地址无效");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 当前不可用");
    const beforeStat = statSync(vaultPath);
    const vaultSerialized = readFileSync(vaultPath, "utf8");
    const envelope = JSON.parse(vaultSerialized);
    const secrets = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, "base64")));
    const runtime = JSON.parse(readFileSync(runtimePath, "utf8"));
    const runtimeProfiles = Array.isArray(runtime.bindings) ? runtime.bindings : [];
    const aggregateRuntime = runtimeProfiles.find((profile) => profile?.channel === "text"
      && /^http:\/\/127\.0\.0\.1:5317(?:\/|$)/u.test(String(profile?.baseUrl || "")));
    if (!aggregateRuntime?.profileId) throw new Error("未登记本机聚合 API 运行时配置");

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
    if (!workspacePath) throw new Error("当前工作区不可用");
    const loaded = await requestJson("/api/workspace/load", {
      method: "POST",
      body: JSON.stringify({ workspacePath }),
    });
    const profiles = Array.isArray(loaded.state?.settings?.textConnections)
      ? loaded.state.settings.textConnections
      : [];
    const profile = profiles.find((item) => item?.id === aggregateRuntime.profileId);
    if (!profile) throw new Error("聚合 API 运行时绑定与当前工作区配置不一致");
    const storedApiKey = String(secrets?.text?.[profile.id] || "").trim();
    if (!storedApiKey) throw new Error("聚合 API 尚未绑定安全凭据");
    const sidecarConfig = JSON.parse(readFileSync(sidecarConfigPath, "utf8"));
    const sidecarKeys = Array.isArray(sidecarConfig?.["api-keys"])
      ? sidecarConfig["api-keys"].map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    const useCurrentCockpitKey = /^(?:1|true)$/iu.test(String(process.env.SHENSI_USE_COCKPIT_CURRENT_KEY || ""));
    if (!sidecarKeys.includes(storedApiKey) && !useCurrentCockpitKey) throw new Error("神思保存的聚合 API Key 与当前 Cockpit 服务访问令牌不一致");
    const apiKey = useCurrentCockpitKey ? sidecarKeys[0] : storedApiKey;
    if (!apiKey) throw new Error("Cockpit 当前没有可用的本机访问令牌");
    const model = String(profile.model || "").trim();
    if (!model) throw new Error("聚合 API 尚未选择模型");

    const effectiveSettings = {
      ...profile,
      ...aggregateRuntime,
      adapter: "api",
      provider: "自定义兼容接口",
      protocol: "responses",
      agentEngine: "codex_api",
      executionMode: "agent",
      executionModes: ["agent"],
      apiKey,
      model,
      temperature: "0",
      maxOutputTokens: "64",
      timeoutMs: "120000",
      webSearchEnabled: false,
    };
    const { runModelAdapter } = await import(pathToFileURL(join(testedAppRoot, "src", "server", "adapters.mjs")).href);
    const chatToken = `SHENSI_CHAT_OK_${Date.now().toString(36).toUpperCase()}`;
    const chatResult = await runModelAdapter({
      settings: {
        ...effectiveSettings,
      },
      system: "Connection test. Follow the exact output request.",
      messages: [{ role: "user", content: `Reply with exactly ${chatToken}` }],
      cwd: process.cwd(),
    });
    if (!String(chatResult?.text || "").includes(chatToken)) throw new Error("聚合 API Chat 返回了内容，但测试口令不匹配");
    const { createCodexApiAgentRuntime } = await import(pathToFileURL(join(testedAppRoot, "src", "server", "codex-api-agent-runtime.mjs")).href);
    const agentRuntime = createCodexApiAgentRuntime();
    const agentToken = `SHENSI_AGENT_OK_${Date.now().toString(36).toUpperCase()}`;
    const agentResult = await agentRuntime.runStage({
      settings: effectiveSettings,
      prompt: `Reply with exactly ${agentToken}`,
      contextBlocks: [],
      sessionId: `aggregate-smoke-${Date.now()}`,
      stage: "agent",
    });
    const toolToken = `SHENSI_TOOL_OK_${Date.now().toString(36).toUpperCase()}`;
    let toolInvocations = 0;
    const toolAgentResult = await agentRuntime.runStage({
      settings: effectiveSettings,
      prompt: `You must call the probe_echo tool exactly once with {"token":"${toolToken}"}. After the tool returns, reply with exactly ${toolToken}`,
      contextBlocks: [],
      sessionId: `aggregate-tool-smoke-${Date.now()}`,
      stage: "agent",
      workspaceToolRuntime: {
        dynamicTools: [{
          type: "namespace",
          name: "probe",
          description: "Read-only aggregate API Agent continuation probe",
          tools: [{
            type: "function",
            name: "echo",
            description: "Return the supplied verification token",
            inputSchema: {
              type: "object",
              properties: { token: { type: "string" } },
              required: ["token"],
              additionalProperties: false,
            },
          }],
        }],
        invoke: async ({ namespace, tool, arguments: args }) => {
          toolInvocations += 1;
          if (namespace !== "probe" || tool !== "echo" || String(args?.token || "") !== toolToken) {
            return { success: false, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: false, error: "probe mismatch" }) }] };
          }
          return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ ok: true, token: toolToken }) }] };
        },
      },
    });
    agentRuntime.close();
    if (!String(agentResult?.text || "").includes(agentToken)) throw new Error("聚合 API Agent 返回了内容，但测试口令不匹配");
    if (!String(toolAgentResult?.text || "").includes(toolToken)) throw new Error("聚合 API Agent 工具续接返回了内容，但测试口令不匹配");
    if (toolInvocations !== 1) throw new Error(`聚合 API Agent 工具实际执行 ${toolInvocations} 次，预期仅执行一次`);
    const afterStat = statSync(vaultPath);
    report({
      ok: true,
      profileIdHash: digest(profile.id).slice(0, 12),
      provider: profile.provider,
      model,
      chatProtocol: chatResult.protocol,
      agentProtocol: agentResult.protocol,
      toolAgentProtocol: toolAgentResult.protocol,
      endpoint: "127.0.0.1:5317",
      chatReplyMatched: true,
      agentReplyMatched: true,
      toolAgentReplyMatched: true,
      toolInvocations,
      active: loaded.state?.settings?.activeTextConnectionId === profile.id,
      storedKeyMatchesCockpit: sidecarKeys.includes(storedApiKey),
      credentialSource: useCurrentCockpitKey ? "cockpit_current_read_only" : "shensi_vault",
      testedAppRoot,
      vaultUnchanged: beforeStat.mtimeMs === afterStat.mtimeMs && digest(vaultSerialized) === digest(readFileSync(vaultPath, "utf8")),
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
