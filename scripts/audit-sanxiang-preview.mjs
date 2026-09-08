import { createHash } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(root, "runtime/browser-preview/作品/三相之力");
const output = resolve(root, process.argv.includes("--closure") ? "output/playwright/sanxiang-closure-20260905" : "output/playwright/sanxiang-20260905");
const state = JSON.parse(await readFile(resolve(workspace, ".shensi/current-state.json"), "utf8"));
const hashes = {};
for (const [id, document] of Object.entries(state.documents || {})) {
  if (!document.contentRef?.path) continue;
  const path = resolve(workspace, document.contentRef.path);
  const local = relative(workspace, path);
  if (local.startsWith("..") || isAbsolute(local)) throw new Error(`Invalid document path: ${id}`);
  const bytes = await readFile(path);
  hashes[id] = {
    title: document.title, path: local, bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
const conversations = Array.isArray(state.conversations) ? state.conversations : Object.values(state.conversations || {});
const active = conversations.find((item) => item.id === state.activeConversationId);
const messages = active?.messages || state.messages || [];
const messageSummary = messages.slice(-4).map((message) => ({
  id: message.id, role: message.role, text: String(message.content || "").slice(0, 500),
  status: message.execution?.status, result: message.execution?.result,
  taskId: message.execution?.taskId || message.execution?.taskSessionId,
  calls: message.execution?.calls, stages: message.execution?.stages?.map(({ id, status, detail }) => ({ id, status, detail })),
  taskContract: message.taskRoute?.taskContract || message.execution?.taskRoute?.taskContract,
}));
const snapshot = { capturedAt: new Date().toISOString(), workspace, hashes, activeConversationId: state.activeConversationId, messages: messageSummary };
if (process.argv.includes("--before")) {
  await writeFile(resolve(output, "document-baseline.json"), JSON.stringify(snapshot, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ baselineSaved: true, documentCount: Object.keys(hashes).length }));
} else {
  const baseline = JSON.parse(await readFile(resolve(output, "document-baseline.json"), "utf8"));
  const changed = Object.keys(hashes).filter((id) => baseline.hashes[id]?.sha256 !== hashes[id].sha256);
  console.log(JSON.stringify({ changed, activeConversationId: state.activeConversationId, messages: messageSummary }, null, 2));
  if (process.argv.includes("--save")) {
    await writeFile(resolve(output, "document-readback.json"), JSON.stringify({ ...snapshot, changed }, null, 2));
  }
}
if (process.argv.includes("--sessions")) {
  const directory = resolve(root, "runtime/browser-preview/task-sessions");
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const selected = [];
  for (const name of names) {
    const session = JSON.parse(await readFile(resolve(directory, name), "utf8"));
    if (session.conversationId !== state.activeConversationId && !JSON.stringify(session.taskEnvelope || {}).includes(state.activeConversationId)) continue;
    selected.push({ path: name, taskId: session.taskId, status: session.status, stage: session.currentStage,
      skills: Object.values(session.skills || {}).filter((item) => item.loadedStages?.length).map(({ id, name, loadedStages }) => ({ id, name, loadedStages })),
      readEvents: session.readEvents,
    });
  }
  console.log(JSON.stringify({ sessions: selected }, null, 2));
}
