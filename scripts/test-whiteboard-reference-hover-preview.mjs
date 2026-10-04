import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(app, /const openWhiteboardGenerationReferenceHoverPreview = \(thumbnail\) => \{/u);
assert.match(app, /thumbnail\.closest\("\.whiteboard-generation-mention-menu"\)/u, "preview must only react to @ reference menu thumbnails");
assert.match(app, /media\.currentSrc \|\| media\.src/u, "preview must use the hovered thumbnail's media source");
assert.match(app, /anchorRect\.right \+ gap/u, "preview must prefer the hovered thumbnail's right side");
assert.match(app, /anchorRect\.left - width - gap/u, "preview must flip left when the right edge has no room");
assert.match(app, /window\.innerHeight - height - margin/u, "preview must stay inside the viewport bottom edge");
assert.match(app, /closeWhiteboardGenerationReferenceHoverPreview\(\);[\s\S]{0,120}clearWhiteboardGenerationMentionReplacement/u, "closing the @ menu must also remove the enlarged preview");
assert.match(styles, /\.whiteboard-generation-reference-hover-preview\s*\{[\s\S]{0,500}position:\s*fixed/u, "hover preview must be a viewport overlay");
assert.match(styles, /\.whiteboard-generation-reference-hover-preview\s+:is\(img, video\)/u, "hover preview must render enlarged image/video media");

console.log("白板 @ 参考缩略图悬停放大预览与边界定位测试通过");
