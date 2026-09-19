import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const targets = process.argv.slice(2).filter(Boolean);
if (!targets.length) throw new Error("usage: node scripts/cleanup-invalid-openai-seedance-state.mjs <current-state.json> [...]");

const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "");
const results = [];

for (const filePath of targets) {
  const source = await readFile(filePath, "utf8");
  const state = JSON.parse(source);
  const settings = state?.settings && typeof state.settings === "object" ? state.settings : state;
  const profiles = Array.isArray(settings.videoConnections) ? settings.videoConnections : [];
  const removed = profiles.filter((profile) => String(profile?.provider || "").trim() === "OpenAI"
    && /^seedance[-_. ]?2\.5$/iu.test(String(profile?.model || "").trim()));
  if (!removed.length) {
    results.push({ filePath, changed: false, removedIds: [], backupPath: "" });
    continue;
  }

  const retained = profiles.filter((profile) => !removed.includes(profile));
  const removedIds = new Set(removed.map((profile) => String(profile?.id || "")).filter(Boolean));
  settings.videoConnections = retained;
  if (removedIds.has(String(settings.activeVideoConnectionId || ""))) {
    settings.activeVideoConnectionId = retained[0]?.id || "";
  }

  const backupPath = `${filePath}.bak-openai-seedance-${stamp}`;
  const tempPath = join(dirname(filePath), `.current-state.openai-seedance-${process.pid}-${Date.now()}.tmp`);
  await copyFile(filePath, backupPath);
  await writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
  results.push({ filePath, changed: true, removedIds: [...removedIds], backupPath });
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
