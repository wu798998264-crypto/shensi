import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConversationAgentService } from "./conversation-agent-service.mjs";
import { startConversationAgentMcp } from "./conversation-agent-mcp.mjs";
import { listManagedSkills } from "./skill-store.mjs";
import { inspectSelectedSkillSource } from "./skill-library.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "./workspace.mjs";
import { applyConversationMediaResultToWorkspace } from "../media-generation-coordination.js";
import { runDeepSeekOpenCodeAgent } from "./deepseek-opencode-agent-runner.mjs";
import { runOpenCodeAgent } from "./opencode-agent-runner.mjs";
import { runClaudeCodeAgentTurn } from "./claude-code-agent-runner.mjs";
import { runExternalCliAgent } from "./external-cli-agent-runner.mjs";
import { runBundledConversationAgent } from "./bundled-conversation-runtime.mjs";
import { createShensiCodexAgentRuntime } from "./shensi-codex-agent-runtime.mjs";
import { agentChildEnvironment, nativeCodexEnvironment, shensiCodexEnvironment } from "./codex-runtime-isolation.mjs";
import { resolveLocalCodexLaunch } from "../cli/codex-launch.mjs";
import { imageModelCapabilities, videoModelCapabilities } from "../model-presets.js";
import { createAgentBrowserService } from "./agent-browser-service.mjs";
import { normalizeAgentPermissionMode, permissionContractFor } from "../agent-permission-policy.js";
import { toolsWithPermissionPrompt } from "./agent-permission-prompt-tools.mjs";
import { filterAgentSkillCatalog } from "../managed-route-document.js";

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("任务已取消"));
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new Error("任务已取消")); };
  signal?.addEventListener("abort", abort, { once: true });
});
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

export const conversationAgentProcessEnvironment = (environment = process.env) => agentChildEnvironment(environment);

const routeDocumentCandidates = [
  { label: "神思任务路由.md", parts: ["神思任务路由.md"], required: false },
  { label: "神思运行规范.md", parts: ["神思运行规范.md"], required: false },
];

const readAvailableRoute = async ({ shensiRoot, requested = [], dynamicRoute = "" } = {}) => {
  const requestedLabels = new Set((Array.isArray(requested) ? requested : []).map((item) => String(item || "").trim()).filter(Boolean));
  const candidates = requestedLabels.size
    ? routeDocumentCandidates.filter((candidate) => requestedLabels.has(candidate.label))
    : routeDocumentCandidates;
  const blocks = [];
  const sources = [];
  for (const candidate of candidates) {
    try {
      const text = await readFile(join(shensiRoot, "神思模块", ...candidate.parts), "utf8");
      if (String(text).trim()) {
        blocks.push(`# ${candidate.label}\n${text}`);
        // Routing/runtime contracts are host instructions, not user evidence.
        // They are loaded for every Agent run but intentionally omitted from
        // the user-facing "已读取" list.
        sources.push({ kind: "document", id: candidate.label, title: candidate.label, fullText: true, characters: text.length, userVisible: false });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  if (String(dynamicRoute).trim()) blocks.push(String(dynamicRoute).trim());
  return { text: blocks.join("\n\n") || "当前没有可用的任务路由附录；请根据用户原始指令和可用 Skill 自主判断，空白路由资料不是阻断条件。", sources };
};

export const createConversationAgentGateway = ({
  appRoot,
  machineRoot,
  shensiRoot,
  apiRuntime,
  codexRuntime,
  resolveRuntimeSettings,
  apiRequest,
  externalRunners = {},
  startMcp = startConversationAgentMcp,
  browser = null,
}) => createConversationAgentService({
  appRoot,
  storageRoot: join(machineRoot, "conversation-agent-v1", "runs"),
  skillCatalog: async (request = {}) => {
    const catalog = await listManagedSkills({ shensiRoot });
    const available = [...catalog.builtins, ...catalog.user]
      .filter((skill) => skill.disabled !== true && skill.testStatus !== "failed")
      .map((skill) => ({ id: /^(builtin|official|user):/u.test(skill.id) ? skill.id : `user:${skill.id}`, name: skill.name, description: skill.description || "", capabilities: skill.capabilities || [] }));
    return filterAgentSkillCatalog({ catalog: available, routeTopology: catalog.routeTopology, request });
  },
  readRoute: async (request = {}) => {
    const catalog = await listManagedSkills({ shensiRoot });
    return readAvailableRoute({ shensiRoot, requested: request.routeDocuments, dynamicRoute: catalog.routeDocument });
  },
  readSkill: (id) => inspectSelectedSkillSource({ selection: id, shensiRoot }),
  run: async (options) => {
    const settings = await resolveRuntimeSettings(options.settings);
    settings.agentPermissionMode = normalizeAgentPermissionMode(options.permissionContract?.mode || settings.agentPermissionMode);
    const permissionContract = options.permissionContract || permissionContractFor(settings.agentPermissionMode, { runner: settings.agentEngine });
    const shensiOnly = settings.agentPermissionMode === "shensi_only";
    if (settings.agentEngine === "codex_api") return runBundledConversationAgent({ ...options, settings, permissionContract, appRoot, machineRoot });
    const processEnvironment = conversationAgentProcessEnvironment();
    if (settings.agentEngine === "codex") {
      const runtimeMachineRoot = join(machineRoot, "conversation-agent-v1", "external", options.sessionId);
      const environment = shensiOnly
        ? shensiCodexEnvironment({ machineRoot: runtimeMachineRoot, environment: processEnvironment })
        : nativeCodexEnvironment({ environment: processEnvironment });
      const runtime = createShensiCodexAgentRuntime({ appRoot, machineRoot: runtimeMachineRoot, environment,
        isolateConfig: shensiOnly,
        launchResolver: () => resolveLocalCodexLaunch({ environment: { ...environment, ...(settings.cliPath && settings.cliPath !== "codex" ? { SHENSI_CODEX_EXECUTABLE: settings.cliPath } : {}) } }) });
      try { return await runtime.runStage({ settings, messages: [{ role: "user", content: options.prompt }], system: options.contextBlocks.map((block) => `# ${block.name}\n${block.text}`).join("\n\n"), shensiRuntime: { stage: "conversation_agent", sessionId: options.sessionId, agentDriven: true }, workspaceToolRuntime: options.workspaceToolRuntime, onToolEvent: options.onToolEvent, registerSteer: options.registerSteer, signal: options.signal, isWaitingForUser: options.isWaitingForUser, permissionContract, requestApproval: options.requestApproval }); }
      finally { await runtime.close(); }
    }
    const externalCliEngine = ["trae_work", "workbuddy", "custom"].includes(settings.agentEngine);
    const mcpTools = settings.agentPermissionMode === "approval_required"
      && (settings.agentEngine === "claude_code" || externalCliEngine)
      ? toolsWithPermissionPrompt(options.workspaceToolRuntime, options.requestApproval, { runner: settings.agentEngine })
      : options.workspaceToolRuntime;
    const nativeHost = await startMcp({ tools: mcpTools, onToolEvent: options.onToolEvent, signal: options.signal });
    const cwd = join(machineRoot, "conversation-agent-v1", "scratch", options.sessionId);
    await mkdir(cwd, { recursive: true });
    try {
      const run = settings.agentEngine === "claude_code"
        ? externalRunners.claudeCode || runClaudeCodeAgentTurn
        : settings.agentEngine === "deepseek_opencode"
          ? externalRunners.deepSeek || runDeepSeekOpenCodeAgent
          : settings.agentEngine === "opencode"
            ? externalRunners.openCode || runOpenCodeAgent
            : externalCliEngine
              ? externalRunners.externalCli || runExternalCliAgent
            : null;
      if (!run) throw new Error("所选运行器未提供 Agent 接口，不会回退到 Chat");
      return await run({ ...settings, engine: settings.agentEngine, prompt: options.prompt, contextBlocks: options.contextBlocks.map((block) => ({ ...block, type: "host_contract" })), cwd, nativeHost, signal: options.signal, maxTurns: 96, timeoutMs: Number(settings.timeoutMs) || 1_800_000, allowEdits: settings.agentPermissionMode !== "shensi_only", allowNetwork: settings.agentPermissionMode !== "shensi_only", permissionContract, requestApproval: options.requestApproval, onEvent: options.onToolEvent, environment: processEnvironment });
    } finally { await nativeHost.close(); }
  },
  mediaStatus: async (jobId, { request, archive = false, emit = async () => {} }) => {
    if (!/^generation-[a-z0-9-]+$/u.test(jobId)) throw new Error("无效媒体任务ID");
    const { job } = await apiRequest(`/api/generation/jobs/${jobId}`);
    if (String(job.target?.workspacePath).replaceAll("\\", "/").toLowerCase() !== String(request.workspacePath).replaceAll("\\", "/").toLowerCase()
      || job.target?.conversationId !== request.conversationId) throw new Error("不能读取其他作品或对话的媒体任务");
    if (archive) {
      await archiveConversationMediaJob({ appRoot, request, job });
      await emit("media_saved", { jobId: job.id, messageId: job.target.messageId, attachment: job.result.attachment, channel: job.channel });
    }
    return { id: job.id, status: job.status, attachment: job.result?.attachment, error: job.error || "", backedUpToAllAssets: archive };
  },
  media: createConversationMediaExecutor({ appRoot, apiRequest }),
  browser: browser || createAgentBrowserService(),
});

export const createConversationMediaExecutor = ({ appRoot, apiRequest }) => {
  const blockedRuns = new Map();
  return async (args, { request, runId, signal, emit = async () => {} }) => {
    if (blockedRuns.has(runId)) throw new Error(blockedRuns.get(runId));
    let submissionAttempted = false;
    try {
      const channel = args.channel;
      if (!["image", "video"].includes(channel)) throw new Error("仅支持图片或视频");
      if (channel === "video" && !(Number(args.duration) > 0)) throw new Error("请先用 interaction.ask 单独确认视频时长；已明确秒数则直接传入");
      const profiles = request.mediaProfiles?.[channel] || [];
      const profile = args.profileId ? profiles.find((candidate) => candidate.id === args.profileId) : profiles[0];
      if (!profile) throw new Error("没有找到指定的媒体配置；不会切换其他配置");
      const capabilities = channel === "image" ? imageModelCapabilities(profile.provider, profile.model) : videoModelCapabilities(profile.provider, profile.model);
      const quality = args.quality || (capabilities.resolutions.includes("2k") ? "2k" : "high");
      const resolution = args.resolution || "720p";
      if (capabilities.exact && channel === "image" && !capabilities.resolutions.includes(quality)) throw new Error("此图片模型不支持所需清晰度，请调整参数，未提交");
      if (capabilities.exact && channel === "video" && (!capabilities.resolutions.includes(resolution) || !capabilities.durationSeconds.includes(Number(args.duration)))) throw new Error("此视频模型不支持所需清晰度或时长，请调整参数，未提交");
      const messageId = `${runId}-${hash(args.operationId).slice(0, 12)}`;
      submissionAttempted = true;
      const submitted = await apiRequest("/api/generation/jobs/media", { channel, submissionId: messageId, target: { targetType: "conversation-message", workspaceKind: request.workspaceKind, workspacePath: request.workspacePath, conversationId: request.conversationId, messageId, sourceMessageId: request.sourceMessageId, documentId: request.targetDocumentId || "", conversationBranchScope: request.branchId || "" }, request: {
        prompt: args.prompt, settings: profile, imageCount: 1, duration: args.duration, quality, resolution, aspectRatio: args.aspectRatio || profile.aspectRatio || "16:9", referenceMedia: (request.attachments || []).filter((attachment) => /^(image|video|audio)\//u.test(attachment.mimeType || "")), connectionSelection: { source: args.profileId ? "explicit" : "first_profile", explicit: Boolean(args.profileId), connectionId: profile.id },
      } });
      const id = submitted.job.id;
      await emit("media_job", { jobId: id, messageId, channel, profileId: profile.id });
      let job = submitted.job;
      try {
        while (["queued", "submitting", "running", "polling", "downloading", "cancel_requested"].includes(job.status)) {
          await sleep(800, signal);
          const polled = await apiRequest(`/api/generation/jobs/${id}`);
          job = polled.job;
        }
      } catch (error) {
        if (signal.aborted) await apiRequest(`/api/generation/jobs/${id}/cancel`, {}).catch(() => {});
        throw new Error(`媒体任务 ${id} 保留，未重新提交：${error.message}`);
      }
      if (job.status !== "complete") throw new Error(`媒体任务 ${id} 未完成：${job.error || job.status}。保留原任务，不盲目重提。`);
      await archiveConversationMediaJob({ appRoot, request, job });
      await emit("media_saved", { jobId: id, messageId, attachment: job.result.attachment, channel });
      return { jobId: id, attachment: job.result.attachment, backedUpToAllAssets: true };
    } catch (error) {
      if (submissionAttempted) blockedRuns.set(runId, `本轮媒体步骤已停止，先核对原任务，不能盲目新建重提：${error.message}`);
      throw error;
    }
  };
};

export const archiveConversationMediaJob = async ({ appRoot, request, job }) => {
  if (job.status !== "complete" || !job.result?.attachment) throw new Error("媒体尚未下载验收完成，不能归档");
  for (let attempt = 0; attempt < 3; attempt++) {
    const loaded = await loadWorkspaceState({ appRoot, requestedPath: request.workspacePath });
    const conversations = structuredClone(loaded.state.conversations);
    const messages = structuredClone(loaded.state.messages);
    const result = applyConversationMediaResultToWorkspace(loaded.state, job, { timeLabel: new Date().toLocaleTimeString("zh-CN") });
    if (result.suppressed) throw new Error("用户已撤销该媒体目标，结果不自动回填");
    // Conversation text is written by the shared UI save lane. The server
    // owns only the durable asset here, avoiding competing whole-chat saves
    // while other conversations continue to receive messages.
    loaded.state.conversations = conversations;
    loaded.state.messages = messages;
    try { await saveWorkspaceState({ appRoot, requestedPath: request.workspacePath, state: loaded.state, expectedStateStamp: loaded.stateStamp }); return result; }
    catch (error) { if (error.code !== "WORKSPACE_STATE_CONFLICT" || attempt === 2) throw new Error(`生成已成功，但全部资产备份未完成；保留任务 ${job.id}，只重试归档：${error.message}`); }
  }
};
