import process from "node:process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const option = (name, fallback = "") => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || "") : fallback;
};

const origin = option("--origin", "http://127.0.0.1:4173").replace(/\/$/u, "");
const requestedIds = option("--profiles").split(",").map((value) => value.trim()).filter(Boolean);
const workspacePath = option("--workspace", "E:\\ShensiUserData\\笔记\\我的笔记");
const workspaceKind = option("--workspace-kind", "notebook");
const timeoutMs = Math.max(30_000, Number(option("--timeout-ms", "600000")) || 600_000);
const roundCount = Number(option("--rounds", "3"));

if (!requestedIds.length) {
  throw new Error("请通过 --profiles 提供至少一个文字配置 ID");
}
if (!["notebook", "project"].includes(workspaceKind)) throw new Error("--workspace-kind 仅支持 notebook 或 project");
if (!Number.isInteger(roundCount) || roundCount < 1) throw new Error("--rounds 必须是正整数");

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
    if (["completed", "failed", "interrupted", "cancelled", "waiting_credentials", "waiting_user"].includes(String(payload.status || ""))) return payload;
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
  const nonce = randomUUID();
  const marker = `MEMORY-${nonce.slice(0, 8).toUpperCase()}`;
  const conversationId = `provider-acceptance-${nonce}`;
  const messages = [];
  const result = {
    profileId,
    name: settings.remarkName || settings.name,
    model: settings.agentModelId || settings.model || "runner-default",
    conversationId,
    status: "completed",
    exactReply: true,
    rounds: [],
  };
  for (let round = 1; round <= roundCount; round += 1) {
    const prompt = round === 1
      ? `只回复：${marker}\n请记住这个随机口令，后续我会问你。不要解释，不要调用工具。`
      : `只回复：本对话第一轮我给你的随机口令，原样返回，不加任何其他内容。这是第${round}轮。`;
    messages.push({ role: "user", content: prompt });
    const startedAt = new Date().toISOString();
    const startedTime = Date.now();
    let runId = "";
    let terminal;
    try {
      const response = await fetch(`${origin}/api/conversation-agent/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workspacePath,
          workspaceKind,
          conversationId,
          sourceMessageId: `user-${nonce}-${round}`,
          messages,
          settings,
          mediaProfiles: {},
        }),
      });
      const started = await response.json();
      if (!response.ok || !started.ok) {
        terminal = { status: "start_failed", error: started.message || `HTTP ${response.status}` };
      } else {
        runId = started.id;
        terminal = await waitForRun(runId);
      }
    } catch (error) {
      terminal = { status: "request_failed", error: error.message };
    }
    const text = String(terminal.text || "").trim();
    const roundResult = {
      round,
      runId,
      startedAt,
      finishedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedTime,
      status: terminal.status,
      prompt,
      text,
      error: String(terminal.error || "").trim(),
      expected: marker,
      exactReply: text === marker,
    };
    result.rounds.push(roundResult);
    process.stdout.write(`${JSON.stringify({ profileId, ...roundResult })}\n`);
    if (roundResult.status !== "completed" || !roundResult.exactReply) {
      result.status = roundResult.status;
      result.exactReply = false;
      result.error = roundResult.error || `第 ${round} 轮未精确返回首轮随机口令`;
      break;
    }
    messages.push({ role: "assistant", content: text });
  }
  result.elapsedMs = result.rounds.reduce((total, round) => total + round.elapsedMs, 0);
  results.push(result);
}

const report = {
  ok: results.every((result) => result.status === "completed" && result.exactReply && result.rounds.length === roundCount),
  completedAt: new Date().toISOString(),
  origin,
  workspacePath,
  workspaceKind,
  roundCount,
  results,
};
const reportPath = resolve(option("--report", `output/playwright/real-text-provider-acceptance-${report.completedAt.replace(/[:.]/gu, "-")}.json`));
await mkdir(resolve(reportPath, ".."), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
