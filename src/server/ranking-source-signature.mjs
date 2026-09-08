import { createHash, createPublicKey, verify as verifyEd25519 } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RANKING_SOURCE_FILES, RANKING_SOURCE_PUBLIC_KEY, RANKING_SOURCE_TRUST_MANIFEST } from "./ranking-source-trust-manifest.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

export const verifyRankingSourceContent = (relativePath, content) => {
  const trusted = RANKING_SOURCE_TRUST_MANIFEST[relativePath];
  if (!trusted) return false;
  const actualHash = sha256(content);
  if (actualHash !== trusted.sha256) return false;
  const signedPayload = `${String(relativePath)}\\n${String(actualHash)}`;
  return verifyEd25519(
    null,
    Buffer.from(signedPayload, "utf8"),
    createPublicKey(RANKING_SOURCE_PUBLIC_KEY),
    Buffer.from(trusted.signature, "base64"),
  );
};

export const verifyRankingSourceSignature = async (sourceId) => {
  const files = RANKING_SOURCE_FILES[String(sourceId)] || [];
  if (!files.length) return false;
  for (const relativePath of files) {
    const absolutePath = resolve(workspaceRoot, relativePath);
    if (!absolutePath.startsWith(`${workspaceRoot}\\`) && absolutePath !== workspaceRoot) return false;
    const content = await readFile(absolutePath);
    if (!verifyRankingSourceContent(relativePath, content)) return false;
  }
  return true;
};
