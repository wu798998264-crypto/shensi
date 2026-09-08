import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  conversationMessageCollapseSource,
  conversationMessageNeedsCollapse,
} from "../src/message-collapse.js";

assert.equal(conversationMessageNeedsCollapse({ role: "user", content: "简短问题" }), false);
assert.equal(conversationMessageNeedsCollapse({ role: "user", content: "问".repeat(421) }), true);
assert.equal(conversationMessageNeedsCollapse({ role: "assistant", content: "简短回答" }), false);
assert.equal(conversationMessageNeedsCollapse({ role: "assistant", content: "答".repeat(901) }), true);
assert.equal(conversationMessageNeedsCollapse({
  role: "assistant",
  content: "",
  candidateDocuments: [{ content: "第一章正文".repeat(230) }],
}), true, "多文档候选也必须按实际生成内容折叠");
assert.equal(conversationMessageNeedsCollapse({
  role: "assistant",
  content: "已完成写入",
  landingStatus: "complete",
  landedDocuments: [{ content: "已落盘正文".repeat(230) }],
}), true, "已落盘正文也必须按实际生成内容折叠");
assert.match(conversationMessageCollapseSource({
  role: "assistant",
  candidate: "候选正文",
  candidateDocuments: [{ content: "第二份正文" }],
}), /候选正文[\s\S]*第二份正文/u);

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
assert.match(appSource, /assistant-message-content message-collapsible-content/u,
  "神思生成内容必须进入可折叠容器");
assert.match(appSource, /assistant-message-expand-button/u,
  "长回复必须显示展开与收起按钮");
assert.match(appSource, /assistantContent\}\$\{renderVerifiedLandedContent\(message\)\}/u,
  "已落盘正文必须位于神思回复折叠容器内部");
assert.match(appSource, /closest\("\.message"\)\?\.querySelector\("\.message-collapsible-content"\)/u,
  "折叠按钮必须同时支持用户消息和神思回复");
assert.match(styles, /\.assistant-message-content\.is-collapsible:not\(\.is-expanded\)/u,
  "神思长回复必须有默认收起样式");

console.log("Conversation message collapse contracts passed");
