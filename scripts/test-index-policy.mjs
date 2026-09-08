import assert from "node:assert/strict";

import { buildProjectQuestionContext } from "../src/general-project-context.js";
import {
  displayOnlyIndexDocumentIds,
  indexCanBeReadForStage,
  indexContextModeForDocument,
  indexRoleForDocument,
  indexPolicies,
  indexWritePolicyForDocument,
  indexWriteTargetForScenario,
} from "../src/index-policy.js";
import { projectCompilationSummary } from "../src/project-status.js";
import { compilePostCommitProjection } from "../src/post-commit-projection.js";

assert.equal(indexRoleForDocument("index-language-blacklist"), "control");
assert.equal(indexRoleForDocument("memory-foreshadowing"), "continuity");
assert.equal(indexCanBeReadForStage("memory-release", "writing"), true);
assert.equal(indexContextModeForDocument("report-compile"), "display-only");
assert.equal(indexCanBeReadForStage("index-pending", "writing"), true);
assert.equal(indexCanBeReadForStage("report-compile", "writing"), false);
assert.equal(indexWriteTargetForScenario("explicit_self_check_report", { contextDomain: "novel" })?.documentId, "report-novel");
assert.equal(indexWriteTargetForScenario("explicit_self_check_report", { contextDomain: "script" })?.documentId, "report-script");
assert.equal(indexWriteTargetForScenario("explicit_self_check_report", { contextDomain: "script-adaptation" })?.documentId, "report-adaptation");
for (const [documentId, policy] of Object.entries(indexPolicies())) {
  assert.ok(Array.isArray(policy.writeScenarios) && policy.writeScenarios.length, `${documentId} 必须声明写入场景`);
  assert.equal(indexWritePolicyForDocument(documentId).target, policy.writeTarget || documentId);
  assert.ok(policy.writeAuthority, `${documentId} 必须声明写入 authority`);
}
assert.deepEqual(displayOnlyIndexDocumentIds().sort(), [
  "index-update-log",
  "report-adaptation",
  "report-compile",
  "report-novel",
  "report-script",
]);

const documents = {
  "outline-series": {
    title: "全集大纲",
    markdown: [
      "# 御兽退婚：废柴的万兽神庭·全书大纲",
      "",
      "第一卷《废柴开庭》",
      "第二卷《百城争锋》",
      "第三卷《天宗暗潮》",
      "第四卷《五域兽盟》",
      "第五卷《神庭旧罪》",
      "第六卷《万兽无疆》",
      "",
      "第1章《今日退婚》",
      "第2章《万兽神庭》",
      "第3章《一拳还辱》",
      "第4章《残狼噬火》",
      "第5章《少主之位》",
      "第6章《山中救兽》",
      "第7章《赤霞矿变》",
      "第8章《血契牢笼》",
      "第9章《族试惊雷》",
      "第10章《废柴登首》",
    ].join("\n"),
  },
  "canon-world": {
    title: "世界观与基础规则",
    markdown: ["# 设定", "一、世界格局", "二、修炼体系", "三、契约规则", "四、万兽神庭", "五、人物", "六、退婚事件", "七、主要灵兽", "八、反派阵营", "九、长期主线"].join("\n"),
  },
  "report-compile": { title: "项目总览", markdown: "报告内容不应默认进入作品上下文。" },
  "index-update-log": { title: "更新日志", markdown: "事务日志不应默认进入作品上下文。" },
  "index-language-blacklist": { title: "创作合同", markdown: "## 项目禁用词\n\n不要混入执行说明。" },
  "index-pending": { title: "待确认事项", markdown: "待确认事项不应默认进入全作品资料。" },
  "index-creative-guidance": { title: "创作引导", markdown: "创作引导不应默认进入全作品资料。" },
  "chapter-1": { title: "第1章", markdown: "正式正文内容。尚未揭开的秘密仍在等待后续回收。".repeat(12) },
};

const summary = projectCompilationSummary({
  moduleItems: {
    outline: [["outline-series", "全集大纲"]],
    canon: [["canon-world", "世界观与基础规则"]],
    manuscript: [["chapter-1", "第1章"]],
  },
  documents,
});
assert.equal(summary.plannedVolumes, 6);
assert.equal(summary.completedVolumeOutlines, 6);
assert.equal(summary.plannedChapterOutlines, 10);
assert.equal(summary.completedChapterOutlines, 10);
assert.equal(summary.settingEntries, 9);
assert.equal(summary.writtenChapters, 1, "正文中的‘尚未’句子不能被项目总览误判为空文档");

const context = buildProjectQuestionContext({
  projectName: "测试作品",
  documents,
  prompt: "请读取整个项目的作品资料",
});
assert.match(context, /全集大纲/u);
assert.doesNotMatch(context, /事务日志不应默认进入/u);
assert.doesNotMatch(context, /报告内容不应默认进入/u);
assert.doesNotMatch(context, /待确认事项不应默认进入/u);
assert.doesNotMatch(context, /创作引导不应默认进入/u);

const explicitReportContext = buildProjectQuestionContext({
  projectName: "测试作品",
  documents,
  prompt: "请读取更新日志",
  referenceIds: ["index-update-log"],
});
assert.match(explicitReportContext, /事务日志不应默认进入/u);

const projection = compilePostCommitProjection({
  documents: [{ documentId: "chapter-1", moduleId: "manuscript", contextDomain: "novel" }],
});
assert.deepEqual(projection.index.readDuringCreativeWriting, ["index-language-blacklist", "index-pending"]);
assert.ok(projection.index.displayOnlyDocumentIds.includes("report-compile"));
assert.equal(projection.index.writeBindings["report-novel"].target, "report-novel");
assert.ok(projection.index.writeBindings["report-novel"].scenarios.includes("explicit_self_check_report"));
assert.ok(projection.memory.eligibleDocumentIds.includes("memory-snapshot"));
assert.deepEqual(projection.outline.automaticDocumentIds, []);
assert.deepEqual(projection.canon.automaticDocumentIds, []);

console.log("索引角色、读取隔离、项目总览统计和正文投影保护测试通过");
