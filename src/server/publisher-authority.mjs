import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PUBLISHER_AUTHORITY_FILE = "publisher-authority.json";

const clean = (value = "", max = 160) => String(value || "").trim().slice(0, max);

export const normalizePublisherAuthority = (value = {}) => {
  const role = value.role === "admin" ? "admin" : "user";
  return {
    schemaVersion: 1,
    accountId: clean(value.accountId, 120) || "local-user",
    displayName: clean(value.displayName, 80) || (role === "admin" ? "神思管理员" : "本地用户"),
    role,
    source: clean(value.source, 80) || "local-default",
  };
};

export const readLocalPublisherAuthority = async (root, env = process.env) => {
  const environmentRole = clean(env.SHENSI_MARKETPLACE_PUBLISHER_ROLE, 20);
  if (environmentRole) {
    return normalizePublisherAuthority({
      accountId: env.SHENSI_MARKETPLACE_PUBLISHER_ACCOUNT_ID,
      displayName: env.SHENSI_MARKETPLACE_PUBLISHER_NAME,
      role: environmentRole,
      source: "environment",
    });
  }
  try {
    return normalizePublisherAuthority(JSON.parse(await readFile(join(root, PUBLISHER_AUTHORITY_FILE), "utf8")));
  } catch {
    return normalizePublisherAuthority();
  }
};

export const publisherFields = ({ authority = {}, publication = {}, verified = false } = {}) => {
  const normalized = normalizePublisherAuthority(authority);
  const storedAccountId = clean(publication.publisherAccountId, 120);
  const publisherAccountId = storedAccountId || normalized.accountId;
  const currentPublisher = publisherAccountId === normalized.accountId;
  const publisherRole = currentPublisher && normalized.role === "admin" ? "admin" : "user";
  const trustLevel = publisherRole === "admin"
    ? "official"
    : verified || publication.trustLevel === "verified" ? "verified" : "community";
  return {
    publisherAccountId,
    publisherRole,
    trustLevel,
    author: publisherRole === "admin" ? normalized.displayName : clean(publication.author, 120) || "本地用户",
    sourceType: publisherRole === "admin" ? "official" : publication.sourceType === "official" ? "local_folder" : clean(publication.sourceType, 80) || "local_folder",
    sourceLabel: publisherRole === "admin" ? "神思官方目录" : publication.sourceLabel === "神思官方目录" ? "本地能力库" : clean(publication.sourceLabel, 160) || "本地能力库",
  };
};

export const applyLocalPublisherAuthority = (registry = {}, authority = {}) => {
  const next = structuredClone(registry);
  next.localPublisher = normalizePublisherAuthority(authority);
  next.marketplaceSubmissions = (next.marketplaceSubmissions ?? []).map((publication) => ({
    ...publication,
    ...publisherFields({
      authority: next.localPublisher,
      publication,
      verified: publication.trustLevel === "verified",
    }),
  }));
  next.capabilityMarketplaceSubmissions = (next.capabilityMarketplaceSubmissions ?? []).map((publication) => ({
    ...publication,
    ...publisherFields({ authority: next.localPublisher, publication, verified: true }),
  }));
  return next;
};
