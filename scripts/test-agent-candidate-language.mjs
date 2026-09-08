import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const panel = await readFile(new URL("../src/conversation-choice-panel.js", import.meta.url), "utf8");
assert.match(app, /const openCandidateGenerationDialog = \(prompt = ""\) => \{[\s\S]{0,260}never ask for a writer role/u);
assert.doesNotMatch(app, /if \(requestsMultipleCandidates\(content\) && openCandidateGenerationDialog\(content\)\) return/u);
assert.match(app, /pending\.kind === "candidate"[\s\S]{0,280}writer-role\/quantity wizard/u);
assert.match(panel, /writer_mode:\s*"请描述候选稿数量和你希望比较的差异"/u);
console.log("Candidate count and variation use natural language; writer-role wizard is disabled");
