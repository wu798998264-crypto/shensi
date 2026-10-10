import assert from "node:assert/strict";
import { compileLibTvVideoReferencePrompt, libTvVideoReferenceBindings } from "../src/server/libtv-video-references.mjs";

const request = { libTvReferencePrompt: "角色@「图片2」 手持@「图片1」；再次@「图片2」，音乐@「音乐.mp3」。普通 user@example.com", providerPromptReferenceTokens: ["@「图片1」", "@「图片2」", "@「音乐.mp3」"], promptReferenceSequence: ["b", "a", "b", "music"] };
const references = [{ id: "a", mimeType: "image/png", absolutePath: "a.png" }, { id: "b", mimeType: "image/png", absolutePath: "b.png" }, { id: "music", mimeType: "audio/mpeg", absolutePath: "m.mp3" }];
const job = { channel: "video", request };
assert.deepEqual(libTvVideoReferenceBindings({ job, references }).map(item => item.id), ["b", "a", "b", "music"]);
assert.equal(compileLibTvVideoReferencePrompt({ job, references, uploadedNodes: ["remote-a", "remote-b", "remote-m"] }), "角色{{Node remote-b}} 手持{{Node remote-a}}；再次{{Node remote-b}}，音乐{{Node remote-m}}。普通 user@example.com");
assert.throws(() => compileLibTvVideoReferencePrompt({ job, references, uploadedNodes: ["remote-a"] }), error => error.providerErrorCode === "LIBTV_REFERENCE_MAPPING_MISSING");
assert.throws(() => libTvVideoReferenceBindings({ job: { ...job, request: { ...request, promptReferenceSequence: ["a"] } }, references }), /数量不一致/u);
assert.throws(() => libTvVideoReferenceBindings({ job, references: references.slice(0, 2) }), /没有对应的媒体/u);
assert.equal(compileLibTvVideoReferencePrompt({ job: { channel: "video", request: { prompt: "普通 @ 用户和未解析@「保留」" } }, references: [], uploadedNodes: [] }), "普通 @ 用户和未解析@「保留」");
// Old jobs retain original display prompt; mapping must not be reconstructed by tray position.
assert.equal(compileLibTvVideoReferencePrompt({ job: { channel: "video", request: { ...request, libTvReferencePrompt: undefined, prompt: request.libTvReferencePrompt, executionPrompt: "已经去标记" } }, references, uploadedNodes: ["remote-a", "remote-b", "remote-m"] }), "角色{{Node remote-b}} 手持{{Node remote-a}}；再次{{Node remote-b}}，音乐{{Node remote-m}}。普通 user@example.com");
console.log("LibTV video reference fidelity and ambiguity rejection passed");
