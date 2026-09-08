export const WORKFLOW_SKILL_SCHEMA_VERSION = 3;

export const WORKFLOW_RUNTIME_KINDS = Object.freeze(["declarative", "isolated_worker", "wasi"]);
export const WORKFLOW_PERMISSIONS = Object.freeze([
  "context.read",
  "document.read",
  "document.write_draft",
  "artifact.write_draft",
  "memory.propose",
  "tool.invoke",
]);

const ID = /^[a-z0-9][a-z0-9._-]{2,79}$/i;
const TOOL_ID = /^[a-z0-9][a-z0-9._/-]{2,119}$/i;
const NAMESPACED_CAPABILITY = /^(?:user|shensi)\.[a-z0-9][a-z0-9._-]{2,95}$/i;

const list = (value) => [...new Set((Array.isArray(value) ? value : []).map((item) => String(item).trim()).filter(Boolean))];

export const validateWorkflowSkillManifest = (manifest = {}) => {
  const errors = [];
  const warnings = [];
  if (Number(manifest.schemaVersion) !== WORKFLOW_SKILL_SCHEMA_VERSION) errors.push("schemaVersion 必须为 3");
  if (!ID.test(String(manifest.id ?? ""))) errors.push("id 必须为 3-80 位安全标识");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(manifest.version ?? ""))) errors.push("version 必须使用语义化版本");
  if (!String(manifest.name ?? "").trim()) errors.push("缺少 name");
  if (!WORKFLOW_RUNTIME_KINDS.includes(manifest.runtime)) errors.push("runtime 只能是 declarative、isolated_worker 或 wasi");

  const capabilities = list(manifest.capabilities);
  if (!capabilities.length) errors.push("至少声明一项能力");
  for (const capability of capabilities) {
    if (!NAMESPACED_CAPABILITY.test(capability)) {
      errors.push(`Workflow Skill 能力必须使用 user.* 或 shensi.* 命名空间：${capability}`);
    }
  }

  const permissions = list(manifest.permissions);
  for (const permission of permissions) {
    if (!WORKFLOW_PERMISSIONS.includes(permission)) errors.push(`未知权限：${permission}`);
  }
  if (permissions.includes("tool.invoke") && !list(manifest.tools).length) errors.push("声明 tool.invoke 时必须列出 tools");
  for (const tool of list(manifest.tools)) if (!TOOL_ID.test(tool)) errors.push(`工具 ID 无效：${tool}`);

  const steps = Array.isArray(manifest.workflow?.steps) ? manifest.workflow.steps : [];
  if (!steps.length) errors.push("workflow.steps 不能为空");
  const stepIds = new Set();
  for (const step of steps) {
    if (!ID.test(String(step?.id ?? ""))) errors.push("每个步骤必须具有安全 id");
    if (stepIds.has(step?.id)) errors.push(`步骤 id 重复：${step.id}`);
    stepIds.add(step?.id);
    if (!["prompt", "tool", "transform", "review", "emit"].includes(step?.kind)) errors.push(`步骤类型无效：${step?.kind}`);
    if (step?.kind === "tool" && !list(manifest.tools).includes(step.tool)) errors.push(`步骤调用未声明工具：${step.tool}`);
  }
  for (const step of steps) {
    for (const dependency of list(step.needs)) if (!stepIds.has(dependency)) errors.push(`步骤 ${step.id} 依赖不存在：${dependency}`);
  }

  if (manifest.runtime !== "declarative") warnings.push("脚本运行时必须由外部隔离执行器提供；当前内核不得回退到主进程执行");
  if (!manifest.outputContract) errors.push("缺少 outputContract");
  return { valid: errors.length === 0, errors, warnings, normalized: { ...manifest, capabilities, permissions, tools: list(manifest.tools) } };
};

export const compileWorkflowExecutionPlan = ({ manifest, grantedPermissions = [], availableTools = [] } = {}) => {
  const validation = validateWorkflowSkillManifest(manifest);
  if (!validation.valid) return { ok: false, ...validation };
  const granted = new Set(list(grantedPermissions));
  const available = new Set(list(availableTools));
  const missingPermissions = validation.normalized.permissions.filter((permission) => !granted.has(permission));
  const missingTools = validation.normalized.tools.filter((tool) => !available.has(tool));
  if (missingPermissions.length || missingTools.length) {
    return { ok: false, errors: [], warnings: validation.warnings, missingPermissions, missingTools };
  }
  return {
    ok: true,
    runtime: manifest.runtime,
    immutableManifest: structuredClone(validation.normalized),
    steps: structuredClone(manifest.workflow.steps),
    outputContract: structuredClone(manifest.outputContract),
    requiresUserCommit: validation.normalized.permissions.some((permission) => permission.endsWith("write_draft")),
  };
};
