import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createId } from "./security.mjs";
import { normalizeSkillId, normalizeVersion, publicError, sha256 } from "./validation.mjs";

const dangerPatterns = [
  /child_process/iu,
  /powershell(?:\.exe)?/iu,
  /cmd(?:\.exe)?\s*\/c/iu,
  /(?:^|[^\w])eval\s*\(/iu,
  /<script\b/iu,
  /(?:api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{12,}/iu,
];

const metadataFromSource = (bytes) => {
  const text = bytes.toString("utf8");
  const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/u)?.[1] || "";
  const field = (name) => frontmatter.match(new RegExp(`^${name}\\s*:\\s*(.+)$`, "imu"))?.[1]?.trim().replace(/^['"]|['"]$/gu, "") || "";
  return {
    id: field("id"),
    name: field("name") || field("title"),
    version: field("version") || "1.0.0",
    description: field("description"),
  };
};

export const scanSkillPackage = (bytes) => {
  const text = bytes.toString("utf8");
  const findings = dangerPatterns.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
  const hasSkillEntry = /(?:^|[\r\n/])SKILL\.md(?:$|[\r\n])/iu.test(text) || /^---/u.test(text);
  if (!hasSkillEntry) findings.push("missing_skill_entry");
  return {
    status: findings.length ? "blocked" : "passed",
    findings,
    scanner: "static-v1",
  };
};

export const prepareSkillSubmission = ({ body, bytes, owner, scanOverride = null, objectKey = "" }) => {
  const metadata = metadataFromSource(bytes);
  const skillId = normalizeSkillId(body.skillId || metadata.id || `${owner.id}.skill`);
  const version = normalizeVersion(body.version || metadata.version);
  const scan = scanOverride || scanSkillPackage(bytes);
  return {
    id: createId("skill"),
    skillId,
    name: String(body.name || metadata.name || skillId).trim().slice(0, 160),
    description: String(body.description || metadata.description || "").trim().slice(0, 2_000),
    ownerUserId: owner.id,
    authorName: owner.displayName,
    status: scan.status === "passed" ? "pending_review" : "quarantined",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    scan,
    versions: [{
      version,
      packageFormat: "shensi-skill-package-v1",
      bytesBase64: bytes.toString("base64url"),
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      objectKey: objectKey || `skills/${skillId}/${version}.pkg`,
      publishedAt: 0,
      uploadedAt: Date.now(),
    }],
  };
};

const signaturePayload = (record) => Buffer.from(JSON.stringify({
  schemaVersion: 2,
  artifactId: String(record.artifactId),
  version: String(record.version),
  assetType: String(record.assetType),
  packageFormat: String(record.packageFormat),
  sha256: String(record.sha256).toLowerCase(),
  sizeBytes: Number(record.sizeBytes),
  objectKey: String(record.objectKey),
  publisherRole: record.publisherRole === "admin" ? "admin" : "user",
  trustLevel: record.trustLevel === "official" ? "official" : record.trustLevel === "verified" ? "verified" : "community",
}), "utf8");

export const ensureSigningKey = async (keyPath) => {
  try {
    return JSON.parse(await readFile(keyPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const value = {
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    };
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
    return value;
  }
};

export const artifactFromSkill = async ({ skill, versionRecord, signingKey }) => {
  const artifact = {
    artifactId: skill.skillId,
    version: versionRecord.version,
    assetType: "skill",
    packageFormat: "shensi-skill-package-v1",
    sha256: versionRecord.sha256,
    sizeBytes: versionRecord.sizeBytes,
    objectKey: versionRecord.objectKey,
    publisherRole: skill.publisherRole === "admin" ? "admin" : "user",
    trustLevel: "community",
    name: skill.name,
    author: skill.authorName,
    description: skill.description,
    rating: 0,
    ratingCount: 0,
  };
  artifact.signature = {
    schemaVersion: 2,
    algorithm: "Ed25519",
    signature: sign(null, signaturePayload(artifact), createPrivateKey(signingKey.privateKeyPem)).toString("base64url"),
  };
  return artifact;
};

export const publicSkill = (skill, versionRecord = skill?.versions?.at(-1)) => ({
  id: String(skill?.skillId || ""),
  name: String(skill?.name || ""),
  description: String(skill?.description || ""),
  version: String(versionRecord?.version || ""),
  author: String(skill?.authorName || "神思用户"),
  status: String(skill?.status || ""),
  trustLevel: "community",
  publishedAt: Number(versionRecord?.publishedAt) || 0,
});

export const publicArtifact = (artifact) => ({
  artifactId: artifact.artifactId,
  version: artifact.version,
  assetType: artifact.assetType,
  packageFormat: artifact.packageFormat,
  sha256: artifact.sha256,
  sizeBytes: artifact.sizeBytes,
  objectKey: artifact.objectKey,
  publisherRole: artifact.publisherRole,
  trustLevel: artifact.trustLevel,
  name: artifact.name,
  author: artifact.author,
  description: artifact.description,
  rating: artifact.rating,
  ratingCount: artifact.ratingCount,
  signature: artifact.signature,
});

export const catalogItems = (state) => state.skills
  .filter((skill) => skill.status === "published")
  .flatMap((skill) => skill.versions.filter((version) => version.publishedAt).map((version) => ({
    ...publicArtifact(version.artifact),
  })));

export const findPublishedArtifact = (state, artifactId, version) => {
  const skill = state.skills.find((entry) => entry.skillId === artifactId && entry.status === "published");
  const record = skill?.versions.find((entry) => entry.version === version && entry.publishedAt);
  return skill && record ? { skill, versionRecord: record, artifact: record.artifact } : null;
};

export const safeScanMessage = (skill) => skill?.scan?.findings?.length ? `自动检查未通过：${skill.scan.findings.map((item) => publicError({ message: item })).join("、")}` : "自动检查通过，等待人工审核";
