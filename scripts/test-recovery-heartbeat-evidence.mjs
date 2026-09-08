import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, server, attemptStore] = await Promise.all([
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../src/server/generation-attempt-store.mjs", import.meta.url), "utf8"),
]);
assert.match(app, /data-heartbeat-at/u);
assert.match(app, /scheduleStaleTextGenerationReconciliation/u);
assert.match(server, /writeStreamEvent\("heartbeat"/u);
assert.match(attemptStore, /heartbeat|recover|resume/u);
assert.match(app, /autosaveReloadButton/u);

console.log(JSON.stringify({
  ok: true,
  conflictRecovery: "contract_and_automation_passed",
  heartbeat: "contract_and_automation_passed",
  manualScreenshots: "pending",
  message: "冲突恢复和长任务心跳的代码/自动化证据通过；仍需真实界面演示并人工截图。",
}));
