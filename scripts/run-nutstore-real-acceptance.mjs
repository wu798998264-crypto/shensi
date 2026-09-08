import { readFile } from "node:fs/promises";

const base = String(process.env.SHENSI_NUTSTORE_TEST_BASE || "http://127.0.0.1:26655").replace(/\/$/u, "");
const account = String(process.env.SHENSI_NUTSTORE_ACCOUNT || "").trim();
const password = String(process.env.SHENSI_NUTSTORE_APP_PASSWORD || "");
if (!account || !password) throw new Error("缺少临时坚果云账号环境变量");
const home = await fetch(`${base}/`);
const html = await home.text();
const token = html.match(/shensi-session-token" content="([^"]+)/u)?.[1] || "";
if (!token) throw new Error("未能读取本地会话令牌");
const safe = (value) => value === undefined ? undefined : value;
const call = async (path, method = "GET", payload = null) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "x-shensi-session": token, ...(payload ? { "content-type": "application/json" } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: response.status, body };
};
const record = [];
const capture = async (id, path, method = "GET", payload = null) => {
  const response = await call(path, method, payload);
  const body = response.body || {};
  record.push({
    id,
    status: response.status,
    ok: body.ok !== false && response.status < 400,
    code: body.code || "",
    message: body.message || "",
    capability: body.capability ? {
      level: body.capability.capabilityLevel,
      ifMatch: body.capability.ifMatch === true,
      move: body.capability.move === true,
      cleanup: body.capability.cleanup === true,
    } : undefined,
    summary: body.summary,
    mode: body.mode,
    itemCount: Array.isArray(body.items) ? body.items.length : undefined,
    previewToken: Boolean(body.previewToken),
    enabled: safe(body.enabled),
    activeMode: safe(body.activeMode),
    phase: safe(body.phase),
    conflictCount: safe(body.conflictCount),
  });
  return body;
};

const config = {
  endpoint: "https://dav.jianguoyun.com/dav/",
  account,
  password,
  remoteRoot: "/神思同步/",
  deviceName: "Codex-真实验收",
  autoSync: false,
};
await capture("status-before", "/api/sync/nutstore/status");
const tested = await capture("real-login-and-capability", "/api/sync/nutstore/test-connection", "POST", config);
if (tested.ok !== true) {
  console.log(JSON.stringify({ ok: false, stage: "real-login-and-capability", record }, null, 2));
  process.exit(1);
}
const configured = await capture("configure-session", "/api/sync/nutstore/configure", "POST", config);
if (configured.ok !== true) {
  console.log(JSON.stringify({ ok: false, stage: "configure-session", record }, null, 2));
  process.exit(1);
}
const preview = await capture("first-sync-preview", "/api/sync/nutstore/first-sync-preview", "POST", config);
if (preview.ok !== true || !preview.previewToken) {
  console.log(JSON.stringify({ ok: false, stage: "first-sync-preview", record }, null, 2));
  process.exit(1);
}
await capture("enable-sync", "/api/sync/nutstore/enable", "POST", { previewToken: preview.previewToken });
await capture("run-sync", "/api/sync/nutstore/run", "POST", {});
await new Promise((resolve) => setTimeout(resolve, 5000));
await capture("status-after-run", "/api/sync/nutstore/status");
await capture("operations", "/api/sync/nutstore/operations");
await capture("conflicts", "/api/sync/nutstore/conflicts");
await capture("logs", "/api/sync/nutstore/logs");

console.log(JSON.stringify({
  ok: record.every((item) => item.ok),
  account: `${account.slice(0, 3)}***${account.slice(-6)}`,
  record,
  credentialsPersistedByScript: false,
}, null, 2));
