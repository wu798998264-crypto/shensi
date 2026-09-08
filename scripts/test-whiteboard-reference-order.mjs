import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const jobStoreSource = await readFile(new URL("../src/server/generation-job-store.mjs", import.meta.url), "utf8");

const aliases = appSource.match(/const whiteboardGenerationReferenceAliases = \(upstream = \[\], referenceOrder = \[\]\) => \{[\s\S]*?\n\};/u)?.[0] || "";
assert.match(aliases, /ordered\.map\(\(node,\s*index\)/u, "引用编号必须使用稳定排序后的上游顺序");
assert.match(aliases, /const sequence = index \+ 1/u, "引用编号必须是全局序号");
assert.doesNotMatch(aliases, /const counters = \{ image: 0, video: 0 \}/u, "当前编号不能按媒体类型分别计数");
assert.match(appSource, /const orderWhiteboardGenerationNodes = \(nodes = \[\], form = null\)/u, "生成引用必须支持持久化顺序");
assert.match(appSource, /name="referenceOrder" type="hidden"/u, "生成表单必须保存引用顺序");
assert.match(appSource, /name="promptReferenceSequence" type="hidden"/u, "生成表单必须保存提示词引用序列");
assert.match(appSource, /const syncWhiteboardGenerationPromptReferenceSequenceFromEditor/u, "提示词引用序列必须与顶部参考顺序分离");
assert.match(appSource, /writeWhiteboardGenerationPromptReferenceSequence\(form, ids\)/u, "编辑提示词只能更新引用序列，不能重排顶部参考");
assert.doesNotMatch(
  appSource.match(/const syncWhiteboardRichPromptValue = \(form\) => \{[\s\S]*?\n\};/u)?.[0] || "",
  /writeWhiteboardGenerationReferenceOrder/u,
  "富文本同步不能覆盖顶部参考顺序",
);
assert.match(appSource, /Incoming edge order is the single source of truth for the visible tray/u, "顶部参考顺序必须以入边顺序为准");
assert.match(appSource, /const orderedIds = orderWhiteboardGenerationNodes\(upstream, form\)\.map\(\(node\) => node\.id\)/u, "拖拽必须基于当前可见顺序计算");
assert.match(appSource, /const promptReferenceSequence = whiteboardGenerationPromptReferenceSequence\(form\)[\s\S]{0,1800}nodeById\.get\(promptReferenceSequence\[mentionIndex\]\)/u, "提示词标签变化时必须优先按持久化节点身份重建");
assert.match(appSource, /whiteboardPromptReferenceIdentityMatches\(expectedReferenceIds, renderedReferenceIds\)/u, "富文本复用必须同时核对显示 token 与稳定节点 ID");
assert.match(appSource, /writeWhiteboardGenerationPromptReferenceSequence\(form, whiteboardPromptReferenceSequenceAfterInsertion\([\s\S]{0,360}existingMentionOccurrences[\s\S]{0,180}node\.id/u, "在提示词中间插入引用时必须先对齐 occurrence 身份序列再重建芯片");
assert.match(appSource, /const droppedMention = document\.elementFromPoint[\s\S]{0,500}whiteboardPromptAtomicDropOffset/u, "拖到已有引用缩略图或标题时必须将落点归一到整个原子引用前后");
assert.match(appSource, /maxlength="20000"/u, "大量参考与说明必须使用统一的长提示词上限，不能在 3000 字符处静默错位");
assert.match(appSource, /const rawValue = serializeWhiteboardRichPromptRaw\(editor\)[\s\S]{0,500}renderWhiteboardGenerationInlineMentions\(form, \{ force: true \}\)/u, "到达长提示词上限时必须同步修正可见编辑器，不能让显示与提交内容分叉");
assert.match(appSource, /const refreshWhiteboardGenerationInlineMentionLabels = \(form, aliases\)/u, "参考栏变化时应只刷新下方芯片标签，不重建聚焦编辑器");
assert.match(appSource, /request: \{[\s\S]{0,320}prompt: instruction,[\s\S]{0,220}referenceOrder,\s+promptReferenceSequence,/u, "文本生成任务必须携带顶部顺序与提示词引用序列，并允许附带点击计时和固定生成配置");
assert.match(appSource, /referenceOrder,\n\s+promptReferenceSequence,\n\s+settings: \{ \.\.\.imageSettings/u, "图片任务必须携带顶部顺序与提示词引用序列");
assert.match(appSource, /referenceOrder,\n\s+promptReferenceSequence,\n\s+settings: \{ \.\.\.videoSettings/u, "视频任务必须携带顶部顺序与提示词引用序列");
assert.match(jobStoreSource, /promptReferenceSequence: Array\.isArray\(request\.promptReferenceSequence\)[\s\S]{0,180}\.map\(String\)\.filter\(Boolean\)/u, "服务端任务记录必须保留重复的提示词引用序列");

assert.match(
  appSource,
  /whiteboardGenerationFormsForNode\(targetNodeId\)\.forEach\(\(generationForm\) => \{[\s\S]{0,260}updateWhiteboardGenerationMentionAliases\(generationForm, aliases/u,
  "重排引用后必须刷新同一卡片的所有生成表单",
);
assert.match(
  appSource,
  /const removeWhiteboardGenerationMention = \(form, sourceNodeId[\s\S]*?querySelectorAll\("\[data-rich-mention-node-id\]"\)[\s\S]*?mention\.dataset\.richMentionNodeId !== String\(sourceNodeId\)/u,
  "删除引用必须按节点 ID 清理下方插入内容",
);
assert.match(
  appSource,
  /removeWhiteboardGenerationMention\(generationForm, sourceNodeId, sourceLabels\)/u,
  "删除引用必须向每个关联生成表单传递同一节点身份",
);
assert.match(
  appSource,
  /const removeWhiteboardGenerationReferencesForEdges = \(canvas, edgeIds = \[\], afterCanvas = canvas\)[\s\S]*?removeWhiteboardGenerationReferenceFromDrafts\(targetNodeId, sourceNodeId, sourceLabels\)/u,
  "删除卡片或连接时也必须清理持久化生成草稿中的引用",
);
assert.match(
  appSource,
  /const deleteWhiteboardNode = \(nodeId\) => \{[\s\S]*?removeWhiteboardGenerationReferencesForEdges\(documentState\.canvas/u,
  "直接删除白板卡片必须走引用清理路径",
);
assert.match(
  appSource,
  /const remaining = whiteboardGenerationSources\(normalizedAfter, targetNodeId\)\.upstream[\s\S]*?updateWhiteboardGenerationMentionAliases\(generationForm, remainingAliases, aliases\)/u,
  "删除后必须按剩余上游顺序刷新编号，不得替换被删内容",
);
assert.match(appSource, /data-clear-whiteboard-generation-references/u, "参考栏必须提供清空全部参考入口");
assert.match(
  appSource,
  /const clearWhiteboardGenerationReferences = \(targetNodeId\)[\s\S]*?edge\.toNode === targetNodeId[\s\S]*?clearWhiteboardGenerationMentions[\s\S]*?clearWhiteboardGenerationReferenceDrafts[\s\S]*?removeCanvasEdge/u,
  "清空参考必须作为一次批量操作同步清理输入框引用、草稿状态和全部入边",
);
assert.match(
  appSource,
  /const clearWhiteboardGenerationMentions[\s\S]*?writeWhiteboardGenerationExplicitReferenceIds\(form, new Set\(\)\)[\s\S]*?writeWhiteboardGenerationReferenceOrder\(form, \[\]\)[\s\S]*?writeWhiteboardGenerationPromptReferenceSequence\(form, \[\]\)/u,
  "清空参考必须同时归零显式引用、顶部顺序和提示词引用序列",
);

console.log("白板引用重排与删除契约测试通过");
