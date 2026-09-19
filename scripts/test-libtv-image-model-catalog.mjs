import assert from "node:assert/strict";
import { LIBTV_IMAGE_MODEL_OPTIONS, getProviderImageModelOptions } from "../src/model-presets.js";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";

const ids = LIBTV_IMAGE_MODEL_OPTIONS.map((item) => item.slug);
assert.deepEqual(ids.slice(0, 2), ["lib-image-2.5-s", "lib-image-2.5-f"]);
assert.deepEqual(
  getProviderImageModelOptions("LibTV").slice(0, 2).map((item) => item.slug),
  ["lib-image-2.5-s", "lib-image-2.5-f"],
  "LibTV 图片配置必须显示官方 CLI 当前最新的 2.5 Pro/Fast 模型",
);

const normalizeWithModel = (model) => normalizeGenerationProfiles({
  imageConnections: [{
    id: "image-libtv",
    name: "LibTV",
    adapter: "cli",
    provider: "LibTV",
    model,
  }],
  activeImageConnectionId: "image-libtv",
}).imageConnections.find((item) => item.id === "image-libtv");

assert.equal(normalizeWithModel("lib-image-2").model, "lib-image-2", "升级不得改写用户现有 LibTV 图片模型");
assert.equal(normalizeWithModel("lib-image-2.5-s").model, "lib-image-2.5-s");
assert.equal(normalizeWithModel("lib-image-2.5-f").model, "lib-image-2.5-f");

console.log("LibTV image model catalog passed");
