import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { generationAssetQualifiesForHistory, normalizeGenerationAsset } from "../src/whiteboard.js";

const root = path.resolve(import.meta.dirname, "..");
const appSource = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
const standaloneText = normalizeGenerationAsset({
  id: "asset-library-text-1",
  kind: "text",
  origin: "upload",
  source: "asset-library",
  text: "独立资产文本",
  attachment: { relativePath: "attachments/asset-library-text-1.txt", name: "素材.txt", mimeType: "text/plain" },
});
assert.equal(standaloneText.source, "asset-library");
assert.equal(standaloneText.sourceNodeId, "");
assert.equal(standaloneText.sourceDocumentId, undefined);
assert.equal(generationAssetQualifiesForHistory(standaloneText), true);
assert.equal(generationAssetQualifiesForHistory({ kind: "text", origin: "upload", source: "asset-library", text: "" }), false);

for (const kind of ["image", "audio", "video"]) {
  const asset = normalizeGenerationAsset({
    id: `asset-library-${kind}`,
    kind,
    origin: "upload",
    source: "asset-library",
    attachment: { relativePath: `attachments/asset-library-${kind}.bin`, name: `${kind}.bin`, mimeType: `${kind}/*` },
  });
  assert.equal(asset.source, "asset-library");
  assert.equal(asset.sourceDocumentId, undefined);
  assert.equal(asset.sourceNodeId, "");
  assert.equal(generationAssetQualifiesForHistory(asset), true);
}

assert.match(appSource, /id="whiteboardAssetHistory"[^>]+title="全部资产"/);
assert.match(appSource, /id="uploadStandaloneAsset"/);
assert.match(appSource, /source: "asset-library"/);
assert.match(appSource, /未添加到文档或白板/);

console.log("v2196 asset library checks passed");
