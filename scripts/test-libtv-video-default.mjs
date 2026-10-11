import assert from "node:assert/strict";
import { normalizeGenerationProfiles } from "../src/generation-profiles.js";

const fresh = normalizeGenerationProfiles({});
assert.equal(fresh.videoConnections.find(p => p.id === "video-libtv").model, "star-video2.5");
const existing = normalizeGenerationProfiles({ videoConnections: [
  { id: "video-libtv", provider: "LibTV", adapter: "cli", model: "star-video2-mini", cliPath: "libtv" },
  { id: "video-libtv-custom", provider: "LibTV", adapter: "cli", model: "star-video2-fast", cliPath: "libtv" },
] });
assert.equal(existing.videoConnections.find(p => p.id === "video-libtv").model, "star-video2-mini", "Explicit existing model must not be overwritten during normalization");
assert.equal(existing.videoConnections.find(p => p.id === "video-libtv-custom").model, "star-video2-fast", "Custom profiles must remain unchanged");
console.log("LibTV video defaults to 2.5; existing explicit models remain intact");
