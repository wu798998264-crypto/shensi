import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  buildExecutionSourceReceipt,
  buildExecutionSourceReceiptFromContextBlocks,
  executionSourceIdentity,
  executionSourceMarker,
  executionSourcesFromContextBlocks,
} from "../src/server/execution-source-proof.mjs";
import { compileHybridAgentContext } from "../src/server/agent-context-protocol.mjs";
import { deepSeekAgentContextText } from "../src/server/deepseek-opencode-agent-runner.mjs";

const skillContent = `开头规则\n${"完整规则正文".repeat(90_000)}\n结尾不可省略规则`;
const block = {
  type: "controlled_skill",
  id: "official:long-writer",
  uri: "official:long-writer",
  name: "长篇主笔规则",
  text: `${executionSourceMarker({ kind: "skill", id: "official:long-writer", version: "1.0.0", content: skillContent })}\n${skillContent}`,
};

const compiledSkillBlock = compileHybridAgentContext({
  typedShensiBlocks: [block],
  providerCapabilities: { supportedTypes: ["controlled_skill"], supportKnown: true },
});
assert.equal(compiledSkillBlock.rejected.length, 0, "builtin Skill URI must remain in the final context");
assert.equal(compiledSkillBlock.blocks.length, 1, "enabled builtin Skill must reach final-input proof");
const nativeSkillIdentity = compiledSkillBlock.blocks[0].contentHash;
const compiledAgainstNativeSession = compileHybridAgentContext({
  typedShensiBlocks: [block],
  nativeSessionManifest: { contextIdentities: [`content:${nativeSkillIdentity}:${block.text.length}`] },
  providerCapabilities: { supportedTypes: ["controlled_skill"], supportKnown: true },
});
assert.equal(compiledAgainstNativeSession.blocks.length, 1,
  "启用 Skill 即使曾进入原生会话，本轮也必须按最新启用状态重新进入最终输入");
const finalInput = deepSeekAgentContextText([block]);
assert.match(finalInput, /结尾不可省略规则/u, "OpenCode 最终输入不得静默截断 Skill 尾部规则");

const sources = executionSourcesFromContextBlocks([block]);
assert.equal(sources.length, 1);
assert.equal(sources[0].content, skillContent);
const receipt = buildExecutionSourceReceipt({
  system: finalInput,
  sources,
  stage: "opencode_agent_final_input",
});
assert.equal(receipt.verified, true);
assert.equal(receipt.sources[0].contentLength, skillContent.length);

const staleSkillContent = `${skillContent.slice(0, -1)}旧`;
const staleBlock = {
  ...block,
  text: `${executionSourceMarker({ kind: "skill", id: block.id, version: "old", content: skillContent })}\n${staleSkillContent}`,
};
const duplicateReceipt = buildExecutionSourceReceipt({
  system: `${staleBlock.text}\n\n${block.text}`,
  sources,
  stage: "stale_client_marker_plus_authoritative_server_marker",
});
assert.equal(duplicateReceipt.verified, true, "过期客户端标记不得压过本轮服务端真实重载的完整 Skill");
const finalBlockReceipt = buildExecutionSourceReceiptFromContextBlocks({
  finalInput: `<wrapper>\n${staleBlock.text}\n${block.text}\n</wrapper>`,
  blocks: [staleBlock, block],
  stage: "runtime_final_input",
});
assert.equal(finalBlockReceipt.verified, true);
assert.equal(finalBlockReceipt.sources.some((item) => item.contentHash === executionSourceIdentity({
  kind: "skill",
  id: block.id,
  content: skillContent,
}).contentHash), true, "最终输入凭证必须包含服务端本轮有效 Skill 全文，而不是旧缓存块");

const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const codexProviderSource = await readFile(new URL("../src/server/codex-agent-provider.mjs", import.meta.url), "utf8");
assert.match(serverSource, /run\.executionSourceReceipt[\s\S]{0,260}receipts/u, "Agent 完成事件必须把最终输入凭证写回任务会话");
assert.match(serverSource, /block\?\.type !== "controlled_skill"/u,
  "服务端必须丢弃客户端缓存的 controlled Skill 正文");
assert.match(serverSource, /shensi-execution-source[\s\S]{0,100}kind[\s\S]{0,100}skill/u,
  "服务端必须丢弃客户端缓存的 Skill 来源标记");
assert.match(serverSource, /agentContextBlocks\.push\(\.\.\.agentSkillContext\.contextBlocks\)/u,
  "服务端必须只注入本轮真实重载的启用 Skill");
assert.match(codexProviderSource, /buildExecutionSourceReceiptFromContextBlocks\([\s\S]{0,260}blocks: options\.contextBlocks/u,
  "运行器必须直接验证本轮服务端有效来源块真实进入最终模型输入");

console.log("Agent 最终模型输入 Skill 全文证据测试通过");
