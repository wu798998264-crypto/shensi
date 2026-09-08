import { claudeCodeCommandArgs, launchClaudeCode, parseClaudeCodeJsonResult, resolveLocalClaudeCodeLaunch } from "../cli/claude-code-launch.mjs";
import { deepSeekAgentContextText } from "./deepseek-opencode-agent-runner.mjs";
import { buildExecutionSourceReceiptFromContextBlocks } from "./execution-source-proof.mjs";

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
  nativeHost = null,
  allowEdits = false,
  allowNetwork = false,
  contextBlocks = [],
  environment = process.env,
  signal = null,
  timeoutMs = 1_800_000,
  launch = launchClaudeCode,
} = {}) => {
  const resources = deepSeekAgentContextText(contextBlocks);
  const finalPrompt = [
    "You are the Claude Code Agent embedded in Shensi. Follow the current user instruction and the verified Shensi product contract.",
    nativeHost ? "Own the full task. Discover resources and perform authorized changes through the shensi MCP tools, which preserve complete document history. Do not use direct filesystem writes." : allowEdits ? "Workspace changes are authorized only within the supplied target and transaction contract." : "This task is read-only; do not change files.",
    allowNetwork ? "Public web access is allowed without bypassing access controls." : "Do not add network activity unless the task contract explicitly permits it.",
    String(prompt || "").trim(),
    resources ? `神思提供的本轮受控上下文：\n${resources}` : "",
  ].filter(Boolean).join("\n\n");
  const executionSourceReceipt = buildExecutionSourceReceiptFromContextBlocks({
    finalInput: finalPrompt,
    blocks: contextBlocks,
    stage: "claude_code_agent_final_input",
  });
  let args = claudeCodeCommandArgs({ prompt: finalPrompt, model, maxTurns, permissionMode });
  if (nativeHost) args.push("--tools", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { shensi: { type: "http", url: nativeHost.url, headers: nativeHost.headers } } }), "--allowedTools", "mcp__shensi__*");
  const providerEnvironment = claudeCodeProviderEnvironment({ provider, baseUrl, apiKey, credentialSource, model, environment });
  let executable = String(cliPath || "claude").trim() || "claude";
  if (launch === launchClaudeCode) {
    const resolved = await resolveLocalClaudeCodeLaunch({
      environment: { ...providerEnvironment, SHENSI_CLAUDE_CODE_EXECUTABLE: executable },
    });
    executable = resolved.executable;
    args = [...(resolved.prefixArgs || []), ...args];
  }
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
    executionSourceReceipt,
  };
};
