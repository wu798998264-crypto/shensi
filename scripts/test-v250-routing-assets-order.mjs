import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { normalizeGenerationProfiles, reorderGenerationProfiles } from "../src/generation-profiles.js";
import { normalizeGenerationAssets } from "../src/whiteboard.js";

const original = normalizeGenerationProfiles({
  imageConnections: [
    { id: "image-a", name: "A", remarkName: "早期", adapter: "cli", provider: "OpenAI", protocol: "images", model: "gpt-image-2", cliPath: "one", cliArgs: "--one" },
    { id: "image-b", name: "B", remarkName: "后期", adapter: "cli", provider: "OpenAI", protocol: "images", model: "gpt-image-2", cliPath: "two", cliArgs: "--two" },
  ],
  activeImageConnectionId: "image-b",
});
const beforeProfiles = new Map(original.imageConnections.map((profile) => [profile.id, structuredClone(profile)]));
const reordered = reorderGenerationProfiles(original, "image", ["image-b", "image-a"]);
assert.deepEqual(reordered.imageConnections.slice(0, 2).map((profile) => profile.id), ["image-b", "image-a"]);
assert.equal(reordered.activeImageConnectionId, "image-b");
for (const profile of reordered.imageConnections) assert.deepEqual(profile, beforeProfiles.get(profile.id));

const assets = normalizeGenerationAssets([
  { id: "upload", kind: "image", attachment: { relativePath: "附件/upload.png" }, createdAt: "2024-01-02T03:04:05.000Z" },
  { id: "generated", kind: "image", prompt: "生成封面", attachment: { relativePath: "附件/generated.png" }, createdAt: "2024-02-02T03:04:05.000Z" },
  { id: "legacy", kind: "image", attachment: { relativePath: "附件/legacy.png" } },
]);
assert.equal(assets.find((asset) => asset.id === "upload").origin, "upload");
assert.equal(assets.find((asset) => asset.id === "generated").origin, "generated");
assert.equal(assets.find((asset) => asset.id === "legacy").origin, "upload");
assert.equal(assets.find((asset) => asset.id === "legacy").createdAt, "");

const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(appSource, /data-generation-order-list="image"/u);
assert.doesNotMatch(appSource, /data-toggle-generation-order=/u);
assert.match(appSource, /reorderGenerationProfiles\(generationWorkingSettings\(\), drag\.channel, ids\)/u);
assert.match(appSource, /fallbackCache: true/u);
assert.match(appSource, /directoryEntryAtPoint/u);
assert.match(appSource, /directoryDropIntoFolder/u);

console.log("v2.5.0 routing, historical asset and profile ordering tests passed");
