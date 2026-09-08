import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sourceRoot = join(process.cwd(), "packaging", "bundled", "skill", "神思");
const dataRoot = await mkdtemp(join(tmpdir(), "shensi-v501-skill-package-"));
process.env.SHENSI_DATA_ROOT = dataRoot;
const { installMarketplaceSkill, installSkillSource, loadManagedSkill, testManagedSkill } = await import("../src/server/skill-store.mjs");
const { loadSelectedSkills } = await import("../src/server/skill-library.mjs");

const packageFiles = async (root, relativeRoot = "") => {
  const current = relativeRoot ? join(root, ...relativeRoot.split("/")) : root;
  const files = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const relativePath = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await packageFiles(root, relativePath));
    else if (entry.isFile() && !["skill.md", "manifest.json"].includes(relativePath.toLowerCase())) {
      files.push({ path: relativePath, content: await readFile(join(current, entry.name)) });
    }
  }
  return files;
};

const assertComplete = async ({ id, references }) => {
  const managed = await loadManagedSkill({ id, includeContent: true });
  const tested = await testManagedSkill({ id });
  assert.equal(tested.test.passed, true, `${id} 必须通过包含引用文件的测试`);
  assert.equal(tested.test.checks.find((check) => check.id === "required_files")?.pass, true);
  const loaded = await loadSelectedSkills([{ id }], { shensiRoot: sourceRoot });
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].fullText, true, `${id} 必须完整读取主文档和引用文件`);
  assert.deepEqual(loaded[0].skillReadFailures, []);
  const packageRoot = managed.sourcePath.replace(/[\\/]SKILL\.md$/iu, "");
  for (const relativePath of references) {
    const target = join(packageRoot, ...relativePath.split("/"));
    assert.ok((await stat(target)).isFile(), `已安装包缺少附件：${relativePath}`);
    assert.ok((await readFile(target, "utf8")).trim().length > 0, `已安装附件为空：${relativePath}`);
  }
};

try {
  await installMarketplaceSkill({ id: "official:book-deconstruction", shensiRoot: sourceRoot });
  await assertComplete({
    id: "user:shensi.book-deconstruction",
    references: ["references/deconstruction-framework.md", "references/output-template.md"],
  });

  const aiRoot = join(sourceRoot, "ai漫剧提示词转换skill");
  const aiBody = await readFile(join(aiRoot, "漫剧提示词转换skill.md"), "utf8");
  const aiSource = `---
schema_version: 2
id: "ai-video-director-2"
name: "AI 视频导演（二）"
version: "1.0.3"
author: "神思团队"
description: "按视频导演二（30秒）规则将剧本转换为可执行的中文视频分镜提示词。"
capability_boundary: "只生成视频分镜提示词，不负责媒体生成或正式文档落盘。"
source: official
capabilities:
  - visual_prompt_writer
  - prompt_writer
role: primary_writer
workspace_modes:
  - project
artifact_types:
  - text
input_requirements:
  - user_brief
output_contract: text_candidate
trigger_keywords:
  - "AI视频导演（二）"
---
${aiBody}`;
  await installSkillSource({
    content: aiSource,
    packageFiles: [],
    origin: "imported",
    sourceType: "local_folder",
    sourceLabel: "v5.0.1 完整包回归",
  });
  await assertComplete({
    id: "user:ai-video-director-2",
    references: [],
  });

  const missingSource = aiSource
    .replace('id: "ai-video-director-2"', 'id: "qa.missing-reference"')
    .replace('name: "AI 视频导演（二）"', 'name: "缺失引用回归"')
    .replace('version: "1.0.3"', 'version: "1.0.0"')
    .concat('\n\n必读：[缺失引用](references/missing.md)\n');
  await installSkillSource({ content: missingSource, origin: "imported", sourceType: "local_folder", sourceLabel: "缺失引用回归" });
  const rejected = await testManagedSkill({ id: "user:qa.missing-reference" });
  assert.equal(rejected.test.passed, false, "缺少必读引用文件的 Skill 不能继续误报测试通过");
  assert.equal(rejected.test.checks.find((check) => check.id === "required_files")?.pass, false);

  console.log(JSON.stringify({
    ok: true,
    complete: ["user:shensi.book-deconstruction", "user:ai-video-director-2"],
    rejectedMissingReference: "user:qa.missing-reference",
  }));
} finally {
  await rm(dataRoot, { recursive: true, force: true });
}
