import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildDeletedContentRecoveryContext,
  deletedContentAccessDecision,
  deletedContentRequestMentioned,
  deletedContentSearchEntries,
  sanitizeDeletedContentWorkspaceRequest,
} from "../src/deleted-content-access.js";
import { looksLikeWorkspaceOperation } from "../src/workspace-operations.js";
import { buildTaskContextManifest } from "../src/server/task-session-manager.mjs";

const entries = [
  {
    trashId: "trash-conversation-1",
    kind: "conversation",
    title: "北灵院讨论",
    deletedAtIso: "2026-08-22T08:00:00.000Z",
    conversation: {
      id: "conversation-1",
      title: "北灵院讨论",
      messages: [
        { role: "user", content: "伏笔是青铜令牌上的第二道水痕。" },
        { role: "assistant", content: "这条伏笔应当在第十二章回收。" },
        { role: "user", content: "感情线暂时不要推进。" },
      ],
    },
  },
  {
    trashId: "trash-document-1",
    kind: "file",
    id: "chapter-deleted",
    title: "废弃第十章",
    deletedAtIso: "2026-08-21T08:00:00.000Z",
    document: { title: "废弃第十章", html: "<p>不应被普通搜索读取的已删除正文。</p>" },
  },
];

for (const prompt of [
  "回收站里有什么？",
  "分析一下之前删除的内容",
  "搜索历史对话",
  "找回所有已删除内容",
]) {
  assert.equal(deletedContentAccessDecision(prompt).authorized, false, `${prompt} 不得获得回收站读取权限`);
  const context = buildDeletedContentRecoveryContext({ entries, prompt });
  assert.equal(context.entries.length, 0);
  assert.equal(context.contextText, "");
}

const recent = buildDeletedContentRecoveryContext({ entries, prompt: "找回刚才删除的历史对话" });
assert.equal(recent.authorized, true);
assert.deepEqual(recent.entries.map((entry) => entry.trashId), ["trash-conversation-1"]);
assert.equal(recent.contextText, "", "恢复整条对话只需要受控元数据，不应提前读取消息正文");

const segment = buildDeletedContentRecoveryContext({
  entries,
  prompt: "从已删除的《北灵院讨论》里找回关于伏笔的那段内容",
});
assert.equal(segment.authorized, true);
assert.deepEqual(segment.entries.map((entry) => entry.trashId), ["trash-conversation-1"]);
assert.match(segment.contextText, /青铜令牌上的第二道水痕/u);
assert.doesNotMatch(segment.contextText, /感情线暂时不要推进/u, "只允许读取用户指定的已删除片段");

assert.deepEqual(deletedContentSearchEntries(entries, "北灵院"), [], "普通全局搜索不得扫描回收站");
assert.deepEqual(
  deletedContentSearchEntries(entries, "找回已删除的《北灵院讨论》").map((entry) => entry.trashId),
  ["trash-conversation-1"],
  "明确找回具体回收项时才允许检索对应条目",
);

const blockedWorkspaceRequest = sanitizeDeletedContentWorkspaceRequest({
  prompt: "回收站里有什么？",
  workspaceMeta: { trash: [{ trashId: "trash-conversation-1", title: "北灵院讨论", kind: "conversation" }] },
  documentContext: ["当前正文", "## 已删除内容片段 · 北灵院讨论\n不应泄漏"],
});
assert.deepEqual(blockedWorkspaceRequest.workspaceMeta.trash, []);
assert.deepEqual(blockedWorkspaceRequest.documentContext, ["当前正文"]);

const allowedWorkspaceRequest = sanitizeDeletedContentWorkspaceRequest({
  prompt: "找回已删除的《北灵院讨论》",
  workspaceMeta: {
    trash: [
      { trashId: "trash-conversation-1", title: "北灵院讨论", kind: "conversation" },
      { trashId: "trash-document-1", title: "废弃第十章", kind: "file" },
    ],
  },
  documentContext: ["当前正文", "## 已删除内容片段 · 北灵院讨论\n已授权片段"],
});
assert.deepEqual(allowedWorkspaceRequest.workspaceMeta.trash.map((entry) => entry.trashId), ["trash-conversation-1"]);
assert.equal(allowedWorkspaceRequest.documentContext.length, 2);
assert.equal(looksLikeWorkspaceOperation("找回刚才删除的历史对话"), true, "明确找回请求必须进入受控工作区恢复路径");
assert.equal(looksLikeWorkspaceOperation("不要找回已删除的历史对话"), false, "否定找回请求不能触发恢复操作");
assert.equal(deletedContentRequestMentioned("分析已删除的对话"), true);

const taskManifest = buildTaskContextManifest({
  documents: {
    active: { id: "active", title: "当前正文", moduleId: "manuscript", projectId: "work-a", revision: "r1", html: "当前内容" },
    recycled: { id: "recycled", title: "回收站正文", moduleId: "trash", projectId: "work-a", revision: "deleted", html: "不可读取" },
  },
  query: "继续当前正文",
  targetDocumentId: "active",
  includedIds: ["active", "recycled"],
  requiredIds: ["active"],
  workspace: { id: "work-a", title: "测试作品", kind: "project" },
});
assert.equal(taskManifest.some((item) => item.id === "recycled"), false, "正式任务资料清单不得读取回收站正文");

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(app, /createConversationTrashEntry\(\{ conversation: clone\(conversation\) \}\)/u, "删除历史对话必须完整进入回收站");
assert.match(app, /buildDeletedContentRecoveryContext\(\{ entries: state\.trash/u, "工作区操作必须先建立回收站读取授权");
assert.match(app, /deletedContentSearchEntries\(state\.trash/u, "全局搜索必须经过回收站读取门禁");
assert.match(app, /looksLikeWorkspaceOperation\(routingPrompt\)/u, "明确恢复已删除内容的请求必须进入受控工作区操作路径");
assert.match(app, /workspaceOperation:\s*agentWorkspaceOperationRequested/u, "受控恢复意图必须随 Agent 请求交给服务端工作区操作管线");
assert.doesNotMatch(app, /trash:\s*\(state\.trash \?\? \[\]\)\.map/u, "工作区元数据不得默认暴露全部回收项");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(server, /sanitizeDeletedContentWorkspaceRequest\(\{/u, "服务端必须独立复核并缩减回收站读取范围");

console.log("deleted conversation trash privacy regressions passed");
