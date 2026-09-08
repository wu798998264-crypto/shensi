import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  deepSeekOpenCodeManualProfile,
  genericOpenCodeManualProfile,
  validateGenericOpenCodeConnection,
} from "../src/generation-profiles.js";

const profile = deepSeekOpenCodeManualProfile({ model: "deepseek-chat", apiKey: "secret" });
assert.equal(profile.provider, "DeepSeek");
assert.equal(profile.adapter, "cli");
assert.equal(profile.cliPath, "opencode");
assert.equal(profile.cliArgs, "");
assert.equal(profile.model, "deepseek/deepseek-chat");
assert.equal(profile.agentEngine, "opencode");
assert.equal(profile.credentialSource, "shensi");
assert.equal(validateGenericOpenCodeConnection({
  profile,
  capability: { available: true, modelsVerified: true, models: [{ slug: "deepseek/deepseek-chat" }] },
}).ok, true);
assert.equal(validateGenericOpenCodeConnection({
  profile: { ...profile, model: "not-reported", agentModelId: "not-reported" },
  capability: { available: true, modelsVerified: true, models: [{ slug: "deepseek/deepseek-chat" }] },
}).stage, "model");
const genericProfile = genericOpenCodeManualProfile({ model: "deepseek/deepseek-chat" });
assert.equal(genericProfile.agentEngine, "opencode");
assert.equal(profile.agentEngine, "opencode", "DeepSeek Agent 新配置必须直接使用通用 OpenCode");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /模型厂商：DeepSeek · 运行引擎：OpenCode CLI/u);
assert.match(appSource, /validateDeepSeekOpenCodeConnection/u);
assert.doesNotMatch(appSource, /name="textAgentEngine"[\s\S]{0,240}<option value="deepseek_opencode">/u);

console.log("DeepSeek Agent generic OpenCode migration tests passed");
