const normalizedSessionId = (value) => String(value || "").trim().slice(0, 200);
const DEFAULT_RUNTIME_UNAVAILABLE_RETRY_MS = 5_000;

const publicRuntimeResult = (result, backend, fallbackCode = "") => ({
  ...result,
  executionRuntime: backend === "agent" ? "codex_agent" : "text_adapter",
  ...(fallbackCode ? { runtimeFallbackCode: fallbackCode } : {}),
});

export class ShensiModelRuntimeRouter {
  constructor({ agentRuntime, fallbackRuntime, runtimeUnavailableRetryMs = DEFAULT_RUNTIME_UNAVAILABLE_RETRY_MS, now = Date.now } = {}) {
    if (!agentRuntime || typeof agentRuntime.runStage !== "function") throw new Error("缺少 Codex Agent 创作运行时");
    if (typeof fallbackRuntime !== "function") throw new Error("缺少文本模型回退运行时");
    this.agentRuntime = agentRuntime;
    this.fallbackRuntime = fallbackRuntime;
    this.runtimeUnavailableRetryMs = Number.isFinite(Number(runtimeUnavailableRetryMs))
      ? Math.max(0, Number(runtimeUnavailableRetryMs))
      : DEFAULT_RUNTIME_UNAVAILABLE_RETRY_MS;
    this.now = typeof now === "function" ? now : Date.now;
    this.backends = new Map();
    this.degradedSessions = new Set();
    this.runtimeUnavailableUntil = 0;
    this.runtimeUnavailableCode = "";
  }

  runtimeTemporarilyUnavailable() {
    if (this.runtimeUnavailableUntil > this.now()) return true;
    this.runtimeUnavailableUntil = 0;
    this.runtimeUnavailableCode = "";
    this.degradedSessions.clear();
    return false;
  }

  sessionBackend(sessionId) {
    const normalized = normalizedSessionId(sessionId);
    if (this.degradedSessions.has(normalized) && this.runtimeTemporarilyUnavailable()) return "text";
    return this.backends.get(normalized) || "";
  }

  async run(options = {}) {
    const sessionId = normalizedSessionId(options.shensiRuntime?.sessionId);
    if (!sessionId) return this.fallbackRuntime(options);

    if (this.agentRuntime.supports?.(options) !== true) {
      return publicRuntimeResult(await this.fallbackRuntime(options), "text");
    }
    if (this.runtimeTemporarilyUnavailable()) {
      this.degradedSessions.add(sessionId);
      return publicRuntimeResult(
        await this.fallbackRuntime(options),
        "text",
        this.runtimeUnavailableCode || "CODEX_AGENT_RUNTIME_UNAVAILABLE",
      );
    }

    this.backends.set(sessionId, "agent");
    this.degradedSessions.delete(sessionId);

    try {
      return publicRuntimeResult(await this.agentRuntime.runStage(options), "agent");
    } catch (error) {
      if (options.signal?.aborted || error?.name === "AbortError") throw error;
      if (error?.safeToFallback !== true) throw error;
      const errorCode = String(error.code || "");
      const fallbackCode = errorCode || "CODEX_AGENT_RUNTIME_UNAVAILABLE";
      if (errorCode === "CODEX_AGENT_RUNTIME_UNAVAILABLE") {
        this.runtimeUnavailableUntil = this.now() + this.runtimeUnavailableRetryMs;
        this.runtimeUnavailableCode = fallbackCode;
        this.degradedSessions.add(sessionId);
      }
      const fallback = await this.fallbackRuntime(options);
      return publicRuntimeResult(fallback, "text", fallbackCode);
    }
  }

  async releaseSession(sessionId) {
    const normalized = normalizedSessionId(sessionId);
    if (!normalized) return;
    const backend = this.backends.get(normalized);
    this.backends.delete(normalized);
    this.degradedSessions.delete(normalized);
    if (backend === "agent") await this.agentRuntime.releaseSession?.(normalized);
  }

  async close() {
    const sessions = [...this.backends.keys()];
    this.backends.clear();
    this.degradedSessions.clear();
    this.runtimeUnavailableUntil = 0;
    this.runtimeUnavailableCode = "";
    await Promise.allSettled(sessions.map((sessionId) => this.agentRuntime.releaseSession?.(sessionId)));
    await this.agentRuntime.close?.();
  }
}

export const createShensiModelRuntimeRouter = (options) => new ShensiModelRuntimeRouter(options);
