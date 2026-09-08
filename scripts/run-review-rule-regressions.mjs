import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closure = process.argv.includes("--closure");
const extraSources = closure ? ["src/request-routing.js", "src/chapter-outline-policy.js", "src/review-context-plan.js",
  "src/formal-write-outcome.js", "src/candidate-chapters.js", "src/landing-document-links.js", "src/server/generation-attempt-store.mjs"] : [];
const extraTests = closure ? ["test-chapter-outline-source-binding.mjs", "test-generation-attempt-review-recovery.mjs",
  "test-formal-write-outcome.mjs", "test-formal-write-boundary-integration.mjs", "test-review-contract-closure.mjs",
  "test-report-transaction-boundary.mjs", "test-secondary-writer-registration.mjs", "test-task-finalization-recovery.mjs", "test-v282-notebook-chapter-order.mjs"] : [];
const checks = [
  ...["src/task-contract.js", "src/formal-write-authorization.js", "src/review-delivery-policy.js",
    "src/chapter-target.js", "src/creative-mutation-plan.js", "src/formal-mutation-permission.js",
    "src/server/shensi-orchestrator.mjs", "src/server/server-context-verifier.mjs", "src/app.js", "server.mjs", ...extraSources]
    .map((file) => ["--check", file]),
  ...["test-review-report-execution.mjs", "test-task-contract-formal-fact-authorization.mjs",
    "test-task-contract.mjs", "test-formal-target-and-rollback.mjs", "test-semantic-orchestration-simplification.mjs",
    "test-task-contract-formal-delivery.mjs", "test-review-context-scope.mjs", "test-conversation-formal-content-landing.mjs",
    "test-formal-write-confirmation.mjs", "test-v284-required-context-reload.mjs", "test-v120-native-document-transactions.mjs",
    "test-intent-envelope.mjs", "test-v317-consolidated-landing-policy.mjs", "test-v240-formal-artifact-landing.mjs",
    "test-v219-formal-mutation-permission.mjs", "test-writing-style-orchestrator.mjs", "test-v109-execution-authority.mjs",
    "test-multi-candidate-request-routing.mjs", "test-protected-image-profile-switch-workflow.mjs", ...extraTests]
    .map((file) => [`scripts/${file}`]),
];
const results = [];
for (const args of checks) {
  const started = Date.now();
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout: 90_000, windowsHide: true });
  const passed = result.status === 0 && !result.error;
  results.push({ command: ["node", ...args].join(" "), passed, exitCode: result.status,
    elapsedMs: Date.now() - started,
    ...(passed ? {} : { error: String(result.stderr || result.error || result.stdout).slice(-5000) }),
  });
  console.log(`${passed ? "PASS" : "FAIL"} ${args.join(" ")}`);
}
await writeFile(resolve(root, closure ? "output/playwright/sanxiang-closure-20260905/regression-results.json" : "output/playwright/sanxiang-20260905/regression-results.json"), JSON.stringify({
  completedAt: new Date().toISOString(), allPassed: results.every((item) => item.passed),
  syntaxChecks: 10 + extraSources.length, targetedTests: checks.length - 10 - extraSources.length, results,
}, null, 2));
process.exitCode = results.every((item) => item.passed) ? 0 : 1;
