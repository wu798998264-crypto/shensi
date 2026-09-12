import { access } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const files = [
  "src/app.js",
  "src/cross-format-content-router.js",
  "src/model-presets.js",
  "src/conversation-attachment-intake.js",
  "src/conversation-task-queue.js",
  "src/whiteboard.js",
  "src/anchored-text-edit.js",
  "src/creative-contract.js",
  "src/document-edit-history.js",
  "src/workspace-mode.js",
  "src/server/skill-store.mjs",
  "src/server/app-data.mjs",
  "server.mjs",
  "packaging/windows/desktop-app/main.mjs",
  "packaging/windows/desktop-app/installer-custom.nsh",
];
for (const file of files) {
  await access(file);
  if (!/\.[cm]?js$/u.test(file)) continue;
  const checked = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (checked.status !== 0) process.exit(checked.status || 1);
}
const packageBoundary = spawnSync(process.execPath, ["scripts/test-package-content-policy.mjs"], { stdio: "inherit" });
if (packageBoundary.status !== 0) process.exit(packageBoundary.status || 1);
for (const test of ["scripts/test-v101-core.mjs", "scripts/test-v103-regressions.mjs", "scripts/test-v106-full-optimization.mjs", "scripts/test-v109-execution-authority.mjs", "scripts/test-v111-creative-contract.mjs", "scripts/test-agent-decision-ui-integration.mjs", "scripts/test-codex-api-agent-runtime.mjs", "scripts/test-no-legacy-chat-runtime.mjs", "scripts/test-video-card-focus-pause.mjs"]) {
  const tested = spawnSync(process.execPath, [test], { stdio: "inherit" });
  if (tested.status !== 0) process.exit(tested.status || 1);
}
const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile("package.json", "utf8"));
console.log(`Shensi v${packageJson.version} source check passed`);
