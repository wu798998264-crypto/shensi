export const localH3StatusKey = (profile = {}) => String(profile.baseUrl || "http://127.0.0.1:8188").trim().replace(/\/$/u, "");

// Runtime availability must not be OR'ed with an older capability probe.
// Revision guards prevent a slow pre-stop probe from resurrecting readiness.
export const createLocalH3StatusStore = ({ request, now = Date.now }) => {
  const entries = new Map();
  const peek = (profile) => {
    const key = localH3StatusKey(profile);
    if (!entries.has(key)) entries.set(key, { key, revision: 0, checkedAt: 0, result: null, pending: null, action: "", error: "" });
    return entries.get(key);
  };
  const probe = (profile = {}, { force = false } = {}) => {
    const entry = peek(profile);
    if (entry.action) return entry.pending?.catch(() => entry.result) || Promise.resolve(entry.result);
    if (!force && entry.pending) return entry.pending;
    if (!force && entry.result && now() - entry.checkedAt < 20_000) return Promise.resolve(entry.result);
    const revision = ++entry.revision;
    entry.pending = request("probe", profile).then((result) => {
      if (entry.revision === revision) Object.assign(entry, { result, checkedAt: now(), pending: null });
      return entry.result;
    }).catch((error) => {
      if (entry.revision === revision) Object.assign(entry, {
        result: { ...entry.result, ready: false, available: false, unknown: true, reasons: [error.message] },
        checkedAt: now(), pending: null,
      });
      return entry.result;
    });
    return entry.pending;
  };
  const control = (action, profile = {}) => {
    const entry = peek(profile);
    if (entry.action) return Promise.reject(new Error("本地 H3 启停请求正在处理"));
    const revision = ++entry.revision;
    entry.action = action;
    entry.error = "";
    entry.result = { ...entry.result, ready: false, available: false };
    const operation = request(action, profile).then((result) => {
      if (entry.revision === revision) Object.assign(entry, { result, checkedAt: now() });
      return result;
    }).catch(async (error) => {
      const status = await request("probe", profile).catch(() => ({ ...entry.result, unknown: true, ready: false, available: false }));
      if (entry.revision === revision) Object.assign(entry, { result: status, checkedAt: now(), error: error.message });
      throw error;
    }).finally(() => {
      if (entry.revision === revision) Object.assign(entry, { pending: null, action: "" });
    });
    entry.pending = operation;
    return operation;
  };
  return { peek, probe, control };
};
