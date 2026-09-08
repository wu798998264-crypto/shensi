import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { zipStore } from "../src/server/docx-export.mjs";
import { skillOriginLabel } from "../src/skill-ui-model.js";

const dataRoot = await mkdtemp(join(tmpdir(), "shensi-github-skill-"));
process.env.SHENSI_DATA_ROOT = dataRoot;

const {
  downloadGithubSkillSnapshot,
  forgetGithubSkillSnapshot,
  parseGithubSkillUrl,
  prepareGithubSkillSnapshot,
} = await import("../src/server/github-skill-import.mjs");
const {
  analyzeSkillPackage,
  deleteManagedCapabilityAsset,
  installSkillPackage,
  loadManagedSkill,
  loadManagedSkillSelections,
  testManagedSkill,
} = await import("../src/server/skill-store.mjs");

const sha = "0123456789abcdef0123456789abcdef01234567";
const skillSource = ({ name, capability = "auxiliary_advisor", marker = name }) => `---
name: ${name}
version: 1.0.0
author: GitHub Tester
description: ${name} 的测试说明。
capability_boundary: 只生成当前 Skill 授权范围内的候选结果。
capabilities:
  - ${capability}
workspace_modes:
  - general
---
# ${name}

保留原始指令标记：${marker}
`;

const archive = (repository, entries) => zipStore(entries.map((entry) => ({
  name: `${repository}-${sha}/${entry.name}`,
  content: entry.content,
})), new Date(0));

const mockGithubFetch = ({ owner = "tester", repository, bytes }) => async (url) => {
  const target = String(url);
  if (target === `https://api.github.com/repos/${owner}/${repository}`) {
    return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (target === `https://api.github.com/repos/${owner}/${repository}/commits/main`) {
    return new Response(JSON.stringify({ sha }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (target === `https://codeload.github.com/${owner}/${repository}/zip/${sha}`) {
    return new Response(bytes, { status: 200, headers: { "content-type": "application/zip", "content-length": String(bytes.length) } });
  }
  return new Response("not found", { status: 404 });
};

const confirmedRelations = (analysis) => (analysis.relations || []).map((relation) => ({
  scopeId: relation.scopeId,
  relationType: relation.relationType,
  orderedMembers: relation.orderedMembers,
}));

try {
  assert.deepEqual(parseGithubSkillUrl("https://github.com/openai/example"), {
    owner: "openai",
    repository: "example",
    ref: "",
    subPath: "",
    sourceUrl: "https://github.com/openai/example",
  });
  assert.equal(parseGithubSkillUrl("https://github.com/openai/example/tree/main/skills/writer").subPath, "skills/writer");
  assert.equal(parseGithubSkillUrl("https://github.com/openai/example/blob/main/skills/writer/SKILL.md").subPath, "skills/writer");
  assert.throws(() => parseGithubSkillUrl("http://github.com/openai/example"), /只支持/u);
  assert.throws(() => parseGithubSkillUrl("https://gitlab.com/openai/example"), /只支持/u);

  const singleRepository = "single-skill";
  const singleSnapshot = await downloadGithubSkillSnapshot({
    url: `https://github.com/tester/${singleRepository}`,
    fetchImpl: mockGithubFetch({
      repository: singleRepository,
      bytes: archive(singleRepository, [
        { name: "nested/writer/SKILL.md", content: skillSource({ name: "长篇主笔", capability: "novel_prose_writer", marker: "NESTED-SOURCE-MUST-SURVIVE" }) },
        { name: "nested/writer/references/style.md", content: "# 风格参考\n\n保持叙事连贯。" },
        { name: "nested/writer/install.exe", content: "never install" },
      ]),
    }),
  });
  assert.equal(singleSnapshot.recommendedType, "skill");
  assert.deepEqual(singleSnapshot.compatibleTypes, ["skill"]);
  assert.equal(singleSnapshot.skillCount, 1);
  assert.equal(singleSnapshot.root?.name || singleSnapshot.children[0]?.name, "长篇主笔");
  const singlePrepared = prepareGithubSkillSnapshot({ snapshotId: singleSnapshot.snapshotId, requestedType: "skill" });
  const singleAnalysis = await analyzeSkillPackage({ bytes: singlePrepared.bytes, sourceLabel: "GitHub 下载" });
  assert.equal(singleAnalysis.composite, false);
  assert.equal(singleAnalysis.skill.name, "长篇主笔", "嵌套的单一 Skill 必须保留原 Skill，而不是替换为合成包装层");
  const singleInstalled = await installSkillPackage({
    bytes: singlePrepared.bytes,
    origin: "downloaded",
    sourceType: "github",
    sourceLabel: "GitHub 下载",
    expectedPackageHash: singlePrepared.packageHash,
    confirmed: true,
  });
  assert.equal(singleInstalled.skill.sourceType, "github");
  assert.equal(skillOriginLabel(singleInstalled.skill), "GitHub 下载");
  const loadedSingle = await loadManagedSkill({ id: singleInstalled.skill.id, includeContent: true });
  assert.match(loadedSingle.content, /NESTED-SOURCE-MUST-SURVIVE/u);
  assert.doesNotMatch(loadedSingle.content, /never install/u);
  const testedSingle = await testManagedSkill({ id: singleInstalled.skill.id });
  assert.equal(testedSingle.test.passed, true, "GitHub Skill 仍需通过现有安全与合同测试后才能参与任务");
  const selectedSingle = await loadManagedSkillSelections([{ id: singleInstalled.skill.id, source: "whiteboard_explicit" }]);
  assert.equal(selectedSingle.length, 1, "测试通过后必须可被面板、@ 引用和白板卡片共用的选择链路读取");
  assert.match(selectedSingle[0].content, /NESTED-SOURCE-MUST-SURVIVE/u);

  const moduleRepository = "writer-module";
  const moduleSnapshot = await downloadGithubSkillSnapshot({
    url: `https://github.com/tester/${moduleRepository}`,
    fetchImpl: mockGithubFetch({
      repository: moduleRepository,
      bytes: archive(moduleRepository, [
        { name: "skills/outline/SKILL.md", content: skillSource({ name: "章节梳理", marker: "OUTLINE" }) },
        { name: "skills/rewrite/SKILL.md", content: skillSource({ name: "段落改写", marker: "REWRITE" }) },
        { name: "skills/summary/SKILL.md", content: skillSource({ name: "段落改写", marker: "SUMMARY" }) },
      ]),
    }),
  });
  assert.equal(moduleSnapshot.recommendedType, "module");
  assert.deepEqual(moduleSnapshot.compatibleTypes, ["module"]);
  assert.deepEqual(moduleSnapshot.children.map((item) => item.name), ["章节梳理", "段落改写", "段落改写 · summary"]);
  const modulePrepared = prepareGithubSkillSnapshot({ snapshotId: moduleSnapshot.snapshotId, requestedType: "module" });
  const moduleAnalysis = await analyzeSkillPackage({ bytes: modulePrepared.bytes, sourceLabel: "GitHub 下载" });
  assert.equal(moduleAnalysis.composite, true);
  await assert.rejects(() => installSkillPackage({
    bytes: modulePrepared.bytes,
    origin: "downloaded",
    sourceType: "github",
    sourceLabel: "GitHub 下载",
    expectedPackageHash: modulePrepared.packageHash,
  }), /必须先预览并确认关系/u);
  const moduleInstalled = await installSkillPackage({
    bytes: modulePrepared.bytes,
    origin: "downloaded",
    sourceType: "github",
    sourceLabel: "GitHub 下载",
    expectedPackageHash: modulePrepared.packageHash,
    confirmedRelations: confirmedRelations(moduleAnalysis),
    confirmed: true,
  });
  assert.equal(moduleInstalled.asset.assetType, "module");
  assert.equal(moduleInstalled.asset.sourceType, "github");
  const deletedModule = await deleteManagedCapabilityAsset({ id: moduleInstalled.asset.id });
  assert.equal(deletedModule.deleted, true);
  assert.ok(deletedModule.trash?.trashId, "删除 GitHub 模块时必须把整体插件 Skill 和结构一起放入回收站");
  await assert.rejects(() => loadManagedSkill({ id: moduleInstalled.skill.id }), /Skill 不存在/u);

  const groupRepository = "creator-group";
  const groupSnapshot = await downloadGithubSkillSnapshot({
    url: `https://github.com/tester/${groupRepository}`,
    fetchImpl: mockGithubFetch({
      repository: groupRepository,
      bytes: archive(groupRepository, [
        { name: "skills/planner/SKILL.md", content: skillSource({ name: "故事规划", capability: "story_planner", marker: "PLANNER" }) },
        { name: "skills/reviewer/SKILL.md", content: skillSource({ name: "成稿自检", capability: "effect_reviewer", marker: "REVIEWER" }) },
      ]),
    }),
  });
  assert.equal(groupSnapshot.recommendedType, "group");
  assert.deepEqual(groupSnapshot.compatibleTypes, ["module", "group"]);
  assert.deepEqual(new Set(groupSnapshot.children.map((item) => item.family)), new Set(["规划与设定能力", "自检与修复能力"]));
  const groupPrepared = prepareGithubSkillSnapshot({ snapshotId: groupSnapshot.snapshotId, requestedType: "group" });
  const groupAnalysis = await analyzeSkillPackage({ bytes: groupPrepared.bytes, sourceLabel: "GitHub 下载" });
  assert.equal(groupAnalysis.composite, true);
  assert.ok(groupAnalysis.relations.length >= 2, "模组必须逐层展示并确认内部关系");
  const groupInstalled = await installSkillPackage({
    bytes: groupPrepared.bytes,
    origin: "downloaded",
    sourceType: "github",
    sourceLabel: "GitHub 下载",
    expectedPackageHash: groupPrepared.packageHash,
    confirmedRelations: confirmedRelations(groupAnalysis),
    confirmed: true,
  });
  assert.equal(groupInstalled.composite, true);
  assert.equal(groupInstalled.asset.assetType, "group");
  assert.equal(groupInstalled.asset.sourceType, "github");
  assert.equal(groupInstalled.asset.sourceLabel, "GitHub 下载");

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  assert.match(app, /id="installGithubSkill"/u);
  assert.match(app, /id="githubSkillDialog"/u);
  assert.match(app, /id="githubSkillType"/u);
  assert.match(app, /\/api\/skills\/github\/analyze/u);
  assert.match(app, /sourceKind: "github"/u);
  assert.match(app, /GitHub 下载/u);
  assert.match(server, /\/api\/skills\/github\/install/u);
  assert.match(server, /sourceType: "github"/u);

  forgetGithubSkillSnapshot(singleSnapshot.snapshotId);
  forgetGithubSkillSnapshot(moduleSnapshot.snapshotId);
  forgetGithubSkillSnapshot(groupSnapshot.snapshotId);
  console.log(JSON.stringify({ ok: true, types: ["skill", "module", "group"], sourceLabel: "GitHub 下载" }));
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
