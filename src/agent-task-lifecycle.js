export const AGENT_TASK_LIFECYCLE_STAGES = Object.freeze([
  "understanding",
  "context",
  "executing",
  "reviewing",
  "committing",
  "terminal",
]);

const clean = (value = "") => String(value ?? "").trim().toLowerCase();
const clone = (value) => {
  if (value === undefined) return undefined;
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
};

const TERMINAL = /^(?:complete|completed|done|succeeded|applied|failed|cancelled|canceled|interrupted|retry_required|blocked|hard_blocked)$/u;
const COMMITTING = /(?:commit|committing|apply|applying|landing|landed|saving|saved|writeback|materializ)/u;
const REVIEWING = /(?:review|reviewing|verify|verifying|validation|checking|audit|quality|continuity)/u;
const CONTEXT = /(?:context|evidence|reading|retriev|search|loading|compil|dependency)/u;
const UNDERSTANDING = /(?:queued|starting|thinking|analy|planning|understanding|routing|preparing)/u;

const lifecycleStage = ({ status = "", phase = "", currentStage = "", landingStatus = "", validationStatus = "" } = {}) => {
  const normalizedStatus = clean(status);
  const signal = [phase, currentStage, landingStatus, validationStatus, status].map(clean).filter(Boolean).join(" ");
  if (TERMINAL.test(normalizedStatus)) return "terminal";
  if (COMMITTING.test(signal)) return "committing";
  if (REVIEWING.test(signal)) return "reviewing";
  if (CONTEXT.test(signal)) return "context";
  if (UNDERSTANDING.test(signal)) return "understanding";
  return "executing";
};

export const agentTaskLifecycle = ({
  kind = "agent",
  status = "",
  phase = "",
  currentStage = "",
  landingStatus = "",
  validationStatus = "",
  provider = "",
  agent = "",
  model = "",
  sessionRecovery = "",
  specialist = null,
} = {}) => {
  const stage = lifecycleStage({ status, phase, currentStage, landingStatus, validationStatus });
  return {
    schemaVersion: 1,
    kind: clean(kind) || "agent",
    stage,
    status: clean(status),
    phase: clean(phase),
    provider: String(provider || "").trim(),
    agent: String(agent || "").trim(),
    model: String(model || "").trim(),
    sessionRecovery: String(sessionRecovery || "").trim(),
    terminal: stage === "terminal",
    specialist: specialist && typeof specialist === "object" ? clone(specialist) : null,
  };
};
