import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { historyObjectHashForStorage, serializeHistoryObjectForStorage } from "../src/server/workspace.mjs";

const left = { title: "同一版本", html: "第一句。\n第二句。", markdown: "# 同一版本\n\n第一句。\n第二句。" };
const right = { markdown: "# 同一版本\n\n第一句。\n第二句。", html: "第一句。\n第二句。", title: "同一版本" };
assert.notEqual(JSON.stringify(left), JSON.stringify(right), "fixture must differ in source key order");
assert.equal(serializeHistoryObjectForStorage(left), serializeHistoryObjectForStorage(right));
assert.equal(historyObjectHashForStorage(left), historyObjectHashForStorage(right));

const hash = createHash("sha256").update(serializeHistoryObjectForStorage(left), "utf8").digest("hex");
assert.equal(historyObjectHashForStorage(left), hash);

const source = await readFile(new URL("../src/server/workspace.mjs", import.meta.url), "utf8");
assert.match(source, /canonicalHistoryValue/u);
assert.match(source, /serializeHistoryObjectForStorage/u);
assert.match(source, /collectStoredHistoryObjectRefs/u);
assert.match(source, /await pruneUnreferencedHistoryObjects\(\{ historyRoot, referencedObjects \}\)/u);

console.log("History object canonical serialization and deferred-reference cleanup contracts passed");
