import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialVault } from "../packaging/windows/desktop-app/credential-vault.mjs";

const root = await mkdtemp(join(tmpdir(), "shensi-credential-vault-"));
const encryptString = (value) => Buffer.from(String(value), "utf8");
const decryptString = (value) => Buffer.from(value).toString("utf8");
const vault = createCredentialVault({
  root,
  encryptionAvailable: () => true,
  encryptString,
  decryptString,
});

try {
  await vault.writeChannel("dreamina", { deletedLater: "secret" });
  await vault.deleteChannel("dreamina");
  const empty = await vault.read();
  assert.deepEqual(empty.secrets, {}, "删除凭证后主仓不应保留连接");

  // A damaged primary must recover the latest backup, not an older pre-delete
  // snapshot. Recovery also has to solidify the valid state back to primary.
  await writeFile(vault.paths.vaultPath, "{broken", "utf8");
  const recovered = await vault.read();
  assert.deepEqual(recovered.secrets, {}, "恢复副本不得复活已删除凭证");
  assert.equal(recovered.solidified, true, "恢复后的凭证仓必须立即固化");

  const persisted = JSON.parse(await readFile(vault.paths.vaultPath, "utf8"));
  assert.equal(persisted.schemaVersion, 1, "旧版本凭证仓格式应保持可读取");
  console.log("Credential vault tombstone and recovery regression checks passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
