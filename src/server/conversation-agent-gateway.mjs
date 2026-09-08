import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createConversationAgentService } from "./conversation-agent-service.mjs";
import { startConversationAgentMcp } from "./conversation-agent-mcp.mjs";
import { listManagedSkills } from "./skill-store.mjs";
import { inspectSelectedSkillSource } from "./skill-library.mjs";
import { loadWorkspaceState, saveWorkspaceState } from "./workspace.mjs";
import { applyConversationMediaResultToWorkspace } from "../media-generation-coordination.js";
import { runOpenCodeAgent } from "./opencode-agent-runner.mjs";
import { runClaudeCodeAgentTurn } from "./claude-code-agent-runner.mjs";
import { runBundledConversationAgent } from "./bundled-conversation-runtime.mjs";
import { createShensiCodexAgentRuntime } from "./shensi-codex-agent-runtime.mjs";
import { nativeCodexEnvironment } from "./codex-runtime-isolation.mjs";
import { resolveLocalCodexLaunch } from "../cli/codex-launch.mjs";

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new Error("任务已取消"));
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(new Error("任务已取消")); };
  signal?.addEventListener("abort", abort, { once: true });
});
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

export const createConversationAgentGateway = ({ appRoot, machineRoot, shensiRoot, apiRuntime, codexRuntime, resolveRuntimeSettings, apiRequest }) => createConversationAgentService({
  appRoot,
  storageRoot: join(machineRoot, "conversation-agent-v1", "runs"),
  skillCatalog: async () => {
    const catalog = await listManagedSkills({ shensiRoot });
    return [...catalog.builtins, ...catalog.user].filter((skill) => skill.disabled !== true && skill.testStatus !== "failed").map((skill) => ({ id: /^(builtin|official|user):/u.test(skill.id) ? skill.id : `user:${skill.id}`, name: skill.name, description: skill.description || "", capabilities: skill.capabilities || [] }));
  },
  readRoute: () => readFile(join(shensiRoot, "神思模块", "任务路由模块.md"), "utf8"),
  readSkill: (id) => inspectSelectedSkillSource({ selection: id, shensiRoot }),
  run: async (options) => {
    const settings = await resolveRuntimeSettings(options.settings);
    if (settings.agentEngine === "codex_api") return runBundledConversationAgent({ ...options, settings, appRoot, machineRoot });
    if (settings.agentEngine === "codex") {
      const environment = nativeCodexEnvironment();
      const runtime = createShensiCodexAgentRuntime({ appRoot, machineRoot: join(machineRoot, "conversation-agent-v1", "external", options.sessionId), environment,
        launchResolver: () => resolveLocalCodexLaunch({ environment: { ...environment, ...(settings.cliPath && settings.cliPath !== "codex" ? { SHENSI_CODEX_EXECUTABLE: settings.cliPath } : {}) } }) });
      try { return await runtime.runStage({ settings, messages: [{ role: "user", content: options.prompt }], system: options.contextBlocks.map((block) => `# ${block.name}\n${block.text}`).join("\n\n"), shensiRuntime: { stage: "conversation_agent", sessionId: options.sessionId, agentDriven: true }, workspaceToolRuntime: options.workspaceToolRuntime, onToolEvent: options.onToolEvent, registerSteer: options.registerSteer, signal: options.signal }); }
      finally { await runtime.close(); }
    }
    const nativeHost = await startConversationAgentMcp({ tools: options.workspaceToolRuntime, onToolEvent: options.onToolEvent, signal: options.signal });
    const cwd = join(machineRoot, "conversation-agent-v1", "scratch", options.sessionId);
    await mkdir(cwd, { recursive: true });
    try {
      const run = settings.agentEngine === "claude_code" ? runClaudeCodeAgentTurn : ["opencode", "deepseek_opencode"].includes(settings.agentEngine) ? runOpenCodeAgent : null;
      if (!run) throw new Error("所选运行器未提供 Agent 接口，不会回退到 Chat");
      return await run({ ...settings, prompt: options.prompt, contextBlocks: options.contextBlocks.map((block) => ({ ...block, type: "host_contract" })), cwd, nativeHost, signal: options.signal, maxTurns: 96, timeoutMs: Number(settings.timeoutMs) || 1_800_000, allowEdits: false });
    } finally { await nativeHost.close(); }
  },
  mediaStatus: async (jobId, { request }) => {
    if (!/^generation-[a-z0-9-]+$/u.test(jobId)) throw new Error("无效媒体任务ID");
    const { job } = await apiRequest(`/api/generation/jobs/${jobId}`);
    if (String(job.target?.workspacePath).replaceAll("\\", "/").toLowerCase() !== String(request.workspacePath).replaceAll("\\", "/").toLowerCase()
      || job.target?.conversationId !== request.conversationId) throw new Error("不能读取其他作品或对话的媒体任务");
    return { id: job.id, status: job.status, attachment: job.result?.attachment, error: job.error || "" };
  },
  media: async (args, { request, runId, signal, emit }) => {
    const channel = args.channel;
    if (!["image", "video"].includes(channel)) throw new Error("仅支持图片或视频");
    if (channel === "video" && !(Number(args.duration) > 0)) throw new Error("请先用 interaction.ask 单独确认视频时长；已明确秒数则直接传入");
    const profiles = request.mediaProfiles?.[channel] || [];
    const profile = args.profileId ? profiles.find((profile) => profile.id === args.profileId) : profiles[0];
    if (!profile) throw new Error("没有找到指定的媒体配置；不会切换其他配置");
    const messageId = `${runId}-${hash(args.operationId).slice(0, 12)}`;
    const submitted = await apiRequest("/api/generation/jobs/media", { channel, submissionId: messageId, target: { targetType: "conversation-message", workspaceKind: request.workspaceKind, workspacePath: request.workspacePath, conversationId: request.conversationId, messageId, sourceMessageId: request.sourceMessageId, documentId: request.targetDocumentId || "", conversationBranchScope: request.branchId || "" }, request: {
      prompt: args.prompt, settings: profile, imageCount: 1, duration: args.duration, quality: args.quality || "2k", resolution: args.resolution || "720p", aspectRatio: args.aspectRatio || profile.aspectRatio || "16:9", referenceMedia: request.attachments || [], connectionSelection: { source: args.profileId ? "explicit" : "first_profile", explicit: Boolean(args.profileId), connectionId: profile.id },
    } });
    const id = submitted.job.id;
    await emit("media_job", { jobId: id, messageId, channel, profileId: profile.id });
    let job = submitted.job;
    try {
      while (!["complete", "failed", "cancelled", "interrupted", "needs_attention", "abandoned"].includes(job.status)) {
        await sleep(800, signal);
        const polled = await apiRequest(`/api/generation/jobs/${id}`);
        job = polled.job;
      }
    } catch (error) {
      if (signal.aborted) await apiRequest(`/api/generation/jobs/${id}/cancel`, {}).catch(() => {});
      throw new Error(`媒体任务 ${id} 保留，未重新提交：${error.message}`);
    }
    if (job.status !== "complete") throw new Error(`媒体任务 ${id} 未完成：${job.error || job.status}。保留原任务，不盲目重提。`);
    let saved = false;
    for (let attempt = 0; attempt < 3 && !saved; attempt++) {
      const loaded = await loadWorkspaceState({ appRoot, requestedPath: request.workspacePath });
      const result = applyConversationMediaResultToWorkspace(loaded.state, job, { timeLabel: new Date().toLocaleTimeString("zh-CN") });
      if (result.suppressed) throw new Error("用户已撤销该媒体目标，结果不自动回填");
      try { await saveWorkspaceState({ appRoot, requestedPath: request.workspacePath, state: loaded.state, expectedStateStamp: loaded.stateStamp }); saved = true; }
      catch (error) { if (error.code !== "WORKSPACE_STATE_CONFLICT" || attempt === 2) throw new Error(`生成已成功，但全部资产备份未完成；保留任务 ${id}，只重试归档：${error.message}`); }
    }
    await emit("media_saved", { jobId: id, attachment: job.result.attachment, channel });
    return { jobId: id, attachment: job.result.attachment, backedUpToAllAssets: true };
  },
});
