import { assessRankingData } from "./ranking-data-quality.mjs";
import { analyzeRankingSnapshots } from "./ranking-scan-analysis.mjs";
import { aggregateRankingCoverage, sanitizeRankingAnalysisSummary, sanitizeRankingAnalysisValue, validateRankingAgentResult } from "./ranking-agent-result.mjs";

const terminal = new Set(["completed", "partial", "failed", "cancelled"]);
const clean = (value, maximum = 2_000) => String(value ?? "").trim().slice(0, maximum);
const publicExecution = (execution = {}) => ({
  engine: clean(execution.engine, 80),
  model: clean(execution.model, 240),
  runId: clean(execution.runId || execution.id, 160),
  status: clean(execution.status || "completed", 80),
});
const publicTask = (task) => ({
  taskId: task.taskId,
  operationId: task.operationId,
  idempotencyKey: task.idempotencyKey,
  status: task.status,
  stage: task.stage,
  progress: { ...task.progress },
  snapshotIds: [...task.snapshotIds],
  failedPlatforms: structuredClone(task.failedPlatforms),
  sourceLedger: structuredClone(task.sourceLedger),
  coverageLedger: structuredClone(task.coverageLedger),
  skillReceipt: task.skillReceipt ? structuredClone(task.skillReceipt) : null,
  analysisExecution: task.analysisExecution ? structuredClone(task.analysisExecution) : null,
  analysisFailure: task.analysisFailure,
  report: task.report ? structuredClone(task.report) : null,
  error: task.error,
  createdAt: task.createdAt,
  updatedAt: task.updatedAt,
});

const rankingOnlyCoverage = ({ platformId, itemCount = 0 } = {}) => ({
  platformId,
  requestedItems: itemCount,
  validItems: itemCount,
  requestedChapters: 0,
  readChapters: 0,
  totalPublishedChapters: 0,
  bodyEvidenceCount: 0,
  bodyCoverageRate: 0,
  analysisLevel: "ranking_only",
  mayClaimFullText: false,
  missing: ["未取得可校验的公开章节正文"],
  warnings: [],
});

const validSkill = (skill) => Boolean(
  skill
  && skill.fullText === true
  && skill.truncated !== true
  && clean(skill.content)
  && (!Array.isArray(skill.skillReadFailures) || skill.skillReadFailures.length === 0),
);

export class RankingScanRunner {
  constructor({ snapshotStore, collectors = {}, verifyCollector = async () => false, skillLoader = null, agentExecutor = null, analyzer = analyzeRankingSnapshots, now = () => new Date() } = {}) {
    if (!snapshotStore) throw new Error("扫榜运行器缺少快照存储");
    this.snapshotStore = snapshotStore;
    this.collectors = collectors;
    this.verifyCollector = verifyCollector;
    this.skillLoader = skillLoader;
    this.agentExecutor = agentExecutor;
    this.analyzer = analyzer;
    this.now = now;
    this.tasks = new Map();
    this.byIdempotency = new Map();
    this.promises = new Map();
  }

  start(contract = {}, { agentExecution = {} } = {}) {
    if (!contract.id || !contract.operationId || !contract.idempotencyKey) throw new Error("扫榜任务合同无效");
    if (!contract.platforms?.length) throw new Error("扫榜任务至少需要一个平台");
    if (contract.allowSnapshotWrite !== true) throw new Error("用户尚未授权保存不可变榜单快照");
    const existingId = this.byIdempotency.get(contract.idempotencyKey);
    if (existingId) return publicTask(this.tasks.get(existingId));
    const createdAt = this.now().toISOString();
    const task = {
      taskId: contract.id,
      operationId: contract.operationId,
      idempotencyKey: contract.idempotencyKey,
      contract: { ...contract },
      agentExecution: agentExecution && typeof agentExecution === "object" ? agentExecution : {},
      status: "running",
      stage: "loading_skill",
      progress: { completed: 0, total: contract.platforms.length },
      snapshotIds: [], snapshots: [], failedPlatforms: [], sourceLedger: [], platformCoverage: [],
      coverageLedger: aggregateRankingCoverage([], contract.platforms),
      skillReceipt: null, analysisExecution: null, analysisFailure: "", report: null, error: "",
      createdAt, updatedAt: createdAt, controller: new AbortController(),
    };
    this.tasks.set(task.taskId, task);
    this.byIdempotency.set(task.idempotencyKey, task.taskId);
    const promise = this.execute(task).catch((error) => {
      if (task.status === "cancelled") return publicTask(task);
      task.status = task.snapshotIds.length ? "partial" : "failed";
      task.stage = "failed";
      task.error = clean(error?.message || error);
      task.updatedAt = this.now().toISOString();
      return publicTask(task);
    });
    this.promises.set(task.taskId, promise);
    return publicTask(task);
  }

  async loadSkill(task) {
    if (typeof this.skillLoader !== "function") throw new Error("爆款扫榜 Skill 全文加载器不可用");
    const skill = await this.skillLoader({ contract: task.contract, signal: task.controller.signal });
    if (!validSkill(skill)) throw new Error("爆款扫榜 Skill 全文或必读规则文件未能完整加载");
    task.skillReceipt = {
      id: clean(skill.id || skill.relativePath || "official:bestseller-ranking-scan", 240),
      version: clean(skill.version || skill.revision || "current", 120),
      contentHash: clean(skill.contentHash || skill.hash, 128),
      contentLength: String(skill.content || "").length,
      fullText: true,
      ruleFiles: (skill.ruleFiles || []).map((item) => clean(item?.path || item, 500)).filter(Boolean),
      loadedAt: this.now().toISOString(),
    };
    return skill;
  }

  async saveSnapshot(task, { platformId, output, route, fallbackReason = "", execution = null } = {}) {
    const items = Array.isArray(output) ? output : output?.items || [];
    task.stage = "quality_check";
    const quality = assessRankingData(items, { parserVersion: output?.parserVersion || route });
    if (quality.status === "failed") throw new Error(quality.warnings.join("；") || "榜单没有有效条目");
    const { validItems, ...qualitySummary } = quality;
    const collectedAt = clean(output?.readAt || output?.collectedAt || this.now().toISOString(), 80);
    const coverage = output?.coverageLedger || rankingOnlyCoverage({ platformId, itemCount: validItems.length });
    const evidenceLedger = {
      route,
      fallbackReason: clean(fallbackReason, 1_000),
      coverage: structuredClone(coverage),
      chapterEvidence: (output?.chapterEvidence || []).map((item) => ({ ...item })),
      citations: (output?.citations || []).map((item) => ({ ...item })),
      execution: execution ? publicExecution(execution) : null,
    };
    task.stage = "saving_snapshot";
    const snapshot = await this.snapshotStore.save({
      taskId: task.taskId,
      idempotencyKey: `${task.idempotencyKey}:${platformId}`,
      platformId,
      rankingId: output?.rankingId || task.contract.rankings?.[0] || "ranking",
      collectedAt,
      sourceUrls: output?.sourceUrls || output?.citations?.map((item) => item.url) || [...new Set(validItems.map((item) => item.sourceUrl).filter(Boolean))],
      quality: qualitySummary,
      items: validItems,
      evidenceLedger,
    });
    if (await this.snapshotStore.verify(snapshot.snapshotId) !== true) throw new Error("榜单快照独立校验失败");
    task.snapshotIds.push(snapshot.snapshotId);
    task.snapshots.push(snapshot);
    task.platformCoverage.push(coverage);
    task.sourceLedger.push({
      platformId, route, status: "success", readAt: collectedAt,
      fallbackReason: clean(fallbackReason, 1_000), snapshotId: snapshot.snapshotId,
      sourceUrls: [...new Set((snapshot.sourceUrls || []).map(String))],
      chapterEvidence: evidenceLedger.chapterEvidence,
      citations: evidenceLedger.citations,
      execution: evidenceLedger.execution,
    });
    return snapshot;
  }

  async collectWithAgent(task, skill, platformId, fallbackReason) {
    if (typeof this.agentExecutor !== "function") throw new Error(`可信采集器不可用，且当前 Agent 无法接管：${fallbackReason}`);
    task.stage = "agent_fallback";
    const response = await this.agentExecutor({
      phase: "platform_collection", taskId: task.taskId, operationId: task.operationId,
      contract: task.contract, platformId, fallbackReason, skill,
      evidence: { snapshots: task.snapshots, sourceLedger: task.sourceLedger },
      execution: task.agentExecution, signal: task.controller.signal,
    });
    if (task.controller.signal.aborted) throw new DOMException("任务已取消", "AbortError");
    const validated = validateRankingAgentResult(response?.result ?? response, { platformId, requestedTopN: task.contract.topN });
    if (!validated.accepted) throw new Error(validated.failures.map((item) => item.reason).join("；") || validated.userActionRequired || "Agent 未返回有效榜单证据");
    await this.saveSnapshot(task, {
      platformId, route: "agent_fallback", fallbackReason, execution: response?.execution,
      output: { ...validated, parserVersion: `agent-structured:${response?.execution?.engine || "current"}`, sourceUrls: validated.citations.map((item) => item.url) },
    });
    return validated;
  }

  async runAgentAnalysis(task, skill) {
    if (typeof this.agentExecutor !== "function") throw new Error("当前 Agent 分析执行器不可用");
    task.stage = "agent_analysis";
    const response = await this.agentExecutor({
      phase: "analysis", taskId: task.taskId, operationId: task.operationId, contract: task.contract,
      skill, evidence: { snapshots: task.snapshots, sourceLedger: task.sourceLedger, coverageLedger: task.coverageLedger },
      execution: task.agentExecution, signal: task.controller.signal,
    });
    const value = response?.result ?? response;
    const report = value?.finalReport || value?.report || value;
    if (!report || typeof report !== "object" || !clean(report.summary || report.marketOverview)) throw new Error("Agent 未返回结构化最终分析报告");
    task.analysisExecution = publicExecution(response?.execution || {});
    return {
      summary: task.coverageLedger.mayClaimFullText === true
        ? clean(report.summary || report.marketOverview, 40_000)
        : sanitizeRankingAnalysisSummary(report.summary || report.marketOverview),
      trends: Array.isArray(report.trends) ? sanitizeRankingAnalysisValue(structuredClone(report.trends.slice(0, 100))) : [],
      platformDifferences: Array.isArray(report.platformDifferences) ? sanitizeRankingAnalysisValue(structuredClone(report.platformDifferences.slice(0, 100))) : [],
      citations: Array.isArray(report.citations) ? structuredClone(report.citations.slice(0, 300)) : [],
      limitations: Array.isArray(report.limitations) ? report.limitations.map((item) => sanitizeRankingAnalysisSummary(clean(item, 1_000))).filter(Boolean).slice(0, 100) : [],
      deconstruction: Array.isArray(report.deconstruction) ? sanitizeRankingAnalysisValue(structuredClone(report.deconstruction.slice(0, 100))) : [],
    };
  }

  async execute(task) {
    const skill = await this.loadSkill(task);
    for (const platformId of task.contract.platforms) {
      if (task.controller.signal.aborted) throw new DOMException("任务已取消", "AbortError");
      task.stage = "reading_ranking";
      task.updatedAt = this.now().toISOString();
      const collector = this.collectors[platformId];
      let fallbackReason = "";
      try {
        if (typeof collector !== "function") throw new Error("平台没有可用的可信采集器");
        if (await this.verifyCollector(platformId) !== true) throw new Error("采集器可信签名校验失败");
        const collectedAt = this.now().toISOString();
        const output = await collector({ contract: task.contract, platformId, collectedAt, signal: task.controller.signal });
        if (task.controller.signal.aborted) throw new DOMException("任务已取消", "AbortError");
        await this.saveSnapshot(task, { platformId, output: { ...(!Array.isArray(output) ? output : {}), items: Array.isArray(output) ? output : output?.items, collectedAt }, route: "trusted_collector" });
      } catch (collectorError) {
        if (collectorError?.name === "AbortError" || task.controller.signal.aborted) break;
        fallbackReason = clean(collectorError?.message || collectorError, 1_000);
        try { await this.collectWithAgent(task, skill, platformId, fallbackReason); }
        catch (agentError) {
          if (agentError?.name === "AbortError" || task.controller.signal.aborted) break;
          const reason = clean(agentError?.message || agentError, 1_000);
          task.failedPlatforms.push({ platformId, reason, fallbackAttempted: true });
          task.sourceLedger.push({ platformId, route: "agent_fallback", status: "failed", fallbackReason, reason, sourceUrls: [], chapterEvidence: [], citations: [], execution: null });
        }
      }
      task.progress.completed += 1;
      task.updatedAt = this.now().toISOString();
    }
    if (task.controller.signal.aborted) {
      task.status = "cancelled";
      task.stage = "cancelled";
      return publicTask(task);
    }
    task.coverageLedger = aggregateRankingCoverage(task.platformCoverage, task.contract.platforms);
    if (!task.snapshots.length) throw new Error(task.failedPlatforms.map((item) => `${item.platformId}：${item.reason}`).join("；") || "扫榜没有生成可用快照");
    task.stage = "analyzing";
    let agentAnalysis = null;
    try { agentAnalysis = await this.runAgentAnalysis(task, skill); }
    catch (error) { task.analysisFailure = clean(error?.message || error, 1_000); }
    const localReport = await this.analyzer({ snapshots: task.snapshots, scanType: task.contract.scanType, failedPlatforms: task.failedPlatforms, sourceLedger: task.sourceLedger, coverageLedger: task.coverageLedger });
    if (!localReport) throw new Error("榜单快照已保存，但分析报告未成功返回");
    task.report = {
      ...localReport,
      marketOverview: agentAnalysis?.summary || localReport.marketOverview,
      agentAnalysis,
      sourceLedger: structuredClone(task.sourceLedger),
      coverage: { ...(localReport.coverage || {}), ...structuredClone(task.coverageLedger) },
      skillReceipt: structuredClone(task.skillReceipt),
      authorizationState: "candidate_only",
    };
    task.status = task.failedPlatforms.length || task.analysisFailure || task.snapshots.some((snapshot) => snapshot.quality?.status !== "ok") ? "partial" : "completed";
    task.stage = "report_returned";
    task.updatedAt = this.now().toISOString();
    return publicTask(task);
  }

  status(taskId) { const task = this.tasks.get(String(taskId)); return task ? publicTask(task) : null; }
  async wait(taskId) { if (!this.promises.has(String(taskId))) throw new Error("扫榜任务不存在"); await this.promises.get(String(taskId)); return this.status(taskId); }
  cancel(taskId) {
    const task = this.tasks.get(String(taskId));
    if (!task || terminal.has(task.status)) return task ? publicTask(task) : null;
    task.controller.abort();
    task.status = "cancelled"; task.stage = "cancelled"; task.updatedAt = this.now().toISOString();
    return publicTask(task);
  }
}
