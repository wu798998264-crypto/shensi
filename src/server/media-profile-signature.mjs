import { createHash } from "node:crypto";

export const CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX = "media-profile-v3:";
export const MEDIA_CAPABILITY_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const normalizedIdentity = (value) => String(value || "").trim().toLowerCase();

const normalizedBaseUrl = (value) => {
  const source = String(value || "").trim();
  if (!source) return "";
  try {
    const url = new URL(source);
    url.hash = "";
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}${url.search}`;
  } catch {
    return source.replace(/\/+$/, "").toLowerCase();
  }
};

const normalizedCliPath = (value) => String(value || "")
  .trim()
  .replace(/\\/g, "/")
  .replace(/\/{2,}/g, "/");

const normalizedCliArgs = (value) => (Array.isArray(value)
  ? JSON.stringify(value.map((item) => String(item)))
  : String(value || "").trim().replace(/\r\n?/g, "\n"));

const sha256 = (domain, value) => createHash("sha256")
  .update(domain, "utf8")
  .update("\0", "utf8")
  .update(String(value || ""), "utf8")
  .digest("hex");

export const mediaCredentialFingerprint = (apiKey) => {
  const credential = String(apiKey || "");
  return credential ? sha256("shensi-media-credential-v1", credential) : "none";
};

export const canonicalMediaProfileSignature = (channel, settings = {}) => {
  const canonical = JSON.stringify([
    normalizedIdentity(channel),
    normalizedIdentity(settings.connectionId || settings.id),
    normalizedIdentity(settings.provider),
    normalizedIdentity(settings.adapter),
    normalizedIdentity(settings.protocol),
    String(settings.model || "").trim(),
    normalizedBaseUrl(settings.baseUrl),
    normalizedCliPath(settings.cliPath),
    normalizedCliArgs(settings.cliArgs),
    mediaCredentialFingerprint(settings.apiKey),
    // The executable is shared, but each Dreamina account has its own
    // isolated profile. Bind the named profile and verified identity into the
    // durable signature so a task cannot resume through another account.
    normalizedIdentity(settings.dreaminaCliProfile),
    normalizedIdentity(settings.dreaminaExpectedIdentity),
  ]);
  return `${CANONICAL_MEDIA_PROFILE_SIGNATURE_PREFIX}${sha256("shensi-media-profile-v3", canonical)}`;
};

export const mediaCapabilityEvidenceExpiry = (checkedAt = new Date().toISOString()) => {
  const checkedAtMs = Date.parse(checkedAt);
  const base = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  return new Date(base + MEDIA_CAPABILITY_EVIDENCE_MAX_AGE_MS).toISOString();
};
