import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { authorCockpitContractDocumentHtml } from "../src/author-cockpit.js";
import {
  applyCreativeContractCandidate,
  creativeContractDocumentPatch,
  creativeContractFieldFromInstruction,
  normalizeCreativeContract,
} from "../src/creative-contract.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [appSource, cssSource, packageScript] = await Promise.all([
  readFile(join(root, "src", "app.js"), "utf8"),
  readFile(join(root, "src", "styles.css"), "utf8"),
  readFile(join(root, "scripts", "windows", "package-windows.ps1"), "utf8"),
]);

const legacy = normalizeCreativeContract({
  html: "<h1>创作合同</h1><h2>项目禁用词</h2><p>当前没有项目级禁用词。</p><h2>特别注意事项</h2><p>尚未填写。</p>",
});
assert.deepEqual(legacy, { schemaVersion: 1, bannedTerms: "", specialNotes: "" });

const migrated = normalizeCreativeContract({
  html: "<h1>创作合同</h1><h2>项目禁用词</h2><p>绝绝子</p><p>命运的齿轮</p><h2>特别注意事项</h2><p>女主不能提前知道真相。</p>",
});
assert.equal(migrated.bannedTerms, "绝绝子\n命运的齿轮");
assert.equal(migrated.specialNotes, "女主不能提前知道真相。");

const manuallyUpdated = creativeContractDocumentPatch({ creativeContract: migrated }, { bannedTerms: "显而易见\n不由得" });
assert.equal(manuallyUpdated.creativeContract.specialNotes, migrated.specialNotes);
assert.match(manuallyUpdated.html, /<h2>项目禁用词<\/h2><p>显而易见<\/p><p>不由得<\/p>/u);
assert.match(manuallyUpdated.markdown, /## 特别注意事项[\s\S]*女主不能提前知道真相/u);

const aiBannedTerms = applyCreativeContractCandidate({
  documentState: manuallyUpdated,
  candidate: "套路化表达\n机械降神",
  instruction: "把这些内容写入项目禁用词，保留特别注意事项",
});
assert.equal(aiBannedTerms.creativeContract.bannedTerms, "套路化表达\n机械降神");
assert.equal(aiBannedTerms.creativeContract.specialNotes, migrated.specialNotes);

const aiStructured = applyCreativeContractCandidate({
  documentState: aiBannedTerms,
  candidate: "## 项目禁用词\n\n万能药\n\n## 特别注意事项\n\n结尾必须保留开放悬念。",
  instruction: "更新创作合同",
});
assert.equal(aiStructured.creativeContract.bannedTerms, "万能药");
assert.equal(aiStructured.creativeContract.specialNotes, "结尾必须保留开放悬念。");
assert.equal(creativeContractFieldFromInstruction("只更新特别注意事项"), "specialNotes");
assert.equal(creativeContractFieldFromInstruction("补充项目禁用词"), "bannedTerms");

const markup = authorCockpitContractDocumentHtml({ documentState: aiStructured });
assert.match(markup, /data-creative-contract-field="bannedTerms"/u);
assert.match(markup, /data-creative-contract-field="specialNotes"/u);
assert.match(markup, /data-creative-contract-ai="bannedTerms"/u);
assert.match(markup, /索引 · 固定项目合同/u);

assert.match(appSource, /cockpitContractDocument \|\| isReadonlyAuthorCockpitDocument/u);
assert.match(appSource, /document\.documentId === CREATIVE_CONTRACT_DOCUMENT_ID[\s\S]{0,220}applyCreativeContractCandidate/u);
assert.match(appSource, /data-creative-contract-field/u);
assert.match(appSource, /creativeContractDocumentPatch\(documentState, \{ \[field\]: input\.value \}\)/u);
assert.match(cssSource, /\.author-cockpit-contract-fields/u);
assert.match(cssSource, /\.author-cockpit-contract-fields\s*\{[\s\S]{0,140}grid-template-columns: minmax\(0, 1fr\)/u);
assert.doesNotMatch(cssSource, /\.author-cockpit-contract-fields\s*\{[\s\S]{0,140}repeat\(2/u);
assert.match(cssSource, /\.author-cockpit-contract-field textarea:focus/u);
assert.match(packageScript, /--config\.electronDist=\$localElectronDist/u);
assert.match(packageScript, /Using local Electron runtime/u);
assert.match(packageScript, /ELECTRON_BUILDER_OFFLINE = "false"/u, "本地Electron无需重新下载，但正式签名必须联网取得可信时间戳");
assert.match(packageScript, /online trusted timestamp signing/u);

console.log("Shensi 1.1.1 creative contract fixed-layout regressions passed");
