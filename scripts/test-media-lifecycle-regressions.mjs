import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tests = [
  "test-media-lifecycle-errors.mjs",
  "test-media-local-stop.mjs",
  "test-media-worker-error-pipeline.mjs",
  "test-dreamina-generation-auth-semantics.mjs",
  "test-dreamina-session-recovery.mjs",
  "test-dreamina-manual-profile-lock.mjs",
  "test-dreamina-manual-profile-lock-store.mjs",
  "test-dreamina-lock-occupants.mjs",
  "test-dreamina-result-recovery-policy.mjs",
  "test-v2167-dreamina-durable-queue.mjs",
  "test-v2168-dreamina-terminal-recovery.mjs",
  "test-v280-dreamina-account-isolation.mjs",
  "test-media-worker-startup-and-dreamina-error.mjs",
  "test-media-worker-stop-process.mjs",
  "test-media-capability-evidence-recovery.mjs",
  "test-media-single-flight-card-apply.mjs",
  "test-media-submission-status-recovery.mjs",
  "test-v300-media-restart-recovery.mjs",
  "test-protected-image-profile-switch-workflow.mjs",
  "test-generation-route-isolation-matrix.mjs",
  "test-whiteboard-media-failure-ui.mjs",
];
const results = [];
for (const name of tests) {
  const started = Date.now();
  const result = await new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(root, "scripts", name)], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
    child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-12000); });
    child.once("error", (error) => resolveRun({ name, passed: false, output: error.message }));
    child.once("close", (code) => resolveRun({ name, passed: code === 0, exitCode: code, output, elapsedMs: Date.now() - started }));
  });
  results.push(result);
  console.log(`${result.passed ? "PASS" : "FAIL"} ${name}${result.passed ? "" : `: ${result.output.slice(-600)}`}`);
}
const sourceFiles = ["src/app.js", "server.mjs", "src/server/media-generation-worker.mjs", "src/server/media-provider-drivers.mjs", "src/server/generation-job-store.mjs", "src/server/media-worker-manager.mjs", "src/server/media-local-stop.mjs", "src/dreamina-manual-profile-policy.js", "src/dreamina-failure.js", "src/libtv-result.js", "src/media-execution-policy.js", "src/cli/dreamina-video-cli.mjs", "src/cli/dreamina-image-cli.mjs", "src/server/media-submission-recovery.mjs", "src/media-generation-coordination.js", "src/media-recovery-reconciler.js"];
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [name, createHash("sha256").update(await readFile(join(root, name))).digest("hex")])));
const directory = join(root, "artifacts", "media-lifecycle");
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "verification.json"), JSON.stringify({
  generatedAt: new Date().toISOString(), paidProviderCalls: false,
  note: "CLI responses are simulated; Electron UI uses an isolated temporary workspace. Installed user configuration and data are not modified.",
  passed: results.filter((result) => result.passed).length, total: results.length, sourceHashes: hashes, results,
}, null, 2));
if (results.some((result) => !result.passed)) process.exitCode = 1;
console.log(`${results.filter((result) => result.passed).length}/${results.length} passed; artifacts/media-lifecycle/verification.json`);
