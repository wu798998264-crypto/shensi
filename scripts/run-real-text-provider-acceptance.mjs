import process from "node:process";

const option = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
};

const origin = option("--origin", "http://127.0.0.1:4173").replace(/\/$/u, "");
const requestedIds = option("--profiles").split(",").map((value) => value.trim()).filter(Boolean);
const workspacePath = option("--workspace", "E:\\ShensiUserData\\笔记\\我的笔记");
const timeoutMs = Math.max(30_000, Number(option("--timeout-ms", "600000")) || 600_000);

if (!requestedIds.length) {
  throw new Error("请通过 --profiles 提供至少一个文字配置 ID");
}

const htmlResponse = await fetch(origin);
const html = await htmlResponse.text();
const sessionToken = html.match(/name="shensi-session-token" content="([^"]+)"/u)?.[1] || "";
if (!htmlResponse.ok || !sessionToken) throw new Error(`无法读取神思本地会话：HTTP ${htmlResponse.status}`);

const headers = { "content-type": "application/json", "x-shensi-session": sessionToken };
const profileResponse = await fetch(`${origin}/api/generation/profile-settings`, { headers, cache: "no-store" });
const profilePayload = await profileResponse.json();
if (!profileResponse.ok || !profilePayload.ok) throw new Error(profilePayload.message || "文字配置读取失败");

const profiles = Array.isArray(profilePayload.settings?.textConnections)
  ? profilePayload.settings.textConnections
  : [];

const waitForRun = async (runId) => {
  const deadline = Date.now() + timeoutMs;
  let payload = null;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/conversation-agent/${encodeURIComponent(runId)}`, { headers, cache: "no-store" });
    payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || `Agent 状态读取失败：HTTP ${response.status}`);
    if (["completed", "failed", "interrupted"].includes(String(payload.status || ""))) return payload;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { ...payload, status: "timeout", error: `超过 ${timeoutMs}ms 未返回终态` };
};

const results = [];
for (const profileId of requestedIds) {
  const settings = profiles.find((profile) => String(profile.id) === profileId);
  if (!settings) {
    results.push({ profileId, status: "missing", error: "配置不存在" });
    continue;
  }
  const nonce = crypto.randomUUID();
  const expected = `${settings.remarkName || settings.name || profileId}真实验收通过。`;
  const request = {
    workspacePath,
    workspaceKind: "notebook",
    conversationId: `provider-acceptance-${nonce}`,
    sourceMessageId: `user-${nonce}`,
    messages: [{ role: "user", content: `只回复：${expected}` }],
    settings,
    mediaProfiles: {},
  };
  const response = await fetch(`${origin}/api/conversation-agent/start`, {
    method: "POST",
    headers,
    body: JSON.stringify(request),
  });
  const started = await response.json();
  if (!response.ok || !started.ok) {
    results.push({ profileId, name: settings.remarkName || settings.name, status: "start_failed", error: started.message || `HTTP ${response.status}` });
    continue;
  }
  const terminal = await waitForRun(started.id);
  results.push({
    profileId,
    name: settings.remarkName || settings.name,
    model: settings.agentModelId || settings.model || "runner-default",
    runId: started.id,
    status: terminal.status,
    text: String(terminal.text || "").trim(),
    error: String(terminal.error || "").trim(),
    expected,
    exactReply: String(terminal.text || "").trim() === expected,
  });
}

process.stdout.write(`${JSON.stringify({ ok: results.every((result) => result.status === "completed" && result.exactReply), origin, results }, null, 2)}\n`);
if (results.some((result) => result.status !== "completed" || !result.exactReply)) process.exitCode = 1;
