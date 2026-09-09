import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createShensiCodexAgentRuntime } from "./shensi-codex-agent-runtime.mjs";
import { startCodexProviderBridge } from "./codex-provider-bridge.mjs";
import { nativeCodexEnvironment } from "./codex-runtime-isolation.mjs";
import { normalizeAgentPermissionMode } from "../agent-permission-policy.js";
import { requestAgentCapabilityApproval } from "./agent-permission-prompt-tools.mjs";

export const runBundledConversationAgent = async ({ appRoot, machineRoot, ...options }) => {
  const permissionMode = normalizeAgentPermissionMode(options.permissionContract?.mode || options.settings?.agentPermissionMode);
  const shensiOnly = permissionMode === "shensi_only";
  // The outer conversation service may already have resolved this protected
  // capability. An explicit boolean is an approval-state snapshot, so never
  // re-open the prompt or fall back to the mutable settings flag.
  const hasNativeWebSearchOverride = typeof options.nativeWebSearchEnabled === "boolean";
  const nativeWebSearchEnabled = shensiOnly
    ? false
    : hasNativeWebSearchOverride
      ? options.nativeWebSearchEnabled
      : options.settings?.webSearchEnabled === true
        ? await requestAgentCapabilityApproval({
          permissionMode,
          capability: "原生联网搜索",
          runner: "神思运行器",
          requestApproval: options.requestApproval,
        })
        : false;
  const triples = { "win32-x64": "x86_64-pc-windows-msvc", "win32-arm64": "aarch64-pc-windows-msvc", "linux-x64": "x86_64-unknown-linux-musl", "linux-arm64": "aarch64-unknown-linux-musl", "darwin-x64": "x86_64-apple-darwin", "darwin-arm64": "aarch64-apple-darwin" };
  const target = `${process.platform}-${process.arch}`;
  const launcher = join(appRoot, "node_modules", "@openai", `codex-${target}`, "vendor", triples[target] || "unsupported", "bin", process.platform === "win32" ? "codex.exe" : "codex");
  try { await access(launcher); } catch { throw Object.assign(new Error("安装包缺少内置 Codex 运行时；请修复安装，未回退到 Chat 或更换模型"), { code: "BUNDLED_CODEX_MISSING" }); }
  const bridge = await startCodexProviderBridge({
    settings: options.settings,
    tools: options.workspaceToolRuntime,
    permissionContract: options.permissionContract,
    signal: options.signal,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(typeof options.onProviderRequest === "function" ? { onRequest: options.onProviderRequest } : {}),
  });
  const runtimeRoot = join(machineRoot, "conversation-agent-v1", "codex", options.sessionId, randomUUID());
  const codexHome = join(runtimeRoot, "home");
  await mkdir(codexHome, { recursive: true });
  const environment = shensiOnly
    ? Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(?:PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|LOCALAPPDATA|APPDATA|USERPROFILE)$/iu.test(key)))
    : nativeCodexEnvironment();
  Object.assign(environment, { ...(shensiOnly ? { CODEX_HOME: codexHome } : {}), SHENSI_AGENT_BACKEND_TOKEN: bridge.token });
  const provider = JSON.stringify({ name: "Shensi configured model", base_url: bridge.url, wire_api: "responses", env_key: "SHENSI_AGENT_BACKEND_TOKEN", requires_openai_auth: false, request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 3_600_000 }).replace(/"([^"\\]+)":/gu, "$1=");
  const launchResolver = async () => ({ executable: launcher, prefixArgs: [
    "-c", 'model_provider="shensi"', "-c", `model_providers.shensi=${provider}`,
    "-c", nativeWebSearchEnabled ? 'web_search="live"' : 'web_search="disabled"',
    ...(shensiOnly
      ? ["-c", "features.shell_tool=false", "-c", "features.unified_exec=false", "-c", "features.remote_models=false", "-c", "features.remote_plugin=false"]
      : ["-c", "features.shell_tool=true", "-c", "features.unified_exec=true", "-c", "features.apply_patch_freeform=true"]),
  ] });
  const runtime = createShensiCodexAgentRuntime({ machineRoot: runtimeRoot, appRoot, launchResolver, environment, idleShutdownMs: 0, isolateConfig: shensiOnly });
  try {
    const result = await runtime.runStage({ settings: { ...options.settings, webSearchEnabled: false, provider: "OpenAI", adapter: "cli", cliPath: "codex", timeoutMs: Math.max(1_800_000, Number(options.settings.timeoutMs) || 0) },
      system: options.contextBlocks.map((block) => `# ${block.name}\n${block.text}`).join("\n\n"), messages: [{ role: "user", content: options.prompt }],
      shensiRuntime: { stage: "conversation_agent", sessionId: options.sessionId, agentDriven: true }, workspaceToolRuntime: options.workspaceToolRuntime,
      signal: options.signal, onToolEvent: options.onToolEvent, registerSteer: options.registerSteer,
      permissionContract: options.permissionContract, requestApproval: options.requestApproval, nativeWebSearchEnabled });
    return { ...result, agentRuntime: { ...result.agentRuntime, runtime: "bundled_codex", version: "0.146.0", model: options.settings.model, protocol: options.settings.protocol, permissionMode } };
  } finally { await runtime.close(); await bridge.close(); }
};
