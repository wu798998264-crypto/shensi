import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  candidateLandingProofFingerprint,
  candidateVersionIsAdopted,
  candidateVersionMatchesCurrentLanding,
  recordCandidateAdoption,
} from "../src/candidate-adoption.js";

const documents = { chapter: { title: "第一章", html: "<p>候选甲正文</p>" } };
const group = { id: "group", adoptedVersionId: "", adoptedCandidateId: "" };
const versionA = { id: "a", candidateId: "candidate-a", landedDocuments: [] };
const versionB = { id: "b", candidateId: "candidate-b", landedDocuments: [] };
const proofA = [{ documentId: "chapter", title: "第一章", content: "候选甲正文" }];
const proofB = [{ documentId: "chapter", title: "第一章", content: "候选乙正文" }];
const textContent = (documentState) => String(documentState.html || "").replace(/<[^>]+>/gu, "");

assert.equal(candidateVersionMatchesCurrentLanding({ version: versionA, documents, documentContent: textContent }), false,
  "未落盘候选不能仅凭活动状态被误标为已采用");
recordCandidateAdoption({ group, version: versionA, landedDocuments: proofA, adoptedAt: 1 });
assert.equal(group.adoptedVersionId, "a");
assert.equal(candidateVersionIsAdopted({ group, version: versionA, documents, documentContent: textContent }), true,
  "成功落盘且当前正文一致的候选必须锁定为已采用");
assert.equal(candidateVersionIsAdopted({ group, version: versionB, documents, documentContent: textContent }), false);

documents.chapter.html = "<p>候选乙正文</p>";
assert.equal(candidateVersionIsAdopted({ group, version: versionA, documents, documentContent: textContent }), false,
  "正文不再匹配时旧候选按钮必须释放");
recordCandidateAdoption({ group, version: versionB, landedDocuments: proofB, adoptedAt: 2 });
assert.equal(group.adoptedVersionId, "b");
assert.equal(candidateVersionIsAdopted({ group, version: versionB, documents, documentContent: textContent }), true);
assert.equal(candidateVersionIsAdopted({ group, version: versionA, documents, documentContent: textContent }), false,
  "改选成功后只能锁定新候选");

const beforeFailure = structuredClone(group);
assert.deepEqual(group, beforeFailure, "没有调用成功登记时，原采用状态必须保持不变");
assert.equal(candidateLandingProofFingerprint(proofA), candidateLandingProofFingerprint([
  { documentId: "chapter", title: " 第一章 ", content: "候选甲\n正文" },
]), "相同正文的空白差异不得制造新的采用指纹");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const materializeStart = app.indexOf("const materializeCandidateDraftBranches");
const comparisonStart = app.indexOf("const renderCandidateComparison");
const synchronizeStart = app.indexOf("const synchronizeSelectedCandidateAttempt");
const switchStart = app.indexOf("const switchCandidateDraftBranch", synchronizeStart);
assert.ok(materializeStart >= 0 && comparisonStart > materializeStart && synchronizeStart > comparisonStart && switchStart > synchronizeStart);

const materialize = app.slice(materializeStart, comparisonStart);
const comparison = app.slice(comparisonStart, synchronizeStart);
const synchronize = app.slice(synchronizeStart, switchStart);

assert.match(materialize, /adoptedVersionId:\s*""/u, "候选组必须持久化当前已采用候选");
assert.match(materialize, /landedDocuments:\s*\[\]/u, "候选版本必须保留已落盘文档凭证");
assert.match(comparison, /candidateVersionIsAdopted\(\{\s*group,\s*version,\s*message\s*\}\)/u, "对比窗口必须依据真实落盘状态判断已采用稿");
assert.match(comparison, /disabled aria-disabled=\\"true\\"/u, "已采用候选的采用按钮必须禁用");
assert.match(comparison, /已采用/u, "已采用候选必须显示明确状态");
assert.match(synchronize, /candidateSelectionNeedsNoWrite[\s\S]{0,240}finalizeCandidateAdoptionWithoutWrite/u, "正文完全一致时必须在落盘事务前短路");
assert.match(synchronize, /state\.messages\.find\(\(entry\) => \([\s\S]{0,180}candidateMessageForVersion/u, "本地采用必须优先更新当前活动消息再同步候选版本");
assert.match(synchronize, /if \(landed\) recordCandidateAdoption/u, "只有正式落盘验证成功后才能更新采用状态");
assert.match(synchronize, /if \(landed\) message\.landedDocuments = clone\(landingReply\?\.landedDocuments \?\? \[\]\)/gu, "落盘失败不得清除候选的既有落盘凭证");
assert.match(app, /所选候选与当前文档一致，未重复写入或创建历史版本/u, "无变化采用必须明确保持零历史版本");
assert.match(app, /if \(candidateVersionIsAdopted\(\{ group, version: requestedVersion, message: requestedMessage \}\)\)/u, "已采用候选必须在事件处理层再次阻止重复选择");

console.log("candidate adoption flow regressions passed");
