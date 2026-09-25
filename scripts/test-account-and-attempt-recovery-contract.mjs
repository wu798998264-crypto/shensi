import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "shensi-attempt-owner-"));
process.env.SHENSI_DATA_ROOT = root;

try {
  const store = await import(`../src/server/generation-attempt-store.mjs?owner=${Date.now()}`);
  await store.beginGenerationAttempt({
    requestId: "attempt-owner-0001",
    workspacePath: join(root, "workspace"),
    targetDocumentId: "chapter-5",
    taskKind: "creative",
    requestFingerprint: "fingerprint-owner-0001",
    conversationId: "conversation-original",
    sourceMessageId: "message-user-original",
    requestSnapshot: { messages: [{ role: "user", content: "继续写第五章" }] },
  });
  const attempt = store.publicGenerationAttempt(await store.loadGenerationAttempt({ requestId: "attempt-owner-0001" }));
  assert.equal(attempt.conversationId, "conversation-original");
  assert.equal(attempt.sourceMessageId, "message-user-original");
  assert.equal(attempt.sourcePrompt, "继续写第五章");

  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /systemManagedRecovery:\s*true/u);
  assert.match(app, /state\.generationAttemptRecoveryLedger\[requestId\]/u);
  assert.match(app, /uniqueConversationForAttempt\(attempt, existingLocations\)/u);
  const recoverySource = app.slice(app.indexOf("const discoverUnfinishedGenerationAttempts"), app.indexOf("const requestWorkspaceOperationPlan"));
  assert.doesNotMatch(recoverySource, /state\.messages\.push\(message\)/u);
  assert.match(app, /\["password", "register", "recover"\]\.includes\(ui\.account\.loginMode\)/u);
  assert.match(app, /data-account-login-mode="recover"/u);
  assert.match(app, /data-account-password-reveal="password"/u);
  assert.match(app, /rememberAccountSession/u);
  assert.doesNotMatch(app, /打开管理后台/u);
  console.log("account UI and generation attempt ownership recovery contract: PASS");
} finally {
  await rm(root, { recursive: true, force: true });
}
