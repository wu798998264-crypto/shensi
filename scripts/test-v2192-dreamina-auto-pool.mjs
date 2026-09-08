import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const codexProvider = await readFile(new URL("../src/server/codex-agent-provider.mjs", import.meta.url), "utf8");
const videoCli = await readFile(new URL("../src/cli/dreamina-video-cli.mjs", import.meta.url), "utf8");
const driver = await readFile(new URL("../src/server/media-provider-drivers.mjs", import.meta.url), "utf8");
assert.doesNotMatch(app, /即梦 · 自动账号池/u);
assert.doesNotMatch(app, /selectDreaminaAutoPoolSettings/u);
assert.doesNotMatch(app, /selectDreaminaAccountCandidate/u);
assert.match(app, /DREAMINA_PROFILE_SWITCH_BLOCKED/u);
assert.match(app, /profile\?\.adapter[^\n]+=== "cli"/u);
assert.match(app, /forceChatgpt: true/u);
assert.match(server, /startAccountLogin\(\{ forceChatgpt: body\.forceChatgpt === true \}\)/u);
assert.match(codexProvider, /async startAccountLogin\(\{ forceChatgpt = false \}/u);
assert.match(videoCli, /DREAMINA_AUTH_REQUIRED/u);
assert.doesNotMatch(videoCli, /refreshGenerationAuth/u, "已核验账号提交前不得无条件重复登录刷新");
assert.match(videoCli, /if \(error\?\.submissionOutcomeKnown === true\)[\s\S]*?rm\(journalPath/u);
assert.match(driver, /DREAMINA_AUTH_REQUIRED/u);

console.log("即梦 CLI 手动配置选择与 API 独立连接回归测试通过");
