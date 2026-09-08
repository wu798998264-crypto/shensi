import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";
import { runModelAdapter } from "../src/server/adapters.mjs";
import { resolveTrustedGenerationSettings } from "../src/server/generation-runtime-store.mjs";
import { buildTaskContextManifest, taskContextManifestPrompt } from "../src/server/task-session-manager.mjs";
import { buildConversationCapsule } from "../src/conversation-context.js";

const statePath = resolve(process.env.SHENSI_V2190_STATE_PATH || "E:/ShensiUserData/笔记/我的笔记/.shensi/current-state.json");
const reportPath = resolve(process.env.SHENSI_V2190_AB_REPORT || "artifacts/v2190-context-ab/real-model-context-ab.json");
const state = JSON.parse(await readFile(statePath, "utf8"));
const normalized = normalizeGenerationProfiles(state.settings || {});
const chatCliProfile = (normalized.textConnections || []).find((profile) => (
  profile.adapter === "cli"
  && profile.provider === "OpenAI"
  && (profile.executionModes || [profile.executionMode]).includes("chat")
));
assert.ok(chatCliProfile, "真实 A/B 验收需要当前已配置的 OpenAI Chat CLI");
const trusted = await resolveTrustedGenerationSettings({
  channel: "text",
  settings: {
    ...normalized,
    ...chatCliProfile,
    id: chatCliProfile.id,
    connectionId: chatCliProfile.id,
    activeTextConnectionId: chatCliProfile.id,
  },
  persistBindings: async () => {},
});
const settings = {
  ...trusted,
  reasoningEffort: "low",
  speedMode: "fast",
  maxOutputTokens: "256",
  timeoutMs: "180000",
};

const paragraph = "叶昭是雾都的年轻铸钟师。她要在九炉议会封锁账本前公布气税造假证据，但父亲留下的铜心图纸藏在雾桥钟楼，只有巡检官沈砚知道入口。";
const currentDocument = Array.from({ length: 18 }, (_, index) => `${index + 1}. ${paragraph}`).join("\n");
const repeatedConversation = Array.from({ length: 12 }, (_, index) => ([
  { role: "user", content: `第${index + 1}轮：保持叶昭的目标、气税冲突和雾桥钟楼线索。` },
  { role: "assistant", content: `第${index + 1}轮已确认：人物为叶昭，她要公布气税账本，铜心图纸藏在雾桥钟楼。` },
])).flat();
const instruction = "只返回单行 JSON，不要 Markdown：{\"character\":\"主角\",\"goal\":\"主角目标\",\"clue\":\"关键线索地点\"}。";
const system = "你是神思上下文 A/B 验收器。严格从已给当前版本资料提取，不补写故事。";

const manifest = buildTaskContextManifest({
  documents: {
    chapter: {
      id: "chapter",
      title: "第二章 雾桥钟楼",
      moduleId: "manuscript",
      projectId: "ab-work",
      revision: "current-r1",
      relativePath: "正文/第二章 雾桥钟楼.md",
      html: `<p>${currentDocument}</p>`,
    },
  },
  query: instruction,
  targetDocumentId: "chapter",
  includedIds: ["chapter"],
  requiredIds: ["chapter"],
  workspace: { id: "ab-work", title: "雾都铜心", kind: "project" },
});
const capsule = buildConversationCapsule(repeatedConversation, { recentLimit: 2 });
const variants = [
  {
    id: "legacy_repeated_full_context",
    system: `${system}\n\n${currentDocument}\n\n${currentDocument}\n\n${currentDocument}`,
    messages: [...repeatedConversation, { role: "user", content: `${currentDocument}\n\n${instruction}` }],
  },
  {
    id: "task_session_manifest",
    system: `${system}\n\n${taskContextManifestPrompt(manifest)}\n\n任务状态账本：\n${capsule.text}`,
    messages: [{ role: "user", content: `当前绑定文档当前版本：\n${currentDocument}\n\n${instruction}` }],
  },
];

const parseResult = (text) => {
  const raw = String(text || "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`模型未返回 JSON：${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(start, end + 1));
};
const charCount = ({ system: systemText, messages }) => systemText.length + messages.reduce((sum, item) => sum + String(item.content || "").length, 0);
const results = [];
for (const variant of variants) {
  const startedAt = Date.now();
  const response = await runModelAdapter({ settings, system: variant.system, messages: variant.messages, cwd: process.cwd() });
  const parsed = parseResult(response.text);
  const quality = parsed.character === "叶昭" && /公布.*气税|气税.*公布/u.test(String(parsed.goal || "")) && /雾桥钟楼/u.test(String(parsed.clue || ""));
  assert.equal(quality, true, `${variant.id} 未正确读取当前文档`);
  results.push({
    id: variant.id,
    inputCharacters: charCount(variant),
    elapsedMs: Date.now() - startedAt,
    protocol: response.protocol || "",
    providerUsage: response.usage || null,
    quality,
    result: parsed,
  });
}
const reduction = 1 - results[1].inputCharacters / results[0].inputCharacters;
assert.ok(reduction >= 0.4, `真实 A/B 输入字符降幅不足 40%: ${(reduction * 100).toFixed(1)}%`);
const report = {
  ok: true,
  provider: trusted.provider,
  adapter: trusted.adapter,
  model: trusted.model,
  profileId: trusted.connectionId,
  actualProviderUsageAvailable: results.every((item) => item.providerUsage != null),
  tokenAndFeePolicy: results.every((item) => item.providerUsage != null)
    ? "provider_actual"
    : "provider_usage_unavailable; no_token_or_fee_estimate_emitted",
  inputCharacterReductionPercent: Number((reduction * 100).toFixed(1)),
  results,
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report, null, 2));
