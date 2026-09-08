import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [executor, provider, openCode, deepSeek] = await Promise.all([
  readFile(resolve(root, "src", "server", "ranking-agent-executor.mjs"), "utf8"),
  readFile(resolve(root, "src", "server", "codex-agent-provider.mjs"), "utf8"),
  readFile(resolve(root, "src", "server", "opencode-agent-runner.mjs"), "utf8"),
  readFile(resolve(root, "src", "server", "deepseek-opencode-agent-runner.mjs"), "utf8"),
]);

assert.match(executor, /trustedReadOnlyNetwork:\s*true/u);
assert.match(executor, /rankingScan:\s*true/u);
assert.match(executor, /不得只凭记忆、预设或搜索摘要/u);
assert.match(executor, /不得声称完成全文分析/u);
assert.match(executor, /登录、付费、验证码/u);
assert.match(provider, /taskPacket\?\.rankingScan === true[\s\S]{0,320}authorizationState === "candidate_only"/u);
assert.match(provider, /\{ type: "readOnly", networkAccess: true \}/u, "联网扫榜仍必须保持文件系统只读");
assert.match(openCode, /web search and public HTTPS page reading|Web search and public HTTPS page reading/u);
assert.match(deepSeek, /webfetch:\s*allowNetwork \? "allow" : "deny"/u);
assert.match(deepSeek, /websearch:\s*allowNetwork \? "allow" : "deny"/u);

console.log("Ranking Agent network policy tests passed");
