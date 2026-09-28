import { readFile } from "node:fs/promises";

// Expose only the existing handshake to this diagnostic; never print session
// tokens, control-pipe tickets, environment variables or account credentials.
const source = await readFile(new URL("../src/server/workbuddy-desktop-bridge.mjs", import.meta.url), "utf8");
const diagnostic = await import(`data:text/javascript;base64,${Buffer.from(`${source}\nexport { waitForSidecar, openAcpTaskSession, closeAcp };`).toString("base64")}`);
const hold = setInterval(() => {}, 1_000);
let opened;
try {
  const sidecar = await diagnostic.waitForSidecar({ timeoutMs: 12_000 });
  if (!sidecar) throw new Error("WorkBuddy desktop bridge unavailable");
  opened = await diagnostic.openAcpTaskSession({ sidecar, cwd: process.cwd(), timeoutMs: 30_000 });
  const models = opened.result?.models || {};
  const safeModels = (items) => (Array.isArray(items) ? items : []).map((item) => ({
    id: String(item?.modelId || item?.id || ""),
    name: String(item?.name || ""),
    disabled: item?.disabled === true,
  }));
  console.log(JSON.stringify({
    modelKeys: Object.keys(models),
    standard: safeModels(models.availableModels),
    metaKeys: Object.keys(models._meta || {}),
    extended: safeModels(models._meta?.["codebuddy.ai"]?.availableModels),
  }, null, 2));
} finally {
  await diagnostic.closeAcp(opened?.session?.acpEndpoint, opened?.credentials);
  clearInterval(hold);
}
