import { randomUUID } from "node:crypto";
import { parseRankingAgentResult } from "./ranking-agent-result.mjs";

const terminalStatuses = new Set(["completed", "failed", "interrupted", "cancelled"]);
const clean = (value, maximum = 2_000) => String(value ?? "").trim().slice(0, maximum);
const safeExecution = (run = {}) => ({
  engine: clean(run.engine, 80),
  model: clean(run.agentModel || run.model, 240),
  runId: clean(run.id || run.turnId, 160),
  status: clean(run.status, 80),
  sourceReceiptVerified: run.executionSourceReceipt?.verified === true,
});

const collectionPrompt = ({ contract, platformId, fallbackReason }) => [
  "执行神思只读‘爆款扫榜’任务。必须实际使用当前 Agent 可用的联网搜索、网页或浏览器工具读取公开页面；不得只凭记忆、预设或搜索摘要作答。",
  "必须遵守已加载的‘爆款扫榜’Skill 全文及必读规则。Skill 负责方法和标准，你负责真实工具调用、证据记录、趋势分析与拆书。",
  `目标平台：${platformId}；榜单：${(contract.rankings || []).join("、") || "公开热门榜"}；频道：${contract.channel || "all"}；题材：${contract.genre || "不限"}；目标数量：${contract.topN || 30}。`,
  `可信采集器未能完成的原因：${fallbackReason || "没有可用采集器"}。这只表示需要 Agent 接管，不表示平台不支持。`,
  "只访问无需绕过登录、付费、验证码或访问限制的公开内容。遇到限制时如实失败，并建议用户上传其合法取得的正文。",
  "不要修改任何文件、作品、设定、大纲、正文、配置或历史版本。",
  "仅返回一个 JSON 对象，不要 Markdown 代码围栏或解释文字。JSON 必须包含：platformId、rankingId、readAt、status、items、chapterEvidence、citations、failures、coverage、report。",
  "items 每项必须含 rank、title、author、bookUrl、sourceUrl、collectedAt；chapterEvidence 每项必须含 title、url、wordCount、contentHash、readAt，可附 contentText 供神思独立复算哈希；coverage 必须含 requestedChapters、readChapters、totalPublishedChapters、missing、warnings；report 必须含 summary、claimedScope、trends、deconstruction。",
  "没有正文证据时 claimedScope 只能是 ranking_only 或 synopsis_analysis；只读到部分公开章节时只能是 chapter_evidence；不得声称完成全文分析。",
].join("\n");

const analysisPrompt = ({ contract }) => [
  "依据神思提供且已经过校验的榜单快照、来源账本和正文覆盖账本，执行最终趋势分析与有限拆书。必须遵守已加载的‘爆款扫榜’Skill。",
  `任务范围：${(contract.platforms || []).join("、")}；榜单：${(contract.rankings || []).join("、") || "公开榜单"}；频道：${contract.channel || "all"}。`,
  "不得补造未在证据账本中出现的作品、章节、链接、字数、哈希或结论。没有正文证据时只能做榜单/简介分析；部分章节证据只能做有限章节分析。",
  "不要修改任何文件、作品、设定、大纲、正文、配置或历史版本。",
  "仅返回一个 JSON 对象，不要 Markdown 代码围栏或解释文字。格式：{\"finalReport\":{\"summary\":\"...\",\"trends\":[],\"platformDifferences\":[],\"citations\":[],\"limitations\":[],\"deconstruction\":[]}}。",
].join("\n");

const waitForRun = async ({ provider, prompt, contextBlocks, requestId, conversationId, runtimeSettings, projectCwd, signal, timeoutMs }) => {
  let startedRun = null;
  let settled = false;
  let abortListener = null;
  let timer = null;
  let offCompleted = () => {};
  let offFailed = () => {};
  const cleanup = () => {
    offCompleted();
    offFailed();
    if (timer) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener?.("abort", abortListener);
  };
  return new Promise((resolveRun, rejectRun) => {
    const finish = (error, run) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) rejectRun(error);
      else resolveRun(run);
    };
    const matches = (run) => String(run?.requestId || "") === requestId;
    const complete = (run) => {
      if (!matches(run)) return;
      if (run.status !== "completed") return finish(new Error(clean(run.error || run.text || `Agent 执行状态为 ${run.status}`, 4_000)));
      if (run.executionSourceReceipt?.verified !== true) return finish(new Error("Agent 最终输入未通过爆款扫榜 Skill 来源校验"));
      finish(null, run);
    };
    offCompleted = provider.on("run_completed", complete);
    offFailed = provider.on("run_failed", (run) => {
      if (matches(run)) finish(new Error(clean(run?.error || run?.text || "Agent 执行失败", 4_000)));
    });
    abortListener = () => {
      if (startedRun?.turnId || startedRun?.id) void provider.interrupt(startedRun.turnId || startedRun.id, { requestId }).catch(() => {});
      finish(Object.assign(new Error("扫榜 Agent 任务已取消"), { name: "AbortError" }));
    };
    if (signal?.aborted) return abortListener();
    signal?.addEventListener?.("abort", abortListener, { once: true });
    timer = setTimeout(() => {
      if (startedRun?.turnId || startedRun?.id) void provider.interrupt(startedRun.turnId || startedRun.id, { requestId }).catch(() => {});
      finish(new Error("扫榜 Agent 超过有限等待时间，已停止；不会自动重复提交"));
    }, Math.max(60_000, Math.min(3_600_000, Number(timeoutMs) || 1_800_000)));
    timer.unref?.();
    void provider.startTurn(prompt, {
      taskRoute: {
        mode: "market_research",
        operation: "analyze",
        deliverableType: "market_scan_report",
        authorizationState: "candidate_only",
        candidateOnly: true,
        action: "analyze",
        commitOwner: "none",
        landingPolicy: "candidate_only",
        requiresCommit: false,
        requiresLandingReceipt: false,
        allowMutations: false,
        source: { kind: "ranking_scan", requestId },
      },
      contextBlocks,
      taskPacket: {
        requestId,
        conversationId,
        threadScopeId: "ranking-scan",
        trustedReadOnlyNetwork: true,
        rankingScan: true,
      },
      runtimeSettings,
      projectCwd,
    }).then((run) => {
      startedRun = run;
      if (terminalStatuses.has(run?.status)) complete(run);
    }).catch((error) => finish(error));
  });
};

export const createRankingAgentExecutor = ({ provider, resolveRuntimeSettings = async () => ({}), defaultProjectCwd = "", timeoutMs = 1_800_000 } = {}) => {
  if (!provider?.startTurn || !provider?.on) throw new Error("扫榜 Agent 执行器缺少当前 Agent Provider");
  return async ({ phase, taskId, operationId, contract, platformId = "", fallbackReason = "", skill, evidence = {}, execution = {}, signal = null } = {}) => {
    if (!skill?.contextBlock?.text || !skill?.content) throw new Error("爆款扫榜 Skill 未进入 Agent 最终输入");
    const requestId = `ranking-agent:${clean(taskId, 120)}:${phase}:${clean(platformId || "report", 80)}:${randomUUID().slice(0, 8)}`;
    const runtimeSettings = await resolveRuntimeSettings(execution?.agentSettings || {});
    const prompt = phase === "analysis" ? analysisPrompt({ contract }) : collectionPrompt({ contract, platformId, fallbackReason });
    const evidenceBlock = {
      type: "resource",
      id: `${requestId}:evidence-ledger`,
      name: phase === "analysis" ? "已校验扫榜证据与覆盖账本" : "本轮扫榜只读任务合同",
      uri: `shensi://ranking-scan/${encodeURIComponent(taskId)}/${encodeURIComponent(phase)}`,
      mimeType: "application/json",
      text: JSON.stringify({
        taskId, operationId, phase, platformId, contract: {
          scanType: contract.scanType, platforms: contract.platforms, rankings: contract.rankings,
          channel: contract.channel, genre: contract.genre, topN: contract.topN,
          allowAuthenticatedPageAccess: false, allowReportLanding: false,
        },
        evidence,
      }),
    };
    const run = await waitForRun({
      provider, prompt, requestId, conversationId: `ranking-scan:${taskId}`,
      runtimeSettings, projectCwd: clean(execution?.projectCwd || defaultProjectCwd, 2_000),
      signal, timeoutMs, contextBlocks: [skill.contextBlock, evidenceBlock],
    });
    const result = parseRankingAgentResult(run.text);
    return { execution: safeExecution(run), result };
  };
};
