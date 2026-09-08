import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

import { createBlankProjectState } from "../src/data.js";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const stylesSource = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const cockpitSource = await readFile(new URL("../src/author-cockpit.js", import.meta.url), "utf8");
const transferSource = await readFile(new URL("../src/server/workspace-document-transfer.mjs", import.meta.url), "utf8");

assert.doesNotMatch(appSource, /quickMemo|memoDirectory|memoCategory|memoEditor|memo-top-actions|\/api\/memos/u);
assert.doesNotMatch(serverSource, /memo-store|\/api\/memos/u);
assert.doesNotMatch(stylesSource, /quick-memo|memo-directory|memo-category|memo-editor|memo-top-actions/u);
await assert.rejects(access(new URL("../src/server/memo-store.mjs", import.meta.url)));

const blank = createBlankProjectState({ name: "备忘录隔离验收" });
assert.equal(blank.documents["library-memo"]?.title, "备忘录");
assert.equal(blank.documents["library-memo"]?.readPolicy, "explicit-only");
assert.equal(blank.moduleItems.library.some(([id]) => id === "library-memo"), true);

assert.doesNotMatch(`${appSource}\n${cockpitSource}\n${transferSource}`, /作者驾驶舱|驾驶舱/u);
assert.match(cockpitSource, /索引 · 项目总览/u);
assert.match(cockpitSource, /索引 · 只读报告/u);

console.log("旧全局备忘录清除、作品备忘录保留与索引可见命名测试通过");
