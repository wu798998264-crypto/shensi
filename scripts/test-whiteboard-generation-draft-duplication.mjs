import assert from "node:assert/strict";
import {
  duplicateWhiteboardGenerationDraftEntries,
  updateWhiteboardGenerationDraftCache,
  whiteboardGenerationDraftKey,
} from "../src/whiteboard-generation-draft.js";

const source = { workspaceId: "workspace-a", documentId: "board-a", nodeId: "card-source" };
let cache = {};
cache = updateWhiteboardGenerationDraftCache(cache, { ...source, channel: "image" }, {
  connectionId: "image-dreamina-cli-baiwuyu",
  model: "jimeng-4.1",
  prompt: "一座雪山上的古城",
}, { updatedAt: 10 });
cache = updateWhiteboardGenerationDraftCache(cache, { ...source, channel: "text" }, {
  executionSurface: "agent",
  connectionId: "text-opencode-deepseek",
  model: "deepseek-v4-pro",
  instruction: "续写镜头说明",
}, { updatedAt: 11 });
cache = updateWhiteboardGenerationDraftCache(cache, { ...source, channel: "audio" }, {
  connectionId: "audio-libtv-jimeng",
  model: "seed-audio-1.0",
  prompt: "生成角色旁白",
}, { updatedAt: 12 });
const duplicated = duplicateWhiteboardGenerationDraftEntries(cache, {
  ...source,
  sourceNodeId: "card-source",
  targetNodeId: "card-copy",
}, { updatedAt: 20 });

const copiedImage = duplicated.entries[whiteboardGenerationDraftKey({ ...source, nodeId: "card-copy", channel: "image" })];
const copiedText = duplicated.entries[whiteboardGenerationDraftKey({ ...source, nodeId: "card-copy", channel: "text" })];
const copiedAudio = duplicated.entries[whiteboardGenerationDraftKey({ ...source, nodeId: "card-copy", channel: "audio" })];
assert.equal(copiedImage.values.connectionId, "image-dreamina-cli-baiwuyu");
assert.equal(copiedImage.values.model, "jimeng-4.1");
assert.equal(copiedText.values.executionSurface, "agent");
assert.equal(copiedText.values.connectionId, "text-opencode-deepseek");
assert.equal(copiedText.values.instruction, "续写镜头说明");
assert.equal(copiedAudio.values.connectionId, "audio-libtv-jimeng");
assert.equal(copiedAudio.values.model, "seed-audio-1.0");
assert.equal(copiedAudio.values.prompt, "生成角色旁白");
console.log("Whiteboard generation draft duplication tests passed");
