import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { compileContextSections } from "../src/context-compiler.js";
import { dreaminaMembershipFromPayload } from "../src/dreamina-membership.js";
import { memoryHealth } from "../src/memory-health.js";
import { pendingDecisionDisplay } from "../src/author-cockpit.js";
import { runCreativeIntegrityScan } from "../src/server/creative-integrity-service.mjs";
import { loadTypeTheoryContext } from "../src/server/shensi-context.mjs";

const membership = dreaminaMembershipFromPayload({
  data: { account: { member_level: "maestro", is_member: true, membership_expires_at: "2027-08-15" } },
});
assert.equal(membership.tier, "advanced");
assert.equal(membership.label, "高级会员");
assert.equal(membership.rawLevel, "maestro");
assert.equal(membership.expiresAt, "2027-08-15");
assert.equal(dreaminaMembershipFromPayload({ vip_level: "ultra" }).label, "高级会员");

const documents = [
  { documentId: "library-north", title: "北明院资料", path: "篆天录／资料／北明院资料", moduleId: "library", revision: "r1", content: "北明院只接受北明血脉后裔入院。" },
  { documentId: "outline-3", title: "第三章大纲", path: "篆天录／大纲／第三章", moduleId: "outline", revision: "r2", content: "陆瑶没有北明血脉，但通过灵息测试进入北明院。" },
  { documentId: "canon-rule", title: "身份规则", path: "篆天录／设定／身份规则", moduleId: "canon", revision: "r3", content: "北明院只接受北明血脉后裔入院。" },
  { documentId: "chapter-3", title: "第三章", path: "篆天录／正文／第三章", moduleId: "manuscript", revision: "r4", content: "陆瑶通过灵息测试后正式进入北明院。" },
  { documentId: "memory-snapshot", title: "状态快照", path: "篆天录／记忆／状态快照", moduleId: "memory", revision: "r5", content: "陆瑶已经成为北明院学员。" },
];
const compiled = compileContextSections({
  ids: documents.map((document) => document.documentId),
  requiredIds: documents.map((document) => document.documentId),
  titleFor: (id) => documents.find((document) => document.documentId === id).title,
  contentFor: (id) => documents.find((document) => document.documentId === id).content,
  authorityFor: (id) => id.startsWith("canon") ? "canon" : "reference",
  maxCharacters: 50_000,
  perDocumentLimit: 8_000,
  query: "检查北明院身份规则与第三章的冲突",
});
assert.deepEqual(new Set(compiled.includedIds), new Set(documents.map((document) => document.documentId)));
assert.equal(compiled.manifest.every((item) => item.included), true);

const firstScan = await runCreativeIntegrityScan({
  settings: {}, documents, existingIssues: [], trigger: { documentId: "chapter-3", reason: "manual_version_created" },
  runModel: async () => ({ text: JSON.stringify({
    issues: [{
      question: "北明院究竟只接收北明血脉后裔，还是也允许无血脉者通过灵息测试入院？",
      conflictExplanation: "身份规则限定只有北明血脉后裔可以入院，但第三章让无血脉的陆瑶通过灵息测试正式入院；两条规则不能同时成立，会影响陆瑶身份、入院情节和后续大纲。请确定最终采用哪一种入院规则。",
      conflictPoints: ["只接受血脉后裔", "无血脉者可通过测试入院"],
      sources: [
        { documentId: "canon-rule", quote: "北明院只接受北明血脉后裔入院。" },
        { documentId: "chapter-3", quote: "陆瑶通过灵息测试后正式进入北明院。" },
      ],
    }], resolutions: [],
  }) }),
});
assert.equal(firstScan.issues.length, 1);
assert.equal(firstScan.issues[0].sources.length, 2);
assert.match(firstScan.issues[0].conflictExplanation, /两条规则不能同时成立/u);
assert.equal(pendingDecisionDisplay(firstScan.issues[0]).sources.length, 2);

const health = memoryHealth({
  moduleItems: { manuscript: [["chapter-3", "第三章"]] },
  documents: { "chapter-3": {
    title: "第三章", markdown: documents.find((document) => document.documentId === "chapter-3").content,
    continuityDelta: { summary: "陆瑶已经进入北明院。", evidenceVerified: true, evidence: [{ quote: "陆瑶已经进入北明院。" }], nextCarryover: ["确认身份规则"] },
    memoryConflictIssues: [firstScan.issues[0].id],
  } },
});
assert.equal(health.conflicts, 1);
assert.equal(health.rows[0].status, "conflict");

const secondDocuments = documents.map((document) => document.documentId === "canon-rule"
  ? { ...document, revision: "r6", content: "北明院允许北明血脉后裔，或通过灵息测试者入院。" } : document);
const secondScan = await runCreativeIntegrityScan({
  settings: {}, documents: secondDocuments, existingIssues: firstScan.issues,
  trigger: { documentId: "canon-rule", reason: "self_check_patch_committed" },
  runModel: async () => ({ text: JSON.stringify({ issues: [], resolutions: [{
    issueFingerprint: firstScan.issues[0].issueFingerprint,
    resolutionEvidence: "设定已经明确补入灵息测试通道，与第三章一致。",
    sources: [{ documentId: "canon-rule", quote: "北明院允许北明血脉后裔，或通过灵息测试者入院。" }],
  }] }) }),
});
assert.equal(secondScan.resolutions.length, 1);

const bundledShensiRoot = fileURLToPath(new URL("../packaging/bundled/skill/神思/", import.meta.url));
const routedTheory = await loadTypeTheoryContext({
  shensiRoot: bundledShensiRoot,
  prompt: "续写当前科幻小说第三章，并遵守作品设定和大纲",
  projectContext: `作品类型：科幻网文；当前章节为第三章。\n\n${compiled.text}`,
  workspaceKind: "project",
});
assert.equal(routedTheory.matched, true);
assert.ok(routedTheory.ruleCount >= 1);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /\["outline", 18\], \["canon", 18\], \["memory", 18\]\]/u, "正文上下文只自动读取大纲、正史设定和记忆");
assert.doesNotMatch(appSource, /\["library",\s*\d+\]/u, "资料库不得进入正文自动读取清单");
assert.doesNotMatch(appSource, /manual_version_recheck|ai_content_committed/u, "手动保存与普通正文落盘不得自动触发模型完整性审查");
assert.match(appSource, /scheduleManualNarrativeMemorySync/u, "正文编辑仍须进入低频记忆与驾驶舱同步");
assert.match(appSource, /reviewDeliveryPolicy/u, "显式自检继续通过正式报告策略执行");
assert.match(appSource, /data-open-pending-source/u);

console.log("Shensi v2.16 integrity, five-source context, Skill and membership tests passed");
