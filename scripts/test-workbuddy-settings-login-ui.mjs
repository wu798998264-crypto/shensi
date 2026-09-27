import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
for (const marker of [
  'id="workBuddySettingsConnection"',
  'id="workBuddySettingsStatus"',
  'id="workBuddySettingsLogin"',
  'const renderWorkBuddySettingsControls = () =>',
  'const selected = engine === "workbuddy";',
  'id="quickWorkBuddyConnection"',
  'id="quickWorkBuddyLogin"',
  'id="whiteboardWorkBuddyConnection"',
  'id="whiteboardWorkBuddyLogin"',
  'const renderQuickWorkBuddyControls = () =>',
  'const renderWhiteboardWorkBuddyControls = () =>',
  'const startWorkBuddyLoginFromQuickPanel = async () =>',
  'const startWorkBuddyLoginFromWhiteboard = async () =>',
  'renderWhiteboardWorkBuddyControls();',
  'agentEngineForTextProfile(profile) !== "workbuddy"',
  'selectOnSuccess: false',
  'elements.quickWorkBuddyLogin?.addEventListener("click"',
  'elements.whiteboardWorkBuddyLogin?.addEventListener("click"',
  'if (section) section.hidden = !selected;',
  '登录状态无效，需要重新登录',
  'const startWorkBuddyLoginFromSettings = async () =>',
  'body: JSON.stringify({ runnerId: "workbuddy" })',
  'pollAgentRunnerLoginState("workbuddy", { allowWithoutDialog: true })',
  'const pollAgentRunnerLoginState = async (runnerId, { attempts = 40, allowWithoutDialog = false, selectOnSuccess = true }',
  'if (allowWithoutDialog) renderWorkBuddySettingsControls();',
]) assert.ok(app.includes(marker), `missing WorkBuddy settings login marker: ${marker}`);

console.log(JSON.stringify({ ok: true, surface: "text-model-settings", runner: "workbuddy", login: "shared-endpoint-and-polling" }, null, 2));
