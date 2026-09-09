import { claudeCodeCommandArgs, launchClaudeCode, parseClaudeCodeJsonResult, resolveLocalClaudeCodeLaunch } from "../cli/claude-code-launch.mjs";
import { deepSeekAgentContextText } from "./deepseek-opencode-agent-runner.mjs";
import { buildExecutionSourceReceiptFromContextBlocks } from "./execution-source-proof.mjs";
import { normalizeAgentPermissionMode } from "../agent-permission-policy.js";
import { toolsWithPermissionPrompt } from "./agent-permission-prompt-tools.mjs";
import { startConversationAgentMcp } from "./conversation-agent-mcp.mjs";

const safeError = (value = "") => String(value || "Claude Code 调用失败")
  .replace(/\b(?:sk-ant|sk)[-_][A-Za-z0-9_-]{10,}\b/giu, "[REDACTED]")
  .replace(/[\r\n]+/gu, " ")
  .trim()
  .slice(0, 4_000);

export const probeClaudeCodeSessionCapabilities = () => Object.freeze({
  resume: true,
  fork: false,
  reason: "claude_code_session_id_supported",
});

const claudeCodeProviderEnvironment = ({
  provider = "Claude",
  baseUrl = "",
  apiKey = "",
  credentialSource = "claude",
  model = "",
  environment = process.env,
} = {}) => {
  if (credentialSource !== "shensi") return { ...environment, DISABLE_AUTOUPDATER: "1" };
  const secret = String(apiKey || "").trim();
  if (!secret) throw new Error(`${provider || "模型服务商"}凭据不可用`);
  const providerId = String(provider || "Claude").trim().toLowerCase();
  const selectedModel = String(model || "").trim();
  let endpoint = String(baseUrl || "").trim().replace(/\/+$/u, "");
  if (providerId === "deepseek") {
    try {
      const parsed = new URL(endpoint || "https://api.deepseek.com/anthropic");
      endpoint = parsed.hostname.toLowerCase() === "api.deepseek.com"
        ? `${parsed.origin}/anthropic`
        : endpoint || parsed.toString().replace(/\/+$/u, "");
    } catch {
      throw new Error("DeepSeek Anthropic 兼容地址无效");
    }
  }
  if (!/^https?:\/\//iu.test(endpoint)) throw new Error("Claude Code 模型服务地址必须是 HTTP(S) 地址");
  return {
    ...environment,
    DISABLE_AUTOUPDATER: "1",
    ANTHROPIC_BASE_URL: endpoint,
    ANTHROPIC_AUTH_TOKEN: secret,
    ...(selectedModel ? {
      ANTHROPIC_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: providerId === "deepseek" ? "deepseek-v4-flash" : selectedModel,
      CLAUDE_CODE_SUBAGENT_MODEL: providerId === "deepseek" ? "deepseek-v4-flash" : selectedModel,
    } : {}),
    ...(providerId === "deepseek" ? { CLAUDE_CODE_EFFORT_LEVEL: "max" } : {}),
  };
};

export const runClaudeCodeAgentTurn = async ({
  prompt = "",
  model = "",
  provider = "Claude",
  baseUrl = "",
  apiKey = "",
  credentialSource = "claude",
  cwd = "",
  cliPath = "claude",
  maxTurns = 8,
  permissionMode = "default",
  agentPermissionMode = "",
  permissionContract = null,
  nativeHost = null,
  requestApproval = null,
  allowEdits = false,
  allowNetwork = false,
  contextBlocks = [],
  environment = process.env,
  signal = null,
  timeoutMs = 1_800_000,
  launch = launchClaudeCode,
} = {}) => {
  const accessMode = normalizeAgentPermissionMode(permissionContract?.mode || agentPermissionMode);
  const nativePermissionMode = accessMode === "full_access" ? "bypassPermissions"
    : accessMode === "approval_required" ? "default"
      : ["dontAsk", "plan"].includes(permissionMode) ? permissionMode : "dontAsk";
  const resources = deepSeekAgentContextText(contextBlocks);
  const finalPrompt = [
    "You are the Claude Code Agent embedded in Shensi. Follow the current user instruction and the verified Shensi product contract.",
    accessMode === "shensi_only"
      ? "Own the full task through the shensi MCP tools only. They preserve complete document history. Direct filesystem, shell, web, ambient plugin, Skill and subagent tools are unavailable."
      : "Native tools, configured Skills, plugins, hooks, MCP servers and subagents may be used when the task needs them. Mutations to Shensi-managed documents and assets must still use shensi MCP tools so history and revision checks remain authoritative.",
    accessMode === "approval_required"
      ? "Protected native operations are approved one at a time through Shensi. Wait for each decision and never reuse it for another operation."
      : accessMode === "full_access"
        ? "The user selected full access for this task. Use the current system account capabilities autonomously, while preserving unrelated work and the explicit task scope."
        : allowEdits ? "Workspace changes are authorized only through Shensi tools." : "Do not change host files.",
    allowNetwork ? "Public web access is allowed without bypassing access controls." : "Do not add network activity unless the task contract explicitly permits it.",
    String(prompt || "").trim(),
    resources ? `神思提供的本轮受控上下文：\n${resources}` : "",
  ].filter(Boolean).join("\n\n");
  const executionSourceReceipt = buildExecutionSourceReceiptFromContextBlocks({
    finalInput: finalPrompt,
    blocks: contextBlocks,
    stage: "claude_code_agent_final_input",
  });
  const providerEnvironment = claudeCodeProviderEnvironment({ provider, baseUrl, apiKey, credentialSource, model, environment });
  let executable = String(cliPath || "claude").trim() || "claude";
  let prefixArgs = [];
  if (launch === launchClaudeCode) {
    const resolved = await resolveLocalClaudeCodeLaunch({
      environment: { ...providerEnvironment, SHENSI_CLAUDE_CODE_EXECUTABLE: executable },
    });
    executable = resolved.executable;
    prefixArgs = resolved.prefixArgs || [];
  }
  let ownedPermissionHost = null;
  try {
    let effectiveNativeHost = nativeHost;
    if (accessMode === "approval_required" && !effectiveNativeHost) {
      if (typeof requestApproval !== "function") throw new Error("操作需确认模式缺少神思审批通道");
      ownedPermissionHost = await startConversationAgentMcp({
        tools: toolsWithPermissionPrompt({ dynamicTools: [] }, requestApproval),
        signal,
      });
      effectiveNativeHost = ownedPermissionHost;
    }
    let args = claudeCodeCommandArgs({ prompt: finalPrompt, model, maxTurns, permissionMode: nativePermissionMode });
    if (accessMode === "shensi_only") {
      // Claude Code's --safe-mode also disables an explicitly supplied MCP
      // server, which would remove the only Shensi workspace tool surface.
      // An empty settings-source list blocks user/project/local settings while
      // still allowing the one strict MCP config passed below.
      args.push("--setting-sources", "", "--disable-slash-commands", "--no-chrome", "--no-session-persistence");
    }
    if (effectiveNativeHost) {
      if (accessMode === "shensi_only") args.push("--tools", "", "--strict-mcp-config");
      args.push("--mcp-config", JSON.stringify({ mcpServers: { shensi: { type: "http", url: effectiveNativeHost.url, headers: effectiveNativeHost.headers } } }));
      // `--allowedTools` is an automatic allow-list. Applying it to the
      // approval tier would silently bypass confirmation for Shensi mutation
      // tools, so only the deny-by-default tier receives it.
      if (accessMode === "shensi_only") args.push("--allowedTools", "mcp__shensi__*");
      if (accessMode === "approval_required") args.push("--permission-prompt-tool", "mcp__shensi__permission_prompt");
    }
    if (accessMode === "full_access") args.push("--dangerously-skip-permissions");
    args = [...prefixArgs, ...args];
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener?.("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Claude Code 调用超时")), Math.max(5_000, Math.min(3_600_000, Number(timeoutMs) || 1_800_000)));
    let result;
    try {
      result = await launch(executable, args, {
        cwd: String(cwd || "").trim() || process.cwd(),
        environment: providerEnvironment,
        signal: controller.signal,
        shell: false,
        windowsHide: true,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", abort);
    }
    if (Number(result?.exitCode) !== 0) throw new Error(`Claude Code 退出码 ${result?.exitCode ?? "?"}：${safeError(result?.stderr)}`);
    return {
      ...parseClaudeCodeJsonResult(result?.stdout),
      actualProvider: String(provider || "anthropic").trim().toLowerCase(),
      actualModel: String(model || "").trim(),
      permissionMode: accessMode,
      executionSourceReceipt,
    };
  } finally {
    await ownedPermissionHost?.close?.().catch(() => {});
  }
};
