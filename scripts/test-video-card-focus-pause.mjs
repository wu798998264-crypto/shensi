import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.match(source, /pauseVideoWhenClickOutside/u);
assert.match(source, /pausePlayingVideosWhenClickingOutside/u);
assert.match(source, /releaseActiveWhiteboardVideo/u);
assert.match(source, /document\.addEventListener\("pointerdown", pausePlayingVideosWhenClickingOutside, true\)/u);
assert.match(source, /whiteboardSurface\.querySelectorAll\("\.whiteboard-card-video"\)/u);
assert.match(source, /chatFeed\.querySelectorAll\("\.generated-video-preview video"\)/u);
assert.match(source, /owner\?\.contains\(target\)/u);
assert.match(source, /releaseActiveWhiteboardVideo\(owner\)/u);
assert.match(source, /name="pauseVideoWhenClickOutside"/u);
console.log("Video card focus pause contracts passed");
