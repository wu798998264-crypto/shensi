import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  hydrateHistoryEntryIntegrity,
  normalizeHistoryEntryIntegrity,
  stampHistoryEntryIntegrity,
} from "../src/version-integrity.js";

const protectedEntry = stampHistoryEntryIntegrity({
  id: "history-large",
  scopeType: "document",
  scopeId: "chapter-1",
  document: { html: `<p>${"正文".repeat(300_000)}</p>` },
});
const hydrated = hydrateHistoryEntryIntegrity(protectedEntry);
assert.notEqual(hydrated, protectedEntry, "hydration may copy the entry shell");
assert.equal(hydrated.document, protectedEntry.document, "protected history payload must not be deep-cloned during hydration");

const damaged = { ...protectedEntry, document: { html: "已被修改" } };
assert.equal(hydrateHistoryEntryIntegrity(damaged).verified, true, "hydration must preserve the stored status without synchronously hashing payloads");
assert.equal(normalizeHistoryEntryIntegrity(damaged).verified, false, "strict normalization must still detect a damaged entry");

const legacy = hydrateHistoryEntryIntegrity({ id: "legacy", scopeType: "document", scopeId: "chapter-2", html: "旧版本" });
assert.equal(legacy.verified, true, "legacy entries must still receive integrity metadata during migration");
assert.ok(legacy.contentHash && legacy.integrityHash);

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const hydrationStart = app.indexOf("const hydrateWorkspace = async () =>");
const hydrationEnd = app.indexOf("const isTextGenerationModel", hydrationStart);
const hydration = app.slice(hydrationStart, hydrationEnd);
assert.ok(hydrationStart >= 0 && hydrationEnd > hydrationStart);
assert.doesNotMatch(hydration, /canonicalBaselineState/u, "startup must not materialize a second full canonical state");
assert.doesNotMatch(hydration, /workspaceStateHashes\(/u, "startup must not hash complete workspace metadata on the renderer thread");
assert.match(hydration, /baselinePreparation/u, "startup must hand baseline work to the background worker");
const worker = await readFile(new URL("../src/workspace-baseline-worker.js", import.meta.url), "utf8");
assert.match(worker, /verifyHistoryEntryIntegrity/u, "history integrity must still be verified in the background worker");
assert.match(app, /applyBackgroundHistoryIntegrity\(historyIntegrity\)/u, "background history verification results must update the live status");

console.log("Startup hydration performance contract passed");
