import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  consumeConversationComposerAttachments,
  conversationComposerReferenceScope,
  markConversationComposerReferencesPending,
  removeConversationAttachmentReference,
  resolveConversationReferenceContext,
  synchronizeConversationReferenceContext,
} from "../src/conversation-reference-policy.js";

const attachment = {
  id: "attachment-one",
  name: "正文资料.txt",
  relativePath: "附件/正文资料.txt",
  mimeType: "text/plain",
};
const conversation = {
  references: [],
  workspaceReferences: [],
  skillReferences: [],
  attachments: [attachment],
};

markConversationComposerReferencesPending(conversation);
synchronizeConversationReferenceContext(conversation);
const sentScope = structuredClone(resolveConversationReferenceContext(conversation));
assert.deepEqual(sentScope.attachments, [attachment], "发送快照必须包含当前输入区附件");
assert.equal(consumeConversationComposerAttachments(conversation), true);
assert.deepEqual(conversation.attachments, [], "发送后输入区不得继续保留附件");
assert.deepEqual(conversationComposerReferenceScope(conversation).attachments, [], "后续指令不得继承上一条附件");
assert.deepEqual(sentScope.attachments, [attachment], "清空输入区不得回头修改已发送消息的附件快照");

const legacyAttachment = {
  name: "旧版附件.txt",
  relativePath: "附件/旧版附件.txt",
  mimeType: "text/plain",
};
const legacyConversation = {
  references: [],
  workspaceReferences: [],
  skillReferences: [],
  attachments: [legacyAttachment],
};
markConversationComposerReferencesPending(legacyConversation);
synchronizeConversationReferenceContext(legacyConversation);
assert.equal(removeConversationAttachmentReference(legacyConversation, legacyAttachment.relativePath), true, "没有 id 的旧附件也必须能用关闭按钮移除");
assert.deepEqual(legacyConversation.attachments, []);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
assert.match(appSource, /const referenceScope = targetConversation[\s\S]{0,500}consumeConversationComposerAttachments\(targetConversation\)/u, "点击发送时必须先冻结附件再清空输入区");
assert.match(appSource, /attachments: clone\(refs\.attachments \|\| \[\]\)/u, "已发送用户消息必须保留附件快照");
assert.match(appSource, /const attachmentKey = attachment\.id \|\| attachment\.relativePath \|\| attachment\.sourceUrl \|\| attachment\.name/u, "附件关闭按钮必须兼容旧数据的稳定键");
assert.match(serverSource, /pathname === "\/api\/books\/import"[\s\S]{0,1800}saveWorkspaceAttachment\([\s\S]{0,900}referenceType: "book"/u, "小说引用必须真实落成工作区附件");
assert.match(appSource, /bookReferenceAttachmentKey[\s\S]{0,1200}conversation\.attachments\.push\(payload\.attachment\)/u, "小说引用附件必须按章节选择去重并进入当前对话");

console.log("对话附件发送、清空、关闭与小说引用附件契约测试通过");
