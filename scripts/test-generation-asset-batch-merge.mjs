import assert from "node:assert/strict";
import { appendGenerationAsset, appendGenerationAssets, normalizeGenerationAssets } from "../src/whiteboard.js";

const media = (id, overrides = {}) => ({
  id,
  kind: "image",
  origin: "generated",
  source: "conversation",
  createdAt: "2026-09-13T10:00:00.000Z",
  attachment: { relativePath: `assets/${id}.png`, sha256: id.repeat(8).slice(0, 64) },
  ...overrides,
});

const initial = [
  media("a", { attachment: { relativePath: "assets/a.png", sha256: "aa" } }),
  media("uploaded", { origin: "upload", attachment: { relativePath: "assets/upload.png", sha256: "same" } }),
];
const additions = [
  media("b", { generationJobId: "job-b" }),
  media("a", { createdAt: "2026-09-13T11:00:00.000Z", completedAt: "2026-09-13T11:01:00.000Z" }),
  media("uploaded-newer", { origin: "upload", createdAt: "2026-09-13T12:00:00.000Z", attachment: { relativePath: "assets/upload-2.png", sha256: "same" } }),
  media("generated-owner", { attachment: { relativePath: "assets/shared.png", sha256: "cc" } }),
  media("upload-shadow", { origin: "upload", attachment: { relativePath: "assets/shared.png", sha256: "dd" } }),
];

const sequential = additions.reduce((assets, asset) => appendGenerationAsset(assets, asset), initial);
const batched = appendGenerationAssets(initial, additions);
assert.deepEqual(batched, sequential, "one-pass batch merge must preserve the existing append and deduplication semantics");
assert.deepEqual(appendGenerationAssets(initial, []), normalizeGenerationAssets(initial));

console.log("Generation asset batch merge contract passed");
