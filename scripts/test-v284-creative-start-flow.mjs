import assert from "node:assert/strict";
import { readSourceWindow } from "./read-source-window.mjs";

import { authorCockpitSections, visibleWorkspaceModules } from "../src/author-cockpit.js";
import {
  CREATIVE_GUIDANCE_DOCUMENT_ID,
  CREATIVE_GUIDANCE_EMPTY_PROMPT,
  creativeGuidanceInferenceRecord,
  creativeGuidanceRecordInstruction,
} from "../src/creative-guidance-record.js";
import { createBlankProjectState, MODULES } from "../src/data.js";

const root = new URL("../", import.meta.url);
const [appSource, styleSource] = await Promise.all([
  Promise.all([
    ['id="noteReferenceKindTabs"', 4],
    ["const noteWorkspaceReferenceHref =", 2],
    ['id="creativeStartWelcomeDialog"', 10],
    ["const canSaveCurrentDocument =", 8],
    ["const previewAvailable =", 6],
  ].map(([marker, lines]) => readSourceWindow(new URL("src/app.js", root), marker, lines))).then((windows) => windows.join("\n")),
  readSourceWindow(new URL("src/styles.css", root), ".note-reference-summary {", 12),
]);

const visible = visibleWorkspaceModules(MODULES);
assert.equal(visible[0]?.id, "reports", "索引必须位于正文上方，作为作品创作起点");
assert.equal(visible[0]?.label, "索引");

const blank = createBlankProjectState({ name: "测试作品" });
assert.equal(blank.moduleItems.index.some(([id]) => id === CREATIVE_GUIDANCE_DOCUMENT_ID), false, "新作品不得预建创作引导目录项");
assert.equal(blank.documents[CREATIVE_GUIDANCE_DOCUMENT_ID], undefined, "新作品不得预建创作引导文档");
assert.equal(blank.activeDocument, "", "首次创作应保持无文档打开");
assert.match(CREATIVE_GUIDANCE_EMPTY_PROMPT, /输入右侧对话框/u, "创作引导必须说明灵感输入位置");
assert.match(CREATIVE_GUIDANCE_EMPTY_PROMPT, /左侧对应的正式文档/u, "创作引导必须说明已有设定和大纲的写入位置");
assert.match(CREATIVE_GUIDANCE_EMPTY_PROMPT, /文本或附件/u, "创作引导必须说明原始资料的提交方式");
assert.match(CREATIVE_GUIDANCE_EMPTY_PROMPT, /切换至「笔记」模式/u, "创作引导必须说明单篇内容的笔记模式入口");

const sections = authorCockpitSections({ moduleItems: blank.moduleItems, documents: blank.documents });
assert.equal(sections[0]?.id, "project-control");
assert.equal(sections.some((section) => section.items.some((item) => item.id === CREATIVE_GUIDANCE_DOCUMENT_ID)), false, "索引不得显示不存在的创作引导文档");

const record = creativeGuidanceInferenceRecord({
  userClues: ["现实题材，控制在十二万字。", "主人公不能靠巧合解决危机。"],
  acceptedChanges: ["人物必须通过主动承担代价完成转变。"],
  assistantText: "我建议加入失散兄弟线。你更想保留哪种结局？",
});
assert.match(record, /用户线索/u);
assert.match(record, /现实题材/u);
assert.match(record, /已确认的内容变化/u);
assert.match(record, /主动承担代价/u);
assert.doesNotMatch(record, /你更想保留哪种结局/u, "推演记录不得包含 AI 对用户的提问");
assert.doesNotMatch(record, /失散兄弟/u, "推演记录不得包含用户尚未采用的神思建议");

const guidanceInstruction = creativeGuidanceRecordInstruction();
assert.match(guidanceInstruction, /可跳过/u, "创作引导必须明确是可跳过的准备入口");
assert.match(guidanceInstruction, /不是正文门禁/u, "创作引导不得成为正文任务门禁");
assert.match(guidanceInstruction, /直接打开正文/u, "直接正文必须保留完整创作能力");
assert.match(guidanceInstruction, /不得.*改写任务路由/u, "创作引导不得改变其他文档的任务路由");

assert.match(appSource, /id="noteReferenceKindTabs"/u, "插入文档必须包含作品、笔记切换标签");
assert.match(appSource, /#shensi-workspace-reference-/u, "跨工作区文档引用必须具有稳定跳转键");
assert.match(appSource, /id="creativeStartWelcomeDialog"/u, "首次进入必须具有软件介绍窗口");
assert.match(appSource, /id="startCreativeJourney"/u, "软件介绍必须提供开始创作按钮");
assert.match(appSource, /previewMode\s*&&\s*!isAuthorCockpitModule/u, "索引文档预览态不能隐藏全屏按钮");
assert.match(styleSource, /\.note-reference-summary\s*\{[\s\S]{0,220}margin(?:-inline)?:\s*[^;]*2[024]px/u, "插入文档底部说明需要与内容保持内缩");

console.log("v2.19.11 creative start flow tests passed");
