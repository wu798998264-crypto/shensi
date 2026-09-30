import assert from "node:assert/strict";
import { detectOpenCodeModelCatalog, resetOpenCodeModelCatalogCache } from "../src/cli/opencode-model-catalog.mjs";
import {
  genericOpenCodeManualProfile,
  normalizeGenerationProfiles,
  validateGenericOpenCodeConnection,
} from "../src/generation-profiles.js";
import { openCodeCatalogCacheKey } from "../src/opencode-profile-ui-policy.js";

const fixture = [
  "if(process.argv.includes('--version')) console.log('OpenCode test');",
  "else console.log(JSON.stringify({models:[{id:'opencode/big-pickle',free:true},{id:'opencode/gpt-6-sol',free:false}]}));",
].join("");
const launchResolver = async () => ({ executable: process.execPath, prefixArgs: ["-e", fixture, "--"] });

resetOpenCodeModelCatalogCache();
const cacheKey = openCodeCatalogCacheKey({ credentialSource: "opencode_free" });
const catalog = await detectOpenCodeModelCatalog({
  cacheKey,
  credentialSource: "opencode_free",
  environment: { ...process.env, OPENCODE_API_KEY: "must-not-leak" },
  launchResolver,
});
assert.equal(catalog.credentialSource, "opencode_free");
assert.equal(catalog.models.find((item) => item.slug === "opencode/big-pickle")?.free, true);

const freeProfile = genericOpenCodeManualProfile({
  credentialSource: "opencode_free",
  model: "opencode/big-pickle",
});
assert.equal(validateGenericOpenCodeConnection({ profile: freeProfile, capability: catalog }).ok, true);
assert.equal(validateGenericOpenCodeConnection({
  profile: { ...freeProfile, model: "opencode/gpt-6-sol", agentModelId: "opencode/gpt-6-sol" },
  capability: catalog,
}).ok, false);

const normalized = normalizeGenerationProfiles({ textConnections: [] });
assert.equal(normalized.textConnections.find((profile) => profile.id === "text-opencode-free")?.credentialSource, "opencode_free");
console.log("OpenCode credential-source isolation contract passed");
