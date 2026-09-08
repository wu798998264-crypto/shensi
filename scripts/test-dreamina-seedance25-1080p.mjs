import assert from "node:assert/strict";
import {
  dreaminaCommandForVideoRequest,
  seedance25CapabilitiesFromCommandHelp,
  validateSeedance25Resolution,
} from "../src/cli/dreamina-video-capabilities.mjs";

const oldHelp = "seedance2.5 -> video_resolution 480p or 720p; duration 4-30s\nseedance2.0_vip -> 720p, 1080p, or 4k";
const newHelp = "seedance2.5 -> video_resolution 480p, 720p, or 1080p; duration 4-30s; VIP-only";
const capabilities = seedance25CapabilitiesFromCommandHelp({
  text2video: newHelp,
  image2video: newHelp,
  frames2video: oldHelp,
  multimodal2video: newHelp,
  multiframe2video: "seedance1.0fast -> video_resolution 720p",
});

assert.deepEqual(capabilities.resolutionsByCommand.text2video, ["480p", "720p", "1080p"]);
assert.deepEqual(capabilities.resolutionsByCommand.frames2video, ["480p", "720p"]);
assert.deepEqual(capabilities.resolutionsByMode.first_last_frame, ["480p", "720p"]);
assert.ok(capabilities.resolutionsByMode.smart_edit.includes("1080p"));
assert.deepEqual(capabilities.resolutionsByMode.smart_multiframe, []);
assert.equal(dreaminaCommandForVideoRequest({ mode: "first_last_frame", imageCount: 2 }), "frames2video");
assert.equal(dreaminaCommandForVideoRequest({ mode: "smart_edit", imageCount: 1, videoCount: 1 }), "multimodal2video");
assert.equal(dreaminaCommandForVideoRequest({ mode: "smart_params" }), "text2video");
assert.doesNotThrow(() => validateSeedance25Resolution({ resolution: "1080p", command: "text2video", capabilities }));
assert.throws(() => validateSeedance25Resolution({ resolution: "1080p", command: "frames2video", capabilities }), /不支持 1080p/u);

console.log("Dreamina Seedance 2.5 dynamic 1080p capability regressions passed");
