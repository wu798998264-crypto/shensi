import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { documentDeleteAllowed, folderDeleteAllowed } from "../src/document-tree.js";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.equal(documentDeleteAllowed({ documentId: "note-1", moduleId: "library", workspaceKind: "project" }), true);
assert.equal(documentDeleteAllowed({ documentId: "whiteboard-1", moduleId: "library", workspaceKind: "project" }), true);
assert.equal(folderDeleteAllowed({ node: { type: "folder", id: "custom-folder:1", custom: true }, moduleId: "library", viewId: "novel", workspaceKind: "project" }), true);
assert.match(app, /ui\.pendingConfirm = \{ type: "delete-document", documentId: ui\.menuDocument \}/u, "文档删除确认必须保存不可被重绘清空的目标快照");
assert.match(app, /ui\.pendingConfirm = \{ type: "delete-folder", folderId \}/u, "自定义文件夹删除确认必须保存目标快照");
assert.match(app, /ui\.pendingConfirm = \{ type: "delete-tree-folder", node: clone\(node\), moduleId, viewId \}/u, "树文件夹删除确认必须保存完整节点快照");
assert.match(app, /const pendingConfirm = ui\.pendingConfirm;[\s\S]{0,260}const action = pendingConfirm \|\| ui\.confirmAction;/u, "确认提交必须优先使用打开确认框时的删除目标");
assert.match(app, /action\?\.type === "delete-document"\) await deleteDocument\(action\.documentId\)/u, "确认提交必须按快照删除文档或白板");

console.log("文档、白板、文件夹删除入口契约测试通过");
