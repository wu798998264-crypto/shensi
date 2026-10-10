import { normalizeWhiteboardGenerationDraftCache } from "./whiteboard-generation-draft.js";

// Only toolbar values are queued here. No provider request, workspace document,
// credential, generation job or canvas mutation passes through this channel.
export const createWhiteboardGenerationDraftPersistence = ({ send, onError = () => {}, delay = 120 } = {}) => {
  const pending = new Map();
  let timer = null;
  let running = null;
  let lastSessionTime = 0;
  const schedule = (milliseconds = delay) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void flush().catch(() => {}); }, milliseconds);
  };
  const enqueue = (cache, scope) => {
    if (!scope?.workspacePath || !scope?.workspaceId) return;
    const normalized = normalizeWhiteboardGenerationDraftCache(cache);
    const entries = Object.fromEntries(Object.entries(normalized.entries).filter(([, entry]) => entry.workspaceId === scope.workspaceId));
    if (!Object.keys(entries).length && !pending.has(scope.workspaceId)) return;
    const active = normalized.active?.workspaceId === scope.workspaceId ? normalized.active : null;
    lastSessionTime = Math.max(Date.now(), lastSessionTime + 1);
    pending.set(scope.workspaceId, { workspacePath: scope.workspacePath, workspaceKind: scope.workspaceKind,
      sessionUpdatedAt: lastSessionTime, cache: { ...normalized, entries, active, openSessions: active ? [active] : [] } });
    schedule();
  };
  const flush = async ({ keepalive = false } = {}) => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (running) await running;
    const operation = (async () => {
      for (const [key, payload] of [...pending]) {
        try {
          await send(payload, { keepalive });
          if (pending.get(key) === payload) pending.delete(key);
        } catch (error) {
          onError(error);
          schedule(2_000);
          throw error;
        }
      }
    })();
    running = operation;
    try { await operation; }
    finally { if (running === operation) running = null; }
    if (pending.size) return flush({ keepalive });
    return true;
  };
  return { enqueue, flush, hasPending: () => pending.size > 0 };
};
