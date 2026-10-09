import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const server = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

assert.match(server, /const trustedAgentModelContext = await trustedConversationModelSettings[\s\S]{0,900}const publicWhiteboardAgent = whiteboardCanvasContext[\s\S]{0,280}credentialSource[\s\S]{0,80}public/u, "public whiteboard lane must use the trusted Agent profile");
assert.match(server, /workspaceToolContext: workspaceToolContextForModelRequest\([\s\S]{0,220}\),/u);
assert.match(server, /workspacePath && !publicWhiteboardAgent/u, "public whiteboard lane must omit workspace tools");
assert.doesNotMatch(app, /quickModelStatusDot|quick-model-status-dot/u, "the removed status dot must not return");
assert.doesNotMatch(styles, /quick-model-status-dot/u, "the removed status dot styles must not return");
assert.match(app, /Memory review remains available from the project index/u);
assert.match(app, /elements\.memoryReviewButton\.hidden = true/u, "editor toolbar memory entry must stay hidden");
console.log("Public whiteboard runtime isolation and editor memory-entry contracts passed");
