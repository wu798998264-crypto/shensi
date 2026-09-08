import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, open, mkdir, rename, stat, realpath } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { publicGenerationAttempt } from "../src/server/generation-attempt-store.mjs";
import { resolveChapterOutlineSource } from "../src/chapter-outline-policy.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const closure = process.argv.includes("--closure");
const workspace = resolve(root, "runtime/browser-preview/作品/三相之力");
const output = resolve(root, closure ? "output/playwright/sanxiang-closure-20260905" : "output/playwright/sanxiang-20260905");
const report = resolve(root, closure ? "docs/reports/2026-09-05-未封口问题修复复核.md" : "docs/reports/2026-09-05-三相之力源码预览与落盘阻断复核.md");
const destinationBase = "E:/ShensiUserData/验收";
const destination = resolve(destinationBase, closure ? "2026-09-05-三相之力未封口修复" : "2026-09-05-三相之力源码预览复核");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (base, path) => {
  const part = relative(base, path);
  return part && !part.startsWith("..") && !isAbsolute(part);
};
const baseline = JSON.parse(await readFile(resolve(output, "document-baseline.json"), "utf8"));
const state = JSON.parse(await readFile(resolve(workspace, ".shensi/current-state.json"), "utf8"));
const hashes = {};
for (const [id, document] of Object.entries(state.documents || {})) {
  if (!document.contentRef?.path) continue;
  const path = await realpath(resolve(workspace, document.contentRef.path));
  assert.ok(inside(workspace, path), `Document escaped workspace: ${id}`);
  const bytes = await readFile(path);
  hashes[id] = { title: document.title, path: relative(workspace, path), bytes: bytes.length, sha256: sha256(bytes) };
}
const changed = Object.keys(hashes).filter((id) => hashes[id].sha256 !== baseline.hashes[id]?.sha256);
assert.ok(changed.every((id) => id === "report-compile"), "Document state changed after report drafting; recheck the report before syncing");
for (const id of ["chapter-1", "chapter-2", "chapter-3", "report-novel"]) assert.equal(hashes[id].sha256, baseline.hashes[id].sha256);
await writeFile(resolve(output, "document-readback.json"), JSON.stringify({
  capturedAt: new Date().toISOString(), workspace, hashes, changed,
}, null, 2));

const taskIds = ["run-1788581848836-grh4s", "run-1788582258598-9ff8w", "run-1788582487644-5qqii",
  "run-1788583166243-q0fru", "run-1788583652953-dqe26", "run-1788584466590-0aauh"];
const tasks = [];
const legacyRecovery = [];
for (const taskId of taskIds) {
  const session = JSON.parse(await readFile(resolve(root, "runtime/browser-preview/task-sessions", `${taskId}.json`), "utf8"));
  tasks.push({ taskId, storedSessionStatus: session.status,
    stages: Object.values(session.stageResults || {}).map(({ stage, text = "", savedAt }) => ({
      stage, savedAt, characters: text.length, sha256: sha256(text),
      containsProtocol: /<\/?(?:tool_call|arg_?key|arg_?value)\b/iu.test(text),
    })),
    readEvents: (session.readEvents || []).map(({ stage, reusedSnapshot, documents = [], skills = [] }) => ({
      stage, reusedSnapshot,
      documents: documents.map(({ id, title, readMode, fullText, compressed, sourceCharacters }) => ({ id, title, readMode, fullText, compressed, sourceCharacters })),
      skills: skills.map(({ id, name, version }) => ({ id, name, version })),
    })),
  });
  if (closure) {
    const path = resolve(root, "runtime/browser-preview/generation-attempts", `${taskId}.json`);
    const bytes = await readFile(path);
    const view = publicGenerationAttempt(JSON.parse(bytes.toString("utf8")));
    assert.equal(view.landingEligible, false);
    assert.equal(view.candidate, "");
    assert.equal(sha256(await readFile(path)), sha256(bytes));
    legacyRecovery.push({ taskId, status: view.status, recoverableAfterRestart: view.recoverableAfterRestart,
      landingEligible: view.landingEligible, originalFileHash: sha256(bytes), originalUnchanged: true });
  }
}
const outlineCandidates = [];
if (closure) for (const id of ["outline-chapter-1", "outline-chapter-2", "outline-chapter-3", "outline-chapter-4", "outline-chapter-5"]) {
  const document = state.documents[id];
  const path = await realpath(resolve(workspace, document.contentRef.path));
  assert.ok(inside(workspace, path));
  outlineCandidates.push({ id, title: document.title, content: await readFile(path, "utf8") });
}
const outlineBindings = closure ? [1, 2, 3].map((chapterNumber) => ({ chapterNumber, ...resolveChapterOutlineSource({ chapterNumber, candidates: outlineCandidates }) })) : [];
if (closure) assert.deepEqual(outlineBindings.map((item) => item.documentId), ["outline-chapter-3", "outline-chapter-4", "outline-chapter-5"]);
const sourceFiles = ["src/task-contract.js", "src/formal-write-authorization.js", "src/review-delivery-policy.js",
  "src/chapter-target.js", "src/creative-mutation-plan.js", "src/formal-mutation-permission.js",
  "src/server/shensi-orchestrator.mjs", "src/server/server-context-verifier.mjs", "src/app.js", "server.mjs",
  ...(closure ? ["src/request-routing.js", "src/chapter-outline-policy.js", "src/review-context-plan.js", "src/formal-write-outcome.js",
    "src/candidate-chapters.js", "src/landing-document-links.js", "src/server/generation-attempt-store.mjs"] : [])];
const sourceHashes = {};
for (const file of sourceFiles) sourceHashes[file] = sha256(await readFile(resolve(root, file)));
const regression = JSON.parse(await readFile(resolve(output, "regression-results.json"), "utf8"));
assert.equal(regression.allPassed, true);
await writeFile(resolve(output, "acceptance-report.json"), JSON.stringify({
  capturedAt: new Date().toISOString(), origin: "http://127.0.0.1:4174", workspace,
  allPassed: false, realReportWorkflowPassed: false,
  softwareRegressionPassed: regression.allPassed,
  reason: closure ? "Browser submission blocked by current Codex CLI connection; no model/provider credentials were changed" : "No new validated report-novel was persisted by these six runs",
  syntaxChecksPassed: regression.syntaxChecks, targetedTestsPassed: regression.targetedTests,
  unchangedProtectedDocuments: ["chapter-1", "chapter-2", "chapter-3", "report-novel"], changedDocuments: changed,
  installedBuildTested: false, paidMediaGenerationRun: false, sourceHashes, tasks,
  ...(closure ? { legacyRecovery, outlineBindings, browserEvidence: "run-1.yml" } : {}),
}, null, 2));

const files = [report, ...["document-baseline.json", "document-readback.json", "regression-results.json",
  "acceptance-report.json", "preview-desktop.png", ...(closure ? ["run-1.yml", "final-state.yml"] : ["recovery-state.yml", "verified-source-build.yml"])].map((name) => resolve(output, name))];
const base = await realpath(destinationBase);
assert.ok(inside(base, destination));
assert.equal(await stat(destination).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; }), false,
  "Destination already exists; nothing will be overwritten");
const staging = resolve(base, `.sanxiang-review-${randomUUID()}`);
assert.ok(inside(base, staging));
await mkdir(staging);
const manifest = { schemaVersion: 1, createdAt: new Date().toISOString(), destination, files: [] };
for (const path of files) {
  const bytes = await readFile(path);
  const name = basename(path);
  const handle = await open(resolve(staging, name), "wx");
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  const expected = sha256(bytes);
  assert.equal(sha256(await readFile(resolve(staging, name))), expected);
  manifest.files.push({ name, source: path, bytes: bytes.length, sha256: expected });
}
const manifestHandle = await open(resolve(staging, "sync-manifest.json"), "wx");
try { await manifestHandle.writeFile(JSON.stringify(manifest, null, 2)); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
await rename(staging, destination);
for (const file of manifest.files) assert.equal(sha256(await readFile(resolve(destination, file.name))), file.sha256);
const result = { synced: true, files: manifest.files.length, destination,
  report: resolve(destination, basename(report)), manifestSha256: sha256(await readFile(resolve(destination, "sync-manifest.json"))) };
await writeFile(resolve(output, "sync-result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
