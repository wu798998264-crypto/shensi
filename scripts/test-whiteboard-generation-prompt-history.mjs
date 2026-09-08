import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWhiteboardPromptHistory,
  pushWhiteboardPromptHistory,
  stepWhiteboardPromptHistory,
} from "../src/whiteboard-generation-prompt-history.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let history = createWhiteboardPromptHistory({
  value: "起始 @「图片1」",
  explicitReferences: "image-1",
  selection: { start: 10, end: 10 },
});
history = pushWhiteboardPromptHistory(history, {
  value: "起始 @「图片1」追加",
  explicitReferences: "image-1",
  selection: { start: 14, end: 14 },
});
history = pushWhiteboardPromptHistory(history, {
  value: "起始 @「图片1」追加",
  explicitReferences: "image-1,image-2",
  selection: { start: 14, end: 14 },
});
assert.equal(history.entries.length, 3, "提示词和引用变更应分别保留为可撤销步骤");
let stepped = stepWhiteboardPromptHistory(history, "undo");
assert.equal(stepped.changed, true);
assert.equal(stepped.snapshot.explicitReferences, "image-1", "撤销应恢复引用集合，不打乱引用顺序");
stepped = stepWhiteboardPromptHistory(stepped.history, "undo");
assert.equal(stepped.snapshot.value, "起始 @「图片1」", "再次撤销应恢复之前的提示词文本");
stepped = stepWhiteboardPromptHistory(stepped.history, "redo");
assert.equal(stepped.snapshot.value, "起始 @「图片1」追加", "重做应恢复提示词文本");

const app = await readFile(join(root, "src", "app.js"), "utf8");
assert.match(app, /stepWhiteboardPromptHistoryForForm\(form, direction\)/u, "生成操作栏必须接入提示词撤销/重做");
assert.match(app, /form\.addEventListener\("keydown", \(event\) => \{/u, "生成操作栏必须监听键盘撤销快捷键");
assert.match(app, /whiteboardGenerationDraftRevision/u, "提示词草稿必须具有独立持久化版本");
assert.match(app, /draftRevision: ui\.whiteboardGenerationDraftRevision/u, "恢复检查点必须包含提示词草稿版本");
assert.match(app, /whiteboardGenerationDraftNeedsRecoveryCheckpoint\(\)/u, "退出前必须等待未写入检查点的提示词草稿");
assert.match(app, /normalized\.explicitReferences/u, "撤销恢复必须保留显式引用顺序");

console.log("白板生成提示词撤销、引用顺序和持久化契约测试通过");
