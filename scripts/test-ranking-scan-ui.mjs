import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const app = await readFile(resolve(import.meta.dirname, "..", "src", "app.js"), "utf8");
for (const id of ["rankingScanDialog", "rankingScanStart", "rankingScanCancel", "rankingScanProgress", "rankingScanDataTab", "rankingScanReportTab", "rankingScanCandidatesTab", "rankingScanContinueDeconstruction", "rankingScanSaveReport", "rankingScanAcquisition", "rankingScanLogin", "rankingScanResultTarget", "rankingScanResultFilter", "rankingScanResultSort", "rankingScanAgentStatus", "agentProfileChoiceDialog", "agentProfileChoiceSelect", "agentProfileChoiceConfirm"]) {
  assert.match(app, new RegExp(`id=[\"']${id}[\"']`), `缺少扫榜界面元素 ${id}`);
}
assert.match(app, /rankingScanTaskInFlight/u);
assert.match(app, /candidate_only/u);
assert.match(app, /本轮已选 Agent 正在接管/u);
assert.match(app, /Skill.*全文已加载并校验/u);
assert.match(app, /正文覆盖/u);
assert.match(app, /agentSettings:\s*generationSettingsForAgentEngine/u);
assert.match(app, /textGenerationProfilesForMode\("agent"\)[\s\S]{0,160}generationConnectionIsConfigured/u, "扫榜配置选择器只能列出已配置的 Agent");
assert.match(app, /requestedAgentProfileId:\s*agentProfile\.id/u, "扫榜请求必须绑定用户明确选择的 Agent 配置");
assert.match(app, /Agent 配置绑定发生变化，已阻止自动改用其他配置/u);
const submitSection = app.slice(app.indexOf('rankingScanElement("rankingScanForm")?.addEventListener'), app.indexOf('rankingScanElement("rankingScanCancel")?.addEventListener'));
assert.doesNotMatch(submitSection, /generationSettingsForAgentEngine\(state\.settings\)\s*,?/u, "扫榜不得使用隐式活动 Agent 配置");
assert.match(app, /data-ranking-scan-export="markdown"/u);
assert.match(app, /data-ranking-scan-export="csv"/u);
assert.match(app, /data-ranking-scan-export="json"/u);
assert.match(app, /ui\.referenceMode = "books"/u, "继续拆书必须进入现有小说引用界面");
const server = await readFile(resolve(import.meta.dirname, "..", "server.mjs"), "utf8");
for (const route of ["sources", "start", "status", "cancel", "auth/start", "auth/status", "auth/cancel", "result", "report/land"]) {
  assert.match(server, new RegExp(`/api/ranking-scan/${route.replace("/", "\\/")}`), `缺少扫榜接口 ${route}`);
}
assert.match(server, /official:bestseller-ranking-scan/u, "扫榜必须固定加载官方 Skill 全文");
assert.match(server, /createRankingAgentExecutor/u, "采集器失败后必须交给当前 Agent");
assert.match(server, /activeAgentProfileId !== requestedAgentProfileId/u, "服务端必须拒绝跨配置执行");
assert.match(server, /!selectedExecutionModes\.includes\("agent"\)/u, "服务端必须拒绝用 Chat 配置执行扫榜");
console.log("Ranking scan UI source tests passed");
