import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  purgeObsoleteWorkspaceCompatibility,
  synchronizeUnifiedTextAgentSelection,
} from "../src/obsolete-workspace-compatibility.js";
import {
  shouldShowCodexAccountControls,
  shouldShowCodexAccountControlsForSettings,
} from "../src/effective-runtime-contract.js";
import { formalDocumentContentPolicy } from "../src/formal-content-policy.js";

const aggregate = {
  id: "aggregate",
  provider: "自定义兼容接口",
  adapter: "api",
  protocol: "responses",
  agentEngine: "codex_api",
  model: "gpt-6-astra",
};
const codexCli = {
  id: "codex-cli",
  provider: "OpenAI",
  adapter: "cli",
  agentEngine: "codex",
  cliPath: "codex",
};
assert.equal(shouldShowCodexAccountControls(aggregate), false);
assert.equal(shouldShowCodexAccountControls(codexCli), true);
assert.equal(shouldShowCodexAccountControlsForSettings({
  textConnections: [aggregate],
  activeTextConnectionId: aggregate.id,
  activeTextAgentConnectionId: aggregate.id,
}), false);
assert.equal(shouldShowCodexAccountControlsForSettings({
  textConnections: [codexCli],
  activeTextConnectionId: codexCli.id,
  activeTextAgentConnectionId: codexCli.id,
}), true);
assert.equal(formalDocumentContentPolicy({
  documentId: "index-creative-guidance",
  moduleId: "index",
}).mode, "retired");

const state = {
  activeDocument: "index-creative-guidance",
  documents: {
    "index-creative-guidance": { title: "创作引导" },
    "chapter-1": { title: "第一章" },
  },
  moduleItems: {
    index: [["index-creative-guidance", "创作引导"], ["chapter-1", "第一章"]],
  },
  histories: { "index-creative-guidance": [{ id: "h1" }] },
  settings: {
    textConnections: [aggregate],
    activeTextConnectionId: "old",
    activeTextAgentConnectionId: aggregate.id,
    activeTextChatConnectionId: "old",
  },
  conversations: [{
    boundDocumentId: "index-creative-guidance",
    messages: [{ target: { documentId: "index-creative-guidance" } }],
  }],
};
const migration = purgeObsoleteWorkspaceCompatibility(state);
assert.equal(migration.changed, true);
assert.equal(state.documents["index-creative-guidance"], undefined);
assert.equal(state.moduleItems.index.some(([id]) => id === "index-creative-guidance"), false);
assert.equal(state.histories["index-creative-guidance"], undefined);
assert.equal(state.conversations[0].boundDocumentId, undefined);
assert.equal(state.conversations[0].messages[0].target.documentId, undefined);
assert.equal(state.activeDocument, "");
assert.equal(state.obsoleteWorkspaceCompatibilityVersion, 1);
assert.equal(state.settings.activeTextConnectionId, aggregate.id);
assert.equal(state.settings.activeTextAgentConnectionId, aggregate.id);
assert.equal(state.settings.activeTextChatConnectionId, aggregate.id);

const source = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
assert.doesNotMatch(source, /state\.documents\[CREATIVE_GUIDANCE_DOCUMENT_ID\]\s*=\s*creativeGuidanceDocumentPatch/u);
assert.match(source, /purgeObsoleteWorkspaceCompatibility\(state\)/u);
assert.match(source, /shouldShowCodexAccountControlsForSettings\(state\.settings\)/u);

console.log("obsolete compatibility cleanup contracts passed");
