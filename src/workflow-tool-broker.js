const clone = (value) => value == null ? value : structuredClone(value);
const bytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
const BLOCKED_REFERENCE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

const resolveReference = (value, scope) => {
  if (Array.isArray(value)) return value.map((item) => resolveReference(item, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveReference(item, scope)]));
  if (typeof value !== "string" || !value.startsWith("$")) return value;
  const segments = value.slice(1).split(".").filter(Boolean);
  let current = scope;
  for (const segment of segments) {
    if (BLOCKED_REFERENCE_SEGMENTS.has(segment) || current == null || !Object.prototype.hasOwnProperty.call(Object(current), segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return clone(current);
};

const auditReason = (error) => String(error?.message ?? error ?? "Workflow 工具调用失败").replace(/\s+/g, " ").trim().slice(0, 240);

export class WorkflowToolBroker {
  constructor({
    grantedPermissions = [],
    availableTools = [],
    scope = {},
    maxToolCalls = 32,
    maxOutputBytes = 8 * 1024 * 1024,
    maxTotalOutputBytes = 16 * 1024 * 1024,
    auditSink = null,
  } = {}) {
    this.grantedPermissions = new Set(grantedPermissions);
    this.availableTools = new Set(availableTools);
    this.scope = Object.freeze(clone(scope));
    this.maxToolCalls = maxToolCalls;
    this.maxOutputBytes = maxOutputBytes;
    this.maxTotalOutputBytes = maxTotalOutputBytes;
    this.auditSink = typeof auditSink === "function" ? auditSink : null;
    this.tools = new Map();
    this.audit = [];
    this.calls = 0;
    this.totalOutputBytes = 0;
  }

  register(toolId, { permission, handler, validate = () => [] } = {}) {
    if (this.tools.has(toolId)) throw new Error(`工具重复注册：${toolId}`);
    if (typeof handler !== "function") throw new Error(`工具缺少处理器：${toolId}`);
    this.tools.set(toolId, { permission, handler, validate });
    return this;
  }

  recordAudit(entry) {
    const record = { sequence: this.audit.length + 1, ...entry };
    this.audit.push(record);
    this.auditSink?.(clone(record));
    return record;
  }

  async invoke(toolId, input, { stepId = "", signal } = {}) {
    const startedAt = Date.now();
    this.calls += 1;
    let tool = null;
    try {
      if (this.calls > this.maxToolCalls) throw new Error(`工具调用超过预算：${this.maxToolCalls}`);
      if (signal?.aborted) throw new Error("Workflow 已取消");
      if (!this.availableTools.has(toolId)) throw new Error(`工具不可用：${toolId}`);
      tool = this.tools.get(toolId);
      if (!tool) throw new Error(`工具没有可信代理实现：${toolId}`);
      if (tool.permission && !this.grantedPermissions.has(tool.permission)) throw new Error(`工具权限未授权：${tool.permission}`);
      const issues = tool.validate(input, this.scope) ?? [];
      if (issues.length) throw new Error(`工具输入无效：${issues.join("；")}`);
      const result = await tool.handler(clone(input), { scope: this.scope, signal });
      const outputBytes = bytes(result);
      if (outputBytes > this.maxOutputBytes) throw new Error(`工具输出超过预算：${this.maxOutputBytes} bytes`);
      if (this.totalOutputBytes + outputBytes > this.maxTotalOutputBytes) {
        throw new Error(`工具累计输出超过预算：${this.maxTotalOutputBytes} bytes`);
      }
      this.totalOutputBytes += outputBytes;
      this.recordAudit({
        type: "tool",
        status: "completed",
        stepId,
        toolId,
        permission: tool.permission ?? "",
        durationMs: Date.now() - startedAt,
        outputBytes,
      });
      return clone(result);
    } catch (error) {
      this.recordAudit({
        type: "tool",
        status: "rejected",
        stepId,
        toolId,
        permission: tool?.permission ?? "",
        durationMs: Date.now() - startedAt,
        outputBytes: 0,
        reason: auditReason(error),
      });
      throw error;
    }
  }
}

const topologicalSteps = (steps = []) => {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const pending = new Set(byId.keys());
  const ordered = [];
  while (pending.size) {
    const ready = [...pending].filter((id) => (byId.get(id).needs ?? []).every((dependency) => !pending.has(dependency)));
    if (!ready.length) throw new Error("Workflow DAG 存在循环依赖");
    for (const id of ready) { ordered.push(byId.get(id)); pending.delete(id); }
  }
  return ordered;
};

export const executeWorkflowPlan = async ({ plan, broker, inputs = {}, promptRunner = null, reviewers = {}, signal } = {}) => {
  if (!plan?.ok) throw new Error("Workflow 执行计划未通过编译");
  if (!(broker instanceof WorkflowToolBroker)) throw new Error("缺少可信工具代理");
  if (plan.steps.length > 64) throw new Error("Workflow 步骤超过 64 个上限");
  const results = {};
  const emissions = [];
  for (const step of topologicalSteps(plan.steps)) {
    if (signal?.aborted) throw new Error("Workflow 已取消");
    const scope = { inputs, steps: results };
    const input = resolveReference(step.input ?? {}, scope);
    if (step.kind === "tool") results[step.id] = await broker.invoke(step.tool, input, { stepId: step.id, signal });
    else if (step.kind === "prompt") {
      if (typeof promptRunner !== "function") throw new Error(`步骤 ${step.id} 需要受控模型执行器`);
      results[step.id] = await promptRunner({ step: clone(step), input, priorResults: clone(results), signal });
    } else if (step.kind === "transform") {
      if (step.operation === "select") results[step.id] = resolveReference(step.source, scope);
      else if (step.operation === "merge") {
        const sources = resolveReference(step.sources ?? [], scope);
        if (!Array.isArray(sources) || sources.some((source) => !source || typeof source !== "object" || Array.isArray(source))) {
          throw new Error("merge 只能合并对象数组");
        }
        const merged = Object.create(null);
        for (const source of sources) {
          for (const [key, value] of Object.entries(source)) {
            if (BLOCKED_REFERENCE_SEGMENTS.has(key)) throw new Error(`merge 包含禁止字段：${key}`);
            merged[key] = clone(value);
          }
        }
        results[step.id] = merged;
      }
      else throw new Error(`不支持的声明式转换：${step.operation}`);
    } else if (step.kind === "review") {
      const reviewer = reviewers[step.reviewer ?? "default"];
      if (typeof reviewer !== "function") throw new Error(`缺少审查器：${step.reviewer ?? "default"}`);
      results[step.id] = await reviewer({ step: clone(step), input, priorResults: clone(results), signal });
      if (results[step.id]?.pass !== true) throw new Error(`Workflow 审查未通过：${results[step.id]?.message ?? step.id}`);
    } else if (step.kind === "emit") {
      const value = resolveReference(step.source ?? step.input, scope);
      const emission = { id: step.id, channel: step.channel ?? "draft", value };
      if (!new Set(["draft", "artifact_draft", "memory_proposal"]).has(emission.channel)) throw new Error(`禁止直接提交输出通道：${emission.channel}`);
      emissions.push(emission);
      results[step.id] = emission;
    } else throw new Error(`不支持的步骤类型：${step.kind}`);
  }
  return {
    status: "completed",
    results,
    emissions,
    audit: clone(broker.audit),
    requiresUserCommit: plan.requiresUserCommit === true || emissions.length > 0,
  };
};
