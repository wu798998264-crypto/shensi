import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { loadManagedSkill, testManagedSkill } from "../src/server/skill-store.mjs";
import { loadSelectedSkills } from "../src/server/skill-library.mjs";

const sourceRoot = join(process.cwd(), "packaging", "bundled", "skill", "神思");
const repairs = [
  {
    id: "user:shensi.book-deconstruction",
    sourceDir: "bestseller-book-deconstruction",
    references: ["references/deconstruction-framework.md", "references/output-template.md"],
  },
];
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const report = [];

for (const repair of repairs) {
  const managed = await loadManagedSkill({ id: repair.id, includeContent: true });
  const packageRoot = dirname(managed.sourcePath);
  const installed = [];
  for (const relativePath of repair.references) {
    assert.ok(managed.content.includes(relativePath), `${repair.id} 未声明必读文件 ${relativePath}`);
    const sourcePath = join(sourceRoot, repair.sourceDir, ...relativePath.split("/"));
    const targetPath = join(packageRoot, ...relativePath.split("/"));
    const source = await readFile(sourcePath);
    assert.ok(source.length > 0, `源码附件为空：${sourcePath}`);
    const existing = await stat(targetPath).catch(() => null);
    if (existing) {
      const current = await readFile(targetPath);
      assert.equal(sha256(current), sha256(source), `已安装附件与官方源不一致，拒绝覆盖：${targetPath}`);
    } else {
      await mkdir(dirname(targetPath), { recursive: true });
      await writeFile(targetPath, source, { flag: "wx" });
      installed.push(relativePath);
    }
  }
  const tested = await testManagedSkill({ id: repair.id });
  assert.equal(tested.test.passed, true, `${repair.id} 完整包测试失败：${tested.test.summary}`);
  assert.equal(tested.test.checks.find((check) => check.id === "required_files")?.pass, true);
  const loaded = await loadSelectedSkills([{ id: repair.id }], { shensiRoot: sourceRoot });
  assert.equal(loaded.length, 1, `${repair.id} 未进入可执行 Skill 列表`);
  assert.equal(loaded[0].fullText, true, `${repair.id} 未完成全文读取`);
  assert.deepEqual(loaded[0].skillReadFailures, []);
  report.push({
    id: repair.id,
    installed,
    ruleFiles: loaded[0].ruleFiles.map((file) => ({ path: file.path, hash: file.hash, contentLength: file.contentLength })),
    fullText: loaded[0].fullText,
    testStatus: tested.skill.testStatus,
  });
}

console.log(JSON.stringify({ ok: true, report }));
