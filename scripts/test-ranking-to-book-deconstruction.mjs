import assert from "node:assert/strict";
import { buildBookDeconstructionHandoff } from "../src/server/ranking-scan-analysis.mjs";

const handoff = buildBookDeconstructionHandoff([{ title: "星门夜渡", author: "林舟", bookUrl: "https://www.qidian.com/book/101/" }]);
assert.deepEqual(handoff.items[0], { title: "星门夜渡", author: "林舟", sourceUrl: "https://www.qidian.com/book/101/" });
assert.equal(handoff.requiresChapterSelection, true);
assert.equal(handoff.allowFullTextFetch, false);
assert.equal(handoff.allowAutomaticDeconstruction, false);
console.log("Ranking to book deconstruction handoff tests passed");
