import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

assert.match(
  source,
  /const defaultResolution = resolutions\.includes\("720p"\) \? "720p" : resolutions\[0\] \|\| "";/,
  "whiteboard video settings must prefer 720p when the selected model supports it",
);
assert.match(
  source,
  /form\.elements\.resolution\.value = resolutions\.includes\(previousResolution\) \? previousResolution : defaultResolution;/,
  "whiteboard video settings must preserve an explicitly selected supported resolution",
);
assert.match(
  source,
  /const requestedMediaResolution = \(prompt, supported = \[\], preferred = ""\) =>/,
  "conversation media resolution helper must accept a preferred default",
);
assert.match(
  source,
  /resolution: requestedMediaResolution\(optionPrompt, capabilities\.resolutions, selectedVideoOptions\?\.resolution \|\| "720p"\)/,
  "conversation video generation must preserve the selected resolution and otherwise prefer 720p",
);
assert.doesNotMatch(
  source,
  /quality: requestedMediaResolution\(/,
  "image generation must not inherit the video-only 720p default",
);

console.log("video default resolution tests passed");
