import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const helper = source.slice(
  source.indexOf("const releaseWhiteboardGenerationDialogInteractivity"),
  source.indexOf("const whiteboardGenerationExplicitReferenceIds"),
);

assert.match(helper, /dialog\.removeAttribute\("aria-busy"\)[\s\S]*dialog\.inert = false/u, "结束初始化必须恢复输入能力");
assert.match(helper, /requestAnimationFrame\(finalizeOpen\)[\s\S]*setTimeout\(finalizeOpen, 180\)/u, "窗口节流时必须有有限时兜底");
assert.match(helper, /catch \(error\)[\s\S]*生成操作栏初始化失败/u, "初始化失败必须向用户显示错误");
for (const name of ["whiteboardGenerateDialog", "whiteboardImageDialog", "whiteboardVideoDialog", "whiteboardAudioDialog"]) {
  assert.match(source, new RegExp(`scheduleWhiteboardGenerationInitialization\\(elements\\.${name}, nodeId`), `${name} 必须使用可恢复初始化`);
}

console.log("Whiteboard generation dialog interactivity guards passed");
