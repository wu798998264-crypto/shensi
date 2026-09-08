import assert from "node:assert/strict";
import { inlineSourceArchiveCandidate } from "../src/inline-source-archive.js";

const source = "以下是我整理好的故事素材，请以这些内容为基础续写第四章。\n" + "人物在雨夜进入旧仓库，发现此前线索。".repeat(60);
const detected = inlineSourceArchiveCandidate({ value: source });
assert.equal(detected?.reason, "explicit_creative_basis");
assert.equal(detected?.authority, "reference_untrusted");
assert.equal(detected?.exactText, source);

assert.equal(inlineSourceArchiveCandidate({
  value: "我想知道：输入大量素材时，能否自动保存到资料库？\n" + "这是产品能力问题。".repeat(80),
}), null, "能力询问不得误归档");

assert.equal(inlineSourceArchiveCandidate({
  value: "这是一段很长的普通讨论。\n" + "没有素材归档或作为创作基础的授权。".repeat(80),
}), null, "普通长对话不得落盘");

const explicit = inlineSourceArchiveCandidate({
  value: "请把以下原始资料存入当前作品的资料库。\n" + "原始访谈记录。".repeat(20),
});
assert.equal(explicit?.reason, "explicit_library_archive");

console.log("v219 inline source archive tests passed");

