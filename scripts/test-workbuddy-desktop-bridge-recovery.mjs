import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/server/workbuddy-desktop-bridge.mjs", import.meta.url), "utf8");
assert.match(source, /BRIDGE_READINESS_WINDOW_MS\s*=\s*12_000/u, "WorkBuddy 首次桥接等待必须有明确上限");
assert.match(source, /const waitForSidecar\s*=\s*async/u, "首次使用必须等待桌面 sidecar 就绪");
assert.match(source, /Date\.now\(\)\s*<\s*deadline/u, "桥接发现不得无限轮询");
assert.match(source, /const openAcpTaskSession\s*=\s*async/u, "ACP 会话生命周期必须独立封装");
assert.match(source, /session\s*=\s*await createHeadlessSession[\s\S]{0,900}return await prepare\(\)/u, "旧 ACP 会话失败后只能有界重建一次");
assert.match(source, /actualProvider:\s*"WorkBuddy"/u, "真实桥接结果必须保留 WorkBuddy 提供方标识");
console.log("WorkBuddy desktop bridge bounded recovery contract passed");
