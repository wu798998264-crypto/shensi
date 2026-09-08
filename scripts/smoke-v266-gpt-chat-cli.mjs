import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { runModelAdapter } from "../src/server/adapters.mjs";
import { resolveTrustedGenerationSettings } from "../src/server/generation-runtime-store.mjs";

const statePath = process.argv[2];
if (!statePath) throw new Error("Usage: node scripts/smoke-v266-gpt-chat-cli.mjs <current-state.json>");
const state = JSON.parse(await readFile(resolve(statePath), "utf8"));
const normalized = normalizeGenerationProfiles(state.settings || {});
const trusted = await resolveTrustedGenerationSettings({ channel: "text", settings: normalized, route: "chat" });
const settings = {
  ...trusted,
  reasoningEffort: "low",
  speedMode: "fast",
  maxOutputTokens: "64",
  timeoutMs: "120000",
};
const token = `GPT_CHAT_TURN_1_${Date.now().toString(36).toUpperCase()}`;
const first = await runModelAdapter({
  settings,
  system: "This is a GPT Chat connection test. Follow the requested exact-output format.",
  messages: [{ role: "user", content: `Reply with exactly ${token}` }],
  cwd: process.cwd(),
});
if (!String(first.text || "").includes(token)) throw new Error(`GPT Chat first turn mismatch: ${first.text}`);
const second = await runModelAdapter({
  settings,
  system: "This is a GPT Chat multi-turn connection test. Read the supplied conversation and follow the exact-output format.",
  messages: [
    { role: "user", content: `Reply with exactly ${token}` },
    { role: "assistant", content: String(first.text || "").trim() },
    { role: "user", content: "Repeat the exact token from your previous answer and nothing else." },
  ],
  cwd: process.cwd(),
});
if (!String(second.text || "").includes(token)) throw new Error(`GPT Chat second turn lost context: ${second.text}`);
console.log(JSON.stringify({
  ok: true,
  profileId: trusted.connectionId,
  provider: trusted.provider,
  adapter: trusted.adapter,
  model: trusted.model,
  executable: trusted.cliPath,
  firstTurn: String(first.text || "").trim(),
  secondTurn: String(second.text || "").trim(),
  multiTurnContext: true,
}, null, 2));
