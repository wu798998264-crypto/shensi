import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearWritingSkillRuleCache,
  loadWritingSkillRuleSources,
  writingSkillRuleCacheStats,
} from "../src/server/writing-style-skill-cache.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-writing-skill-"));
try {
  const references = join(root, "references");
  await mkdir(references, { recursive: true });
  const skillPath = join(root, "SKILL.md");
  const rulePath = join(references, "language.md");
  const sentencePath = join(references, "sentence.txt");
  const skillText = "# 主笔\n\n## 必读规则\n\n- [语言规则](references/language.md)\n- references/sentence.txt\n";
  await writeFile(skillPath, skillText, "utf8");
  await writeFile(rulePath, "禁止使用“命运的齿轮”。", "utf8");
  await writeFile(sentencePath, "句式“不是……而是……”最多出现一次。", "utf8");

  clearWritingSkillRuleCache();
  const first = await loadWritingSkillRuleSources({ sourcePath: skillPath, content: skillText });
  assert.equal(first.files.length, 2, "Markdown 链接和必读章节中的裸路径都必须加载");
  assert.match(first.files[0].content, /命运的齿轮/u);
  assert.equal(first.files[0].fullText, true);
  assert.equal(first.failures.length, 0);
  const afterFirst = writingSkillRuleCacheStats();
  assert.equal(afterFirst.fileReads, 2);

  const second = await loadWritingSkillRuleSources({ sourcePath: skillPath, content: skillText });
  assert.equal(second.files[0].hash, first.files[0].hash);
  assert.equal(second.cacheHits, 2, "未变化的必读文件必须命中缓存");
  assert.equal(writingSkillRuleCacheStats().fileReads, 2, "缓存命中不能重复读取文件正文");

  await new Promise((resolve) => setTimeout(resolve, 20));
  await writeFile(rulePath, "禁止使用“命运的齿轮”。\n“仿佛”最多出现一次。", "utf8");
  const third = await loadWritingSkillRuleSources({ sourcePath: skillPath, content: skillText });
  assert.notEqual(third.files[0].hash, first.files[0].hash, "文件变化后必须重新读取并更新哈希");
  assert.equal(writingSkillRuleCacheStats().fileReads, 3);

  const missing = await loadWritingSkillRuleSources({
    sourcePath: skillPath,
    content: "# 主笔\n\n## 必读\n- [缺失规则](references/missing.md)",
  });
  assert.equal(missing.failures.length, 1);
  assert.equal(missing.blocking, false, "必读规则缺失只记录，不得阻断写作");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("writing Skill required-file hash cache tests passed");
