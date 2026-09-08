import { basename } from "node:path";
import { excerptContextContent, rankRelevantDocuments } from "../context-compiler.js";
import { compileWorkflowExecutionPlan } from "../workflow-skill-contract.js";
import { executeWorkflowPlan, WorkflowToolBroker } from "../workflow-tool-broker.js";
import { loadWorkspaceState, resolveWorkspaceRoot } from "./workspace.mjs";

export const OFFLINE_WORKFLOW_TOOL_IDS = Object.freeze([
  "shensi/document.read",
  "shensi/workspace.search",
  "shensi/context.read",
]);

const OFFLINE_TOOL_SET = new Set(OFFLINE_WORKFLOW_TOOL_IDS);
const OFFLINE_PERMISSION_SET = new Set([
  "context.read",
  "document.read",
  "document.write_draft",
  "artifact.write_draft",
  "memory.propose",
  "tool.invoke",
]);
const EMISSION_PERMISSION = Object.freeze({
  draft: "document.write_draft",
  artifact_draft: "artifact.write_draft",
  memory_proposal: "memory.propose",
});
const BLOCKED_FIELDS = new Set(["__proto__", "prototype", "constructor"]);

const DEFAULT_LIMITS = Object.freeze({
  maxDurationMs: 30_000,
  maxInputBytes: 256 * 1024,
  maxSteps: 64,
  maxToolCalls: 16,
  maxToolOutputBytes: 1024 * 1024,
  maxTotalToolOutputBytes: 4 * 1024 * 1024,
  maxPromptCalls: 8,
  maxPromptOutputBytes: 1024 * 1024,
  maxReviewCalls: 8,
  maxReviewOutputBytes: 256 * 1024,
  maxEmissions: 16,
  maxEmissionBytes: 2 * 1024 * 1024,
  maxResultBytes: 8 * 1024 * 1024,
});

const clone = (value) => value == null ? value : structuredClone(value);
const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
const uniqueStrings = (value) => [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
};
const cleanAuditReason = (error) => String(error?.message ?? error ?? "Workflow 运行失败").replace(/\s+/g, " ").trim().slice(0, 240);

const normalizeLimits = (limits = {}) => ({
  maxDurationMs: boundedInteger(limits.maxDurationMs, DEFAULT_LIMITS.maxDurationMs, 100, 120_000),
  maxInputBytes: boundedInteger(limits.maxInputBytes, DEFAULT_LIMITS.maxInputBytes, 1024, 1024 * 1024),
  maxSteps: boundedInteger(limits.maxSteps, DEFAULT_LIMITS.maxSteps, 1, 64),
  maxToolCalls: boundedInteger(limits.maxToolCalls, DEFAULT_LIMITS.maxToolCalls, 1, 32),
  maxToolOutputBytes: boundedInteger(limits.maxToolOutputBytes, DEFAULT_LIMITS.maxToolOutputBytes, 1024, 4 * 1024 * 1024),
  maxTotalToolOutputBytes: boundedInteger(limits.maxTotalToolOutputBytes, DEFAULT_LIMITS.maxTotalToolOutputBytes, 1024, 8 * 1024 * 1024),
  maxPromptCalls: boundedInteger(limits.maxPromptCalls, DEFAULT_LIMITS.maxPromptCalls, 0, 16),
  maxPromptOutputBytes: boundedInteger(limits.maxPromptOutputBytes, DEFAULT_LIMITS.maxPromptOutputBytes, 1024, 4 * 1024 * 1024),
  maxReviewCalls: boundedInteger(limits.maxReviewCalls, DEFAULT_LIMITS.maxReviewCalls, 0, 16),
  maxReviewOutputBytes: boundedInteger(limits.maxReviewOutputBytes, DEFAULT_LIMITS.maxReviewOutputBytes, 1024, 1024 * 1024),
  maxEmissions: boundedInteger(limits.maxEmissions, DEFAULT_LIMITS.maxEmissions, 1, 32),
  maxEmissionBytes: boundedInteger(limits.maxEmissionBytes, DEFAULT_LIMITS.maxEmissionBytes, 1024, 8 * 1024 * 1024),
  maxResultBytes: boundedInteger(limits.maxResultBytes, DEFAULT_LIMITS.maxResultBytes, 1024, 16 * 1024 * 1024),
});

export class WorkflowRuntimeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "WorkflowRuntimeError";
    this.code = code;
    this.details = clone(details);
  }
}

const runtimeError = (code, message, details = {}) => new WorkflowRuntimeError(code, message, details);

const validatePlainData = (value, label = "输入", seen = new Set()) => {
  if (value == null || ["string", "number", "boolean"].includes(typeof value)) return;
  if (typeof value !== "object") throw runtimeError("invalid_input", `${label}只能包含 JSON 数据`);
  if (seen.has(value)) throw runtimeError("invalid_input", `${label}不能包含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validatePlainData(item, label, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw runtimeError("invalid_input", `${label}只能包含普通对象`);
    for (const [key, item] of Object.entries(value)) {
      if (BLOCKED_FIELDS.has(key)) throw runtimeError("invalid_input", `${label}包含禁止字段：${key}`);
      validatePlainData(item, label, seen);
    }
  }
  seen.delete(value);
};

const assertExplicitPolicy = ({ grantedPermissions, availableTools }) => {
  if (!Array.isArray(grantedPermissions)) {
    throw runtimeError("policy_required", "必须由可信调用方显式提供 grantedPermissions");
  }
  if (!Array.isArray(availableTools)) {
    throw runtimeError("policy_required", "必须由可信调用方显式提供 availableTools");
  }
  const granted = uniqueStrings(grantedPermissions);
  const available = uniqueStrings(availableTools);
  const unsupportedPermissions = granted.filter((permission) => !OFFLINE_PERMISSION_SET.has(permission));
  const unsupportedTools = available.filter((toolId) => !OFFLINE_TOOL_SET.has(toolId));
  if (unsupportedPermissions.length) {
    throw runtimeError("permission_not_supported", `离线 Workflow 不支持授权：${unsupportedPermissions.join("、")}`, { unsupportedPermissions });
  }
  if (unsupportedTools.length) {
    throw runtimeError("tool_not_supported", `离线 Workflow 不提供工具：${unsupportedTools.join("、")}`, { unsupportedTools });
  }
  return { granted, available };
};

const compileOfflinePlan = ({ manifest, grantedPermissions, availableTools, limits, promptRunner, reviewers }) => {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw runtimeError("invalid_manifest", "缺少 Workflow Skill manifest");
  }
  if (manifest.runtime !== "declarative") {
    throw runtimeError("runtime_not_available", "当前仅支持 declarative；isolated_worker 与 wasi 必须等待外部隔离执行器");
  }
  const plan = compileWorkflowExecutionPlan({ manifest, grantedPermissions, availableTools });
  if (!plan.ok) {
    throw runtimeError("compile_failed", "Workflow 执行计划未通过权限、工具或合同编译", {
      errors: plan.errors ?? [],
      warnings: plan.warnings ?? [],
      missingPermissions: plan.missingPermissions ?? [],
      missingTools: plan.missingTools ?? [],
    });
  }
  if (plan.steps.length > limits.maxSteps) {
    throw runtimeError("step_budget_exceeded", `Workflow 步骤超过预算：${limits.maxSteps}`);
  }
  const declaredUnsafeTools = plan.immutableManifest.tools.filter((toolId) => !OFFLINE_TOOL_SET.has(toolId));
  if (declaredUnsafeTools.length) {
    throw runtimeError("tool_not_supported", `Workflow 声明了不安全或不存在的工具：${declaredUnsafeTools.join("、")}`);
  }
  const promptSteps = plan.steps.filter((step) => step.kind === "prompt");
  if (promptSteps.length && typeof promptRunner !== "function") {
    throw runtimeError("trusted_prompt_runner_required", "包含 prompt 步骤的 Workflow 必须注入受信模型执行器");
  }
  if (promptSteps.length > limits.maxPromptCalls) {
    throw runtimeError("prompt_budget_exceeded", `prompt 步骤超过预算：${limits.maxPromptCalls}`);
  }
  const reviewSteps = plan.steps.filter((step) => step.kind === "review");
  if (reviewSteps.length > limits.maxReviewCalls) {
    throw runtimeError("review_budget_exceeded", `review 步骤超过预算：${limits.maxReviewCalls}`);
  }
  for (const step of reviewSteps) {
    const reviewerId = String(step.reviewer ?? "default");
    if (BLOCKED_FIELDS.has(reviewerId)
      || !Object.prototype.hasOwnProperty.call(reviewers, reviewerId)
      || typeof reviewers[reviewerId] !== "function") {
      throw runtimeError("trusted_reviewer_required", `步骤 ${step.id} 必须注入受信审查器：${reviewerId}`);
    }
  }
  for (const step of plan.steps.filter((candidate) => candidate.kind === "emit")) {
    const permission = EMISSION_PERMISSION[step.channel ?? "draft"];
    if (!permission) throw runtimeError("emit_channel_denied", `禁止输出通道：${step.channel}`);
    if (!plan.immutableManifest.permissions.includes(permission) || !grantedPermissions.includes(permission)) {
      throw runtimeError("emit_permission_denied", `输出通道 ${step.channel ?? "draft"} 缺少权限：${permission}`);
    }
  }
  return plan;
};

const publicDocument = (documentId, documentState = {}, maxChars = 200_000) => {
  const markdown = String(documentState.markdown ?? "");
  return {
    documentId,
    title: String(documentState.title ?? documentId),
    markdown: markdown.slice(0, maxChars),
    truncated: markdown.length > maxChars,
    updatedAt: String(documentState.updatedAt ?? ""),
    moduleId: String(documentState.moduleId ?? ""),
    workspaceView: String(documentState.workspaceView ?? ""),
    sourcePath: String(documentState.sourcePath ?? ""),
  };
};

const normalizedDocumentIds = (input, documents, { required = true, maximum = 20 } = {}) => {
  const ids = Array.isArray(input?.documentIds) ? uniqueStrings(input.documentIds) : [];
  if (required && !ids.length) return { ids, issues: ["documentIds 不能为空"] };
  if (ids.length > maximum) return { ids, issues: [`documentIds 不能超过 ${maximum} 项`] };
  const unknown = ids.filter((documentId) => !Object.prototype.hasOwnProperty.call(documents, documentId));
  return { ids, issues: unknown.length ? [`文档不在当前工作区：${unknown.join("、")}`] : [] };
};

const registerOfflineTools = ({ broker, documents }) => {
  broker.register("shensi/document.read", {
    permission: "document.read",
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return ["输入必须是对象"];
      const documentId = String(input.documentId ?? "").trim();
      if (!documentId) return ["documentId 不能为空"];
      if (!Object.prototype.hasOwnProperty.call(documents, documentId)) return ["文档不在当前工作区"];
      if (input.maxChars != null && (!Number.isInteger(Number(input.maxChars)) || Number(input.maxChars) < 1 || Number(input.maxChars) > 200_000)) {
        return ["maxChars 必须是 1-200000 的整数"];
      }
      return [];
    },
    handler: async (input) => {
      const documentId = String(input.documentId).trim();
      return publicDocument(documentId, documents[documentId], Number(input.maxChars) || 200_000);
    },
  });

  broker.register("shensi/workspace.search", {
    permission: "context.read",
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return ["输入必须是对象"];
      const query = String(input.query ?? "").trim();
      if (!query || query.length > 120) return ["query 必须是 1-120 个字符"];
      if (input.limit != null && (!Number.isInteger(Number(input.limit)) || Number(input.limit) < 1 || Number(input.limit) > 20)) {
        return ["limit 必须是 1-20 的整数"];
      }
      return normalizedDocumentIds(input, documents, { required: false, maximum: 100 }).issues;
    },
    handler: async (input) => {
      const query = String(input.query).trim();
      const selected = normalizedDocumentIds(input, documents, { required: false, maximum: 100 }).ids;
      const candidates = selected.length ? selected : Object.keys(documents);
      const requestedLimit = Number(input.limit) || 10;
      const ranked = rankRelevantDocuments({
        ids: candidates,
        query,
        titleFor: (documentId) => documents[documentId]?.title ?? documentId,
        contentFor: (documentId) => documents[documentId]?.markdown ?? "",
        limit: requestedLimit + 1,
      });
      const matches = ranked.slice(0, requestedLimit).map(({ id: documentId, score, matchedTerms }) => {
        const documentState = documents[documentId] ?? {};
        const markdown = String(documentState.markdown ?? "");
        const snippet = excerptContextContent(markdown, 420, { query }).text || markdown.slice(0, 420);
        return {
          documentId,
          title: String(documentState.title ?? documentId),
          snippet,
          score: Math.round(score * 1_000) / 1_000,
          matchedTerms,
        };
      });
      return { query, retrieval: "bm25-cjk-v1", matches, truncated: ranked.length > requestedLimit };
    },
  });

  broker.register("shensi/context.read", {
    permission: "context.read",
    validate: (input) => {
      if (!input || typeof input !== "object" || Array.isArray(input)) return ["输入必须是对象"];
      const { issues } = normalizedDocumentIds(input, documents, { required: true, maximum: 20 });
      if (issues.length) return issues;
      if (input.maxCharsPerDocument != null && (!Number.isInteger(Number(input.maxCharsPerDocument)) || Number(input.maxCharsPerDocument) < 1 || Number(input.maxCharsPerDocument) > 20_000)) {
        return ["maxCharsPerDocument 必须是 1-20000 的整数"];
      }
      return [];
    },
    handler: async (input) => {
      const { ids } = normalizedDocumentIds(input, documents, { required: true, maximum: 20 });
      const maxChars = Number(input.maxCharsPerDocument) || 8_000;
      return { documents: ids.map((documentId) => publicDocument(documentId, documents[documentId], maxChars)) };
    },
  });
};

const withDeadline = async (work, { deadlineAt, signal, label }) => {
  if (signal?.aborted) throw runtimeError("aborted", "Workflow 已取消");
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw runtimeError("timeout", `Workflow ${label} 超时`);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(runtimeError("timeout", `Workflow ${label} 超时`)), remainingMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(work), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

export const executeOfflineWorkflow = async ({
  appRoot,
  requestedPath,
  manifest,
  grantedPermissions,
  availableTools,
  inputs = {},
  promptRunner = null,
  reviewers = {},
  signal,
  limits: requestedLimits = {},
} = {}) => {
  const limits = normalizeLimits(requestedLimits);
  if (!reviewers || typeof reviewers !== "object" || Array.isArray(reviewers)) {
    throw runtimeError("invalid_reviewer_registry", "reviewers 必须是受信审查器对象");
  }
  validatePlainData(inputs);
  if (serializedBytes(inputs) > limits.maxInputBytes) {
    throw runtimeError("input_budget_exceeded", `Workflow 输入超过预算：${limits.maxInputBytes} bytes`);
  }
  const policy = assertExplicitPolicy({ grantedPermissions, availableTools });
  const plan = compileOfflinePlan({
    manifest,
    grantedPermissions: policy.granted,
    availableTools: policy.available,
    limits,
    promptRunner,
    reviewers,
  });
  let workspaceRoot;
  let loaded;
  try {
    workspaceRoot = resolveWorkspaceRoot({ appRoot, requestedPath });
    loaded = await loadWorkspaceState({ appRoot, requestedPath: workspaceRoot });
  } catch (error) {
    if (error instanceof WorkflowRuntimeError) throw error;
    throw runtimeError("workspace_scope_denied", cleanAuditReason(error));
  }
  if (!loaded.state) throw runtimeError("workspace_not_initialized", "工作区尚未完成本地保存，无法运行 Workflow");
  const documents = loaded.state.documents && typeof loaded.state.documents === "object" ? loaded.state.documents : {};
  const runtimeAudit = [];
  let auditSequence = 0;
  const recordAudit = (entry) => {
    runtimeAudit.push({ ...entry, sequence: ++auditSequence });
  };
  const broker = new WorkflowToolBroker({
    grantedPermissions: policy.granted,
    availableTools: policy.available,
    scope: { workspaceId: basename(workspaceRoot), documentIds: Object.keys(documents) },
    maxToolCalls: limits.maxToolCalls,
    maxOutputBytes: limits.maxToolOutputBytes,
    maxTotalOutputBytes: limits.maxTotalToolOutputBytes,
    auditSink: recordAudit,
  });
  registerOfflineTools({ broker, documents });
  const deadlineAt = Date.now() + limits.maxDurationMs;
  let promptCalls = 0;
  const guardedPromptRunner = typeof promptRunner === "function" ? async (context) => {
    promptCalls += 1;
    const startedAt = Date.now();
    if (promptCalls > limits.maxPromptCalls) throw runtimeError("prompt_budget_exceeded", `prompt 调用超过预算：${limits.maxPromptCalls}`);
    try {
      const output = await withDeadline(
        () => promptRunner({ ...context, workspace: { id: basename(workspaceRoot), documentCount: Object.keys(documents).length } }),
        { deadlineAt, signal: context.signal, label: `prompt ${context.step?.id ?? ""}` },
      );
      validatePlainData(output, "prompt 输出");
      const outputBytes = serializedBytes(output);
      if (outputBytes > limits.maxPromptOutputBytes) {
        throw runtimeError("prompt_output_budget_exceeded", `prompt 输出超过预算：${limits.maxPromptOutputBytes} bytes`);
      }
      recordAudit({
        type: "prompt",
        status: "completed",
        stepId: context.step?.id ?? "",
        durationMs: Date.now() - startedAt,
        outputBytes,
      });
      return clone(output);
    } catch (error) {
      const safeError = error instanceof WorkflowRuntimeError
        ? error
        : runtimeError("prompt_runner_failed", "受信 prompt 执行器调用失败");
      recordAudit({
        type: "prompt",
        status: "rejected",
        stepId: context.step?.id ?? "",
        durationMs: Date.now() - startedAt,
        outputBytes: 0,
        reason: cleanAuditReason(safeError),
      });
      throw safeError;
    }
  } : null;
  let reviewCalls = 0;
  const guardedReviewers = Object.fromEntries(Object.entries(reviewers)
    .filter(([, reviewer]) => typeof reviewer === "function")
    .map(([reviewerId, reviewer]) => [reviewerId, async (context) => {
      reviewCalls += 1;
      const startedAt = Date.now();
      if (reviewCalls > limits.maxReviewCalls) throw runtimeError("review_budget_exceeded", `review 调用超过预算：${limits.maxReviewCalls}`);
      try {
        const output = await withDeadline(
          () => reviewer({ ...context, workspace: { id: basename(workspaceRoot), documentCount: Object.keys(documents).length } }),
          { deadlineAt, signal: context.signal, label: `review ${context.step?.id ?? reviewerId}` },
        );
        validatePlainData(output, "review 输出");
        const outputBytes = serializedBytes(output);
        if (outputBytes > limits.maxReviewOutputBytes) {
          throw runtimeError("review_output_budget_exceeded", `review 输出超过预算：${limits.maxReviewOutputBytes} bytes`);
        }
        recordAudit({
          type: "review",
          status: "completed",
          stepId: context.step?.id ?? "",
          reviewerId,
          durationMs: Date.now() - startedAt,
          outputBytes,
        });
        return clone(output);
      } catch (error) {
        const safeError = error instanceof WorkflowRuntimeError
          ? error
          : runtimeError("reviewer_failed", `受信审查器调用失败：${reviewerId}`);
        recordAudit({
          type: "review",
          status: "rejected",
          stepId: context.step?.id ?? "",
          reviewerId,
          durationMs: Date.now() - startedAt,
          outputBytes: 0,
          reason: cleanAuditReason(safeError),
        });
        throw safeError;
      }
    }]));

  try {
    const result = await withDeadline(
      () => executeWorkflowPlan({
        plan,
        broker,
        inputs: clone(inputs),
        promptRunner: guardedPromptRunner,
        reviewers: guardedReviewers,
        signal,
      }),
      { deadlineAt, signal, label: "执行" },
    );
    if (result.emissions.length > limits.maxEmissions) {
      throw runtimeError("emission_budget_exceeded", `Workflow 输出项超过预算：${limits.maxEmissions}`);
    }
    const emissionBytes = serializedBytes(result.emissions);
    if (emissionBytes > limits.maxEmissionBytes) {
      throw runtimeError("emission_budget_exceeded", `Workflow 草稿输出超过预算：${limits.maxEmissionBytes} bytes`);
    }
    for (const emission of result.emissions) {
      if (!Object.prototype.hasOwnProperty.call(EMISSION_PERMISSION, emission.channel)) {
        throw runtimeError("emit_channel_denied", `禁止输出通道：${emission.channel}`);
      }
    }
    if (serializedBytes(result) > limits.maxResultBytes) {
      throw runtimeError("result_budget_exceeded", `Workflow 返回结果超过预算：${limits.maxResultBytes} bytes`);
    }
    return {
      ...result,
      audit: runtimeAudit,
      requiresUserCommit: result.emissions.length > 0 || result.requiresUserCommit === true,
      workspace: { id: basename(workspaceRoot), documentCount: Object.keys(documents).length },
      policy: {
        runtime: "declarative",
        grantedPermissions: policy.granted,
        availableTools: policy.available,
        directWrites: false,
        networkAccess: false,
      },
    };
  } catch (error) {
    if (error instanceof WorkflowRuntimeError) {
      error.details = { ...error.details, audit: clone(runtimeAudit) };
      throw error;
    }
    throw runtimeError("execution_failed", cleanAuditReason(error), { audit: clone(runtimeAudit) });
  }
};
